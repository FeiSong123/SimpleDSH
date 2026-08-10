import { bytesEqual, utf8Bytes } from "./ops.js";
import type { FrozenBytes } from "./types.js";

// This literal is provider-visible Cache ABI. Keep tool names sorted and never
// regenerate it from objects or a schema library.
const CANONICAL_TOOLS_JSON =
  '[{"type":"function","function":{"name":"bash","description":"Run one shell command in the workspace.","parameters":{"type":"object","properties":{"command":{"type":"string"},"timeout":{"type":"number","exclusiveMinimum":0}},"required":["command"],"additionalProperties":false}}},{"type":"function","function":{"name":"edit","description":"Replace old_string using exact UTF-8 byte matching, left-to-right and non-overlapping. Omit replace_all or set it to false to require exactly one match; set it to true to replace all matches. Zero matches fail with edit_no_match and matchCount 0; multiple matches with replace_all false fail with edit_not_unique and their matchCount.","parameters":{"type":"object","properties":{"path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"},"replace_all":{"type":"boolean"}},"required":["path","old_string","new_string"],"additionalProperties":false}}},{"type":"function","function":{"name":"read","description":"Read a bounded file slice with line numbers.","parameters":{"type":"object","properties":{"path":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1}},"required":["path"],"additionalProperties":false}}},{"type":"function","function":{"name":"write","description":"Write complete content to a file.","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"],"additionalProperties":false}}}]';

// Frozen load-only compatibility for v4 -> v1 Journals and Snapshots. Never
// reinterpret or regenerate these bytes after the active edit ABI changes.
const LEGACY_CANONICAL_TOOLS_JSON =
  '[{"type":"function","function":{"name":"bash","description":"Run one shell command in the workspace.","parameters":{"type":"object","properties":{"command":{"type":"string"},"timeout":{"type":"number","exclusiveMinimum":0}},"required":["command"],"additionalProperties":false}}},{"type":"function","function":{"name":"edit","description":"Replace exact text in a file.","parameters":{"type":"object","properties":{"path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"},"replace_all":{"type":"boolean"}},"required":["path","old_string","new_string","replace_all"],"additionalProperties":false}}},{"type":"function","function":{"name":"read","description":"Read a bounded file slice with line numbers.","parameters":{"type":"object","properties":{"path":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1}},"required":["path"],"additionalProperties":false}}},{"type":"function","function":{"name":"write","description":"Write complete content to a file.","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"],"additionalProperties":false}}}]';

export const CANONICAL_TOOLS_BYTES = utf8Bytes(CANONICAL_TOOLS_JSON);
export const LEGACY_CANONICAL_TOOLS_BYTES = utf8Bytes(
  LEGACY_CANONICAL_TOOLS_JSON,
);

export type ToolSchemaProfile = "edit-v5" | "edit-v4";

export function toolSchemaProfileForBytes(
  bytes: FrozenBytes,
): ToolSchemaProfile {
  if (bytesEqual(bytes, CANONICAL_TOOLS_BYTES)) return "edit-v5";
  if (bytesEqual(bytes, LEGACY_CANONICAL_TOOLS_BYTES)) return "edit-v4";
  throw new TypeError("tools blob is not an admitted closed ABI");
}
