import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBlobStore, type BlobPosition } from "../../src/blob/index.js";
import type { FrozenBytes } from "../../src/bytes/types.js";
import { utf8View, viewAssistant } from "../../src/bytes/view.js";
import { loadDeepSeekCredential } from "../../src/ds/credential.js";
import type { AssistantView } from "../../src/ds/types.js";
import {
  newSessionId,
  openJournal,
  randomEventIdentitySource,
  systemJournalClock,
  type AnyVerifiedJournalEvent,
  type CommitBoundaryId,
  type EffectId,
  type EventId,
  type RequestSnapshotId,
  type SessionId,
} from "../../src/journal/index.js";
import { runOfficialSession } from "../../src/session/index.js";
import { createSnapshotStore } from "../../src/snapshot/index.js";

const LIVE_ENABLED = process.env["DSH_LIVE"] === "1";
const LIVE_SESSION_TIMEOUT_MS = 15 * 60_000;
const LIVE_TEST_TIMEOUT_MS = 31 * 60_000;
const NO_TOOL_MARKER = "SIMPLEDSH_STAGE06_NO_TOOL_OK_20260804";
const READ_MARKER = "SIMPLEDSH_STAGE06_READ_OK_20260804";
const READ_MARKER_PATH = "synthetic-marker.txt";
const PROJECT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const FLASH_PRICE_USD_PER_MILLION = Object.freeze({
  cacheHitInput: 0.0028,
  cacheMissInput: 0.14,
  output: 0.28,
});

type AssistantEvent = Extract<
  AnyVerifiedJournalEvent,
  { readonly type: "assistant_committed" }
>;

type SnapshotEvent = Extract<
  AnyVerifiedJournalEvent,
  { readonly type: "request_snapshot_stored" }
>;

type BoundaryEvent = Extract<
  AnyVerifiedJournalEvent,
  { readonly type: "commit_boundary_created" }
>;

interface ReplayedSession {
  readonly events: readonly AnyVerifiedJournalEvent[];
  readonly sessionDir: string;
}

interface AssistantRecord {
  readonly event: AssistantEvent;
  readonly view: AssistantView;
}

interface RedactedUsage {
  readonly promptTokens: number;
  readonly promptCacheHitTokens: number;
  readonly promptCacheMissTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key, index) => actual[index] === key)
  );
}

function assertFixedOfficialRequest(body: FrozenBytes): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8View(body));
  } catch {
    assert.fail("durable request body is not valid JSON");
  }
  assert.ok(isRecord(parsed), "durable request body must be an object");
  assert.ok(
    hasExactKeys(parsed, [
      "model",
      "messages",
      "tools",
      "stream",
      "stream_options",
      "thinking",
      "reasoning_effort",
      "max_tokens",
    ]),
    "durable request contains a routing or provider override",
  );
  assert.ok(
    parsed["model"] === "deepseek-v4-flash",
    "durable request model is not fixed Flash",
  );
  assert.ok(
    parsed["reasoning_effort"] === "max",
    "durable request reasoning effort is not max",
  );
  assert.ok(
    parsed["max_tokens"] === 65_536,
    "durable request max tokens is not fixed",
  );
  assert.ok(parsed["stream"] === true, "durable request is not streaming");
  assert.ok(Array.isArray(parsed["messages"]), "durable request messages are invalid");
  assert.ok(Array.isArray(parsed["tools"]), "durable request tools are invalid");

  const thinking = parsed["thinking"];
  assert.ok(
    isRecord(thinking) &&
      hasExactKeys(thinking, ["type"]) &&
      thinking["type"] === "enabled",
    "durable request thinking mode is not enabled",
  );
  const streamOptions = parsed["stream_options"];
  assert.ok(
    isRecord(streamOptions) &&
      hasExactKeys(streamOptions, ["include_usage"]) &&
      streamOptions["include_usage"] === true,
    "durable request usage streaming is not fixed",
  );
}

function assertOpaqueResponseModel(model: string): void {
  assert.ok(
    model.trim().length > 0,
    "event trace contains an empty response model",
  );
  assert.ok(
    model !== "deepseek-v4-pro",
    "event trace contains the explicitly forbidden Pro response model",
  );
}

async function reopenCleanly(
  workspaceRoot: string,
  sessionId: SessionId,
): Promise<ReplayedSession> {
  const opened = await openJournal(
    workspaceRoot,
    sessionId,
    systemJournalClock,
    randomEventIdentitySource,
  );
  try {
    assert.ok(opened.replay.head !== null, "reopened Journal has no durable head");
    assert.ok(opened.replay.tornTail === null, "reopened Journal has a torn tail");
    assert.ok(
      opened.replay.validPrefixByteCount === opened.replay.totalByteCount,
      "reopened Journal did not verify to physical EOF",
    );
    assert.ok(
      !opened.replay.events.some(
        (event) => event.type === "journal_tail_recovered",
      ),
      "live Session required unexpected Journal tail repair",
    );
    return Object.freeze({
      events: opened.replay.events,
      sessionDir: opened.paths.sessionDir,
    });
  } finally {
    await opened.writer.close();
  }
}

async function assertSnapshotsAndAttemptOrder(
  replayed: ReplayedSession,
): Promise<number> {
  const eventIndexes = new Map<EventId, number>();
  const snapshots = new Map<
    RequestSnapshotId,
    Readonly<{ readonly event: SnapshotEvent; readonly index: number }>
  >();
  const boundaries = new Map<
    CommitBoundaryId,
    Readonly<{ readonly event: BoundaryEvent; readonly index: number }>
  >();
  const snapshotStore = await createSnapshotStore(replayed.sessionDir);

  replayed.events.forEach((event, index) => {
    eventIndexes.set(event.id, index);
    if (event.type === "request_snapshot_stored") {
      assert.ok(
        !snapshots.has(event.payload.requestSnapshotId),
        "request Snapshot id was reused",
      );
      snapshots.set(
        event.payload.requestSnapshotId,
        Object.freeze({ event, index }),
      );
    }
    if (event.type === "commit_boundary_created") {
      assert.ok(
        !boundaries.has(event.payload.commitBoundaryId),
        "Commit Boundary id was reused",
      );
      boundaries.set(
        event.payload.commitBoundaryId,
        Object.freeze({ event, index }),
      );
    }
  });

  for (const { event } of snapshots.values()) {
    const body = await snapshotStore.load({
      bodyRef: event.payload.bodyRef,
      bodyHash: event.payload.bodyHash,
      byteCount: event.payload.byteCount,
    });
    assertFixedOfficialRequest(body);
  }

  const attempts = replayed.events.filter(
    (event) => event.type === "request_attempt_started",
  );
  assert.ok(attempts.length > 0, "live Session sent no durable request attempt");
  for (const attempt of attempts) {
    const attemptIndex = eventIndexes.get(attempt.id);
    const snapshot = snapshots.get(attempt.payload.requestSnapshotId);
    assert.ok(attemptIndex !== undefined, "request attempt is absent from replay");
    assert.ok(snapshot !== undefined, "request attempt has no durable Snapshot");
    assert.ok(
      snapshot.index < attemptIndex,
      "request attempt precedes its durable Snapshot",
    );
    const boundary = boundaries.get(snapshot.event.payload.commitBoundaryId);
    assert.ok(boundary !== undefined, "request Snapshot has no Commit Boundary");
    assert.ok(
      boundary.index < snapshot.index,
      "request Snapshot precedes its Commit Boundary",
    );
    const sourceEvents = boundary.event.payload.sourceEventIds.map((id) => {
      const index = eventIndexes.get(id);
      return index === undefined ? undefined : replayed.events[index];
    });
    assert.ok(
      sourceEvents.every((event) => event !== undefined),
      "Commit Boundary has a missing source event",
    );
    const isUserBoundary =
      sourceEvents.length === 1 && sourceEvents[0]?.type === "user_committed";
    const isToolBoundary =
      sourceEvents.length > 0 &&
      sourceEvents.every((event) => event?.type === "tool_result_committed");
    assert.ok(
      isUserBoundary || isToolBoundary,
      "request was not selected from a user/tool Commit Boundary",
    );
  }
  return attempts.length;
}

function assertImmediateCheckpoints(events: readonly AnyVerifiedJournalEvent[]): void {
  events.forEach((event, index) => {
    if (event.type !== "assistant_committed") return;
    assertOpaqueResponseModel(event.payload.responseModel);
    const next = events[index + 1];
    assert.ok(
      next?.type === "cache_checkpoint_created",
      "assistant response has no immediate Cache Checkpoint",
    );
    assert.ok(
      next.payload.sourceAssistantEventId === event.id &&
        next.payload.requestSnapshotId === event.payload.requestSnapshotId &&
        next.payload.providerRequestId === event.payload.providerRequestId,
      "assistant Cache Checkpoint does not bind the exact response",
    );
  });
}

function assertNoOrphans(events: readonly AnyVerifiedJournalEvent[]): void {
  const attempts = new Map<string, number>();
  const attemptTerminals = new Map<string, number>();
  const preparedEffects = new Map<EffectId, number>();
  const completedEffects = new Map<EffectId, number>();
  const indeterminateEffects = new Map<EffectId, number>();
  const reconciledEffects = new Map<EffectId, number>();

  for (const event of events) {
    if (event.type === "request_attempt_started") {
      attempts.set(event.payload.attemptId, (attempts.get(event.payload.attemptId) ?? 0) + 1);
    } else if (
      event.type === "assistant_committed" ||
      event.type === "request_interrupted"
    ) {
      assert.ok(
        attempts.has(event.payload.attemptId),
        "attempt terminal has no durable start",
      );
      attemptTerminals.set(
        event.payload.attemptId,
        (attemptTerminals.get(event.payload.attemptId) ?? 0) + 1,
      );
    } else if (event.type === "effect_prepared") {
      preparedEffects.set(
        event.payload.effectId,
        (preparedEffects.get(event.payload.effectId) ?? 0) + 1,
      );
    } else if (event.type === "effect_completed") {
      assert.ok(
        preparedEffects.has(event.payload.effectId),
        "completed Effect has no durable prepare",
      );
      completedEffects.set(
        event.payload.effectId,
        (completedEffects.get(event.payload.effectId) ?? 0) + 1,
      );
    } else if (event.type === "effect_indeterminate") {
      assert.ok(
        preparedEffects.has(event.payload.effectId),
        "indeterminate Effect has no durable prepare",
      );
      indeterminateEffects.set(
        event.payload.effectId,
        (indeterminateEffects.get(event.payload.effectId) ?? 0) + 1,
      );
    } else if (event.type === "effect_reconciled") {
      assert.ok(
        preparedEffects.has(event.payload.effectId),
        "reconciled Effect has no durable prepare",
      );
      reconciledEffects.set(
        event.payload.effectId,
        (reconciledEffects.get(event.payload.effectId) ?? 0) + 1,
      );
    }
  }

  for (const [attemptId, starts] of attempts) {
    assert.ok(starts === 1, "request attempt was started more than once");
    assert.ok(
      attemptTerminals.get(attemptId) === 1,
      "request attempt has no unique terminal",
    );
  }
  for (const [effectId, prepares] of preparedEffects) {
    assert.ok(prepares === 1, "Effect was prepared more than once");
    const completed = completedEffects.get(effectId) ?? 0;
    const indeterminate = indeterminateEffects.get(effectId) ?? 0;
    const reconciled = reconciledEffects.get(effectId) ?? 0;
    assert.ok(
      completed + reconciled === 1,
      "Effect has no unique settled or reconciled terminal",
    );
    assert.ok(
      (completed === 1 && indeterminate === 0) ||
        (completed === 0 && indeterminate === 1 && reconciled === 1),
      "Effect terminal sequence is incomplete",
    );
  }
}

function assertCompletedRun(events: readonly AnyVerifiedJournalEvent[]): void {
  const completed = events.filter((event) => event.type === "run_completed");
  assert.ok(completed.length === 1, "Session has no unique run_completed terminal");
  assert.ok(
    events.at(-1)?.type === "run_completed",
    "run_completed is not the final durable event",
  );
  assert.ok(
    !events.some((event) => event.type === "run_interrupted"),
    "successful live Session contains an interrupted Run",
  );
}

async function loadAssistantRecords(
  replayed: ReplayedSession,
): Promise<readonly AssistantRecord[]> {
  const blobs = await createBlobStore(replayed.sessionDir);
  const records: AssistantRecord[] = [];
  let position: BlobPosition = Object.freeze({
    blobIndex: 0,
    previousChainHash: null,
  });
  for (const event of replayed.events) {
    if (
      event.type !== "user_committed" &&
      event.type !== "assistant_committed" &&
      event.type !== "tool_result_committed"
    ) {
      continue;
    }
    if (event.type === "assistant_committed") {
      const bytes = await blobs.load(event.payload, position);
      records.push(Object.freeze({ event, view: viewAssistant(bytes) }));
    }
    position = Object.freeze({
      blobIndex: event.payload.blobIndex + 1,
      previousChainHash: event.payload.chainHash,
    });
  }
  return Object.freeze(records);
}

function redactedUsage(
  events: readonly AnyVerifiedJournalEvent[],
): readonly RedactedUsage[] {
  return Object.freeze(
    events
      .filter(
        (event): event is AssistantEvent => event.type === "assistant_committed",
      )
      .map((event) =>
        Object.freeze({
          promptTokens: event.payload.usage.promptTokens,
          promptCacheHitTokens: event.payload.usage.promptCacheHitTokens,
          promptCacheMissTokens: event.payload.usage.promptCacheMissTokens,
          completionTokens: event.payload.usage.completionTokens,
          reasoningTokens: event.payload.usage.reasoningTokens,
        }),
      ),
  );
}

function publishedRegularPriceEstimateUsd(
  usage: readonly RedactedUsage[],
): number {
  const cost = usage.reduce(
    (total, item) =>
      total +
      (item.promptCacheHitTokens * FLASH_PRICE_USD_PER_MILLION.cacheHitInput +
        item.promptCacheMissTokens *
          FLASH_PRICE_USD_PER_MILLION.cacheMissInput +
        item.completionTokens * FLASH_PRICE_USD_PER_MILLION.output) /
        1_000_000,
    0,
  );
  return Number(cost.toFixed(12));
}

async function runBoundedOfficialSession(
  input: Parameters<typeof runOfficialSession>[0],
): Promise<Awaited<ReturnType<typeof runOfficialSession>>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIVE_SESSION_TIMEOUT_MS);
  timeout.unref();
  try {
    return await runOfficialSession({ ...input, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

test("live model telemetry rejects only the exact forbidden public Pro id", () => {
  for (const opaqueModel of [
    "deepseek-v4-flash",
    "DeepSeek-V4-Pro",
    "deepseek-v4-pro-20260804",
    "resolved-pro-telemetry",
  ]) {
    assert.doesNotThrow(() => assertOpaqueResponseModel(opaqueModel));
  }
  assert.throws(
    () => assertOpaqueResponseModel("deepseek-v4-pro"),
    /explicitly forbidden Pro response model/u,
  );
});

test(
  "authorized fixed-Flash protocol keeps two live Sessions durable and closed",
  {
    timeout: LIVE_TEST_TIMEOUT_MS,
  },
  async (context) => {
    assert.ok(
      LIVE_ENABLED,
      "live protocol is fail-closed unless DSH_LIVE=1 is set exactly",
    );
    const credential = loadDeepSeekCredential({ projectRoot: PROJECT_ROOT });
    const noToolWorkspace = await mkdtemp(
      join(tmpdir(), "simpledsh-stage06-live-no-tool-"),
    );
    const readWorkspace = await mkdtemp(
      join(tmpdir(), "simpledsh-stage06-live-read-"),
    );
    context.after(async () => {
      await Promise.all([
        rm(noToolWorkspace, { recursive: true, force: true }),
        rm(readWorkspace, { recursive: true, force: true }),
      ]);
    });

    await writeFile(join(readWorkspace, READ_MARKER_PATH), `${READ_MARKER}\n`, {
      flag: "wx",
      mode: 0o600,
    });

    const noToolSessionId = newSessionId();
    const noToolResult = await runBoundedOfficialSession({
      workspaceRoot: noToolWorkspace,
      sessionId: noToolSessionId,
      credential,
      environmentFacts: {},
      userInput:
        `Do not call any tool. Reply with exactly this stable marker and no other text: ${NO_TOOL_MARKER}`,
    });
    assert.ok(
      noToolResult.content.trim() === NO_TOOL_MARKER,
      "no-tool response did not report the stable marker exactly",
    );
    assert.ok(noToolResult.requestCount === 1, "no-tool Session used extra model turns");
    const noToolReplay = await reopenCleanly(noToolWorkspace, noToolSessionId);
    const noToolPhysicalRequests = await assertSnapshotsAndAttemptOrder(noToolReplay);
    assertImmediateCheckpoints(noToolReplay.events);
    assertNoOrphans(noToolReplay.events);
    assertCompletedRun(noToolReplay.events);
    const noToolAssistants = await loadAssistantRecords(noToolReplay);
    assert.ok(noToolAssistants.length === 1, "no-tool Session has extra responses");
    assert.ok(
      noToolAssistants[0]?.view.toolCalls.length === 0,
      "no-tool Session emitted a tool call",
    );
    assert.ok(
      !noToolReplay.events.some(
        (event) =>
          event.type === "tool_result_committed" ||
          event.type.startsWith("effect_"),
      ),
      "no-tool Session produced tool or Effect state",
    );

    const readSessionId = newSessionId();
    const readResult = await runBoundedOfficialSession({
      workspaceRoot: readWorkspace,
      sessionId: readSessionId,
      credential,
      environmentFacts: {},
      userInput:
        `Call the read tool exactly once with path ${JSON.stringify(READ_MARKER_PATH)}. After the tool result, reply with exactly the marker from the file and no other text.`,
    });
    assert.ok(
      readResult.content.trim() === READ_MARKER,
      "read roundtrip did not report the synthetic marker exactly",
    );
    assert.ok(readResult.requestCount === 2, "read Session was not one tool roundtrip");
    const readReplay = await reopenCleanly(readWorkspace, readSessionId);
    const readPhysicalRequests = await assertSnapshotsAndAttemptOrder(readReplay);
    assertImmediateCheckpoints(readReplay.events);
    assertNoOrphans(readReplay.events);
    assertCompletedRun(readReplay.events);

    const readAssistants = await loadAssistantRecords(readReplay);
    assert.ok(readAssistants.length === 2, "read Session has extra responses");
    const toolCallingAssistant = readAssistants[0];
    const finalAssistant = readAssistants[1];
    assert.ok(
      toolCallingAssistant?.view.toolCalls.length === 1 &&
        toolCallingAssistant.view.toolCalls[0]?.function.name === "read",
      "read Session did not issue exactly one read call",
    );
    assert.ok(
      finalAssistant?.view.toolCalls.length === 0,
      "read Session final response emitted another tool call",
    );
    const readCall = toolCallingAssistant.view.toolCalls[0];
    let readArguments: unknown;
    try {
      readArguments = JSON.parse(readCall.function.arguments);
    } catch {
      assert.fail("read call arguments are not valid JSON");
    }
    assert.ok(
      isRecord(readArguments) &&
        readArguments["path"] === READ_MARKER_PATH,
      "read call did not target the synthetic marker file",
    );

    const toolResults = readReplay.events.filter(
      (event) => event.type === "tool_result_committed",
    );
    assert.ok(
      toolResults.length === 1 &&
        toolResults[0]?.payload.toolCallId === readCall.id &&
        toolResults[0].payload.effectId === null,
      "read call has no unique effect-free tool result",
    );
    const permissions = readReplay.events.filter(
      (event) => event.type === "permission_decided",
    );
    assert.ok(
      permissions.length === 1 &&
        permissions[0]?.payload.toolCallId === readCall.id &&
        permissions[0].payload.finalDecision === "allow",
      "read call has no unique allow decision",
    );
    assert.ok(
      !readReplay.events.some((event) => event.type.startsWith("effect_")),
      "read-only roundtrip created Effect state",
    );

    const noToolUsage = redactedUsage(noToolReplay.events);
    const readUsage = redactedUsage(readReplay.events);
    const noToolResponseModels = noToolReplay.events
      .filter(
        (event): event is AssistantEvent => event.type === "assistant_committed",
      )
      .map((event) => event.payload.responseModel);
    const readResponseModels = readReplay.events
      .filter(
        (event): event is AssistantEvent => event.type === "assistant_committed",
      )
      .map((event) => event.payload.responseModel);
    context.diagnostic(
      JSON.stringify({
        evidence: "simpledsh-stage06-live-protocol-redacted-v1",
        sessions: [
          {
            kind: "no_tool",
            requestCount: noToolPhysicalRequests,
            usage: noToolUsage,
            responseModels: noToolResponseModels,
            publishedRegularPriceEstimateUsd:
              publishedRegularPriceEstimateUsd(noToolUsage),
          },
          {
            kind: "read_roundtrip",
            requestCount: readPhysicalRequests,
            usage: readUsage,
            responseModels: readResponseModels,
            publishedRegularPriceEstimateUsd:
              publishedRegularPriceEstimateUsd(readUsage),
          },
        ],
      }),
    );
  },
);
