#!/usr/bin/env node

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

import { sha256Hex } from "./bytes/ops.js";
import {
  assertReasoningEffort,
  type ReasoningEffort,
} from "./bytes/request.js";
import { InteractiveSession } from "./cli/interactive.js";
import { runLogin, runLogout } from "./cli/login.js";
import { color, money, tokens } from "./cli/theme.js";
import { formatToolActivity } from "./cli/transcript.js";
import { withAutoResume } from "./cli/resume.js";
import { withTruncationContinuation } from "./cli/truncation.js";
import { DEFAULT_COMPACTION_THRESHOLD_TOKENS } from "./session/compaction.js";
import {
  DeclaredVerification,
  isRetryable,
  MAX_VERIFICATION_RETRIES,
  verificationContinuation,
} from "./cli/verify.js";
import { childEnvironment } from "./tool/runtime.js";
import {
  formatSessionList,
  listSessions,
  mostRecentContinuableSession,
} from "./cli/sessions.js";
import { freezeBytes, type FrozenBytes } from "./bytes/types.js";
import {
  loadPackagedFlashPriceBookV1,
  projectSessionCostV1,
  type CostReportV1,
} from "./cost/index.js";
import { loadDeepSeekCredential, CredentialError } from "./ds/credential.js";
import {
  createSessionPaths,
  inspectWriterLease,
  JournalError,
  newSessionId,
  openJournalReadOnly,
  quarantineWriterLease,
  type SessionId,
} from "./journal/index.js";
import {
  captureSessionEnvironment,
  continueOfficialSession,
  DEFAULT_RUN_BUDGET,
  reconcileOfficialSession,
  recoverOfficialSession,
  runOfficialSession,
  SessionInterruptedError,
  ProjectInstructionsError,
  SessionKernelError,
  type CompletedSessionResult,
  type RunBudgetLimits,
  type ToolActivity,
} from "./session/index.js";
import { ReconciliationInputError } from "./session/reconcile.js";
import type { GateSpec } from "./verify/gate.js";
import type { DeepSeekSemanticFragment } from "./ds/types.js";

const USAGE = `Usage: flashcoder
       flashcoder run [--effort low|high|max] [--verify <command>]
               [--protect <path>]... [--verify-timeout <sec>] <prompt...>
       printf '<prompt>' | flashcoder run
       flashcoder login
       flashcoder logout
       flashcoder sessions
       flashcoder continue [session-id]
       flashcoder inspect <session-id>
       flashcoder recover <session-id> [quarantine options]
       flashcoder reconcile <session-id> <evidence.json> [quarantine options]

With no arguments flashcoder starts an interactive multi-turn session.

Verification (run only). The check decides the exit code; its command is never
shown to the model, only its output when it fails:
       --verify <command>        shell command whose exit code decides
       --protect <path>          a path the check depends on; if it moved by
                                 the time the check runs the verdict is
                                 tampered, never passed (repeatable)
       --verify-timeout <sec>    default 600

Turn budget (interactive/continue only; each turn stops cleanly at a boundary):
       --max-cost-usd <amount>   default 1
       --max-minutes <n>         default 30
       --auto-compact-tokens <n> replace the conversation with a summary once
                                 the prefix reaches n prompt tokens; 0 disables
                                 (default 834464)

Quarantine options (recover/reconcile only):
       --quarantine-fingerprint <sha256:...>
       --confirm-no-concurrent-start
       [--force-ambiguous]
`;

/**
 * A reader that closed early is not a failure.
 *
 * `flashcoder inspect <id> | head` leaves the last write with nowhere to go, and
 * an EPIPE with no listener is an unhandled 'error' event and a stack trace.
 * Exit on it, but with whatever exit code was already decided: a run that had
 * settled on 4 because its verification failed must not report success just
 * because the reader walked away. Any other stream error is still real.
 */
function exitOnClosedReader(stream: NodeJS.WriteStream): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw error;
  });
}
exitOnClosedReader(process.stdout);
exitOnClosedReader(process.stderr);

const SESSION_ID = /^ses_[0-9a-f]{32}$/u;
const LEASE_FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;

type CliFailure = Readonly<{
  readonly message: string;
  readonly exitCode: number;
}>;

class CliInputError extends Error {
  constructor() {
    super("invalid CLI input");
    this.name = "CliInputError";
  }
}

interface QuarantineOptions {
  readonly fingerprint?: string;
  readonly confirmedNoConcurrentStart: boolean;
  readonly forceAmbiguous: boolean;
}

type CliCommand =
  | Readonly<{
      readonly kind: "run";
      readonly prompt: string;
      readonly effort?: ReasoningEffort;
      readonly verify?: GateSpec;
    }>
  | Readonly<{
      readonly kind: "interactive";
      readonly compactAtTokens: number;
    }>
  | Readonly<{ readonly kind: "sessions" }>
  | Readonly<{ readonly kind: "login" }>
  | Readonly<{ readonly kind: "logout" }>
  | Readonly<{
      readonly kind: "continue";
      readonly sessionId: SessionId | null;
      readonly compactAtTokens: number;
    }>
  | Readonly<{ readonly kind: "inspect"; readonly sessionId: SessionId }>
  | Readonly<{
      readonly kind: "recover";
      readonly sessionId: SessionId;
      readonly quarantine: QuarantineOptions;
    }>
  | Readonly<{
      readonly kind: "reconcile";
      readonly sessionId: SessionId;
      readonly evidencePath: string;
      readonly quarantine: QuarantineOptions;
    }>;

async function promptFromStdin(): Promise<string> {
  if (process.stdin.isTTY === true) throw new CliInputError();
  process.stdin.setEncoding("utf8");
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  if (prompt.trim().length === 0) throw new CliInputError();
  return prompt;
}

/** `--effort low|high|max`, consumed before the prompt words. */
function parseEffort(arguments_: readonly string[]): ReasoningEffort | undefined {
  const index = arguments_.indexOf("--effort");
  if (index < 0) return undefined;
  const value = arguments_[index + 1];
  if (value === undefined) throw new CliInputError();
  try {
    return assertReasoningEffort(value);
  } catch {
    throw new CliInputError();
  }
}

const VERIFY_FLAGS = new Set(["--verify", "--protect", "--verify-timeout"]);

/** `--verify <command> [--protect <path>]... [--verify-timeout <sec>]`. */
function parseVerify(arguments_: readonly string[]): GateSpec | undefined {
  const command = flagValue(arguments_, "--verify");
  const timeout = flagValue(arguments_, "--verify-timeout");
  const protectedPaths = arguments_
    .filter((_, index) => index > 0 && arguments_[index - 1] === "--protect")
    .map((value) => value.trim());
  if (command === undefined) {
    if (timeout !== undefined || protectedPaths.length > 0) throw new CliInputError();
    return undefined;
  }
  if (command.trim().length === 0) throw new CliInputError();
  const timeoutSeconds = timeout === undefined ? 600 : Number(timeout);
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 86_400) {
    throw new CliInputError();
  }
  if (protectedPaths.some((path) => path.length === 0)) throw new CliInputError();
  return Object.freeze({
    command,
    protectedPaths: Object.freeze([...new Set(protectedPaths)]),
    timeoutSeconds,
  });
}

function flagValue(
  arguments_: readonly string[],
  flag: string,
): string | undefined {
  const index = arguments_.indexOf(flag);
  if (index < 0) return undefined;
  if (arguments_.indexOf(flag, index + 1) >= 0) throw new CliInputError();
  const value = arguments_[index + 1];
  if (value === undefined) throw new CliInputError();
  return value;
}

async function parsePrompt(arguments_: readonly string[]): Promise<string> {
  const consumed = new Set(["--effort", ...VERIFY_FLAGS]);
  const promptParts = arguments_.slice(1).filter((value, index, all) => {
    if (consumed.has(value)) return false;
    const previous = all[index - 1];
    return previous === undefined || !consumed.has(previous);
  });
  if (promptParts.length === 0) return promptFromStdin();
  const prompt = promptParts.join(" ");
  if (prompt.trim().length === 0) throw new CliInputError();
  return prompt;
}

function parseSessionId(value: string | undefined): SessionId {
  if (value === undefined || !SESSION_ID.test(value)) throw new CliInputError();
  return value as SessionId;
}

function parseRecoveryArguments(
  arguments_: readonly string[],
  positionalCount: 1 | 2,
): Readonly<{
  readonly positional: readonly string[];
  readonly quarantine: QuarantineOptions;
}> {
  const positional: string[] = [];
  let fingerprint: string | undefined;
  let confirmedNoConcurrentStart = false;
  let forceAmbiguous = false;
  for (let index = 1; index < arguments_.length; index += 1) {
    const value = arguments_[index];
    if (value === "--quarantine-fingerprint") {
      const candidate = arguments_[index + 1];
      if (
        fingerprint !== undefined ||
        candidate === undefined ||
        !LEASE_FINGERPRINT.test(candidate)
      ) {
        throw new CliInputError();
      }
      fingerprint = candidate;
      index += 1;
    } else if (value === "--confirm-no-concurrent-start") {
      if (confirmedNoConcurrentStart) throw new CliInputError();
      confirmedNoConcurrentStart = true;
    } else if (value === "--force-ambiguous") {
      if (forceAmbiguous) throw new CliInputError();
      forceAmbiguous = true;
    } else if (value?.startsWith("--") === true) {
      throw new CliInputError();
    } else if (value !== undefined) {
      positional.push(value);
    }
  }
  if (
    positional.length !== positionalCount ||
    (fingerprint === undefined) !== !confirmedNoConcurrentStart ||
    (forceAmbiguous && fingerprint === undefined)
  ) {
    throw new CliInputError();
  }
  return Object.freeze({
    positional: Object.freeze(positional),
    quarantine: Object.freeze({
      ...(fingerprint === undefined ? {} : { fingerprint }),
      confirmedNoConcurrentStart,
      forceAmbiguous,
    }),
  });
}

/**
 * Flags the multi-turn forms accept.
 *
 * They were documented in the usage text but unreachable: the interactive form
 * required no arguments at all, and `continue` rejected anything past a session
 * id, so every one of these was rejected as an invalid invocation.
 */
const SESSION_FLAGS = new Set([
  "--max-cost-usd",
  "--max-minutes",
  "--auto-compact-tokens",
]);

/** The arguments left once the session flags and their values are removed. */
function withoutSessionFlags(
  arguments_: readonly string[],
): readonly string[] {
  return arguments_.filter((value, index, all) => {
    if (SESSION_FLAGS.has(value)) return false;
    const previous = all[index - 1];
    return previous === undefined || !SESSION_FLAGS.has(previous);
  });
}

async function parseCommand(arguments_: readonly string[]): Promise<CliCommand> {
  const positional = withoutSessionFlags(arguments_);
  if (positional.length === 0) {
    return Object.freeze({
      kind: "interactive",
      compactAtTokens: parseCompactThreshold(arguments_),
    });
  }
  switch (positional[0]) {
    case "run": {
      const effort = parseEffort(arguments_);
      const verify = parseVerify(arguments_);
      return Object.freeze({
        kind: "run",
        prompt: await parsePrompt(arguments_),
        ...(effort === undefined ? {} : { effort }),
        ...(verify === undefined ? {} : { verify }),
      });
    }
    case "sessions":
      if (arguments_.length !== 1) throw new CliInputError();
      return Object.freeze({ kind: "sessions" });
    case "login":
      if (arguments_.length !== 1) throw new CliInputError();
      return Object.freeze({ kind: "login" });
    case "logout":
      if (arguments_.length !== 1) throw new CliInputError();
      return Object.freeze({ kind: "logout" });
    case "continue":
      if (positional.length > 2) throw new CliInputError();
      return Object.freeze({
        kind: "continue",
        sessionId:
          positional.length === 2 ? parseSessionId(positional[1]) : null,
        compactAtTokens: parseCompactThreshold(arguments_),
      });
    case "inspect":
      if (arguments_.length !== 2) throw new CliInputError();
      return Object.freeze({
        kind: "inspect",
        sessionId: parseSessionId(arguments_[1]),
      });
    case "recover": {
      const parsed = parseRecoveryArguments(arguments_, 1);
      return Object.freeze({
        kind: "recover",
        sessionId: parseSessionId(parsed.positional[0]),
        quarantine: parsed.quarantine,
      });
    }
    case "reconcile": {
      const parsed = parseRecoveryArguments(arguments_, 2);
      const evidencePath = parsed.positional[1];
      if (evidencePath === undefined || evidencePath.length === 0) {
        throw new CliInputError();
      }
      return Object.freeze({
        kind: "reconcile",
        sessionId: parseSessionId(parsed.positional[0]),
        evidencePath,
        quarantine: parsed.quarantine,
      });
    }
    default:
      throw new CliInputError();
  }
}

function classifyFailure(error: unknown): CliFailure {
  if (error instanceof CliInputError) {
    return Object.freeze({ message: "flashcoder: invalid_invocation\n", exitCode: 2 });
  }
  if (error instanceof CredentialError) {
    return Object.freeze({
      message: `flashcoder: credential_${error.code}\n`,
      exitCode: 3,
    });
  }
  if (error instanceof SessionInterruptedError) {
    return Object.freeze({
      message: `flashcoder: session_interrupted_${error.reason}\n`,
      exitCode: error.reason === "cancelled" ? 130 : 4,
    });
  }
  if (error instanceof ProjectInstructionsError) {
    // Says which file and what is wrong with it: the fix is always an edit to
    // that file, and a code alone would not point at it.
    return Object.freeze({
      message: `flashcoder: ${error.message}\n`,
      exitCode: 2,
    });
  }
  if (error instanceof SessionKernelError) {
    return Object.freeze({
      message: `flashcoder: session_${error.code}\n`,
      exitCode: 5,
    });
  }
  if (error instanceof ReconciliationInputError) {
    return Object.freeze({
      message: `flashcoder: reconciliation_${error.code}\n`,
      exitCode: 2,
    });
  }
  if (error instanceof JournalError) {
    // Taking a lease from another writer is never automatic: naming the exact
    // lease you saw is how you say you looked. But the code alone left nobody
    // any way to find out what to name, so it says where to read it.
    const guidance =
      error.code === "JOURNAL_LEASE_HELD"
        ? "flashcoder: another writer holds this session. If no other flashcoder is" +
          " running, take it over with:\n" +
          "flashcoder:   flashcoder inspect <session-id>   # observation.finalLease.fingerprint\n" +
          "flashcoder:   flashcoder recover <session-id> --quarantine-fingerprint <sha256:...>" +
          " --confirm-no-concurrent-start\n"
        : "";
    return Object.freeze({
      message: `flashcoder: ${error.code.toLowerCase()}\n${guidance}`,
      exitCode: 5,
    });
  }
  return Object.freeze({ message: "flashcoder: internal_error\n", exitCode: 1 });
}

function percentFromBasisPoints(value: string | null): string {
  if (value === null) return "-";
  const basisPoints = BigInt(value);
  const integer = basisPoints / 100n;
  const decimal = (basisPoints % 100n).toString().padStart(2, "0");
  return `${integer}.${decimal}%`;
}

class CliRenderer {
  readonly #tty = process.stderr.isTTY === true;
  #statusVisible = false;
  #previewAtLineBoundary = true;

  readonly preview = (fragment: DeepSeekSemanticFragment): void => {
    // Only the answer; reasoning deltas stay out of the transcript.
    if (fragment.kind !== "content") return;
    if (this.#tty && this.#statusVisible) {
      process.stderr.write("\r\x1b[2K");
      this.#statusVisible = false;
    }
    process.stderr.write(fragment.text);
    this.#previewAtLineBoundary = fragment.text.endsWith("\n");
  };

  readonly status = (report: CostReportV1): void => {
    const active = report.lineages.find(
      ({ lineageId }) => lineageId === report.activeLineageId,
    );
    const observed = report.lastProviderObservedPromptTokens;
    const line = color.dim(
      [
        money(report.knownSessionCost.total.usd),
        `cache ${percentFromBasisPoints(active?.cacheHitRatio.basisPoints ?? null)}`,
        observed === null || observed === undefined
          ? "context -"
          : `context ${tokens(Number(observed))}`,
      ].join(" · "),
    );
    if (!this.#tty) {
      // Deltas arrive without line breaks, so start the status on its own row
      // rather than gluing it onto the end of a sentence.
      if (!this.#previewAtLineBoundary) process.stderr.write("\n");
      process.stderr.write(`${line}\n`);
      this.#previewAtLineBoundary = true;
      return;
    }
    if (this.#statusVisible) process.stderr.write("\r\x1b[2K");
    else if (!this.#previewAtLineBoundary) process.stderr.write("\n");
    process.stderr.write(line);
    this.#statusVisible = true;
    this.#previewAtLineBoundary = false;
  };

  readonly tool = (activity: ToolActivity): void => {
    if (activity.phase !== "settled") return;
    if (this.#tty && this.#statusVisible) {
      process.stderr.write("\r\x1b[2K");
      this.#statusVisible = false;
    }
    if (!this.#previewAtLineBoundary) process.stderr.write("\n");
    process.stderr.write(`${formatToolActivity(activity)}\n`);
    this.#previewAtLineBoundary = true;
  };

  finish(): void {
    if (this.#tty && this.#statusVisible) {
      process.stderr.write("\n");
      this.#statusVisible = false;
      this.#previewAtLineBoundary = true;
    }
  }
}

/**
 * Close the progress display, then put the answer on stdout.
 *
 * stdout carries the answer so `flashcoder run <prompt> > answer.txt` gets exactly
 * that and nothing else. When stdout and stderr are the same terminal the
 * answer already streamed past as it was produced, so printing it a second time
 * is noise rather than output.
 */
function writeResult(renderer: CliRenderer | undefined, content: string): void {
  renderer?.finish();
  if (process.stdout.isTTY === true && process.stderr.isTTY === true) return;
  process.stdout.write(content);
}

async function quarantineIfRequested(
  workspaceRoot: string,
  sessionId: SessionId,
  options: QuarantineOptions,
): Promise<void> {
  if (options.fingerprint === undefined) return;
  const paths = createSessionPaths(workspaceRoot, sessionId);
  const inspection = await inspectWriterLease(paths);
  if (inspection.fingerprint !== options.fingerprint) {
    throw new CliInputError();
  }
  const quarantined = await quarantineWriterLease(paths, inspection, {
    confirmedNoConcurrentStart: true,
    ...(options.forceAmbiguous ? { forceAmbiguous: true } : {}),
  });
  process.stderr.write(
    `flashcoder: writer_lease_quarantined=${quarantined.inspectionFingerprint}\n`,
  );
}

async function readEvidenceFile(path: string): Promise<FrozenBytes> {
  let handle;
  try {
    handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      !Number.isSafeInteger(stats.size) ||
      stats.size < 1 ||
      stats.size > MAX_EVIDENCE_BYTES
    ) {
      throw new CliInputError();
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== stats.dev ||
      after.ino !== stats.ino ||
      after.size !== stats.size ||
      after.mtimeMs !== stats.mtimeMs ||
      bytes.byteLength !== stats.size
    ) {
      throw new CliInputError();
    }
    await handle.close();
    handle = undefined;
    return freezeBytes(bytes);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof CliInputError) throw error;
    throw new CliInputError();
  }
}

async function inspectSession(
  workspaceRoot: string,
  sessionId: SessionId,
): Promise<void> {
  const opened = await openJournalReadOnly(workspaceRoot, sessionId);
  const cost = projectSessionCostV1(
    sessionId,
    opened.replay.events,
    await loadPackagedFlashPriceBookV1(),
  );
  const tornTail = opened.replay.tornTail;
  const report = Object.freeze({
    v: 1,
    sessionId,
    observation: opened.observation,
    journal: Object.freeze({
      head: opened.replay.head,
      validPrefixByteCount: opened.replay.validPrefixByteCount,
      totalByteCount: opened.replay.totalByteCount,
      tornTail:
        tornTail === null
          ? null
          : Object.freeze({
              byteCount: tornTail.byteLength,
              hash: `sha256:${sha256Hex(tornTail)}`,
            }),
      events: opened.replay.events,
    }),
    recovery: opened.recoveryView,
    cost,
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

/**
 * Per-turn limits. Defaults bound an unattended session; the flags exist so a
 * long job can raise them deliberately rather than by accident.
 */
/**
 * `--auto-compact-tokens <n>`, or 0 to leave the conversation alone.
 *
 * The default suits Flash's 1M window. A different model, or a machine where
 * latency matters more than cache hits, wants a different number, and the only
 * way to find out is to be able to change it.
 */
function parseCompactThreshold(arguments_: readonly string[]): number {
  const raw = flagValue(arguments_, "--auto-compact-tokens");
  if (raw === undefined) return DEFAULT_COMPACTION_THRESHOLD_TOKENS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new CliInputError();
  return value;
}

function parseBudgetOptions(
  arguments_: readonly string[],
): RunBudgetLimits {
  let limits = DEFAULT_RUN_BUDGET;
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    const raw = arguments_[index + 1];
    if (flag === "--max-cost-usd") {
      if (raw === undefined || !/^\d+(?:\.\d{1,12})?$/u.test(raw)) {
        throw new CliInputError();
      }
      const [whole = "0", fraction = ""] = raw.split(".");
      const picodollars =
        BigInt(whole) * 1_000_000_000_000n +
        BigInt(fraction.padEnd(12, "0"));
      if (picodollars <= 0n) throw new CliInputError();
      limits = { ...limits, maxCostPicodollars: picodollars };
      index += 1;
    } else if (flag === "--max-minutes") {
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) throw new CliInputError();
      limits = { ...limits, maxWallMs: value * 60_000 };
      index += 1;
    }
  }
  return limits;
}

/**
 * Decide which Session an interactive run attaches to.
 *
 * `flashcoder` starts a fresh one. `flashcoder continue` reuses a Session whose last Run
 * completed; anything else is left to `flashcoder recover`, which is the only path
 * allowed to take over a durable pending tail.
 */
async function resolveInteractiveSession(
  workspaceRoot: string,
  command: Extract<CliCommand, { kind: "interactive" | "continue" }>,
): Promise<Readonly<{ sessionId: SessionId; started: boolean }> | null> {
  if (command.kind === "interactive") return null;
  if (command.sessionId !== null) {
    const summary = (await listSessions(workspaceRoot)).find(
      ({ sessionId }) => sessionId === command.sessionId,
    );
    if (summary === undefined) {
      process.stderr.write("flashcoder: no such session in this workspace\n");
      throw new CliInputError();
    }
    if (summary.state !== "completed") {
      process.stderr.write(
        `flashcoder: session is ${summary.state}; run flashcoder recover ${summary.sessionId} first\n`,
      );
      throw new CliInputError();
    }
    return Object.freeze({ sessionId: summary.sessionId, started: true });
  }
  const recent = await mostRecentContinuableSession(workspaceRoot);
  if (recent === null) {
    process.stderr.write("flashcoder: no continuable session in this workspace\n");
    throw new CliInputError();
  }
  return Object.freeze({ sessionId: recent.sessionId, started: true });
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (
    arguments_.length === 1 &&
    (arguments_[0] === "--help" || arguments_[0] === "-h")
  ) {
    process.stdout.write(USAGE);
    return;
  }
  if (
    arguments_.length === 2 &&
    arguments_[0] === "run" &&
    (arguments_[1] === "--help" || arguments_[1] === "-h")
  ) {
    process.stdout.write(USAGE);
    return;
  }

  const controller = new AbortController();
  let renderer: CliRenderer | undefined;
  const onInterrupt = (): void => controller.abort();
  process.once("SIGINT", onInterrupt);
  try {
    const command = await parseCommand(arguments_);
    const workspaceRoot = process.cwd();
    if (command.kind === "inspect") {
      await inspectSession(workspaceRoot, command.sessionId);
      return;
    }
    if (command.kind === "login") {
      if (process.stdin.isTTY !== true) {
        process.stderr.write(
          "flashcoder: login needs a terminal; set DEEPSEEK_API_KEY in the environment instead\n",
        );
        throw new CliInputError();
      }
      await runLogin();
      return;
    }
    if (command.kind === "logout") {
      runLogout();
      return;
    }
    if (command.kind === "sessions") {
      process.stdout.write(formatSessionList(await listSessions(workspaceRoot)));
      return;
    }
    if (command.kind === "interactive" || command.kind === "continue") {
      if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
        process.stderr.write(
          "flashcoder: interactive mode needs a terminal; use flashcoder run <prompt> instead\n",
        );
        throw new CliInputError();
      }
      // SIGINT belongs to the editor here: it interrupts the running turn
      // rather than tearing the process down.
      process.removeListener("SIGINT", onInterrupt);
      const existing = await resolveInteractiveSession(workspaceRoot, command);
      await new InteractiveSession(
        workspaceRoot,
        existing,
        parseBudgetOptions(arguments_),
        command.compactAtTokens,
      ).run();
      return;
    }
    if (command.kind === "run") {
      const sessionId = newSessionId();
      process.stderr.write(`flashcoder: session_id=${sessionId}\n`);
      renderer = new CliRenderer();
      const credential = loadDeepSeekCredential({ projectRoot: workspaceRoot });
      const environmentFacts = await captureSessionEnvironment(workspaceRoot);
      const effort =
        command.effort === undefined ? {} : { reasoningEffort: command.effort };
      const observers = {
        onPreview: renderer.preview,
        onStatus: renderer.status,
        onToolActivity: renderer.tool,
      } as const;
      const recover = (): Promise<CompletedSessionResult> =>
        recoverOfficialSession({
          workspaceRoot,
          sessionId,
          signal: controller.signal,
          onPreview: renderer!.preview,
          onStatus: renderer!.status,
          onToolActivity: renderer!.tool,
          loadCredential: () =>
            loadDeepSeekCredential({ projectRoot: workspaceRoot }),
        });
      const onResume = (attempt: number, max: number): void => {
        process.stderr.write(
          `flashcoder: resuming from the last safe boundary (${String(attempt)}/${String(max)})\n`,
        );
      };
      const declared =
        command.verify === undefined
          ? undefined
          : await DeclaredVerification.declare(
              command.verify,
              workspaceRoot,
              childEnvironment(workspaceRoot),
            );
      const verification = declared === undefined ? {} : { verification: declared };
      const turn = (userInput: string, first: boolean) =>
        withAutoResume(
          () =>
            first
              ? runOfficialSession({
                  workspaceRoot,
                  sessionId,
                  userInput,
                  ...effort,
                  ...verification,
                  environmentFacts,
                  signal: controller.signal,
                  ...observers,
                  credential,
                })
              : continueOfficialSession({
                  workspaceRoot,
                  sessionId,
                  userInput,
                  ...effort,
                  ...verification,
                  environmentFacts,
                  signal: controller.signal,
                  ...observers,
                  credential,
                }),
          recover,
          onResume,
        );
      const continueTurn = (userInput: string) => turn(userInput, false);
      let result = await withTruncationContinuation(
        await turn(command.prompt, true),
        continueTurn,
        (attempt, max) =>
          process.stderr.write(
            `flashcoder: the reply hit the output limit; continuing (${String(attempt)}/${String(max)})\n`,
          ),
      );
      for (
        let attempt = 1;
        isRetryable(result.verification) && attempt <= MAX_VERIFICATION_RETRIES;
        attempt += 1
      ) {
        const failure = declared?.last;
        if (failure === undefined || failure === null) break;
        process.stderr.write(
          `flashcoder: verification failed; continuing (${String(attempt)}/${String(MAX_VERIFICATION_RETRIES)})\n`,
        );
        result = await withTruncationContinuation(
          await continueTurn(verificationContinuation(failure)),
          continueTurn,
        );
      }
      if (declared !== undefined) {
        process.stderr.write(`flashcoder: verification=${result.verification}\n`);
      }
      writeResult(renderer, result.content);
      if (declared !== undefined && result.verification !== "passed") {
        process.exitCode = 4;
      }
      return;
    }
    await quarantineIfRequested(
      workspaceRoot,
      command.sessionId,
      command.quarantine,
    );
    renderer = new CliRenderer();
    const common = {
      workspaceRoot,
      sessionId: command.sessionId,
      signal: controller.signal,
      onPreview: renderer.preview,
      onStatus: renderer.status,
      loadCredential: () => loadDeepSeekCredential({ projectRoot: workspaceRoot }),
    } as const;
    const result =
      command.kind === "recover"
        ? await recoverOfficialSession(common)
        : await reconcileOfficialSession({
            ...common,
            evidenceBytes: await readEvidenceFile(command.evidencePath),
          });
    writeResult(renderer, result.content);
  } catch (error) {
    const failure = classifyFailure(error);
    process.stderr.write(failure.message);
    process.exitCode = failure.exitCode;
  } finally {
    renderer?.finish();
    process.removeListener("SIGINT", onInterrupt);
  }
}

await main();
