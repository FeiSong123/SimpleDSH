import { assertUnicodeScalarString } from "./ops.js";
import {
  activeEditProfile,
  type ToolSchemaProfile,
} from "./schemas.js";
import { asToolCallId } from "./tool-call-id.js";
import type { ToolCallId } from "./tool-call-id.js";

export const toolNames = Object.freeze([
  "bash",
  "edit",
  "read",
  "web_search",
  "write",
] as const);
export type ToolName = (typeof toolNames)[number];

export interface ReadArguments {
  readonly path: string;
  readonly offset: number;
  readonly limit: number;
}

export interface WriteArguments {
  readonly path: string;
  readonly content: string;
}

export interface EditArguments {
  readonly path: string;
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll: boolean;
}

export interface BashArguments {
  readonly command: string;
  readonly timeoutSeconds: number;
}

export interface WebSearchArguments {
  readonly searchQuery: string;
  readonly searchLocale: string;
}

export type ValidatedToolArguments =
  | Readonly<{ readonly name: "read"; readonly value: Readonly<ReadArguments> }>
  | Readonly<{ readonly name: "write"; readonly value: Readonly<WriteArguments> }>
  | Readonly<{ readonly name: "edit"; readonly value: Readonly<EditArguments> }>
  | Readonly<{ readonly name: "bash"; readonly value: Readonly<BashArguments> }>
  | Readonly<{
      readonly name: "web_search";
      readonly value: Readonly<WebSearchArguments>;
    }>;

export type StaticToolValidationCode =
  | "unknown_tool"
  | "invalid_json"
  | "invalid_arguments"
  | "missing_required_field"
  | "unknown_field"
  | "wrong_type";

export type ToolCallValidation =
  | Readonly<{
      readonly ok: true;
      readonly toolCallId: ToolCallId;
      readonly arguments: ValidatedToolArguments;
    }>
  | Readonly<{
      readonly ok: false;
      readonly toolCallId: ToolCallId;
      readonly code: StaticToolValidationCode;
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function hasRequiredAndOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function scalar(value: unknown, allowEmpty: boolean): value is string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) return false;
  try {
    assertUnicodeScalarString(value, "tool argument");
  } catch {
    return false;
  }
  return !value.includes("\0");
}

function knownToolName(value: string): value is ToolName {
  return (toolNames as readonly string[]).includes(value);
}

/**
 * web_search exists only in the active search-v1 tools ABI. Sessions whose
 * Lineage froze the previous or legacy tools blob never declared the tool, so
 * a call under those profiles is the same as an unknown tool.
 */
function webSearchAdmittedForProfile(profile: ToolSchemaProfile): boolean {
  return profile === "search-v1";
}

export function validateToolArgumentsForProfile(
  name: string,
  argumentsText: string,
  profile: ToolSchemaProfile,
):
  | Readonly<{ readonly ok: true; readonly arguments: ValidatedToolArguments }>
  | Readonly<{ readonly ok: false; readonly code: StaticToolValidationCode }> {
  if (!knownToolName(name)) {
    return Object.freeze({ ok: false, code: "unknown_tool" });
  }
  if (name === "web_search" && !webSearchAdmittedForProfile(profile)) {
    return Object.freeze({ ok: false, code: "unknown_tool" });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    return Object.freeze({ ok: false, code: "invalid_json" });
  }
  if (!isRecord(parsed)) {
    return Object.freeze({
      ok: false,
      code: name === "edit" && activeEditProfile(profile)
        ? "wrong_type"
        : "invalid_arguments",
    });
  }

  if (name === "read") {
    if (
      !hasRequiredAndOptionalKeys(parsed, ["path"], ["offset", "limit"]) ||
      !scalar(parsed["path"], false) ||
      (parsed["offset"] !== undefined &&
        (!Number.isSafeInteger(parsed["offset"]) || (parsed["offset"] as number) < 0)) ||
      (parsed["limit"] !== undefined &&
        (!Number.isSafeInteger(parsed["limit"]) ||
          (parsed["limit"] as number) < 1 ||
          (parsed["limit"] as number) > 2_000))
    ) {
      return Object.freeze({ ok: false, code: "invalid_arguments" });
    }
    return Object.freeze({
      ok: true,
      arguments: Object.freeze({
        name,
        value: Object.freeze({
          path: parsed["path"],
          offset: (parsed["offset"] as number | undefined) ?? 0,
          limit: (parsed["limit"] as number | undefined) ?? 200,
        }),
      }),
    });
  }

  if (name === "write") {
    if (
      !hasExactKeys(parsed, ["path", "content"]) ||
      !scalar(parsed["path"], false) ||
      !scalar(parsed["content"], true)
    ) {
      return Object.freeze({ ok: false, code: "invalid_arguments" });
    }
    return Object.freeze({
      ok: true,
      arguments: Object.freeze({
        name,
        value: Object.freeze({ path: parsed["path"], content: parsed["content"] }),
      }),
    });
  }

  if (name === "edit") {
    if (activeEditProfile(profile)) {
      const required = ["path", "old_string", "new_string"] as const;
      const allowed = [...required, "replace_all"] as const;
      const keys = Object.keys(parsed);
      if (keys.some((key) => !(allowed as readonly string[]).includes(key))) {
        return Object.freeze({ ok: false, code: "unknown_field" });
      }
      if (
        required.some(
          (key) => !Object.prototype.hasOwnProperty.call(parsed, key),
        )
      ) {
        return Object.freeze({ ok: false, code: "missing_required_field" });
      }
      if (
        !scalar(parsed["path"], false) ||
        !scalar(parsed["old_string"], false) ||
        !scalar(parsed["new_string"], true) ||
        (Object.prototype.hasOwnProperty.call(parsed, "replace_all") &&
          typeof parsed["replace_all"] !== "boolean")
      ) {
        return Object.freeze({ ok: false, code: "wrong_type" });
      }
      return Object.freeze({
        ok: true,
        arguments: Object.freeze({
          name,
          value: Object.freeze({
            path: parsed["path"],
            oldString: parsed["old_string"],
            newString: parsed["new_string"],
            replaceAll: (parsed["replace_all"] as boolean | undefined) ?? false,
          }),
        }),
      });
    }
    if (
      !hasExactKeys(parsed, ["path", "old_string", "new_string", "replace_all"]) ||
      !scalar(parsed["path"], false) ||
      !scalar(parsed["old_string"], false) ||
      !scalar(parsed["new_string"], true) ||
      typeof parsed["replace_all"] !== "boolean"
    ) {
      return Object.freeze({ ok: false, code: "invalid_arguments" });
    }
    return Object.freeze({
      ok: true,
      arguments: Object.freeze({
        name,
        value: Object.freeze({
          path: parsed["path"],
          oldString: parsed["old_string"],
          newString: parsed["new_string"],
          replaceAll: parsed["replace_all"],
        }),
      }),
    });
  }

  if (name === "web_search") {
    if (
      !hasRequiredAndOptionalKeys(parsed, ["search_query"], ["search_locale"]) ||
      !scalar(parsed["search_query"], false) ||
      (parsed["search_locale"] !== undefined &&
        !scalar(parsed["search_locale"], false))
    ) {
      return Object.freeze({ ok: false, code: "invalid_arguments" });
    }
    return Object.freeze({
      ok: true,
      arguments: Object.freeze({
        name,
        value: Object.freeze({
          searchQuery: parsed["search_query"],
          searchLocale: (parsed["search_locale"] as string | undefined) ?? "",
        }),
      }),
    });
  }

  if (
    !hasRequiredAndOptionalKeys(parsed, ["command"], ["timeout"]) ||
    !scalar(parsed["command"], false) ||
    (parsed["timeout"] !== undefined &&
      (typeof parsed["timeout"] !== "number" ||
        !Number.isFinite(parsed["timeout"]) ||
        parsed["timeout"] <= 0 ||
        parsed["timeout"] > 600))
  ) {
    return Object.freeze({ ok: false, code: "invalid_arguments" });
  }
  return Object.freeze({
    ok: true,
    arguments: Object.freeze({
      name,
      value: Object.freeze({
        command: parsed["command"],
        timeoutSeconds: (parsed["timeout"] as number | undefined) ?? 120,
      }),
    }),
  });
}

export function validateToolArguments(
  name: string,
  argumentsText: string,
):
  | Readonly<{ readonly ok: true; readonly arguments: ValidatedToolArguments }>
  | Readonly<{ readonly ok: false; readonly code: StaticToolValidationCode }> {
  return validateToolArgumentsForProfile(name, argumentsText, "edit-v5");
}

export function validateToolCallForProfile(
  value: {
    readonly id: string;
    readonly function: {
      readonly name: string;
      readonly arguments: string;
    };
  },
  profile: ToolSchemaProfile,
): ToolCallValidation {
  const toolCallId = asToolCallId(value.id);
  const result = validateToolArgumentsForProfile(
    value.function.name,
    value.function.arguments,
    profile,
  );
  return result.ok
    ? Object.freeze({ ok: true, toolCallId, arguments: result.arguments })
    : Object.freeze({ ok: false, toolCallId, code: result.code });
}

export function validateToolCall(value: {
  readonly id: string;
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}): ToolCallValidation {
  return validateToolCallForProfile(value, "edit-v5");
}
