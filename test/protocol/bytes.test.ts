import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { materializeAssistant } from "../../src/bytes/assistant.js";
import {
  bytesEqual,
  concatBytes,
  fromBase64,
  lengthPrefix,
  sha256Hex,
  toBase64,
  utf8Bytes,
} from "../../src/bytes/ops.js";
import {
  BASE_FROZEN_ZONE_BYTES,
  BASE_FROZEN_ZONE_SHA256,
} from "../../src/bytes/request.js";
import { freezeBytes } from "../../src/bytes/types.js";
import { viewAssistant } from "../../src/bytes/view.js";

test("UTF-8 FrozenBytes survive base64 storage without byte drift", () => {
  const original = utf8Bytes("中🙂e\u0301\\u4e2d");
  const restored = fromBase64(toBase64(original));
  assert.equal(bytesEqual(restored, original), true);
  assert.equal(sha256Hex(restored), sha256Hex(original));
});

test("FrozenBytes owns private bytes and returns defensive copies", () => {
  const source = new Uint8Array([1, 2, 3]);
  const frozen = freezeBytes(source);
  const initialHash = sha256Hex(frozen);
  source[0] = 9;
  const exposed = frozen.copy();
  exposed[1] = 9;
  assert.deepEqual([...frozen.copy()], [1, 2, 3]);
  assert.equal(sha256Hex(frozen), initialHash);
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Object.isFrozen(Object.getPrototypeOf(frozen)), true);
});

test("FrozenBytes never passes backing bytes to an overridable typed-array method", () => {
  let captured: Uint8Array | undefined;
  class CapturingUint8Array extends Uint8Array {
    override set(source: ArrayLike<number>, offset?: number): void {
      if (source instanceof Uint8Array) captured = source;
      super.set(source, offset);
    }
  }

  const frozen = freezeBytes(new Uint8Array([1, 2, 3]));
  const oldSurface = frozen as unknown as {
    readonly copyInto?: (target: Uint8Array, offset: number) => void;
  };
  assert.equal(oldSurface.copyInto, undefined);

  const hostileTarget = new CapturingUint8Array(3);
  hostileTarget.set(frozen.copy());
  assert.notEqual(captured, undefined);
  if (captured !== undefined) captured[0] = 9;
  assert.deepEqual([...frozen.copy()], [1, 2, 3]);
  assert.deepEqual([...concatBytes([frozen]).copy()], [1, 2, 3]);
});

test("base64 restore rejects non-canonical encodings", () => {
  for (const invalid of ["YQ", "YQ=", "YQ===", " YQ==", "YQ==\n", "@@=="]) {
    assert.throws(() => fromBase64(invalid), TypeError, invalid);
  }
});

test("assistant canonical bytes preserve reasoning and nested tool arguments", () => {
  const assistant = materializeAssistant({
    content: "完成🙂",
    reasoningContent: "分析e\u0301",
    toolCalls: [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "write",
          arguments: '{"path":"深/层.json","content":"\\u4e2d🙂"}',
        },
      },
    ],
  });
  const restored = fromBase64(toBase64(assistant));
  assert.deepEqual(viewAssistant(restored), {
    role: "assistant",
    content: "完成🙂",
    reasoningContent: "分析e\u0301",
    toolCalls: [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "write",
          arguments: '{"path":"深/层.json","content":"\\u4e2d🙂"}',
        },
      },
    ],
  });
});

test("length framing distinguishes identical concatenations", () => {
  const left = concatBytes([lengthPrefix(utf8Bytes("a")), lengthPrefix(utf8Bytes("bc"))]);
  const right = concatBytes([lengthPrefix(utf8Bytes("ab")), lengthPrefix(utf8Bytes("c"))]);
  assert.notEqual(sha256Hex(left), sha256Hex(right));
});

test("frozen zone golden hash is explicit", () => {
  assert.equal(sha256Hex(BASE_FROZEN_ZONE_BYTES), BASE_FROZEN_ZONE_SHA256);
});

test("source does not parse FrozenBytes outside the read-only view", () => {
  for (const path of [
    "src/bytes/assistant.ts",
    "src/bytes/ops.ts",
    "src/bytes/request.ts",
    "src/bytes/schemas.ts",
    "src/bytes/system.ts",
    "src/bytes/types.ts",
  ]) {
    assert.doesNotMatch(readFileSync(path, "utf8"), /JSON\.parse\s*\(/u, path);
  }
});
