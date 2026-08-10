import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_TRUNCATION_CONTINUATIONS,
  TRUNCATION_CONTINUATION,
  withTruncationContinuation,
} from "../../src/cli/truncation.js";
import type { CompletedSessionResult } from "../../src/session/index.js";

function result(truncated: boolean, content: string): CompletedSessionResult {
  return {
    status: "completed",
    sessionId: "ses_0",
    lineageId: "lin_0",
    runId: "run_0",
    content,
    commitBoundaryId: "cb_0",
    requestCount: 1,
    truncated,
  } as unknown as CompletedSessionResult;
}

test("a finished reply is returned untouched", async () => {
  const sent: string[] = [];
  const out = await withTruncationContinuation(
    result(false, "done"),
    async (text) => {
      sent.push(text);
      return result(false, "should not happen");
    },
  );
  assert.equal(out.content, "done");
  assert.deepEqual(sent, []);
});

test("a cut-off reply is continued until the model finishes", async () => {
  const sent: string[] = [];
  const out = await withTruncationContinuation(
    result(true, "cut off mid-"),
    async (text) => {
      sent.push(text);
      return result(false, "the real answer");
    },
  );
  assert.equal(out.content, "the real answer");
  assert.deepEqual(sent, [TRUNCATION_CONTINUATION]);
});

test("continuation is bounded", async () => {
  // Otherwise a model that overruns every time loops until the task times out,
  // which is the failure this repairs, not a new one to introduce.
  let calls = 0;
  const out = await withTruncationContinuation(
    result(true, "one"),
    async () => {
      calls += 1;
      return result(true, "still cut off");
    },
  );
  assert.equal(calls, MAX_TRUNCATION_CONTINUATIONS);
  assert.equal(out.truncated, true);
});

test("each continuation is reported to the caller", async () => {
  const seen: Array<[number, number]> = [];
  await withTruncationContinuation(
    result(true, "one"),
    async () => result(true, "two"),
    (attempt, max) => seen.push([attempt, max]),
  );
  assert.deepEqual(seen, [
    [1, MAX_TRUNCATION_CONTINUATIONS],
    [2, MAX_TRUNCATION_CONTINUATIONS],
    [3, MAX_TRUNCATION_CONTINUATIONS],
  ]);
});

test("the continuation text asks for an action and forbids a restatement", async () => {
  // It rides on a cache-hit prefix, so it stays one short sentence pair.
  assert.ok(TRUNCATION_CONTINUATION.length < 160);
  assert.match(TRUNCATION_CONTINUATION, /output token limit/u);
  assert.match(TRUNCATION_CONTINUATION, /Do not repeat/u);
  assert.match(TRUNCATION_CONTINUATION, /tool/u);
});
