import type { ToolCall } from "../ds/types.js";
import {
  assertUnicodeScalarString,
  concatBytes,
  joinBytes,
  utf8Bytes,
} from "./ops.js";
import { asToolCallId } from "./tool-call-id.js";
import type { FrozenBytes } from "./types.js";

export interface AssistantMaterialization {
  readonly content: string;
  readonly reasoningContent: string;
  readonly toolCalls: readonly ToolCall[];
}

function jsonString(value: string): FrozenBytes {
  return utf8Bytes(JSON.stringify(value));
}

function canonicalToolCall(call: ToolCall): FrozenBytes {
  const toolCallId = asToolCallId(call.id);
  assertUnicodeScalarString(call.function.name, "tool call name");
  assertUnicodeScalarString(call.function.arguments, "tool call arguments");
  if (call.function.name.length === 0) {
    throw new TypeError("tool call name must not be empty");
  }
  return concatBytes([
    utf8Bytes('{"id":'),
    jsonString(toolCallId),
    utf8Bytes(',"type":"function","function":{"name":'),
    jsonString(call.function.name),
    utf8Bytes(',"arguments":'),
    jsonString(call.function.arguments),
    utf8Bytes("}}"),
  ]);
}

export function materializeAssistant(
  value: AssistantMaterialization,
): FrozenBytes {
  assertUnicodeScalarString(value.content, "assistant content");
  assertUnicodeScalarString(value.reasoningContent, "assistant reasoning content");
  const head = [
    utf8Bytes('{"role":"assistant","content":'),
    jsonString(value.content),
    utf8Bytes(',"reasoning_content":'),
    jsonString(value.reasoningContent),
  ];
  // DeepSeek rejects an empty tool_calls array outright, so a turn without
  // tool calls omits the field. A single-turn session never sends the
  // assistant back and so never hit this; the second request of any
  // multi-turn session did, with a 400 that no retry could fix.
  if (value.toolCalls.length === 0) {
    return concatBytes([...head, utf8Bytes("}")]);
  }
  return concatBytes([
    ...head,
    utf8Bytes(',"tool_calls":['),
    joinBytes(value.toolCalls.map(canonicalToolCall), utf8Bytes(",")),
    utf8Bytes("]}"),
  ]);
}
