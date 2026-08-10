import assert from "node:assert/strict";
import test from "node:test";

import { bytesEqual, utf8Bytes } from "../../src/bytes/ops.js";
import {
  BASE_REQUEST_GOLDEN_SHA256,
  buildDeepSeekRequestSnapshot,
  DEEPSEEK_ENDPOINT,
  DEEPSEEK_MODEL,
  restoreDeepSeekRequestSnapshot,
} from "../../src/bytes/request.js";
import { CANONICAL_TOOLS_BYTES } from "../../src/bytes/schemas.js";
import { ACTIVE_SYSTEM_MESSAGE_BYTES } from "../../src/bytes/system.js";
import { utf8View } from "../../src/bytes/view.js";

test("request golden freezes official backend model thinking and effort", () => {
  const user = utf8Bytes('{"role":"user","content":"hello"}');
  const snapshot = buildDeepSeekRequestSnapshot([ACTIVE_SYSTEM_MESSAGE_BYTES, user]);
  const expected =
    '{"model":"deepseek-v4-flash","messages":[' +
    utf8View(ACTIVE_SYSTEM_MESSAGE_BYTES) +
    ',{"role":"user","content":"hello"}],"tools":' +
    utf8View(CANONICAL_TOOLS_BYTES) +
    ',"stream":true,"stream_options":{"include_usage":true},"thinking":{"type":"enabled"},"reasoning_effort":"max","max_tokens":65536}';

  assert.equal(DEEPSEEK_ENDPOINT, "https://api.deepseek.com/chat/completions");
  assert.equal(DEEPSEEK_MODEL, "deepseek-v4-flash");
  assert.equal(utf8View(snapshot.body), expected);
  assert.equal(bytesEqual(snapshot.body, utf8Bytes(expected)), true);
  assert.equal(snapshot.byteCount, snapshot.body.byteLength);
  assert.match(snapshot.bodySha256, /^[0-9a-f]{64}$/u);
});

test("request body golden hash is signed", () => {
  const snapshot = buildDeepSeekRequestSnapshot([ACTIVE_SYSTEM_MESSAGE_BYTES]);
  assert.equal(snapshot.bodySha256, BASE_REQUEST_GOLDEN_SHA256);
});

test("request builder appends frozen message bytes without reconstruction", () => {
  const unusual = utf8Bytes(
    '{ "role" : "assistant", "content" : "\\u4e2d", "reasoning_content" : "r", "tool_calls" : [] }',
  );
  const body = utf8View(buildDeepSeekRequestSnapshot([unusual]).body);
  assert.ok(body.includes(utf8View(unusual)));
});

test("request golden excludes unsupported and configurable fields", () => {
  const body = utf8View(buildDeepSeekRequestSnapshot([ACTIVE_SYSTEM_MESSAGE_BYTES]).body);
  for (const forbidden of [
    '"temperature"',
    '"top_p"',
    '"presence_penalty"',
    '"frequency_penalty"',
    '"tool_choice"',
    '"strict"',
    '"user"',
    '"base_url"',
    '"provider"',
    '"deepseek-reasoner"',
    '"deepseek-v4-pro"',
  ]) {
    assert.equal(body.includes(forbidden), false, forbidden);
  }
});

test("retry snapshot identity is the same immutable object", () => {
  const snapshot = buildDeepSeekRequestSnapshot([ACTIVE_SYSTEM_MESSAGE_BYTES]);
  const original = snapshot.body.copy();
  const exposed = snapshot.body.copy();
  exposed[0] = exposed[0] === 0 ? 1 : 0;
  const attempts = [snapshot, snapshot, snapshot];
  assert.equal(attempts.every((attempt) => attempt === snapshot), true);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.deepEqual(snapshot.body.copy(), original);
  const restored = restoreDeepSeekRequestSnapshot(snapshot.body, snapshot);
  assert.notEqual(restored, snapshot);
  assert.equal(restored.bodySha256, snapshot.bodySha256);
  assert.deepEqual(restored.body.copy(), original);
  assert.throws(
    () =>
      restoreDeepSeekRequestSnapshot(snapshot.body, {
        bodySha256: "0".repeat(64),
        byteCount: snapshot.byteCount,
      }),
    /integrity mismatch/u,
  );
});
