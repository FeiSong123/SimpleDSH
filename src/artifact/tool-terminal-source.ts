import {
  normalizeToolTerminal,
  type ToolTerminal,
} from "./terminal.js";

export type ToolTerminalSource = "artifact" | "effect";
export type TerminalToolName = "read" | "write" | "edit" | "bash" | "web_search";

const terminalToolNames = new Set<string>([
  "read",
  "write",
  "edit",
  "bash",
  "web_search",
]);

function terminalSourceError(message: string): never {
  throw new TypeError(`invalid tool terminal source: ${message}`);
}

export function validateToolTerminalForSource(
  toolName: TerminalToolName,
  source: ToolTerminalSource,
  value: ToolTerminal,
  hardLimitReached: boolean,
): ToolTerminal {
  if (!terminalToolNames.has(toolName)) {
    return terminalSourceError("tool name is invalid");
  }
  if (source !== "artifact" && source !== "effect") {
    return terminalSourceError("source is invalid");
  }
  if (typeof hardLimitReached !== "boolean") {
    return terminalSourceError("hard-limit marker is invalid");
  }
  let terminal: ToolTerminal;
  try {
    terminal = normalizeToolTerminal(value);
  } catch {
    return terminalSourceError("terminal is invalid");
  }
  const allowed = source === "artifact"
    ? toolName === "read"
      ? new Set(["ok", "invalid_arguments", "io_error"])
      : toolName === "web_search"
        ? new Set(["ok", "io_error"])
        : toolName === "write"
          ? new Set(["invalid_arguments", "io_error"])
          : toolName === "edit"
            ? new Set([
                "invalid_arguments",
                "io_error",
                "edit_no_match",
                "edit_not_unique",
              ])
            : new Set(["bash_supervisor_unavailable"])
    : toolName === "write" || toolName === "edit"
      ? new Set(["ok", "io_error", "target_changed"])
      : toolName === "web_search"
        ? new Set(["ok", "io_error"])
        : toolName === "bash"
          ? new Set([
              "ok",
              "io_error",
              "nonzero_exit",
              "signaled",
              "timeout",
              "cancelled",
              "output_limit",
            ])
          : new Set<string>();
  if (!allowed.has(terminal.code)) {
    return terminalSourceError("code is invalid for the tool and source");
  }
  if (toolName === "bash") {
    if (
      source === "effect" &&
      (terminal.code === "output_limit") !== hardLimitReached
    ) {
      return terminalSourceError("bash code differs from the hard-limit marker");
    }
    if (source === "artifact" && hardLimitReached) {
      return terminalSourceError("pre-effect bash reached the raw output limit");
    }
    if (terminal.code === "ok" && terminal.exitCode !== 0) {
      return terminalSourceError("successful bash lacks exit code zero");
    }
    if (
      (source === "artifact" && terminal.descendantsReaped !== null) ||
      (source === "effect" && typeof terminal.descendantsReaped !== "boolean")
    ) {
      return terminalSourceError("bash cleanup observation is invalid");
    }
  } else {
    if (
      terminal.exitCode !== null ||
      terminal.signal !== null ||
      terminal.descendantsReaped !== null
    ) {
      return terminalSourceError(
        "file terminal carries exit, signal, or cleanup state",
      );
    }
    if (toolName === "read") {
      if (hardLimitReached && terminal.code !== "ok") {
        return terminalSourceError("read hard limit is not succeeded/ok");
      }
    } else if (toolName === "web_search") {
      if (hardLimitReached && terminal.code !== "ok") {
        return terminalSourceError("web search hard limit is not succeeded/ok");
      }
    } else if (hardLimitReached) {
      return terminalSourceError("write/edit reached the raw output limit");
    }
  }
  return terminal;
}
