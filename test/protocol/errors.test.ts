import {
  deepStrictEqual,
  ok,
  strictEqual,
  throws,
} from "node:assert/strict";
import { test } from "node:test";

import {
  DEEPSEEK_MAX_TOTAL_ATTEMPTS,
  DeepSeekHttpError,
  DeepSeekProtocolError,
  classifyDeepSeekHttpStatus,
  decideDeepSeekRetry,
  deepSeekRetryDelayMs,
  parseDeepSeekRetryAfter,
  type DeepSeekSemanticState,
} from "../../src/ds/errors.js";

const NOW = Date.parse("Wed, 21 Oct 2015 07:27:30 GMT");

test("DeepSeek protocol and HTTP errors retain typed, non-body metadata", () => {
  const cause = new Error("fixture cause");
  const protocol = new DeepSeekProtocolError("invalid SSE event", { cause });
  strictEqual(protocol.name, "DeepSeekProtocolError");
  strictEqual(protocol.kind, "protocol");
  strictEqual(protocol.message, "invalid SSE event");
  strictEqual(protocol.cause, cause);

  const http = new DeepSeekHttpError(429, "2", { cause });
  strictEqual(http.name, "DeepSeekHttpError");
  strictEqual(http.kind, "http");
  strictEqual(http.status, 429);
  strictEqual(http.retryAfterHeader, "2");
  strictEqual(http.message, "DeepSeek HTTP 429");
  strictEqual(http.cause, cause);

  throws(() => new DeepSeekHttpError(99), RangeError);
  throws(() => new DeepSeekHttpError(600), RangeError);
  throws(() => new DeepSeekHttpError(429.5), RangeError);
});

test("HTTP classification is exhaustive for the DeepSeek status contract", () => {
  deepStrictEqual(
    [400, 401, 402, 422, 429, 500, 503, 418].map((status) => [
      status,
      classifyDeepSeekHttpStatus(status),
    ]),
    [
      [400, "request_invalid"],
      [401, "authentication"],
      [402, "balance"],
      [422, "request_invalid"],
      [429, "rate_limited"],
      [500, "server"],
      [503, "server"],
      [418, "unknown"],
    ],
  );
});

test("Retry-After delay-seconds are exact, capped, and reject signed decimals", () => {
  strictEqual(parseDeepSeekRetryAfter(undefined, NOW), undefined);
  strictEqual(parseDeepSeekRetryAfter(null, NOW), undefined);
  strictEqual(parseDeepSeekRetryAfter("", NOW), undefined);
  strictEqual(parseDeepSeekRetryAfter(" 1 ", NOW), 1_000);
  strictEqual(parseDeepSeekRetryAfter("0", NOW), 0);
  strictEqual(parseDeepSeekRetryAfter("59", NOW), 59_000);
  strictEqual(parseDeepSeekRetryAfter("60", NOW), 60_000);
  strictEqual(parseDeepSeekRetryAfter("61", NOW), 60_000);
  strictEqual(
    parseDeepSeekRetryAfter("999999999999999999999999", NOW),
    60_000,
  );
  strictEqual(parseDeepSeekRetryAfter("-1", NOW), undefined);
  strictEqual(parseDeepSeekRetryAfter("+1", NOW), undefined);
  strictEqual(parseDeepSeekRetryAfter("1.5", NOW), undefined);
});

test("Retry-After HTTP-date is deterministic, capped, and rejects stale dates", () => {
  strictEqual(
    parseDeepSeekRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT", NOW),
    30_000,
  );
  strictEqual(
    parseDeepSeekRetryAfter("Wed, 21 Oct 2015 07:29:30 GMT", NOW),
    60_000,
  );
  strictEqual(
    parseDeepSeekRetryAfter("Wed, 21 Oct 2015 07:27:30 GMT", NOW),
    0,
  );
  strictEqual(
    parseDeepSeekRetryAfter("Wed, 21 Oct 2015 07:27:29 GMT", NOW),
    undefined,
  );
  strictEqual(
    parseDeepSeekRetryAfter("Tue, 21 Oct 2015 07:28:00 GMT", NOW),
    undefined,
  );
  strictEqual(parseDeepSeekRetryAfter("not a date", NOW), undefined);
  throws(
    () =>
      parseDeepSeekRetryAfter(
        "Wed, 21 Oct 2015 07:28:00 GMT",
        Number.NaN,
      ),
    RangeError,
  );
});

test("bounded backoff is exponential and 429 equal jitter is injectable", () => {
  strictEqual(
    deepSeekRetryDelayMs({ reason: 500, failedAttempt: 1 }),
    500,
  );
  strictEqual(
    deepSeekRetryDelayMs({ reason: 503, failedAttempt: 2 }),
    1_000,
  );
  strictEqual(
    deepSeekRetryDelayMs({ reason: "timeout", failedAttempt: 3 }),
    2_000,
  );
  strictEqual(
    deepSeekRetryDelayMs({ reason: 500, failedAttempt: 5 }),
    8_000,
  );
  strictEqual(
    deepSeekRetryDelayMs({ reason: 500, failedAttempt: 1_000 }),
    8_000,
  );

  strictEqual(
    deepSeekRetryDelayMs({
      reason: 429,
      failedAttempt: 1,
      randomUnit: 0,
    }),
    250,
  );
  strictEqual(
    deepSeekRetryDelayMs({
      reason: 429,
      failedAttempt: 1,
      randomUnit: 0.5,
    }),
    375,
  );
  strictEqual(
    deepSeekRetryDelayMs({
      reason: 429,
      failedAttempt: 1,
      randomUnit: 0.999_999,
    }),
    500,
  );
  strictEqual(
    deepSeekRetryDelayMs({
      reason: 429,
      failedAttempt: 5,
      randomUnit: 0.999_999,
    }),
    8_000,
  );

  throws(
    () =>
      deepSeekRetryDelayMs({
        reason: 429,
        failedAttempt: 1,
        randomUnit: -0.01,
      }),
    RangeError,
  );
  throws(
    () =>
      deepSeekRetryDelayMs({
        reason: 429,
        failedAttempt: 1,
        randomUnit: 1,
      }),
    RangeError,
  );
});

test("Retry-After is a bounded minimum over the local backoff", () => {
  strictEqual(
    deepSeekRetryDelayMs({
      reason: 429,
      failedAttempt: 1,
      retryAfterMs: 100,
      randomUnit: 0,
    }),
    250,
  );
  strictEqual(
    deepSeekRetryDelayMs({
      reason: 429,
      failedAttempt: 1,
      retryAfterMs: 2_000,
      randomUnit: 0,
    }),
    2_000,
  );
  strictEqual(
    deepSeekRetryDelayMs({
      reason: 503,
      failedAttempt: 1,
      retryAfterMs: 90_000,
    }),
    60_000,
  );
  throws(
    () =>
      deepSeekRetryDelayMs({
        reason: 500,
        failedAttempt: 1,
        retryAfterMs: -1,
      }),
    RangeError,
  );
});

test("400 and 422 fail closed and request an integrity self-check", () => {
  for (const status of [400, 422]) {
    deepStrictEqual(
      decideDeepSeekRetry({
        failure: new DeepSeekHttpError(status),
        semanticState: "pre_semantic",
        failedAttempt: 1,
        nowMs: NOW,
      }),
      {
        retry: false,
        delayMs: null,
        retryClass: "request_invalid",
        integritySelfCheck: true,
      },
    );
  }
});

test("401, 402, and unknown HTTP statuses stop without retry", () => {
  const cases = [
    [401, "authentication"],
    [402, "balance"],
    [418, "unknown"],
  ] as const;

  for (const [status, retryClass] of cases) {
    deepStrictEqual(
      decideDeepSeekRetry({
        failure: new DeepSeekHttpError(status),
        semanticState: "pre_semantic",
        failedAttempt: 1,
        nowMs: NOW,
      }),
      {
        retry: false,
        delayMs: null,
        retryClass,
        integritySelfCheck: false,
      },
    );
  }
});

test("429, 500, 503, and timeout retry only pre-semantic within three attempts", () => {
  const failures = [
    new DeepSeekHttpError(429),
    new DeepSeekHttpError(500),
    new DeepSeekHttpError(503),
    { kind: "timeout" as const },
  ];

  for (const failure of failures) {
    const first = decideDeepSeekRetry({
      failure,
      semanticState: "pre_semantic",
      failedAttempt: 1,
      nowMs: NOW,
      randomUnit: 0.5,
    });
    strictEqual(first.retry, true);
    ok(first.delayMs !== null && first.delayMs > 0);

    const second = decideDeepSeekRetry({
      failure,
      semanticState: "pre_semantic",
      failedAttempt: 2,
      nowMs: NOW,
      randomUnit: 0.5,
    });
    strictEqual(second.retry, true);

    const exhausted = decideDeepSeekRetry({
      failure,
      semanticState: "pre_semantic",
      failedAttempt: DEEPSEEK_MAX_TOTAL_ATTEMPTS,
      nowMs: NOW,
      randomUnit: 0.5,
    });
    strictEqual(exhausted.retry, false);
    strictEqual(exhausted.delayMs, null);
  }
});

test("post-semantic and unknown semantic state always fail closed", () => {
  for (const semanticState of [
    "post_semantic",
    "unknown",
  ] satisfies readonly DeepSeekSemanticState[]) {
    for (const failure of [
      new DeepSeekHttpError(429),
      new DeepSeekHttpError(500),
      new DeepSeekHttpError(503),
      { kind: "timeout" as const },
    ]) {
      const decision = decideDeepSeekRetry({
        failure,
        semanticState,
        failedAttempt: 1,
        nowMs: NOW,
        randomUnit: 0.5,
      });
      strictEqual(decision.retry, false);
      strictEqual(decision.delayMs, null);
    }
  }
});

test("cancel, protocol, and unknown transport failures always fail closed", () => {
  const failures = [
    { kind: "cancelled" as const },
    new DeepSeekProtocolError("malformed event"),
    { kind: "transport" as const, code: "ECONNRESET" },
  ];

  for (const failure of failures) {
    const decision = decideDeepSeekRetry({
      failure,
      semanticState: "pre_semantic",
      failedAttempt: 1,
      nowMs: NOW,
      randomUnit: 0.5,
    });
    strictEqual(decision.retry, false);
    strictEqual(decision.delayMs, null);
    strictEqual(decision.integritySelfCheck, false);
  }
});

test("retry decision honors parsed Retry-After and validates attempt numbering", () => {
  const decision = decideDeepSeekRetry({
    failure: new DeepSeekHttpError(
      429,
      "Wed, 21 Oct 2015 07:28:00 GMT",
    ),
    semanticState: "pre_semantic",
    failedAttempt: 1,
    nowMs: NOW,
    randomUnit: 0,
  });
  strictEqual(decision.retry, true);
  strictEqual(decision.delayMs, 30_000);

  throws(
    () =>
      decideDeepSeekRetry({
        failure: new DeepSeekHttpError(500),
        semanticState: "pre_semantic",
        failedAttempt: 0,
      }),
    RangeError,
  );
  throws(
    () =>
      decideDeepSeekRetry({
        failure: new DeepSeekHttpError(500),
        semanticState: "pre_semantic",
        failedAttempt: 1.5,
      }),
    RangeError,
  );
});
