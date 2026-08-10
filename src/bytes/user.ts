import {
  assertUnicodeScalarString,
  concatBytes,
  utf8Bytes,
} from "./ops.js";
import type { FrozenBytes } from "./types.js";

export function materializeUserMessage(content: string): FrozenBytes {
  assertUnicodeScalarString(content, "user content");
  return concatBytes([
    utf8Bytes('{"role":"user","content":'),
    utf8Bytes(JSON.stringify(content)),
    utf8Bytes("}"),
  ]);
}
