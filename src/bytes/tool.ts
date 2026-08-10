import {
  concatBytes,
  utf8Bytes,
} from "./ops.js";
import type { FrozenBytes } from "./types.js";
import { asToolCallId } from "./tool-call-id.js";
import { assertUnicodeScalarString } from "./ops.js";

export interface ToolMessageMaterialization {
  readonly toolCallId: string;
  readonly content: string;
}

export function materializeToolMessage(
  value: ToolMessageMaterialization,
): FrozenBytes {
  const toolCallId = asToolCallId(value.toolCallId);
  assertUnicodeScalarString(value.content, "tool content");
  return concatBytes([
    utf8Bytes('{"role":"tool","tool_call_id":'),
    utf8Bytes(JSON.stringify(toolCallId)),
    utf8Bytes(',"content":'),
    utf8Bytes(JSON.stringify(value.content)),
    utf8Bytes("}"),
  ]);
}
