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

test("the default leaves room for the response, the summary and one turn", () => {
  // Derived from the window rather than chosen: 1,000,000 less two 65,536
  // outputs — this turn's and the summary's, which is written on the Lineage
  // being replaced and so pays the full prefix again — less a turn of growth.
  assert.equal(DEFAULT_COMPACTION_THRESHOLD_TOKENS, 768_928);
  // Compacting at the threshold must still fit: prefix, plus the summary the
  // compaction request emits, inside the window.
  assert.ok(DEFAULT_COMPACTION_THRESHOLD_TOKENS + 65_536 <= 1_000_000);
  // And so must the turn that follows the check, once it has grown.
  assert.ok(
    DEFAULT_COMPACTION_THRESHOLD_TOKENS + 100_000 + 65_536 <= 1_000_000,
  );
});
