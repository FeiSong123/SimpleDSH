import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { INLINE_BLOB_LIMIT } from "../../src/blob/index.js";
import {
  encodeToolOutputData,
} from "../../src/artifact/tool-output.js";
import { materializeAssistant } from "../../src/bytes/assistant.js";
import { concatBytes, sha256Hex, utf8Bytes } from "../../src/bytes/ops.js";
import {
  buildDeepSeekRequestSnapshot,
  DEEPSEEK_MODEL,
} from "../../src/bytes/request.js";
import { ACTIVE_SYSTEM_MESSAGE_BYTES } from "../../src/bytes/system.js";
import { materializeUserMessage } from "../../src/bytes/user.js";
import { DeepSeekTransportError } from "../../src/ds/transport.js";
import type {
  CompletedDeepSeekResponse,
  DeepSeekSemanticFragment,
  DeepSeekUsage,
  ToolCall,
} from "../../src/ds/types.js";
import {
  openJournal,
  type AnyVerifiedJournalEvent,
  type CanonicalTimestamp,
  type EventId,
  type EventIdentitySource,
  type JournalEventType,
  type SessionId,
  type VerifiedJournalEvent,
} from "../../src/journal/index.js";
import {
  captureSessionEnvironment,
  runSessionFixture,
  SessionInterruptedError,
  SessionKernelError,
  type SessionFixtureInput,
  type SessionFixtureTurn,
} from "../../src/session/index.js";

type BeforeSendObservation = Parameters<
  NonNullable<SessionFixtureInput["onBeforeSend"]>
>[0];

const FIXED_AT = "2026-08-04T08:00:00.000Z" as CanonicalTimestamp;
const fixedClock = Object.freeze({ now: () => FIXED_AT });

function sessionId(fill: string): SessionId {
  return `ses_${fill.repeat(32)}` as SessionId;
}

function eventIds(fill: string): EventIdentitySource {
  let counter = 0;
  return Object.freeze({
    nextEventId: () => {
      counter += 1;
      const suffix = counter.toString(16);
      return `evt_${fill.repeat(32 - suffix.length)}${suffix}` as EventId;
    },
  });
}

async function workspace(t: TestContext, label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `simpledsh-session-${label}-`));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 500; count += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not become true");
}

function frozenToolCalls(calls: readonly ToolCall[]): readonly ToolCall[] {
  return Object.freeze(
    calls.map((call) =>
      Object.freeze({
        id: call.id,
        type: "function" as const,
        function: Object.freeze({ ...call.function }),
      }),
    ),
  );
}

function toolCall(
  id: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
): ToolCall {
  return Object.freeze({
    id,
    type: "function" as const,
    function: Object.freeze({ name, arguments: JSON.stringify(args) }),
  });
}

function usage(rawFinishReason: string): DeepSeekUsage {
  return Object.freeze({
    promptTokens: 12,
    promptCacheHitTokens: 2,
    promptCacheMissTokens: 10,
    completionTokens: 4,
    reasoningTokens: 1,
    rawFinishReason,
  });
}

function completedResponse(input: Readonly<{
  content: string;
  reasoningContent: string;
  toolCalls?: readonly ToolCall[];
  semanticDeltaCount?: number;
  providerRequestId: string;
}>): CompletedDeepSeekResponse {
  const toolCalls = frozenToolCalls(input.toolCalls ?? []);
  const materialization = Object.freeze({
    content: input.content,
    reasoningContent: input.reasoningContent,
    toolCalls,
  });
  return Object.freeze({
    assistantBytes: materializeAssistant(materialization),
    content: materialization.content,
    reasoningContent: materialization.reasoningContent,
    toolCalls,
    usage: usage(toolCalls.length === 0 ? "stop" : "tool_calls"),
    providerRequestId: input.providerRequestId,
    responseModel: DEEPSEEK_MODEL,
    systemFingerprint: null,
    semanticDeltaCount: input.semanticDeltaCount ?? 1,
  });
}

function success(
  response: CompletedDeepSeekResponse,
  fragments: readonly DeepSeekSemanticFragment[],
): SessionFixtureTurn {
  return Object.freeze({
    kind: "success" as const,
    response,
    fragments: Object.freeze([...fragments]),
  });
}

function postSemanticFailure(
  fragments: readonly DeepSeekSemanticFragment[] = [],
): SessionFixtureTurn {
  return Object.freeze({
    kind: "interrupted" as const,
    failure: new DeepSeekTransportError("transport", "FIXTURE_RESET"),
    semanticState: "post_semantic" as const,
    decision: Object.freeze({
      retry: false,
      delayMs: null,
      retryClass: "transport_unknown" as const,
      integritySelfCheck: false,
    }),
    fragments: Object.freeze([...fragments]),
  });
}

function twoTurnResponses(readPath: string): readonly SessionFixtureTurn[] {
  const readCall = Object.freeze({
    id: "call_read_1",
    type: "function" as const,
    function: Object.freeze({
      name: "read",
      arguments: JSON.stringify({ path: readPath }),
    }),
  });
  const first = completedResponse({
    content: "",
    reasoningContent: "Read the requested fixture.",
    toolCalls: [readCall],
    semanticDeltaCount: 1,
    providerRequestId: "fixture-request-1",
  });
  const second = completedResponse({
    content: "The fixture was read.",
    reasoningContent: "The read result is sufficient.",
    semanticDeltaCount: 1,
    providerRequestId: "fixture-request-2",
  });
  return Object.freeze([
    success(first, [Object.freeze({ kind: "tool_call" as const })]),
    success(second, [
      Object.freeze({ kind: "content" as const, text: second.content }),
    ]),
  ]);
}

async function replay(
  root: string,
  id: SessionId,
  fill: string,
): Promise<readonly AnyVerifiedJournalEvent[]> {
  const reopened = await openJournal(root, id, fixedClock, eventIds(fill));
  try {
    return reopened.replay.events;
  } finally {
    await reopened.writer.close();
  }
}

function eventAt<Type extends JournalEventType>(
  events: readonly AnyVerifiedJournalEvent[],
  index: number,
  type: Type,
): VerifiedJournalEvent<Type> {
  const event = events[index];
  assert.ok(event, `missing event at index ${String(index)}`);
  assert.equal(event.type, type);
  return event as VerifiedJournalEvent<Type>;
}

function eventTypes(
  events: readonly AnyVerifiedJournalEvent[],
): readonly JournalEventType[] {
  return events.map((event) => event.type);
}

function wireRecord(bytes: Uint8Array): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

test("session Git environment rejects enumerable prototype variables", async (t) => {
  const root = await workspace(t, "git-environment");
  const tracePath = join(root, "prototype-git-trace.log");
  Object.defineProperty(Object.prototype, "GIT_TRACE", {
    configurable: true,
    enumerable: true,
    value: tracePath,
  });
  try {
    await captureSessionEnvironment(root);
  } finally {
    delete (Object.prototype as Record<string, unknown>)["GIT_TRACE"];
  }
  await assert.rejects(access(tracePath), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("single loop commits user boundary, one real read tool result, and final boundary with exact replay", async (t) => {
  const root = await workspace(t, "single-loop");
  const id = sessionId("1");
  await writeFile(join(root, "fixture.txt"), "fixture-read-body\n", "utf8");

  const result = await runSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "Read fixture.txt and report completion.",
    turns: twoTurnResponses("fixture.txt"),
    clock: fixedClock,
    eventIds: eventIds("a"),
  });

  assert.deepEqual(
    {
      status: result.status,
      sessionId: result.sessionId,
      content: result.content,
      requestCount: result.requestCount,
    },
    {
      status: "completed",
      sessionId: id,
      content: "The fixture was read.",
      requestCount: 2,
    },
  );

  const events = await replay(root, id, "b");
  assert.deepEqual(eventTypes(events), [
    "session_started",
    "artifact_published",
    "cache_abi_declared",
    "lineage_started",
    "lineage_activated",
    "run_started",
    "artifact_published",
    "fact_recorded",
    "user_committed",
    "commit_boundary_created",
    "request_snapshot_stored",
    "request_attempt_started",
    "request_semantic_started",
    "assistant_committed",
    "cache_checkpoint_created",
    "permission_decided",
    "artifact_published",
    "tool_result_committed",
    "commit_boundary_created",
    "request_snapshot_stored",
    "request_attempt_started",
    "request_semantic_started",
    "assistant_committed",
    "cache_checkpoint_created",
    "commit_boundary_created",
    "run_completed",
  ]);

  const user = eventAt(events, 8, "user_committed");
  const userBoundary = eventAt(events, 9, "commit_boundary_created");
  const firstSnapshot = eventAt(events, 10, "request_snapshot_stored");
  const toolAssistant = eventAt(events, 13, "assistant_committed");
  const toolCheckpoint = eventAt(events, 14, "cache_checkpoint_created");
  const permission = eventAt(events, 15, "permission_decided");
  const readArtifact = eventAt(events, 16, "artifact_published");
  const toolResult = eventAt(events, 17, "tool_result_committed");
  const toolBoundary = eventAt(events, 18, "commit_boundary_created");
  const secondSnapshot = eventAt(events, 19, "request_snapshot_stored");
  const finalAssistant = eventAt(events, 22, "assistant_committed");
  const finalCheckpoint = eventAt(events, 23, "cache_checkpoint_created");
  const finalBoundary = eventAt(events, 24, "commit_boundary_created");
  const completed = eventAt(events, 25, "run_completed");

  assert.deepEqual(userBoundary.payload.sourceEventIds, [user.id]);
  assert.equal(firstSnapshot.payload.commitBoundaryId, userBoundary.payload.commitBoundaryId);
  assert.equal(toolCheckpoint.payload.sourceAssistantEventId, toolAssistant.id);
  assert.deepEqual(permission.payload, {
    toolCallId: "call_read_1",
    policyDecision: "allow",
    finalDecision: "allow",
    resolution: "policy",
  });
  assert.equal(readArtifact.payload.artifactType, "tool_output");
  assert.equal(readArtifact.payload.toolCallId, "call_read_1");
  assert.equal(readArtifact.payload.terminal?.status, "succeeded");
  assert.equal(readArtifact.payload.terminal?.code, "ok");
  assert.ok((readArtifact.payload.streamBytes?.read ?? 0) > 0);
  assert.equal(toolResult.payload.artifactId, readArtifact.payload.artifactId);
  assert.deepEqual(toolBoundary.payload.sourceEventIds, [toolResult.id]);
  assert.equal(secondSnapshot.payload.commitBoundaryId, toolBoundary.payload.commitBoundaryId);
  assert.equal(finalCheckpoint.payload.sourceAssistantEventId, finalAssistant.id);
  assert.equal(finalBoundary.payload.cacheCheckpointId, finalCheckpoint.payload.cacheCheckpointId);
  assert.deepEqual(finalBoundary.payload.sourceEventIds, [finalAssistant.id]);
  assert.equal(completed.payload.commitBoundaryId, finalBoundary.payload.commitBoundaryId);
  assert.equal(completed.payload.sourceAssistantEventId, finalAssistant.id);
  assert.equal(result.commitBoundaryId, finalBoundary.payload.commitBoundaryId);
});

test("normal turns retain bounded Artifact handles while tampered and cross-Session refs stay unbound", async (t) => {
  const root = await workspace(t, "artifact-handle-turns");
  const lines = Array.from(
    { length: 2_000 },
    (_, index) => `record-${String(index).padStart(4, "0")}-${"x".repeat(24)}\n`,
  );
  const sourceBytes = utf8Bytes(lines.join(""));
  await writeFile(join(root, "large.txt"), sourceBytes.copy());
  const sourceFrameParts: ReturnType<typeof encodeToolOutputData>[] = [];
  const raw = sourceBytes.copy();
  for (let chunkOffset = 0; chunkOffset < raw.byteLength; chunkOffset += 32_768) {
    const chunk = raw.subarray(
      chunkOffset,
      Math.min(raw.byteLength, chunkOffset + 32_768),
    );
    let cursor = 0;
    while (cursor < chunk.byteLength) {
      const lf = chunk.indexOf(0x0a, cursor);
      const end = lf === -1 ? chunk.byteLength : lf + 1;
      sourceFrameParts.push(
        encodeToolOutputData("read", chunk.subarray(cursor, end)),
      );
      cursor = end;
    }
  }
  const sourceFrames = concatBytes(sourceFrameParts);
  const artifactRef = `artifacts/sha256/${sha256Hex(sourceFrames)}`;
  const selectedLine = lines[1_234];
  assert.ok(selectedLine);
  const selectedFrame = encodeToolOutputData("read", utf8Bytes(selectedLine));
  const observations: BeforeSendObservation[] = [];
  const id = sessionId("e");
  await runSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "Read the large fixture, then one bounded Artifact record.",
    turns: Object.freeze([
      success(completedResponse({
        content: "",
        reasoningContent: "Read the source.",
        toolCalls: [toolCall("call_large_source", "read", {
          path: "large.txt",
          limit: 2_000,
        })],
        providerRequestId: "artifact-request-1",
      }), [Object.freeze({ kind: "tool_call" as const })]),
      success(completedResponse({
        content: "",
        reasoningContent: "Read one durable record.",
        toolCalls: [toolCall("call_artifact_slice", "read", {
          path: artifactRef,
          offset: 1_234,
          limit: 1,
        })],
        providerRequestId: "artifact-request-2",
      }), [Object.freeze({ kind: "tool_call" as const })]),
      success(completedResponse({
        content: "done",
        reasoningContent: "The bounded record is available.",
        providerRequestId: "artifact-request-3",
      }), [Object.freeze({ kind: "content" as const, text: "done" })]),
    ]),
    clock: fixedClock,
    eventIds: eventIds("e"),
    onBeforeSend: (observation) => {
      observations.push(observation);
    },
  });
  assert.equal(observations.length, 3);
  const secondBody = new TextDecoder("utf-8", { fatal: true }).decode(
    observations[1]!.snapshot.body.copy(),
  );
  const secondRequest = JSON.parse(secondBody) as Readonly<{
    readonly messages: readonly Readonly<{
      readonly role: string;
      readonly content: string;
    }>[];
  }>;
  const firstToolMessage = secondRequest.messages.find(({ role }) => role === "tool");
  assert.ok(firstToolMessage);
  const firstToolContent = JSON.parse(firstToolMessage.content) as Record<string, unknown>;
  assert.equal(firstToolContent["artifact_ref"], artifactRef);
  assert.equal(firstToolContent["truncated"], true);
  assert.equal(secondBody.includes("artifact_id"), false);
  assert.equal(secondBody.includes("artifact_sha256"), false);
  assert.equal(secondBody.includes("byte_count"), false);

  const events = await replay(root, id, "f");
  const sourceArtifact = events.find(
    (event): event is VerifiedJournalEvent<"artifact_published"> =>
      event.type === "artifact_published" &&
      event.payload.toolCallId === "call_large_source",
  );
  const sliceArtifact = events.find(
    (event): event is VerifiedJournalEvent<"artifact_published"> =>
      event.type === "artifact_published" &&
      event.payload.toolCallId === "call_artifact_slice",
  );
  assert.ok(sourceArtifact);
  assert.ok(sliceArtifact);
  assert.equal(sourceArtifact.payload.artifactRef, artifactRef);
  assert.equal(sourceArtifact.payload.terminal?.code, "ok");
  assert.equal(sliceArtifact.payload.terminal?.code, "ok");
  assert.equal(
    sliceArtifact.payload.artifactHash,
    `sha256:${sha256Hex(selectedFrame)}`,
  );

  const otherId = sessionId("f");
  const tamperedRef = `${artifactRef.slice(0, -1)}${artifactRef.endsWith("0") ? "1" : "0"}`;
  await runSessionFixture({
    workspaceRoot: root,
    sessionId: otherId,
    userInput: "Attempt two unbound Artifact handles.",
    turns: Object.freeze([
      success(completedResponse({
        content: "",
        reasoningContent: "Probe only the supplied handles.",
        toolCalls: [
          toolCall("call_cross_session_ref", "read", { path: artifactRef }),
          toolCall("call_tampered_ref", "read", { path: tamperedRef }),
        ],
        providerRequestId: "artifact-reject-1",
      }), [Object.freeze({ kind: "tool_call" as const })]),
      success(completedResponse({
        content: "rejected",
        reasoningContent: "Neither handle was bound.",
        providerRequestId: "artifact-reject-2",
      }), [Object.freeze({ kind: "content" as const, text: "rejected" })]),
    ]),
    clock: fixedClock,
    eventIds: eventIds("f"),
  });
  const rejectedEvents = await replay(root, otherId, "0");
  for (const callId of ["call_cross_session_ref", "call_tampered_ref"]) {
    const artifact = rejectedEvents.find(
      (event): event is VerifiedJournalEvent<"artifact_published"> =>
        event.type === "artifact_published" &&
        event.payload.toolCallId === callId,
    );
    assert.ok(artifact);
    assert.equal(artifact.payload.terminal?.code, "invalid_arguments");
    assert.equal(artifact.payload.byteCount, 0);
  }
});

test("durable user and snapshot before send preserve fixed backend bytes despite model overrides", async (t) => {
  const root = await workspace(t, "before-send");
  const id = sessionId("2");
  const userInput = "Read input.txt once.";
  await writeFile(join(root, "input.txt"), "durable-before-send\n", "utf8");
  const observations: BeforeSendObservation[] = [];

  const untrustedOverrides = Object.freeze({
    model: "not-deepseek",
    endpoint: "https://example.invalid/steal",
    thinking: Object.freeze({ type: "disabled" }),
    reasoning_effort: "high",
  });
  const input = Object.freeze({
    ...untrustedOverrides,
    workspaceRoot: root,
    sessionId: id,
    userInput,
    turns: twoTurnResponses("input.txt"),
    clock: fixedClock,
    eventIds: eventIds("c"),
    onBeforeSend: (observation: (typeof observations)[number]) => {
      observations.push(observation);
    },
  });

  await runSessionFixture(input);
  assert.equal(observations.length, 2);

  for (const observation of observations) {
    const acknowledged = observation.acknowledgedEvents;
    const snapshotEvent = eventAt(
      acknowledged,
      acknowledged.length - 1,
      "request_snapshot_stored",
    );
    const sourceBoundary = acknowledged.find(
      (event): event is VerifiedJournalEvent<"commit_boundary_created"> =>
        event.type === "commit_boundary_created" &&
        event.payload.commitBoundaryId === snapshotEvent.payload.commitBoundaryId,
    );
    assert.ok(sourceBoundary, "Snapshot must cite an acknowledged Boundary");
    assert.ok(
      acknowledged.some(
        (event) =>
          event.type === "commit_boundary_created" &&
          event.payload.sourceEventIds.some((sourceId) =>
            acknowledged.some(
              (candidate) =>
                candidate.id === sourceId && candidate.type === "user_committed",
            ),
          ),
      ),
      "the durable user Boundary must be visible before every send",
    );
    assert.equal(
      snapshotEvent.payload.bodyHash,
      `sha256:${observation.snapshot.bodySha256}`,
    );
    assert.equal(snapshotEvent.payload.byteCount, observation.snapshot.byteCount);
    const body = wireRecord(observation.snapshot.body.copy());
    assert.equal(body["model"], DEEPSEEK_MODEL);
    assert.equal(body["stream"], true);
    assert.equal(body["reasoning_effort"], "max");
    assert.equal(body["max_tokens"], 65_536);
    assert.deepEqual(body["thinking"], { type: "enabled" });
    assert.equal(JSON.stringify(body).includes("not-deepseek"), false);
    assert.equal(JSON.stringify(body).includes("example.invalid"), false);
  }

  const expectedFirst = buildDeepSeekRequestSnapshot([
    ACTIVE_SYSTEM_MESSAGE_BYTES,
    materializeUserMessage(userInput),
  ]);
  assert.deepEqual(
    observations[0]?.snapshot.body.copy(),
    expectedFirst.body.copy(),
    "the first provider-visible body must be the exact frozen protocol bytes",
  );
  assert.equal(observations[0]?.snapshot.bodySha256, expectedFirst.bodySha256);
});

test("atomic assistant preview fragments remain uncommitted after interruption", async (t) => {
  const root = await workspace(t, "preview-partial");
  const id = sessionId("3");
  const fragments = Object.freeze([
    Object.freeze({ kind: "reasoning" as const, text: "partial thought" }),
    Object.freeze({ kind: "content" as const, text: "partial answer" }),
    Object.freeze({ kind: "tool_call" as const }),
  ]);
  const previewed: DeepSeekSemanticFragment[] = [];

  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Interrupt after preview.",
      turns: [postSemanticFailure(fragments)],
      onPreview: (fragment) => {
        previewed.push(fragment);
      },
      clock: fixedClock,
      eventIds: eventIds("d"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof SessionInterruptedError);
      assert.equal(error.reason, "semantic_interrupted");
      return true;
    },
  );

  assert.deepEqual(previewed, fragments);
  const events = await replay(root, id, "e");
  assert.equal(events.some((event) => event.type === "assistant_committed"), false);
  assert.equal(events.some((event) => event.type === "tool_result_committed"), false);
  assert.deepEqual(eventTypes(events).slice(-3), [
    "request_semantic_started",
    "request_interrupted",
    "run_interrupted",
  ]);
});

test("a never-settling preview observer cannot block fixture request truth", async (t) => {
  const root = await workspace(t, "preview-never-settles");
  const id = sessionId("b");
  const final = completedResponse({
    content: "The durable response completes.",
    reasoningContent: "Preview is not request truth.",
    semanticDeltaCount: 2,
    providerRequestId: "fixture-preview-never-settles",
  });
  let releasePreview = (): void => {
    throw new Error("preview gate was not initialized");
  };
  const previewGate = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  let previewCalls = 0;
  let resultContent: string | undefined;
  let failure: unknown;

  const pending = runSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "Finish even when preview rendering never settles.",
    turns: [
      success(final, [
        Object.freeze({ kind: "reasoning" as const, text: final.reasoningContent }),
        Object.freeze({ kind: "content" as const, text: final.content }),
      ]),
    ],
    onPreview: () => {
      previewCalls += 1;
      return previewGate;
    },
    clock: fixedClock,
    eventIds: eventIds("b"),
  });
  const observed = pending.then(
    (result) => {
      resultContent = result.content;
    },
    (error: unknown) => {
      failure = error;
    },
  );

  try {
    await waitUntil(() => previewCalls === 1);
    await waitUntil(() => resultContent !== undefined || failure !== undefined);
    assert.equal(failure, undefined);
    assert.equal(resultContent, final.content);
    assert.equal(previewCalls, 1);
    const events = await replay(root, id, "b");
    assert.equal(events.at(-1)?.type, "run_completed");
    assert.equal(
      events.some((event) => event.type === "request_interrupted"),
      false,
    );
  } finally {
    releasePreview();
    await observed;
  }
});

test("a rejecting preview observer is disabled without changing fixture completion", async (t) => {
  const root = await workspace(t, "preview-rejects");
  const id = sessionId("f");
  const final = completedResponse({
    content: "The durable response remains successful.",
    reasoningContent: "Preview rejection is observational only.",
    semanticDeltaCount: 2,
    providerRequestId: "fixture-preview-rejects",
  });
  let previewCalls = 0;

  const result = await runSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "Ignore a failed preview renderer.",
    turns: [
      success(final, [
        Object.freeze({ kind: "reasoning" as const, text: final.reasoningContent }),
        Object.freeze({ kind: "content" as const, text: final.content }),
      ]),
    ],
    onPreview: () => {
      previewCalls += 1;
      return Promise.reject(new Error("fixture preview rejection"));
    },
    clock: fixedClock,
    eventIds: eventIds("f"),
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(result.status, "completed");
  assert.equal(result.content, final.content);
  assert.equal(previewCalls, 1);
  const events = await replay(root, id, "f");
  assert.equal(events.at(-1)?.type, "run_completed");
  assert.equal(
    events.some((event) => event.type === "request_interrupted"),
    false,
  );
});

test("semantic interruption records the canonical terminal pair without transparent retry", async (t) => {
  const root = await workspace(t, "semantic-interruption");
  const id = sessionId("4");
  let sends = 0;
  const unreachableSuccess = completedResponse({
    content: "must not be reached",
    reasoningContent: "",
    semanticDeltaCount: 0,
    providerRequestId: "unreachable-request",
  });

  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Do not retry a semantic interruption.",
      turns: [postSemanticFailure(), success(unreachableSuccess, [])],
      onBeforeSend: () => {
        sends += 1;
      },
      clock: fixedClock,
      eventIds: eventIds("5"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof SessionInterruptedError);
      assert.equal(error.reason, "semantic_interrupted");
      return true;
    },
  );

  assert.equal(sends, 1);
  const events = await replay(root, id, "6");
  assert.equal(
    events.filter((event) => event.type === "request_attempt_started").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "request_snapshot_stored").length,
    1,
  );
  assert.deepEqual(eventTypes(events).slice(-4), [
    "request_attempt_started",
    "request_semantic_started",
    "request_interrupted",
    "run_interrupted",
  ]);
  const interrupted = eventAt(events, events.length - 2, "request_interrupted");
  const runInterrupted = eventAt(events, events.length - 1, "run_interrupted");
  assert.equal(interrupted.payload.semanticState, "post_semantic");
  assert.equal(interrupted.payload.retryClass, "transport_unknown");
  assert.equal(interrupted.payload.outcome, "transport_error");
  assert.equal(runInterrupted.payload.reason, "semantic_interrupted");
  assert.equal(runInterrupted.payload.sourceEventId, interrupted.id);
});

test("pre-aborted AbortSignal sends nothing and closes only after the mandatory user Boundary", async (t) => {
  const root = await workspace(t, "pre-abort");
  const id = sessionId("7");
  const controller = new AbortController();
  controller.abort();
  let sends = 0;

  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Persist me before cancellation.",
      turns: [],
      signal: controller.signal,
      onBeforeSend: () => {
        sends += 1;
      },
      clock: fixedClock,
      eventIds: eventIds("8"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof SessionInterruptedError);
      assert.equal(error.reason, "cancelled");
      return true;
    },
  );

  assert.equal(sends, 0);
  const events = await replay(root, id, "9");
  assert.deepEqual(eventTypes(events), [
    "session_started",
    "artifact_published",
    "cache_abi_declared",
    "lineage_started",
    "lineage_activated",
    "run_started",
    "artifact_published",
    "fact_recorded",
    "user_committed",
    "commit_boundary_created",
    "run_interrupted",
  ]);
  const boundary = eventAt(events, 9, "commit_boundary_created");
  const interrupted = eventAt(events, 10, "run_interrupted");
  assert.equal(interrupted.payload.sourceEventId, boundary.id);
  assert.equal(interrupted.payload.reason, "cancelled");
});

test("invalid response bytes and fields fail closed without a partial assistant", async (t) => {
  const root = await workspace(t, "invalid-response");
  const id = sessionId("a");
  const canonical = completedResponse({
    content: "canonical whole response",
    reasoningContent: "canonical reasoning",
    semanticDeltaCount: 0,
    providerRequestId: "invalid-fixture-request",
  });
  const inconsistent = Object.freeze({
    ...canonical,
    content: "field does not match assistantBytes",
  });

  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Reject an inconsistent completed response.",
      turns: [success(inconsistent, [])],
      clock: fixedClock,
      eventIds: eventIds("b"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof SessionInterruptedError);
      assert.equal(error.reason, "request_failed");
      return true;
    },
  );

  const events = await replay(root, id, "c");
  assert.equal(events.some((event) => event.type === "assistant_committed"), false);
  assert.equal(events.some((event) => event.type === "cache_checkpoint_created"), false);
  assert.equal(events.some((event) => event.type === "run_completed"), false);
  assert.equal(
    events.filter((event) => event.type === "commit_boundary_created").length,
    1,
  );
  assert.deepEqual(eventTypes(events).slice(-4), [
    "request_snapshot_stored",
    "request_attempt_started",
    "request_interrupted",
    "run_interrupted",
  ]);
  const interrupted = eventAt(events, events.length - 2, "request_interrupted");
  const terminal = eventAt(events, events.length - 1, "run_interrupted");
  assert.equal(interrupted.payload.outcome, "protocol_error");
  assert.equal(interrupted.payload.semanticState, "pre_semantic");
  assert.equal(terminal.payload.reason, "request_failed");
  assert.equal(terminal.payload.sourceEventId, interrupted.id);
});

test("multi-tool result batch commits two reads and one write in declared order before the next Snapshot", async (t) => {
  const root = await workspace(t, "multi-tool-order");
  const id = sessionId("d");
  await Promise.all([
    writeFile(join(root, "first.txt"), "first body\n", "utf8"),
    writeFile(join(root, "second.txt"), "second body\n", "utf8"),
  ]);
  const calls = Object.freeze([
    toolCall("call_read_first", "read", { path: "first.txt" }),
    toolCall("call_read_second", "read", { path: "second.txt" }),
    toolCall("call_write_third", "write", {
      path: "written.txt",
      content: "written by the real runtime\n",
    }),
  ]);
  const tools = completedResponse({
    content: "",
    reasoningContent: "Read both inputs, then write the requested output.",
    toolCalls: calls,
    providerRequestId: "fixture-multi-tool-request",
  });
  const final = completedResponse({
    content: "The reads and write completed.",
    reasoningContent: "The complete tool batch is durable.",
    providerRequestId: "fixture-multi-tool-final",
  });

  await runSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "Read two files and write one file.",
    turns: [
      success(tools, [Object.freeze({ kind: "tool_call" as const })]),
      success(final, [
        Object.freeze({ kind: "content" as const, text: final.content }),
      ]),
    ],
    clock: fixedClock,
    eventIds: eventIds("e"),
  });

  assert.equal(
    await readFile(join(root, "written.txt"), "utf8"),
    "written by the real runtime\n",
  );
  const events = await replay(root, id, "f");
  const results = events.filter(
    (event): event is VerifiedJournalEvent<"tool_result_committed"> =>
      event.type === "tool_result_committed",
  );
  assert.deepEqual(
    results.map((event) => event.payload.toolCallId),
    calls.map((call) => call.id),
  );
  const toolBoundary = events.find(
    (event): event is VerifiedJournalEvent<"commit_boundary_created"> =>
      event.type === "commit_boundary_created" &&
      event.payload.sourceEventIds.length === results.length &&
      event.payload.sourceEventIds.every(
        (sourceId, index) => sourceId === results[index]?.id,
      ),
  );
  assert.ok(toolBoundary, "the complete batch must have one ordered Boundary");
  assert.deepEqual(
    toolBoundary.payload.sourceEventIds,
    results.map((event) => event.id),
  );
  const boundaryIndex = events.findIndex((event) => event.id === toolBoundary.id);
  const nextSnapshot = eventAt(
    events,
    boundaryIndex + 1,
    "request_snapshot_stored",
  );
  assert.equal(
    nextSnapshot.payload.commitBoundaryId,
    toolBoundary.payload.commitBoundaryId,
  );
});

test("a successful final response wins an AbortSignal and still creates its final boundary", async (t) => {
  const root = await workspace(t, "late-preview-abort");
  const id = sessionId("e");
  const controller = new AbortController();
  const final = completedResponse({
    content: "This complete response wins.",
    reasoningContent: "The transport has a complete successful response.",
    semanticDeltaCount: 2,
    providerRequestId: "fixture-late-abort-final",
  });

  const result = await runSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "Complete despite a late preview cancellation.",
    turns: [
      success(final, [
        Object.freeze({
          kind: "reasoning" as const,
          text: final.reasoningContent,
        }),
        Object.freeze({ kind: "content" as const, text: final.content }),
      ]),
    ],
    signal: controller.signal,
    onPreview: (fragment) => {
      if (fragment.kind === "content") controller.abort();
    },
    clock: fixedClock,
    eventIds: eventIds("5"),
  });

  assert.equal(controller.signal.aborted, true);
  assert.equal(result.status, "completed");
  assert.equal(result.content, final.content);
  const events = await replay(root, id, "2");
  assert.equal(
    events.some(
      (event) =>
        event.type === "request_interrupted" || event.type === "run_interrupted",
    ),
    false,
  );
  assert.deepEqual(eventTypes(events).slice(-4), [
    "assistant_committed",
    "cache_checkpoint_created",
    "commit_boundary_created",
    "run_completed",
  ]);
  const assistant = eventAt(events, events.length - 4, "assistant_committed");
  const checkpoint = eventAt(
    events,
    events.length - 3,
    "cache_checkpoint_created",
  );
  const boundary = eventAt(
    events,
    events.length - 2,
    "commit_boundary_created",
  );
  const completed = eventAt(events, events.length - 1, "run_completed");
  assert.equal(checkpoint.payload.sourceAssistantEventId, assistant.id);
  assert.deepEqual(boundary.payload.sourceEventIds, [assistant.id]);
  assert.equal(boundary.payload.cacheCheckpointId, checkpoint.payload.cacheCheckpointId);
  assert.equal(completed.payload.commitBoundaryId, boundary.payload.commitBoundaryId);
});

test("abort at the next before-send preserves the complete tool batch boundary and one interruption pair", async (t) => {
  const root = await workspace(t, "post-tool-before-send-abort");
  const id = sessionId("f");
  await writeFile(join(root, "source.txt"), "source body\n", "utf8");
  const controller = new AbortController();
  const calls = Object.freeze([
    toolCall("call_read_before_abort", "read", { path: "source.txt" }),
    toolCall("call_write_before_abort", "write", {
      path: "durable.txt",
      content: "durable before cancellation\n",
    }),
  ]);
  const tools = completedResponse({
    content: "",
    reasoningContent: "Complete this batch before the next request.",
    toolCalls: calls,
    providerRequestId: "fixture-before-send-abort-tools",
  });
  const unreachable = completedResponse({
    content: "must not commit",
    reasoningContent: "",
    semanticDeltaCount: 0,
    providerRequestId: "fixture-before-send-abort-unreachable",
  });
  let beforeSendCount = 0;

  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Complete tools, then cancel before the next send.",
      turns: [
        success(tools, [Object.freeze({ kind: "tool_call" as const })]),
        success(unreachable, []),
      ],
      signal: controller.signal,
      onBeforeSend: () => {
        beforeSendCount += 1;
        if (beforeSendCount === 2) controller.abort();
      },
      clock: fixedClock,
      eventIds: eventIds("3"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof SessionInterruptedError);
      assert.equal(error.reason, "cancelled");
      return true;
    },
  );

  assert.equal(beforeSendCount, 2);
  assert.equal(
    await readFile(join(root, "durable.txt"), "utf8"),
    "durable before cancellation\n",
  );
  const events = await replay(root, id, "4");
  const results = events.filter(
    (event): event is VerifiedJournalEvent<"tool_result_committed"> =>
      event.type === "tool_result_committed",
  );
  assert.deepEqual(
    results.map((event) => event.payload.toolCallId),
    calls.map((call) => call.id),
  );
  const toolBoundaries = events.filter(
    (event): event is VerifiedJournalEvent<"commit_boundary_created"> =>
      event.type === "commit_boundary_created" &&
      event.payload.sourceEventIds.length === results.length &&
      event.payload.sourceEventIds.every(
        (sourceId, index) => sourceId === results[index]?.id,
      ),
  );
  assert.equal(toolBoundaries.length, 1);
  const toolBoundary = toolBoundaries[0];
  assert.ok(toolBoundary);
  const nextSnapshot = events.find(
    (event): event is VerifiedJournalEvent<"request_snapshot_stored"> =>
      event.type === "request_snapshot_stored" &&
      event.payload.commitBoundaryId === toolBoundary.payload.commitBoundaryId,
  );
  assert.ok(nextSnapshot, "the cancelled send must still cite the tool Boundary");
  const requestInterruptions = events.filter(
    (event): event is VerifiedJournalEvent<"request_interrupted"> =>
      event.type === "request_interrupted",
  );
  const runInterruptions = events.filter(
    (event): event is VerifiedJournalEvent<"run_interrupted"> =>
      event.type === "run_interrupted",
  );
  assert.equal(requestInterruptions.length, 1);
  assert.equal(runInterruptions.length, 1);
  assert.equal(requestInterruptions[0]?.payload.outcome, "cancelled");
  assert.equal(requestInterruptions[0]?.payload.semanticState, "pre_semantic");
  assert.equal(runInterruptions[0]?.payload.reason, "cancelled");
  assert.equal(
    runInterruptions[0]?.payload.sourceEventId,
    requestInterruptions[0]?.id,
  );
  assert.equal(
    events.filter((event) => event.type === "assistant_committed").length,
    1,
  );
});

test("Snapshot CAS durability failure closes from the safe user boundary before any send", async (t) => {
  const root = await workspace(t, "snapshot-cas-failure");
  const id = sessionId("6");
  let casPublications = 0;
  let sends = 0;

  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Do not send after Snapshot storage fails.",
      turns: [],
      clock: fixedClock,
      eventIds: eventIds("6"),
      onBeforeSend: () => {
        sends += 1;
      },
      persistenceControls: {
        fault: (point) => {
          if (point !== "cas.after_temp_sync") return;
          casPublications += 1;
          if (casPublications === 3) {
            throw new Error("injected Snapshot CAS failure");
          }
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof SessionInterruptedError);
      assert.equal(error.reason, "durability_failure");
      return true;
    },
  );

  assert.equal(sends, 0);
  const events = await replay(root, id, "7");
  assert.equal(
    events.some((event) => event.type === "request_snapshot_stored"),
    false,
  );
  assert.equal(
    events.some((event) => event.type === "request_attempt_started"),
    false,
  );
  const boundary = eventAt(events, events.length - 2, "commit_boundary_created");
  const interrupted = eventAt(events, events.length - 1, "run_interrupted");
  assert.equal(interrupted.payload.reason, "durability_failure");
  assert.equal(interrupted.payload.sourceEventId, boundary.id);
});

test("assistant blob CAS durability failure closes the acknowledged attempt without a partial assistant", async (t) => {
  const root = await workspace(t, "assistant-cas-failure");
  const id = sessionId("7");
  let casPublications = 0;
  const largeContent = "x".repeat(INLINE_BLOB_LIMIT + 1);
  const response = completedResponse({
    content: largeContent,
    reasoningContent: "The complete response exceeds the inline blob limit.",
    providerRequestId: "fixture-assistant-cas-failure",
  });

  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Force an external assistant blob.",
      turns: [
        success(response, [
          Object.freeze({ kind: "content" as const, text: largeContent }),
        ]),
      ],
      clock: fixedClock,
      eventIds: eventIds("8"),
      persistenceControls: {
        fault: (point) => {
          if (point !== "cas.after_temp_sync") return;
          casPublications += 1;
          if (casPublications === 4) {
            throw new Error("injected assistant blob CAS failure");
          }
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof SessionInterruptedError);
      assert.equal(error.reason, "durability_failure");
      return true;
    },
  );

  const events = await replay(root, id, "9");
  assert.equal(
    events.some((event) => event.type === "assistant_committed"),
    false,
  );
  const requestInterrupted = eventAt(
    events,
    events.length - 2,
    "request_interrupted",
  );
  const runInterrupted = eventAt(events, events.length - 1, "run_interrupted");
  assert.equal(requestInterrupted.payload.outcome, "durability_error");
  assert.equal(requestInterrupted.payload.retryClass, "unknown");
  assert.equal(requestInterrupted.payload.semanticState, "post_semantic");
  assert.equal(runInterrupted.payload.reason, "durability_failure");
  assert.equal(runInterrupted.payload.sourceEventId, requestInterrupted.id);
});

test("ambiguous finalization acknowledgements never invent interruption terminals", async (t) => {
  const cases = [
    [14, "assistant_committed"],
    [15, "cache_checkpoint_created"],
    [16, "commit_boundary_created"],
    [17, "run_completed"],
  ] as const;

  for (const [targetAppend, expectedPhysicalTail] of cases) {
    await t.test(expectedPhysicalTail, async (inner) => {
      const root = await workspace(inner, `ambiguous-${expectedPhysicalTail}`);
      const id = sessionId(String.fromCharCode(97 + targetAppend - 14));
      let appendCount = 0;
      const response = completedResponse({
        content: "Complete response.",
        reasoningContent: "Complete reasoning.",
        providerRequestId: `fixture-ambiguous-${expectedPhysicalTail}`,
      });

      await assert.rejects(
        runSessionFixture({
          workspaceRoot: root,
          sessionId: id,
          userInput: "Exercise one finalization ambiguity.",
          turns: [
            success(response, [
              Object.freeze({
                kind: "content" as const,
                text: response.content,
              }),
            ]),
          ],
          clock: fixedClock,
          eventIds: eventIds(String(targetAppend - 13)),
          persistenceControls: {
            fault: (point) => {
              if (point !== "append.after_sync_before_ack") return;
              appendCount += 1;
              if (appendCount === targetAppend) {
                throw new Error("injected ambiguous append acknowledgement");
              }
            },
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof SessionKernelError);
          assert.equal(error.code, "durability_failure");
          return true;
        },
      );

      assert.equal(appendCount, targetAppend);
      const events = await replay(root, id, "d");
      assert.equal(events.at(-1)?.type, expectedPhysicalTail);
      assert.equal(
        events.some(
          (event) =>
            event.type === "request_interrupted" ||
            event.type === "run_interrupted",
        ),
        false,
      );
    });
  }
});

test(
  "a failed acknowledgement of cancellation after the tool boundary is durability failure, not false cancelled",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await workspace(t, "tool-boundary-cancel-ack");
    const id = sessionId("c");
    const controller = new AbortController();
    let appendCount = 0;
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
    const bashCall = toolCall("call_bash_cancel_ack", "bash", {
      command: "sleep 5",
      timeout: 10,
    });
    const tools = completedResponse({
      content: "",
      reasoningContent: "Run the bounded cancellation fixture.",
      toolCalls: [bashCall],
      providerRequestId: "fixture-tool-boundary-cancel-ack",
    });

    try {
      await assert.rejects(
        runSessionFixture({
          workspaceRoot: root,
          sessionId: id,
          userInput: "Cancel the bounded bash after it starts.",
          turns: [
            success(tools, [Object.freeze({ kind: "tool_call" as const })]),
          ],
          signal: controller.signal,
          onPreview: () => {
            cancellationTimer ??= setTimeout(() => controller.abort(), 100);
          },
          clock: fixedClock,
          eventIds: eventIds("e"),
          persistenceControls: {
            fault: (point) => {
              if (point !== "append.after_sync_before_ack") return;
              appendCount += 1;
              if (appendCount === 22) {
                throw new Error("injected cancellation terminal ambiguity");
              }
            },
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof SessionKernelError);
          assert.equal(error.code, "durability_failure");
          return true;
        },
      );
    } finally {
      if (cancellationTimer !== undefined) clearTimeout(cancellationTimer);
    }

    assert.equal(controller.signal.aborted, true);
    assert.equal(appendCount, 22);
    const events = await replay(root, id, "f");
    const toolResult = events.find(
      (event): event is VerifiedJournalEvent<"tool_result_committed"> =>
        event.type === "tool_result_committed",
    );
    const boundary = events.find(
      (event): event is VerifiedJournalEvent<"commit_boundary_created"> =>
        event.type === "commit_boundary_created" &&
        toolResult !== undefined &&
        event.payload.sourceEventIds.length === 1 &&
        event.payload.sourceEventIds[0] === toolResult.id,
    );
    assert.ok(toolResult);
    assert.ok(boundary);
    assert.equal(events.at(-1)?.type, "run_interrupted");
  },
);
