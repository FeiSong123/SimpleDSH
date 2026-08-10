import { assertUnicodeScalarString } from "./ops.js";

declare const toolCallIdBrand: unique symbol;

export type ToolCallId = string & {
  readonly [toolCallIdBrand]: "ToolCallId";
};

export const MAX_TOOL_CALL_ID_UTF8_BYTES = 4_096;
export const toolCallIdByteLimit = MAX_TOOL_CALL_ID_UTF8_BYTES;

const encoder = new TextEncoder();

export function asToolCallId(value: unknown): ToolCallId {
  if (typeof value !== "string") {
    throw new TypeError("tool call id must be a string");
  }
  assertUnicodeScalarString(value, "tool call id");
  const byteLength = encoder.encode(value).byteLength;
  if (byteLength < 1 || byteLength > MAX_TOOL_CALL_ID_UTF8_BYTES) {
    throw new TypeError("tool call id must contain 1..4096 UTF-8 bytes");
  }
  return value as ToolCallId;
}

export function assertToolCallId(
  value: unknown,
  label = "tool call id",
): asserts value is ToolCallId {
  try {
    asToolCallId(value);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new TypeError(`${label}: ${error.message}`);
    }
    throw error;
  }
}

export function isToolCallId(value: unknown): value is ToolCallId {
  try {
    asToolCallId(value);
    return true;
  } catch {
    return false;
  }
}
