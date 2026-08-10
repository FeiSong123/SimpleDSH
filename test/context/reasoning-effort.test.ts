import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex } from "../../src/bytes/ops.js";
import {
  assertReasoningEffort,
  buildDeepSeekRequestSnapshot,
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
} from "../../src/bytes/request.js";
import { materializeUserMessage } from "../../src/bytes/user.js";
import {
  buildCacheAbiV2,
  MODEL_TUPLE_BYTES,
  modelTupleBytesFor,
  reasoningEffortFromTuple,
} from "../../src/lineage/cache-abi.js";

const MESSAGE = materializeUserMessage("hello");

test("Flash admits exactly the three documented efforts", () => {
  // The docs map xhigh onto high and silently ignore anything else, so the
  // closed set is enforced here rather than trusting the provider.
  assert.deepEqual([...REASONING_EFFORTS], ["low", "high", "max"]);
  assert.equal(DEFAULT_REASONING_EFFORT, "max");
  for (const effort of REASONING_EFFORTS) {
    assert.equal(assertReasoningEffort(effort), effort);
  }
  for (const rejected of ["xhigh", "medium", "minimal", "none", "MAX", ""]) {
    assert.throws(() => assertReasoningEffort(rejected), TypeError);
  }
});

test("the default effort keeps the historical request bytes unchanged", () => {
  const explicit = buildDeepSeekRequestSnapshot([MESSAGE], "max");
  const implicit = buildDeepSeekRequestSnapshot([MESSAGE]);
  assert.equal(explicit.bodySha256, implicit.bodySha256);
  const body = new TextDecoder().decode(implicit.body.copy());
  assert.ok(body.includes('"reasoning_effort":"max"'));
});

test("each effort produces distinct request bytes", () => {
  const hashes = new Map<string, string>();
  for (const effort of REASONING_EFFORTS) {
    const snapshot = buildDeepSeekRequestSnapshot([MESSAGE], effort);
    const body = new TextDecoder().decode(snapshot.body.copy());
    assert.ok(
      body.includes(`"reasoning_effort":"${effort}"`),
      `body must carry ${effort}`,
    );
    hashes.set(effort, snapshot.bodySha256);
  }
  assert.equal(new Set(hashes.values()).size, REASONING_EFFORTS.length);
});

test("each effort is its own Cache ABI", () => {
  const ids = new Map<string, string>();
  for (const effort of REASONING_EFFORTS) {
    const abi = buildCacheAbiV2(undefined, effort);
    ids.set(effort, abi.cacheAbiId);
    assert.equal(reasoningEffortFromTuple(abi.modelTupleBytes), effort);
  }
  // Distinct ABI ids are what stops a prefix from being reused across efforts.
  assert.equal(new Set(ids.values()).size, REASONING_EFFORTS.length);
  assert.equal(ids.get("max"), buildCacheAbiV2().cacheAbiId);
});

test("the default tuple export still matches max", () => {
  assert.equal(
    sha256Hex(MODEL_TUPLE_BYTES),
    sha256Hex(modelTupleBytesFor("max")),
  );
  assert.equal(reasoningEffortFromTuple(MODEL_TUPLE_BYTES), "max");
});

test("a foreign tuple is not recognised as any effort", () => {
  const foreign = materializeUserMessage("not a tuple");
  assert.equal(reasoningEffortFromTuple(foreign), null);
});
