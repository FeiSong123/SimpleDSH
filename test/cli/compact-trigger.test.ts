import assert from "node:assert/strict";
import test from "node:test";

import { InteractiveSession } from "../../src/cli/interactive.js";
import { DEFAULT_COMPACTION_THRESHOLD_TOKENS } from "../../src/session/compaction.js";

const should = InteractiveSession.shouldCompact;

test("the prefix has to reach the threshold", () => {
  assert.equal(should(511_999, 512_000, true), false);
  assert.equal(should(512_000, 512_000, true), true);
  assert.equal(should(900_000, 512_000, true), true);
});

test("a session that has not started is never compacted", () => {
  // There is nothing to summarise before the first turn, and asking the model
  // to summarise an empty conversation costs a request for nothing.
  assert.equal(should(512_000, 512_000, false), false);
});

test("zero disables it", () => {
  assert.equal(should(10_000_000, 0, true), false);
});

test("the default is the 512K the contract records", () => {
  assert.equal(DEFAULT_COMPACTION_THRESHOLD_TOKENS, 512_000);
});
