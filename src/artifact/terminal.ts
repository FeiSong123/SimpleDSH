export const toolSignals = Object.freeze([
  "SIGABRT",
  "SIGALRM",
  "SIGBREAK",
  "SIGBUS",
  "SIGCHLD",
  "SIGCONT",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINFO",
  "SIGINT",
  "SIGIO",
  "SIGIOT",
  "SIGKILL",
  "SIGLOST",
  "SIGPIPE",
  "SIGPOLL",
  "SIGPROF",
  "SIGPWR",
  "SIGQUIT",
  "SIGSEGV",
  "SIGSTKFLT",
  "SIGSTOP",
  "SIGSYS",
  "SIGTERM",
  "SIGTRAP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGUNUSED",
  "SIGURG",
  "SIGUSR1",
  "SIGUSR2",
  "SIGVTALRM",
  "SIGWINCH",
  "SIGXCPU",
  "SIGXFSZ",
] as const);

export type ToolSignal = (typeof toolSignals)[number];

export type ToolTerminalStatus =
  | "succeeded"
  | "failed"
  | "invalid"
  | "denied"
  | "unavailable";

export type ToolTerminalCode =
  | "ok"
  | "unknown_tool"
  | "invalid_json"
  | "invalid_arguments"
  | "permission_denied"
  | "io_error"
  | "edit_no_match"
  | "edit_not_unique"
  | "target_changed"
  | "nonzero_exit"
  | "signaled"
  | "timeout"
  | "cancelled"
  | "output_limit"
  | "bash_supervisor_unavailable"
  | "credential_shield_unavailable";

export interface ToolTerminal {
  readonly status: ToolTerminalStatus;
  readonly code: ToolTerminalCode;
  readonly exitCode: number | null;
  readonly signal: ToolSignal | null;
  readonly descendantsReaped: boolean | null;
}

export type EffectTerminal = ToolTerminal & {
  readonly status: "succeeded" | "failed";
};

const signalSet = new Set<string>(toolSignals);

const codesByStatus: Readonly<Record<ToolTerminalStatus, ReadonlySet<string>>> =
  Object.freeze({
    succeeded: new Set(["ok"]),
    failed: new Set([
      "io_error",
      "edit_no_match",
      "edit_not_unique",
      "target_changed",
      "nonzero_exit",
      "signaled",
      "timeout",
      "cancelled",
      "output_limit",
    ]),
    invalid: new Set(["unknown_tool", "invalid_json", "invalid_arguments"]),
    denied: new Set(["permission_denied"]),
    unavailable: new Set([
      "bash_supervisor_unavailable",
      "credential_shield_unavailable",
    ]),
  });

function terminalError(message: string): TypeError {
  return new TypeError(`invalid tool terminal: ${message}`);
}

function assertClosedTerminal(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw terminalError("expected a closed record");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw terminalError("expected a plain record");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== 5 ||
    ownKeys.some((key) => typeof key !== "string") ||
    !["status", "code", "exitCode", "signal", "descendantsReaped"].every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    )
  ) {
    throw terminalError("fields are not closed");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of ownKeys as string[]) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      throw terminalError("fields must be enumerable data properties");
    }
  }
}

function parseExitCode(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) {
    throw terminalError("exitCode must be null or a safe integer");
  }
  return value as number;
}

function parseSignal(value: unknown): ToolSignal | null {
  if (value === null) return null;
  if (typeof value !== "string" || !signalSet.has(value)) {
    throw terminalError("signal is not in the frozen enum");
  }
  return value as ToolSignal;
}

function assertExitPair(
  code: ToolTerminalCode,
  exitCode: number | null,
  signal: ToolSignal | null,
): void {
  const neither = exitCode === null && signal === null;
  const exactlyOne = (exitCode === null) !== (signal === null);
  switch (code) {
    case "ok":
      if (signal !== null || (exitCode !== null && exitCode !== 0)) {
        throw terminalError("ok requires null/null or 0/null");
      }
      return;
    case "nonzero_exit":
      if (exitCode === null || exitCode < 1 || exitCode > 255 || signal !== null) {
        throw terminalError("nonzero_exit requires exitCode 1..255 and null signal");
      }
      return;
    case "signaled":
      if (exitCode !== null || signal === null) {
        throw terminalError("signaled requires null exitCode and a signal");
      }
      return;
    case "timeout":
    case "cancelled":
      if (!exactlyOne) {
        throw terminalError(`${code} requires exactly one exitCode or signal`);
      }
      return;
    case "output_limit":
      if (!exactlyOne) {
        throw terminalError("output_limit requires exactly one exitCode or signal");
      }
      return;
    default:
      if (!neither) {
        throw terminalError(`${code} requires null exitCode and signal`);
      }
  }
}

export function normalizeToolTerminal(
  value: unknown,
  allowedStatuses?: ReadonlySet<ToolTerminalStatus>,
): ToolTerminal {
  assertClosedTerminal(value);
  const status = value["status"];
  const code = value["code"];
  if (
    typeof status !== "string" ||
    !Object.prototype.hasOwnProperty.call(codesByStatus, status)
  ) {
    throw terminalError("status is not recognized");
  }
  const typedStatus = status as ToolTerminalStatus;
  if (allowedStatuses !== undefined && !allowedStatuses.has(typedStatus)) {
    throw terminalError("status is not allowed at this source");
  }
  if (typeof code !== "string" || !codesByStatus[typedStatus].has(code)) {
    throw terminalError("status/code pair is not recognized");
  }
  const typedCode = code as ToolTerminalCode;
  const exitCode = parseExitCode(value["exitCode"]);
  const signal = parseSignal(value["signal"]);
  const descendantsReaped = value["descendantsReaped"];
  if (descendantsReaped !== null && typeof descendantsReaped !== "boolean") {
    throw terminalError("descendantsReaped must be null or boolean");
  }
  assertExitPair(typedCode, exitCode, signal);
  return Object.freeze({
    status: typedStatus,
    code: typedCode,
    exitCode,
    signal,
    descendantsReaped,
  });
}

const effectTerminalStatuses = new Set<ToolTerminalStatus>([
  "succeeded",
  "failed",
]);

export function normalizeEffectTerminal(value: unknown): EffectTerminal {
  return normalizeToolTerminal(value, effectTerminalStatuses) as EffectTerminal;
}
