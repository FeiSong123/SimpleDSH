import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

import { RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES } from "../artifact/tool-output.js";
import { toolSignals, type ToolSignal } from "../artifact/terminal.js";
import { freezeBytes, type FrozenBytes } from "../bytes/types.js";

export interface BashChildEnvironment {
  readonly HOME: string;
  readonly HOSTNAME: string;
  readonly LANG: string;
  readonly LC_ALL: string;
  readonly LOGNAME: string;
  readonly PATH: string;
  readonly USER: string;
}

export interface RunNativeBashOptions {
  readonly command: string;
  readonly cwd: string;
  readonly childEnvironment: BashChildEnvironment;
  readonly timeoutSeconds: number;
  readonly signal: AbortSignal;
}

export type BashRunReason =
  | "natural"
  | "timeout"
  | "cancelled"
  | "output_limit"
  | "io_error";

export interface BashRunResult {
  readonly reason: BashRunReason;
  readonly exitCode: number | null;
  readonly signal: ToolSignal | null;
  readonly descendantsReaped: boolean;
  readonly output: readonly BashOutputRecord[];
}

export interface BashOutputRecord {
  readonly stream: "stdout" | "stderr";
  readonly bytes: FrozenBytes;
}

export class BashProcessStateUnknownError extends Error {
  readonly descendantsReaped: boolean;
  readonly output: readonly BashOutputRecord[];

  constructor(
    descendantsReaped: boolean,
    output: readonly BashOutputRecord[] = Object.freeze([]),
  ) {
    super("the Bash launch did not yield a known direct-child terminal");
    this.name = "BashProcessStateUnknownError";
    this.descendantsReaped = descendantsReaped;
    this.output = output;
  }
}

type OutputStreamName = "stdout" | "stderr";

interface DirectChildTerminal {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface SpawnSucceeded {
  readonly kind: "spawned";
}

interface SpawnFailed {
  readonly kind: "failed";
}

type SpawnOutcome = SpawnSucceeded | SpawnFailed;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

interface TrackedEof {
  readonly promise: Promise<void>;
  readonly ended: () => boolean;
}

const TERM_GRACE_MILLISECONDS = 250;
const DIRECT_CHILD_WAIT_MILLISECONDS = 1_000;
const CLEANUP_OBSERVATION_MILLISECONDS = 2_000;
const GROUP_PROBE_INTERVAL_MILLISECONDS = 25;
const OUTPUT_COALESCE_BYTES = 64 * 1024;
const knownSignals = new Set<string>(toolSignals);

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({
    promise,
    resolve: (value: T): void => resolvePromise?.(value),
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

async function boundedValue<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T | undefined> {
  const timeout = Symbol("timeout");
  let timer: NodeJS.Timeout | undefined;
  const value = await Promise.race([
    promise,
    new Promise<typeof timeout>((resolvePromise) => {
      timer = setTimeout(() => resolvePromise(timeout), milliseconds);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return value === timeout ? undefined : value;
}

function assertScalarCommand(command: string): void {
  if (
    typeof command !== "string" ||
    command.length === 0 ||
    command.includes("\0") ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(command)
  ) {
    throw new TypeError("command must be non-empty Unicode scalar text without NUL");
  }
}

function assertOptions(options: RunNativeBashOptions): void {
  assertScalarCommand(options.command);
  if (
    !Number.isFinite(options.timeoutSeconds) ||
    options.timeoutSeconds <= 0 ||
    options.timeoutSeconds > 600
  ) {
    throw new TypeError("timeoutSeconds must be finite and in (0, 600]");
  }
  if (!(options.signal instanceof AbortSignal)) {
    throw new TypeError("signal must be an AbortSignal");
  }
}

function childEnvironment(
  environment: BashChildEnvironment,
): Readonly<NodeJS.ProcessEnv> {
  const closedEnvironment = Object.assign(Object.create(null) as NodeJS.ProcessEnv, {
    HOME: environment.HOME,
    HOSTNAME: environment.HOSTNAME,
    LANG: environment.LANG,
    LC_ALL: environment.LC_ALL,
    LOGNAME: environment.LOGNAME,
    PATH: environment.PATH,
    PYTHONDONTWRITEBYTECODE: "1",
    USER: environment.USER,
  });
  for (const value of Object.values(closedEnvironment)) {
    if (typeof value !== "string" || value.includes("\0")) {
      throw new TypeError("Bash child environment values must be strings without NUL");
    }
  }
  return Object.freeze(closedEnvironment);
}

function frozenRunResult(
  reason: BashRunReason,
  exitCode: number | null,
  signal: ToolSignal | null,
  descendantsReaped: boolean,
  output: readonly BashOutputRecord[],
): BashRunResult {
  return Object.freeze({ reason, exitCode, signal, descendantsReaped, output });
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function groupAbsent(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return false;
  } catch (error) {
    return errnoCode(error) === "ESRCH";
  }
}

function signalGroup(
  processGroupId: number,
  signal: "SIGTERM" | "SIGKILL",
): "sent" | "absent" | "failed" {
  try {
    process.kill(-processGroupId, signal);
    return "sent";
  } catch (error) {
    return errnoCode(error) === "ESRCH" ? "absent" : "failed";
  }
}

async function stopOriginalGroup(processGroupId: number | null): Promise<void> {
  if (processGroupId === null || groupAbsent(processGroupId)) return;
  if (signalGroup(processGroupId, "SIGTERM") === "absent") return;
  await delay(TERM_GRACE_MILLISECONDS);
  if (!groupAbsent(processGroupId)) {
    signalGroup(processGroupId, "SIGKILL");
  }
}

async function observeGroupAbsent(
  processGroupId: number | null,
): Promise<boolean> {
  if (processGroupId === null) return false;
  const probeCount = Math.ceil(
    CLEANUP_OBSERVATION_MILLISECONDS / GROUP_PROBE_INTERVAL_MILLISECONDS,
  );
  for (let probe = 0; probe <= probeCount; probe += 1) {
    if (groupAbsent(processGroupId)) return true;
    if (probe < probeCount) {
      await delay(GROUP_PROBE_INTERVAL_MILLISECONDS);
    }
  }
  return false;
}

function trackEof(stream: Readable | null): TrackedEof {
  let observed = stream?.readableEnded === true;
  const eof = deferred<void>();
  if (observed) eof.resolve(undefined);
  stream?.once("end", () => {
    observed = true;
    eof.resolve(undefined);
  });
  return Object.freeze({
    promise: eof.promise,
    ended: (): boolean => observed,
  });
}

class BashOutputCapture {
  readonly #requestStop: (reason: BashRunReason) => void;
  readonly #records: BashOutputRecord[] = [];
  readonly #pending = new Uint8Array(OUTPUT_COALESCE_BYTES);
  #pendingStream: OutputStreamName | undefined;
  #pendingBytes = 0;
  #payloadBytes = 0;
  #limited = false;
  #finished = false;

  constructor(requestStop: (reason: BashRunReason) => void) {
    this.#requestStop = requestStop;
  }

  #flush(): void {
    if (this.#pendingStream === undefined || this.#pendingBytes === 0) return;
    this.#records.push(Object.freeze({
      stream: this.#pendingStream,
      bytes: freezeBytes(this.#pending.subarray(0, this.#pendingBytes)),
    }));
    this.#pendingStream = undefined;
    this.#pendingBytes = 0;
  }

  accept(stream: OutputStreamName, chunk: Buffer): void {
    if (this.#finished || this.#limited || chunk.byteLength === 0) return;
    if (this.#pendingStream !== undefined && this.#pendingStream !== stream) {
      this.#flush();
    }
    let offset = 0;
    while (offset < chunk.byteLength && !this.#limited) {
      // A full coalesced record clears its owner. Rebind on every iteration so
      // the remainder of one large data callback cannot be dropped or later
      // attributed to the other pipe.
      this.#pendingStream = stream;
      const remaining = RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES - this.#payloadBytes;
      if (remaining === 0) {
        this.#flush();
        this.#limited = true;
        this.#requestStop("output_limit");
        break;
      }
      const take = Math.min(
        chunk.byteLength - offset,
        OUTPUT_COALESCE_BYTES - this.#pendingBytes,
        remaining,
      );
      this.#pending.set(chunk.subarray(offset, offset + take), this.#pendingBytes);
      this.#pendingBytes += take;
      this.#payloadBytes += take;
      offset += take;
      if (this.#pendingBytes === OUTPUT_COALESCE_BYTES) this.#flush();
      if (this.#payloadBytes === RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES) {
        this.#flush();
        this.#limited = true;
        this.#requestStop("output_limit");
      }
    }
  }

  finish(): readonly BashOutputRecord[] {
    if (this.#finished) throw new TypeError("Bash output capture is finished");
    this.#finished = true;
    this.#flush();
    return Object.freeze([...this.#records]);
  }
}

function normalizeDirectTerminal(
  terminal: DirectChildTerminal,
  descendantsReaped: boolean,
): Readonly<{ exitCode: number | null; signal: ToolSignal | null }> {
  const hasExitCode = terminal.exitCode !== null;
  const hasSignal = terminal.signal !== null;
  if (hasExitCode === hasSignal) {
    throw new BashProcessStateUnknownError(descendantsReaped);
  }
  if (hasExitCode) {
    if (
      !Number.isSafeInteger(terminal.exitCode) ||
      (terminal.exitCode as number) < 0 ||
      (terminal.exitCode as number) > 255
    ) {
      throw new BashProcessStateUnknownError(descendantsReaped);
    }
    return Object.freeze({ exitCode: terminal.exitCode, signal: null });
  }
  if (!knownSignals.has(terminal.signal as string)) {
    throw new BashProcessStateUnknownError(descendantsReaped);
  }
  return Object.freeze({
    exitCode: null,
    signal: terminal.signal as ToolSignal,
  });
}

function safeProcessGroupId(child: ChildProcess): number | null {
  return Number.isSafeInteger(child.pid) && (child.pid as number) > 0
    ? child.pid as number
    : null;
}

export async function runNativeBash(
  options: RunNativeBashOptions,
): Promise<BashRunResult> {
  assertOptions(options);
  const environment = childEnvironment(options.childEnvironment);

  let child: ChildProcess;
  try {
    child = spawn(
      "/bin/bash",
      ["--noprofile", "--norc", "-lc", options.command],
      {
        cwd: options.cwd,
        detached: true,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    return frozenRunResult("io_error", null, null, true, Object.freeze([]));
  }

  const spawnOutcome = deferred<SpawnOutcome>();
  const directTerminal = deferred<DirectChildTerminal>();
  const stopRequested = deferred<void>();
  let spawned = false;
  let directTerminalObserved = false;
  let directTerminalValue: DirectChildTerminal | undefined;
  let reason: BashRunReason | null = null;
  let timeout: NodeJS.Timeout | undefined;

  const stopExternalTriggers = (): void => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
    options.signal.removeEventListener("abort", abort);
  };
  const requestStop = (nextReason: BashRunReason): void => {
    if (nextReason === "output_limit") {
      reason = "output_limit";
      stopRequested.resolve(undefined);
      return;
    }
    if (
      reason !== null ||
      (directTerminalObserved && nextReason !== "io_error")
    ) {
      return;
    }
    reason = nextReason;
    stopRequested.resolve(undefined);
  };
  const abort = (): void => requestStop("cancelled");
  const outputCapture = new BashOutputCapture(requestStop);
  const stdoutData = (chunk: Buffer): void =>
    outputCapture.accept("stdout", chunk);
  const stderrData = (chunk: Buffer): void =>
    outputCapture.accept("stderr", chunk);
  const streamError = (): void => requestStop("io_error");
  const streams = [child.stdout, child.stderr].filter(
    (stream): stream is Readable => stream !== null,
  );
  child.stdout?.on("data", stdoutData);
  child.stderr?.on("data", stderrData);
  for (const stream of streams) stream.on("error", streamError);
  const finishOutput = (): readonly BashOutputRecord[] => {
    child.stdout?.off("data", stdoutData);
    child.stderr?.off("data", stderrData);
    for (const stream of streams) {
      stream.off("error", streamError);
      stream.destroy();
    }
    return outputCapture.finish();
  };

  child.once("spawn", () => {
    spawned = true;
    spawnOutcome.resolve(Object.freeze({ kind: "spawned" }));
  });
  child.once("error", () => {
    if (!spawned) {
      spawnOutcome.resolve(Object.freeze({ kind: "failed" }));
    } else {
      requestStop("io_error");
    }
  });
  child.once("exit", (exitCode, signal) => {
    directTerminalObserved = true;
    directTerminalValue = Object.freeze({ exitCode, signal });
    stopExternalTriggers();
    directTerminal.resolve(directTerminalValue);
  });

  const stdoutEof = trackEof(child.stdout);
  const stderrEof = trackEof(child.stderr);
  const bothEof = Promise.all([stdoutEof.promise, stderrEof.promise]).then(
    () => true as const,
  );

  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  timeout = setTimeout(
    () => requestStop("timeout"),
    options.timeoutSeconds * 1_000,
  );
  if (directTerminalObserved) stopExternalTriggers();

  const outcome = await spawnOutcome.promise;
  if (outcome.kind === "failed") {
    stopExternalTriggers();
    const output = finishOutput();
    return frozenRunResult("io_error", null, null, true, output);
  }

  const processGroupId = safeProcessGroupId(child);
  const first = await Promise.race([
    directTerminal.promise.then((terminal) => Object.freeze({
      kind: "terminal" as const,
      terminal,
    })),
    stopRequested.promise.then(() => Object.freeze({ kind: "stop" as const })),
  ]);

  await stopOriginalGroup(processGroupId);
  let terminal = first.kind === "terminal"
    ? first.terminal
    : await boundedValue(
      directTerminal.promise,
      DIRECT_CHILD_WAIT_MILLISECONDS,
    );

  const [originalGroupAbsent, eofObserved] = await Promise.all([
    observeGroupAbsent(processGroupId),
    boundedValue(bothEof, CLEANUP_OBSERVATION_MILLISECONDS),
  ]);
  terminal ??= directTerminalValue;
  const output = finishOutput();
  stopExternalTriggers();

  const descendantsReaped =
    originalGroupAbsent &&
    eofObserved === true &&
    stdoutEof.ended() &&
    stderrEof.ended();
  if (terminal === undefined) {
    throw new BashProcessStateUnknownError(descendantsReaped, output);
  }
  let normalized: Readonly<{
    readonly exitCode: number | null;
    readonly signal: ToolSignal | null;
  }>;
  try {
    normalized = normalizeDirectTerminal(terminal, descendantsReaped);
  } catch (error) {
    if (error instanceof BashProcessStateUnknownError) {
      throw new BashProcessStateUnknownError(descendantsReaped, output);
    }
    throw error;
  }
  return frozenRunResult(
    reason ?? "natural",
    normalized.exitCode,
    normalized.signal,
    descendantsReaped,
    output,
  );
}
