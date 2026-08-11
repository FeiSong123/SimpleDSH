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
  SessionKernelError,
  type CompletedSessionResult,
  type RunBudgetLimits,
  type ToolActivity,
} from "./session/index.js";
import { ReconciliationInputError } from "./session/reconcile.js";
import type { GateSpec } from "./verify/gate.js";
import type { DeepSeekSemanticFragment } from "./ds/types.js";

const USAGE = `Usage: simpledsh
       simpledsh run [--effort low|high|max] [--verify <command>]
               [--protect <path>]... [--verify-timeout <sec>] <prompt...>
       printf '<prompt>' | simpledsh run
       simpledsh login
       simpledsh logout
       simpledsh sessions
       simpledsh continue [session-id]
       simpledsh inspect <session-id>
       simpledsh recover <session-id> [quarantine options]
       simpledsh reconcile <session-id> <evidence.json> [quarantine options]

With no arguments simpledsh starts an interactive multi-turn session.

Verification (run only). The check decides the exit code; its command is never
shown to the model, only its output when it fails:
       --verify <command>        shell command whose exit code decides
       --protect <path>          a path the check depends on; if it moved by
                                 the time the check runs the verdict is
                                 tampered, never passed (repeatable)
       --verify-timeout <sec>    default 600

Turn budget (interactive/continue only; each turn stops cleanly at a boundary):
       --max-tool-rounds <n>     default 50
       --max-cost-usd <amount>   default 1
       --max-minutes <n>         default 30

Quarantine options (recover/reconcile only):
       --quarantine-fingerprint <sha256:...>
       --confirm-no-concurrent-start
       [--force-ambiguous]
`;

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
  | Readonly<{ readonly kind: "interactive" }>
  | Readonly<{ readonly kind: "sessions" }>
  | Readonly<{ readonly kind: "login" }>
  | Readonly<{ readonly kind: "logout" }>
  | Readonly<{
      readonly kind: "continue";
      readonly sessionId: SessionId | null;
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

async function parseCommand(arguments_: readonly string[]): Promise<CliCommand> {
  if (arguments_.length === 0) return Object.freeze({ kind: "interactive" });
  switch (arguments_[0]) {
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
      if (arguments_.length > 2) throw new CliInputError();
      return Object.freeze({
        kind: "continue",
        sessionId:
          arguments_.length === 2 ? parseSessionId(arguments_[1]) : null,
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
    return Object.freeze({ message: "simpledsh: invalid_invocation\n", exitCode: 2 });
  }
  if (error instanceof CredentialError) {
    return Object.freeze({
      message: `simpledsh: credential_${error.code}\n`,
      exitCode: 3,
    });
  }
  if (error instanceof SessionInterruptedError) {
    return Object.freeze({
      message: `simpledsh: session_interrupted_${error.reason}\n`,
      exitCode: error.reason === "cancelled" ? 130 : 4,
    });
  }
  if (error instanceof SessionKernelError) {
    return Object.freeze({
      message: `simpledsh: session_${error.code}\n`,
      exitCode: 5,
    });
  }
  if (error instanceof ReconciliationInputError) {
    return Object.freeze({
      message: `simpledsh: reconciliation_${error.code}\n`,
      exitCode: 2,
    });
  }
  if (error instanceof JournalError) {
    return Object.freeze({
      message: `simpledsh: ${error.code.toLowerCase()}\n`,
      exitCode: 5,
    });
  }
  return Object.freeze({ message: "simpledsh: internal_error\n", exitCode: 1 });
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
 * stdout carries the answer so `simpledsh run <prompt> > answer.txt` gets exactly
 * that and nothing else. When stdout and stderr are the same terminal the
 * answer already streamed past as it was produced, so printing it a second time
 * is noise rather than output.
 */
/**
 * EPIPE guard: when stdout/stderr is piped, the reader may close early (e.g.
 * `simpledsh ... | head`), turning the final write into an EPIPE that Node
 * would otherwise surface as an unhandled 'error' event crash. Exit cleanly
 * instead; any other stream error is still a real failure.
 */
function ignorePipeClosure(stream: NodeJS.WriteStream): void {
  stream.on("error", (err) => {
    if (err !== null && err !== undefined && err.code === "EPIPE")
      process.exit(0);
    throw err;
  });
}
ignorePipeClosure(process.stdout);
ignorePipeClosure(process.stderr);

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
    `simpledsh: writer_lease_quarantined=${quarantined.inspectionFingerprint}\n`,
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
function parseBudgetOptions(
  arguments_: readonly string[],
): RunBudgetLimits {
  let limits = DEFAULT_RUN_BUDGET;
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    const raw = arguments_[index + 1];
    if (flag === "--max-tool-rounds") {
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value <= 0) throw new CliInputError();
      limits = { ...limits, maxToolRounds: value };
      index += 1;
    } else if (flag === "--max-cost-usd") {
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
 * `dsh` starts a fresh one. `simpledsh continue` reuses a Session whose last Run
 * completed; anything else is left to `simpledsh recover`, which is the only path
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
      process.stderr.write("simpledsh: no such session in this workspace\n");
      throw new CliInputError();
    }
    if (summary.state !== "completed") {
      process.stderr.write(
        `simpledsh: session is ${summary.state}; run simpledsh recover ${summary.sessionId} first\n`,
      );
      throw new CliInputError();
    }
    return Object.freeze({ sessionId: summary.sessionId, started: true });
  }
  const recent = await mostRecentContinuableSession(workspaceRoot);
  if (recent === null) {
    process.stderr.write("simpledsh: no continuable session in this workspace\n");
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
          "simpledsh: login needs a terminal; set DEEPSEEK_API_KEY in the environment instead\n",
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
          "simpledsh: interactive mode needs a terminal; use simpledsh run <prompt> instead\n",
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
      ).run();
      return;
    }
    if (command.kind === "run") {
      const sessionId = newSessionId();
      process.stderr.write(`simpledsh: session_id=${sessionId}\n`);
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
          `simpledsh: resuming from the last safe boundary (${String(attempt)}/${String(max)})\n`,
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
            `simpledsh: the reply hit the output limit; continuing (${String(attempt)}/${String(max)})\n`,
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
          `simpledsh: verification failed; continuing (${String(attempt)}/${String(MAX_VERIFICATION_RETRIES)})\n`,
        );
        result = await withTruncationContinuation(
          await continueTurn(verificationContinuation(failure)),
          continueTurn,
        );
      }
      if (declared !== undefined) {
        process.stderr.write(`simpledsh: verification=${result.verification}\n`);
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
