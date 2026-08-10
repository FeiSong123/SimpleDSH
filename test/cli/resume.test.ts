import assert from "node:assert/strict";
import test from "node:test";

import {
  isResumable,
  MAX_AUTO_RESUMES,
  withAutoResume,
} from "../../src/cli/resume.js";
import {
  SessionInterruptedError,
  SessionKernelError,
} from "../../src/session/index.js";
import type { CompletedSessionResult } from "../../src/session/index.js";

const RESULT = { status: "completed", content: "done" } as CompletedSessionResult;

function interrupted(
  reason: string,
  retryClass?: string,
): SessionInterruptedError {
  return new SessionInterruptedError(
    reason as ConstructorParameters<typeof SessionInterruptedError>[0],
    retryClass as ConstructorParameters<typeof SessionInterruptedError>[1],
  );
}

test("only a cleanly closed interruption is resumable", () => {
  assert.equal(isResumable(interrupted("request_failed")), true);
  assert.equal(isResumable(interrupted("semantic_interrupted")), true);

  // These leave external state unknown or the Journal inconsistent; an
  // operator has to look before anything else runs.
  assert.equal(isResumable(interrupted("effect_indeterminate")), false);
  assert.equal(isResumable(interrupted("integrity_violation")), false);
  assert.equal(isResumable(interrupted("cancelled")), false);
  assert.equal(isResumable(interrupted("durability_failure")), false);

  assert.equal(isResumable(new SessionKernelError("invalid_state")), false);
  assert.equal(isResumable(new Error("boom")), false);
});

test("a turn that succeeds never resumes", async () => {
  let resumes = 0;
  const result = await withAutoResume(
    () => Promise.resolve(RESULT),
    () => {
      resumes += 1;
      return Promise.resolve(RESULT);
    },
  );
  assert.equal(result, RESULT);
  assert.equal(resumes, 0);
});

test("a broken stream resumes from the last safe boundary", async () => {
  const attempts: number[] = [];
  let resumes = 0;
  const result = await withAutoResume(
    () => Promise.reject(interrupted("semantic_interrupted")),
    () => {
      resumes += 1;
      return Promise.resolve(RESULT);
    },
    (attempt) => attempts.push(attempt),
  );
  assert.equal(result, RESULT);
  assert.equal(resumes, 1);
  assert.deepEqual(attempts, [1]);
});

test("resuming is bounded and reports the last failure", async () => {
  const attempts: number[] = [];
  let resumes = 0;
  await assert.rejects(
    withAutoResume(
      () => Promise.reject(interrupted("request_failed")),
      () => {
        resumes += 1;
        return Promise.reject(interrupted("semantic_interrupted"));
      },
      (attempt) => attempts.push(attempt),
    ),
    (error: unknown) =>
      error instanceof SessionInterruptedError &&
      error.reason === "semantic_interrupted",
  );
  assert.equal(resumes, MAX_AUTO_RESUMES);
  assert.deepEqual(attempts, [1, 2, 3]);
});

test("a non-resumable failure stops immediately", async () => {
  let resumes = 0;
  await assert.rejects(
    withAutoResume(
      () => Promise.reject(interrupted("effect_indeterminate")),
      () => {
        resumes += 1;
        return Promise.resolve(RESULT);
      },
    ),
    (error: unknown) =>
      error instanceof SessionInterruptedError &&
      error.reason === "effect_indeterminate",
  );
  // An indeterminate effect must never be retried automatically.
  assert.equal(resumes, 0);
});

test("a non-resumable failure during resume stops the loop", async () => {
  let resumes = 0;
  await assert.rejects(
    withAutoResume(
      () => Promise.reject(interrupted("semantic_interrupted")),
      () => {
        resumes += 1;
        return Promise.reject(new SessionKernelError("invalid_state"));
      },
    ),
    SessionKernelError,
  );
  assert.equal(resumes, 1);
});

test("a permanently invalid request is never resumed", async () => {
  // Invariant 7: a 400 means the request itself is wrong, so a new Run from the
  // same boundary reproduces it byte for byte. A real session burned three
  // resume attempts on one before this rule existed.
  for (const permanent of [
    "request_invalid",
    "authentication",
    "balance",
    "protocol",
  ]) {
    assert.equal(isResumable(interrupted("request_failed", permanent)), false);
  }
  for (const transient of ["timeout", "server", "rate_limited", "transport_unknown"]) {
    assert.equal(isResumable(interrupted("request_failed", transient)), true);
  }

  let resumes = 0;
  await assert.rejects(
    withAutoResume(
      () => Promise.reject(interrupted("request_failed", "request_invalid")),
      () => {
        resumes += 1;
        return Promise.resolve(RESULT);
      },
    ),
    SessionInterruptedError,
  );
  assert.equal(resumes, 0);
});
