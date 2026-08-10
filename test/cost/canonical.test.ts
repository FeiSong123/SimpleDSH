import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { bytesEqual } from "../../src/bytes/ops.js";
import {
  encodeCostReportV1,
  projectSessionCostV1,
} from "../../src/cost/project.js";
import { parseFlashPriceBookV1 } from "../../src/cost/prices.js";
import type { SessionId } from "../../src/journal/types.js";
import {
  ATTEMPT_A,
  CostEventBuilder,
  LINEAGE_A,
  RUN_A,
  SESSION_ID,
  SNAPSHOT_A,
  commitAssistant,
  objectId,
  startAttempt,
  startLineage,
} from "./fixture.js";

const priceUrl = new URL("../../src/cost/flash-prices-v1.toml", import.meta.url);
const FUTURE_PRICE = `
[[regular]]
id = "deepseek-v4-flash-regular-2026-09-01"
observed_from = "2026-09-01T00:00:00.000Z"
verified_at = "2026-09-01"
cache_hit_picodollars_per_token = 3000
cache_miss_picodollars_per_token = 150000
output_picodollars_per_token = 300000
`;

async function priceText(): Promise<string> {
  return readFile(priceUrl, "utf8");
}

function completedEvents() {
  const builder = new CostEventBuilder();
  builder.append({ type: "session_started", sessionId: SESSION_ID, payload: {} });
  startLineage(builder, LINEAGE_A, RUN_A);
  startAttempt(builder, {
    lineageId: LINEAGE_A,
    runId: RUN_A,
    attemptId: ATTEMPT_A,
    requestSnapshotId: SNAPSHOT_A,
  });
  commitAssistant(builder, {
    lineageId: LINEAGE_A,
    runId: RUN_A,
    attemptId: ATTEMPT_A,
    requestSnapshotId: SNAPSHOT_A,
    responseModel: "opaque-model",
    promptTokens: 4,
    hitTokens: 3,
    missTokens: 1,
    completionTokens: 2,
    reasoningTokens: 1,
  });
  return builder.events();
}

test("canonical cost facts rebuild to identical bytes without mutating facts", async () => {
  const events = completedEvents();
  const before = JSON.stringify(events);
  const book = parseFlashPriceBookV1(await priceText());
  const first = projectSessionCostV1(SESSION_ID, events, book);
  const second = projectSessionCostV1(SESSION_ID, events, book);
  const firstBytes = encodeCostReportV1(first);
  const secondBytes = encodeCostReportV1(second);

  assert.equal(bytesEqual(firstBytes, secondBytes), true);
  assert.equal(Buffer.from(firstBytes.copy()).toString("utf8").endsWith("\n"), false);
  assert.equal(JSON.stringify(events), before);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.requests), true);
  assert.equal(Object.isFrozen(first.requests[0]), true);
  assert.equal(Object.isFrozen(first.requests[0]?.usage), true);
  assert.equal(Object.isFrozen(first.lineages), true);
  assert.equal(Object.isFrozen(first.lineages[0]?.knownCost.total), true);
  assert.equal(Object.isFrozen(first.telemetry), true);
  assert.equal(Object.isFrozen(first.unavailableMetrics), true);
  assert.throws(() => {
    (first.requests as unknown as unknown[]).push({});
  }, TypeError);
});

test("appending a future price version does not reprice historical facts", async () => {
  const events = completedEvents();
  const originalBook = parseFlashPriceBookV1(await priceText());
  const extendedBook = parseFlashPriceBookV1((await priceText()) + FUTURE_PRICE);
  const original = encodeCostReportV1(
    projectSessionCostV1(SESSION_ID, events, originalBook),
  );
  const rebuilt = encodeCostReportV1(
    projectSessionCostV1(SESSION_ID, events, extendedBook),
  );

  assert.equal(bytesEqual(original, rebuilt), true);
});

test("empty verified prefixes are deterministic and malformed scopes fail closed", async () => {
  const book = parseFlashPriceBookV1(await priceText());
  const empty = projectSessionCostV1(SESSION_ID, [], book);

  assert.equal(empty.activeLineageId, null);
  assert.deepEqual(empty.requests, []);
  assert.deepEqual(empty.lineages, []);
  assert.equal(empty.knownSessionCost.total.picodollars, "0");
  assert.equal(empty.costCompleteness, "complete");
  assert.deepEqual(empty.sessionReasoningShare, {
    numerator: "0",
    denominator: "0",
    basisPoints: null,
  });
  assert.equal(empty.lastProviderObservedPromptTokens, null);

  const events = completedEvents();
  assert.throws(
    () => projectSessionCostV1(SESSION_ID, events.slice(1), book),
    TypeError,
  );
  assert.throws(
    () =>
      projectSessionCostV1(
        objectId<SessionId>("ses", 99),
        events,
        book,
      ),
    TypeError,
  );
});
