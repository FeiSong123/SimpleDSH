import type { AssistantView } from "../ds/types.js";
import { materializeAssistant } from "./assistant.js";
import { bytesEqual, utf8Bytes } from "./ops.js";
import { materializeToolMessage } from "./tool.js";
import { asToolCallId } from "./tool-call-id.js";
import type { ToolCallId } from "./tool-call-id.js";
import type { FrozenBytes } from "./types.js";
import { materializeUserMessage } from "./user.js";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key, index) => actual[index] === key)
  );
}

function isCanonicalString(value: unknown, allowEmpty = true): value is string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function utf8View(bytes: FrozenBytes): string {
  return utf8Decoder.decode(bytes.copy());
}

function requireCanonical(
  actual: FrozenBytes,
  expected: FrozenBytes,
  message: string,
): void {
  if (!bytesEqual(actual, expected)) throw new TypeError(message);
}

export interface SystemView {
  readonly role: "system";
  readonly content: string;
}

export function viewSystem(bytes: FrozenBytes): SystemView {
  const parsed: unknown = JSON.parse(utf8View(bytes));
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["role", "content"]) ||
    parsed["role"] !== "system" ||
    !isCanonicalString(parsed["content"])
  ) {
    throw new TypeError("invalid canonical system bytes");
  }
  requireCanonical(
    bytes,
    materializeRoleContent("system", parsed["content"]),
    "invalid canonical system bytes",
  );
  return Object.freeze({ role: "system", content: parsed["content"] });
}

function materializeRoleContent(
  role: "system",
  content: string,
): FrozenBytes {
  return utf8Bytes(
    `{"role":${JSON.stringify(role)},"content":${JSON.stringify(content)}}`,
  );
}

export interface UserView {
  readonly role: "user";
  readonly content: string;
}

export function viewUser(bytes: FrozenBytes): UserView {
  const parsed: unknown = JSON.parse(utf8View(bytes));
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["role", "content"]) ||
    parsed["role"] !== "user" ||
    !isCanonicalString(parsed["content"])
  ) {
    throw new TypeError("invalid canonical user bytes");
  }
  requireCanonical(
    bytes,
    materializeUserMessage(parsed["content"]),
    "invalid canonical user bytes",
  );
  return Object.freeze({ role: "user", content: parsed["content"] });
}

export interface ToolView {
  readonly role: "tool";
  readonly toolCallId: ToolCallId;
  readonly content: string;
}

export function viewTool(bytes: FrozenBytes): ToolView {
  const parsed: unknown = JSON.parse(utf8View(bytes));
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["role", "tool_call_id", "content"]) ||
    parsed["role"] !== "tool" ||
    !isCanonicalString(parsed["tool_call_id"], false) ||
    !isCanonicalString(parsed["content"])
  ) {
    throw new TypeError("invalid canonical tool bytes");
  }
  const view: ToolView = Object.freeze({
    role: "tool",
    toolCallId: asToolCallId(parsed["tool_call_id"]),
    content: parsed["content"],
  });
  requireCanonical(
    bytes,
    materializeToolMessage(view),
    "invalid canonical tool bytes",
  );
  return view;
}

export function viewAssistant(bytes: FrozenBytes): AssistantView {
  const parsed: unknown = JSON.parse(utf8View(bytes));
  // Two canonical shapes: with tool_calls when the turn made calls, without the
  // key at all when it did not. The provider rejects an empty array, so the
  // field is absent rather than empty.
  const hasCalls = isRecord(parsed) && "tool_calls" in parsed;
  if (
    !isRecord(parsed) ||
    !hasExactKeys(
      parsed,
      hasCalls
        ? ["role", "content", "reasoning_content", "tool_calls"]
        : ["role", "content", "reasoning_content"],
    ) ||
    parsed["role"] !== "assistant" ||
    !isCanonicalString(parsed["content"]) ||
    !isCanonicalString(parsed["reasoning_content"]) ||
    (hasCalls &&
      (!Array.isArray(parsed["tool_calls"]) || parsed["tool_calls"].length === 0))
  ) {
    throw new TypeError("invalid canonical assistant bytes");
  }

  const rawCalls: readonly unknown[] = hasCalls
    ? (parsed["tool_calls"] as readonly unknown[])
    : [];
  const toolCalls = rawCalls.map((value): AssistantView["toolCalls"][number] => {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["id", "type", "function"]) ||
      !isCanonicalString(value["id"], false) ||
      value["type"] !== "function" ||
      !isRecord(value["function"]) ||
      !hasExactKeys(value["function"], ["name", "arguments"]) ||
      !isCanonicalString(value["function"]["name"], false) ||
      !isCanonicalString(value["function"]["arguments"])
    ) {
      throw new TypeError("invalid canonical assistant tool call bytes");
    }
    return {
      id: asToolCallId(value["id"]),
      type: "function",
      function: {
        name: value["function"]["name"],
        arguments: value["function"]["arguments"],
      },
    };
  });

  const view: AssistantView = {
    role: "assistant",
    content: parsed["content"],
    reasoningContent: parsed["reasoning_content"],
    toolCalls,
  };
  requireCanonical(
    bytes,
    materializeAssistant(view),
    "invalid canonical assistant bytes",
  );
  return Object.freeze({
    ...view,
    toolCalls: Object.freeze(
      toolCalls.map((call) =>
        Object.freeze({
          ...call,
          function: Object.freeze({ ...call.function }),
        }),
      ),
    ),
  });
}
