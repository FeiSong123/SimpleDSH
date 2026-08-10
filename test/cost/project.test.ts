import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  formatUsdPicodollarsExact,
  projectSessionCostV1,
} from "../../src/cost/project.js";
import { parseFlashPriceBookV1 } from "../../src/cost/prices.js";
import type {
  ArtifactId,
  AttemptId,
  CacheCheckpointId,
  CanonicalTimestamp,
  RequestSnapshotId,
  Sha256,
} from "../../src/journal/types.js";
import {
  ATTEMPT_A,
  ATTEMPT_B,
  CostEventBuilder,
  HASH_A,
  LINEAGE_A,
  LINEAGE_B,
  RUN_A,
  RUN_B,
  SESSION_ID,
  SNAPSHOT_A,
  SNAPSHOT_B,
  commitAssistant,
  effectId,
  objectId,
  startAttempt,
  startLineage,
  toolCallId,
} from "./fixture.js";

const priceUrl = new URL("../../src/cost/flash-prices-v1.toml", import.meta.url);

async function priceBook() {
  return parseFlashPriceBookV1(
    await readFile(priceUrl, "utf8"),
  );
}

test("cost projection prices native usage once and reports durable telemetry", async () => {
  const builder = new CostEventBuilder();
  builder.append({ type: "session_started", sessionId: SESSION_ID, payload: {} });
  startLineage(builder, LINEAGE_A, RUN_A);
  startAttempt(builder, {
    lineageId: LINEAGE_A,
    runId: RUN_A,
    attemptId: ATTEMPT_A,
    requestSnapshotId: SNAPSHOT_A,
  });
  const assistantA = commitAssistant(builder, {
    lineageId: LINEAGE_A,
    runId: RUN_A,
    attemptId: ATTEMPT_A,
    requestSnapshotId: SNAPSHOT_A,
    responseModel: "resolved-z",
    promptTokens: 15,
    hitTokens: 10,
    missTokens: 5,
    completionTokens: 3,
    reasoningTokens: 2,
    finishReason: "length",
  });
  builder.append({
    type: "cache_checkpoint_created",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_A,
    runId: RUN_A,
    payload: {
      cacheCheckpointId: objectId<CacheCheckpointId>("ccp", 20),
      requestSnapshotId: SNAPSHOT_A,
      blobCount: 1,
      chainHash: HASH_A,
      promptTokens: 9_999,
      providerRequestId: `provider-${ATTEMPT_A}`,
      sourceAssistantEventId: assistantA.id,
    },
  });

  const interruptedAttemptA = objectId<AttemptId>("att", 21);
  const interruptedSnapshotA = objectId<RequestSnapshotId>("rqs", 22);
  startAttempt(builder, {
    lineageId: LINEAGE_A,
    runId: RUN_A,
    attemptId: interruptedAttemptA,
    requestSnapshotId: interruptedSnapshotA,
    ordinal: 2,
  });
  const interruptedA = builder.append({
    type: "request_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_A,
    runId: RUN_A,
    payload: {
      attemptId: interruptedAttemptA,
      requestSnapshotId: interruptedSnapshotA,
      outcome: "http_error",
      status: 400,
      retryClass: "request_invalid",
      semanticState: "pre_semantic",
    },
  });
  const openAttempt = objectId<AttemptId>("att", 23);
  startAttempt(builder, {
    lineageId: LINEAGE_A,
    runId: RUN_A,
    attemptId: openAttempt,
    requestSnapshotId: objectId<RequestSnapshotId>("rqs", 24),
    ordinal: 3,
  });

  startLineage(builder, LINEAGE_B, RUN_B);
  startAttempt(builder, {
    lineageId: LINEAGE_B,
    runId: RUN_B,
    attemptId: ATTEMPT_B,
    requestSnapshotId: SNAPSHOT_B,
  });
  commitAssistant(builder, {
    lineageId: LINEAGE_B,
    runId: RUN_B,
    attemptId: ATTEMPT_B,
    requestSnapshotId: SNAPSHOT_B,
    responseModel: "resolved-a",
    promptTokens: 100,
    hitTokens: 90,
    missTokens: 10,
    completionTokens: 10,
    reasoningTokens: 5,
  });
  const interruptedAttemptB = objectId<AttemptId>("att", 25);
  const interruptedSnapshotB = objectId<RequestSnapshotId>("rqs", 26);
  startAttempt(builder, {
    lineageId: LINEAGE_B,
    runId: RUN_B,
    attemptId: interruptedAttemptB,
    requestSnapshotId: interruptedSnapshotB,
    ordinal: 2,
  });
  builder.append({
    type: "request_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_B,
    runId: RUN_B,
    payload: {
      attemptId: interruptedAttemptB,
      requestSnapshotId: interruptedSnapshotB,
      outcome: "http_error",
      status: 422,
      retryClass: "request_invalid",
      semanticState: "post_semantic",
    },
  });
  builder.append({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_A,
    runId: RUN_A,
    payload: { reason: "request_failed", sourceEventId: interruptedA.id },
  });
  builder.append({
    type: "cache_break",
    sessionId: SESSION_ID,
    payload: {
      classification: "planned",
      fromLineageId: LINEAGE_A,
      toLineageId: LINEAGE_B,
      reason: "abi_change",
      authorizedRevision: "reviewed-revision",
    },
  });
  builder.append({
    type: "cache_break",
    sessionId: SESSION_ID,
    payload: {
      classification: "unplanned",
      reason: "fixture",
      expectedHash: HASH_A,
      actualHash: `sha256:${"c".repeat(64)}` as Sha256,
      diffArtifactId: objectId<ArtifactId>("art", 27),
    },
  });

  const reconciled = effectId(28);
  const prepared = effectId(29);
  const completed = effectId(30);
  for (const [id, call] of [
    [reconciled, "call-reconciled"],
    [prepared, "call-prepared"],
    [completed, "call-completed"],
  ] as const) {
    builder.append({
      type: "effect_prepared",
      sessionId: SESSION_ID,
      lineageId: LINEAGE_B,
      runId: RUN_B,
      payload: {
        effectId: id,
        toolCallId: toolCallId(call),
        toolName: "write",
        argumentsHash: HASH_A,
      },
    });
  }
  builder.append({
    type: "effect_indeterminate",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_B,
    runId: RUN_B,
    payload: { effectId: reconciled, reason: "crash_gap" },
  });
  builder.append({
    type: "effect_reconciled",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_B,
    runId: RUN_B,
    payload: {
      effectId: reconciled,
      resolution: "proven_not_executed",
      evidenceArtifactId: objectId<ArtifactId>("art", 31),
    },
  });
  builder.append({
    type: "effect_completed",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_B,
    runId: RUN_B,
    payload: {
      effectId: completed,
      toolCallId: toolCallId("call-completed"),
      artifactId: objectId<ArtifactId>("art", 32),
      terminal: {
        status: "succeeded",
        code: "ok",
        exitCode: null,
        signal: null,
        descendantsReaped: null,
      },
    },
  });

  const report = projectSessionCostV1(SESSION_ID, builder.events(), await priceBook());

  assert.equal(report.activeLineageId, LINEAGE_B);
  assert.equal(report.requests.length, 2);
  assert.equal(report.requests[0]?.cost?.cacheHit.picodollars, "28000");
  assert.equal(report.requests[0]?.cost?.cacheMiss.picodollars, "700000");
  assert.equal(report.requests[0]?.cost?.output.picodollars, "840000");
  assert.equal(report.requests[0]?.cost?.total.picodollars, "1568000");
  assert.equal(report.requests[0]?.cacheHitRatio.basisPoints, "6667");
  assert.equal(report.requests[0]?.reasoningShare.basisPoints, "6667");
  assert.equal(report.requests[1]?.cost?.total.picodollars, "4452000");
  assert.equal(report.knownSessionCost.total.picodollars, "6020000");
  assert.equal(report.knownSessionCost.total.usd, "0.000006020000");
  assert.equal(report.costCompleteness, "lower_bound");
  assert.deepEqual(report.sessionReasoningShare, {
    numerator: "7",
    denominator: "13",
    basisPoints: "5385",
  });
  assert.equal(report.lastProviderObservedPromptTokens, "100");

  assert.equal(report.lineages[0]?.lineageId, LINEAGE_A);
  assert.equal(report.lineages[0]?.attemptCount, "3");
  assert.equal(report.lineages[0]?.successfulRequestCount, "1");
  assert.equal(report.lineages[0]?.pricedRequestCount, "1");
  assert.equal(report.lineages[0]?.interruptedAttemptCount, "1");
  assert.equal(report.lineages[0]?.openAttemptCount, "1");
  assert.equal(report.lineages[0]?.costCompleteness, "lower_bound");
  assert.equal(report.lineages[1]?.lastProviderObservedPromptTokens, "100");

  assert.deepEqual(report.telemetry.responseModels, [
    { value: "resolved-a", count: "1" },
    { value: "resolved-z", count: "1" },
  ]);
  assert.deepEqual(report.telemetry.cacheBreaks, { planned: "1", unplanned: "1" });
  assert.equal(report.telemetry.http400Count, "1");
  assert.equal(report.telemetry.http422Count, "1");
  assert.deepEqual(report.telemetry.requestInterruptions, {
    total: "2",
    byOutcome: [{ value: "http_error", count: "2" }],
  });
  assert.deepEqual(report.telemetry.runInterruptions, {
    total: "1",
    byReason: [{ value: "request_failed", count: "1" }],
  });
  assert.equal(report.telemetry.finishReasonLengthCount, "1");
  assert.deepEqual(report.telemetry.effectStates, {
    prepared: "1",
    completed: "1",
    indeterminate: "0",
    reconciledCompleted: "0",
    reconciledProvenNotExecuted: "1",
    indeterminateObserved: "1",
  });
  assert.deepEqual(report.telemetry.unpricedAttempts, {
    open: "1",
    interrupted: "2",
    bySemanticState: [
      { value: "pre_semantic", count: "1" },
      { value: "post_semantic", count: "1" },
    ],
  });
  assert.deepEqual(report.unavailableMetrics, [
    "queue_wait",
    "appended_tokens",
    "current_prefix_tokens",
  ]);
});

test("attempts before the first observed price remain explicitly unpriced", async () => {
  const builder = new CostEventBuilder();
  builder.append({ type: "session_started", sessionId: SESSION_ID, payload: {} });
  startLineage(builder, LINEAGE_A, RUN_A);
  startAttempt(builder, {
    lineageId: LINEAGE_A,
    runId: RUN_A,
    attemptId: ATTEMPT_A,
    requestSnapshotId: SNAPSHOT_A,
    at: "2026-08-02T23:59:59.999Z" as CanonicalTimestamp,
  });
  commitAssistant(builder, {
    lineageId: LINEAGE_A,
    runId: RUN_A,
    attemptId: ATTEMPT_A,
    requestSnapshotId: SNAPSHOT_A,
    responseModel: "opaque-provider-model",
    promptTokens: 2,
    hitTokens: 1,
    missTokens: 1,
    completionTokens: 1,
    reasoningTokens: 1,
  });

  const report = projectSessionCostV1(SESSION_ID, builder.events(), await priceBook());
  assert.equal(report.requests[0]?.pricingStatus, "unpriced");
  assert.equal(report.requests[0]?.priceVersionId, null);
  assert.equal(report.requests[0]?.unpricedReason, "attempt_predates_price_book");
  assert.equal(report.requests[0]?.cost, null);
  assert.equal(report.knownSessionCost.total.picodollars, "0");
  assert.equal(report.costCompleteness, "lower_bound");
  assert.equal(report.lineages[0]?.successfulRequestCount, "1");
  assert.equal(report.lineages[0]?.pricedRequestCount, "0");
});

test("BigInt arithmetic stays exact beyond Number safe multiplication", async () => {
  const maximum = Number.MAX_SAFE_INTEGER;
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
    responseModel: "opaque",
    promptTokens: maximum,
    hitTokens: maximum,
    missTokens: 0,
    completionTokens: maximum,
    reasoningTokens: maximum,
  });

  const report = projectSessionCostV1(SESSION_ID, builder.events(), await priceBook());
  const expectedHit = BigInt(maximum) * 2_800n;
  const expectedOutput = BigInt(maximum) * 280_000n;
  const expectedTotal = expectedHit + expectedOutput;
  assert.equal(report.knownSessionCost.cacheHit.picodollars, expectedHit.toString());
  assert.equal(report.knownSessionCost.output.picodollars, expectedOutput.toString());
  assert.equal(report.knownSessionCost.total.picodollars, expectedTotal.toString());
  assert.equal(
    report.knownSessionCost.total.usd,
    formatUsdPicodollarsExact(expectedTotal),
  );
  assert.doesNotThrow(() => JSON.stringify(report));
  assert.equal(formatUsdPicodollarsExact(0n), "0.000000000000");
  assert.throws(() => formatUsdPicodollarsExact(-1n), TypeError);
});
