import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { createBlobStore } from "../../src/blob/store.js";
import { materializeAssistant } from "../../src/bytes/assistant.js";
import { utf8Bytes } from "../../src/bytes/ops.js";
import { buildDeepSeekRequestSnapshot } from "../../src/bytes/request.js";
import { materializeUserMessage } from "../../src/bytes/user.js";
import type { ToolCall } from "../../src/ds/types.js";
import { inspectWriterLease, quarantineWriterLease } from "../../src/journal/lease.js";
import {
  openJournal,
  type OpenJournalResult,
} from "../../src/journal/open.js";
import { createSessionPaths } from "../../src/journal/paths.js";
import type {
  AnyVerifiedJournalEvent,
  ArtifactId,
  AttemptId,
  CacheCheckpointId,
  CanonicalTimestamp,
  CommitBoundaryId,
  EventId,
  LineageId,
  RequestSnapshotId,
  RunId,
  SessionId,
} from "../../src/journal/types.js";
import { buildCacheAbiV1 } from "../../src/lineage/cache-abi.js";
import { createSnapshotStore } from "../../src/snapshot/store.js";
import {
  JournalToolDurability,
  ToolDurabilityError,
} from "../../src/tool/durability.js";

const SESSION_ID = `ses_${"1".repeat(32)}` as SessionId;
const LINEAGE_ID = `lin_${"2".repeat(32)}` as LineageId;
const RUN_ID = `run_${"3".repeat(32)}` as RunId;
const MANIFEST_ID = `art_${"4".repeat(32)}` as ArtifactId;
const FACT_ID = `art_${"5".repeat(32)}` as ArtifactId;
const BOUNDARY_ID = `cbd_${"6".repeat(32)}` as CommitBoundaryId;
const SNAPSHOT_ID = `rqs_${"7".repeat(32)}` as RequestSnapshotId;
const ATTEMPT_ID = `att_${"8".repeat(32)}` as AttemptId;
const CHECKPOINT_ID = `ccp_${"8".repeat(32)}` as CacheCheckpointId;
const RECOVERY_RUN_ID = `run_${"9".repeat(32)}` as RunId;
const EVIDENCE_ID = `art_${"a".repeat(32)}` as ArtifactId;
const TIMESTAMP = "2026-08-04T05:00:00.000Z" as CanonicalTimestamp;
const REPOSITORY_ROOT = resolve(process.cwd());
const TARGET_NAME = "crash-target.txt";
const TEMP_NAME = `.flashcoder-tmp-${"f".repeat(32)}`;

type CrashMode =
  | "before_prepared"
  | "prepared_before_publish"
  | "published_before_completed"
  | "completed";

type AssistantEvent = Extract<
  AnyVerifiedJournalEvent,
  { readonly type: "assistant_committed" }
>;
type PreparedEvent = Extract<
  AnyVerifiedJournalEvent,
  { readonly type: "effect_prepared" }
>;

interface SeededWorkspace {
  readonly workspace: string;
  readonly targetPath: string;
  readonly assistant: AssistantEvent;
}

function eventIds(fill: string): { readonly nextEventId: () => EventId } {
  let counter = 0;
  return {
    nextEventId: () => {
      counter += 1;
      return `evt_${counter.toString(16).padStart(32, fill)}` as EventId;
    },
  };
}

const fixedClock = Object.freeze({
  now: () => TIMESTAMP,
});

function writeCall(): ToolCall {
  return Object.freeze({
    id: "call_crash_write",
    type: "function" as const,
    function: Object.freeze({
      name: "write",
      arguments: JSON.stringify({
        path: TARGET_NAME,
        content: "once\n",
      }),
    }),
  });
}

async function seedWorkspace(
  t: TestContext,
  initialTarget?: string,
): Promise<SeededWorkspace> {
  const workspace = await mkdtemp(join(tmpdir(), "flashcoder-crash-truth-"));
  const targetPath = join(workspace, TARGET_NAME);
  if (initialTarget !== undefined) await writeFile(targetPath, initialTarget);
  const opened = await openJournal(
    workspace,
    SESSION_ID,
    fixedClock,
    eventIds("1"),
  );
  t.after(async () => {
    await opened.writer.close().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  });

  const session = await opened.writer.append({
    type: "session_started",
    sessionId: SESSION_ID,
    payload: {},
  });
  const cacheAbi = buildCacheAbiV1();
  const manifestDescriptor = await opened.artifacts.publishArtifact(
    cacheAbi.manifestBytes,
    {
      lineCount: null,
      mediaType: "application/octet-stream",
      artifactType: "cache_abi_manifest",
      streamBytes: null,
      hardLimitReached: null,
      descendantsReaped: null,
      toolCallId: null,
      terminal: null,
    },
  );
  const manifest = await opened.writer.append({
    type: "artifact_published",
    sessionId: SESSION_ID,
    parentId: session.id,
    payload: { artifactId: MANIFEST_ID, ...manifestDescriptor },
  });
  await opened.writer.append({
    type: "cache_abi_declared",
    sessionId: SESSION_ID,
    parentId: manifest.id,
    payload: {
      cacheAbiId: cacheAbi.cacheAbiId,
      manifestArtifactId: MANIFEST_ID,
      manifestByteCount: cacheAbi.manifestBytes.byteLength,
    },
  });
  await opened.writer.append({
    type: "lineage_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    payload: { cacheAbiId: cacheAbi.cacheAbiId },
  });
  await opened.writer.append({
    type: "lineage_activated",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    payload: {
      previousLineageId: null,
      nextLineageId: LINEAGE_ID,
      reason: "initial",
    },
  });
  await opened.writer.append({
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: { cause: "user", previousRunId: null },
  });

  const factBytes = utf8Bytes("u");
  const factDescriptor = await opened.artifacts.publishArtifact(factBytes, {
    lineCount: 1,
    mediaType: "text/plain; charset=utf-8",
    artifactType: "fact",
    streamBytes: null,
    hardLimitReached: null,
    descendantsReaped: null,
    toolCallId: null,
    terminal: null,
  });
  await opened.writer.append({
    type: "artifact_published",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: { artifactId: FACT_ID, ...factDescriptor },
  });
  const fact = await opened.writer.append({
    type: "fact_recorded",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      kind: "user_input",
      artifactId: FACT_ID,
      byteCount: factBytes.byteLength,
    },
  });

  const blobs = await createBlobStore(opened.paths.sessionDir);
  const userBytes = materializeUserMessage("u");
  const userBlob = await blobs.publish("user", userBytes, {
    blobIndex: 0,
    previousChainHash: null,
  });
  const user = await opened.writer.append({
    type: "user_committed",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    parentId: fact.id,
    payload: { ...userBlob, sourceFactEventIds: [fact.id] },
  });
  const boundary = await opened.writer.append({
    type: "commit_boundary_created",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    parentId: user.id,
    payload: {
      commitBoundaryId: BOUNDARY_ID,
      cacheCheckpointId: null,
      blobCount: 1,
      chainHash: userBlob.chainHash,
      protocolClosed: true,
      effectsSettled: true,
      sourceEventIds: [user.id],
    },
  });

  const request = buildDeepSeekRequestSnapshot([
    cacheAbi.systemBlob,
    userBytes,
  ]);
  const snapshots = await createSnapshotStore(opened.paths.sessionDir);
  const snapshot = await snapshots.publish(request.body);
  await opened.writer.append({
    type: "request_snapshot_stored",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    parentId: boundary.id,
    payload: {
      requestSnapshotId: SNAPSHOT_ID,
      ...snapshot,
      cacheAbiId: cacheAbi.cacheAbiId,
      projectorVersion: "dsh-projector-v1",
      headEventId: boundary.id,
      commitBoundaryId: BOUNDARY_ID,
      segmentHashes: [cacheAbi.headerHash, userBlob.chainHash],
      recoveryFromSnapshotId: null,
    },
  });
  await opened.writer.append({
    type: "request_attempt_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      attemptId: ATTEMPT_ID,
      requestSnapshotId: SNAPSHOT_ID,
      ordinal: 1,
    },
  });

  const assistantBytes = materializeAssistant({
    content: "",
    reasoningContent: "",
    toolCalls: [writeCall()],
  });
  const assistantBlob = await blobs.publish("assistant", assistantBytes, {
    blobIndex: 1,
    previousChainHash: userBlob.chainHash,
  });
  const assistant = await opened.writer.append({
    type: "assistant_committed",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      ...assistantBlob,
      attemptId: ATTEMPT_ID,
      requestSnapshotId: SNAPSHOT_ID,
      providerRequestId: "crash-truth-fixture-request",
      responseModel: "deepseek-v4-flash",
      systemFingerprint: null,
      semanticDeltaCount: 0,
      usage: {
        promptTokens: 1,
        promptCacheHitTokens: 0,
        promptCacheMissTokens: 1,
        completionTokens: 1,
        reasoningTokens: 0,
        rawFinishReason: "tool_calls",
      },
    },
  });
  assert.equal(assistant.type, "assistant_committed");
  if (assistant.type !== "assistant_committed") {
    assert.fail("fixture did not commit an assistant event");
  }
  await opened.writer.append({
    type: "cache_checkpoint_created",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    parentId: assistant.id,
    payload: {
      cacheCheckpointId: CHECKPOINT_ID,
      requestSnapshotId: SNAPSHOT_ID,
      sourceAssistantEventId: assistant.id,
      providerRequestId: "crash-truth-fixture-request",
      promptTokens: 1,
      blobCount: 2,
      chainHash: assistantBlob.chainHash,
    },
  });
  await opened.writer.close();
  return Object.freeze({ workspace, targetPath, assistant });
}

async function crashAt(workspace: string, mode: CrashMode): Promise<void> {
  const worker = join(
    REPOSITORY_ROOT,
    "dist/test/effects/crash-worker.js",
  );
  const child = spawn(
    process.execPath,
    [worker, workspace, SESSION_ID, mode, REPOSITORY_ROOT],
    {
      stdio: "ignore",
      env: { PATH: process.env["PATH"] ?? "" },
    },
  );
  const [code, signal] = (await once(child, "exit")) as [
    number | null,
    NodeJS.Signals | null,
  ];
  assert.equal(code, null, mode);
  assert.equal(signal, "SIGKILL", mode);
}

async function recoverAfterCrash(
  t: TestContext,
  workspace: string,
  fill: string,
): Promise<OpenJournalResult> {
  const paths = createSessionPaths(workspace, SESSION_ID);
  const stale = await inspectWriterLease(paths);
  assert.equal(stale.state, "stale-proven-dead");
  await quarantineWriterLease(paths, stale, {
    confirmedNoConcurrentStart: true,
  });
  const opened = await openJournal(
    workspace,
    SESSION_ID,
    fixedClock,
    eventIds(fill),
  );
  t.after(async () => opened.writer.close().catch(() => undefined));
  return opened;
}

async function reopenClean(
  t: TestContext,
  workspace: string,
  fill: string,
): Promise<OpenJournalResult> {
  const opened = await openJournal(
    workspace,
    SESSION_ID,
    fixedClock,
    eventIds(fill),
  );
  t.after(async () => opened.writer.close().catch(() => undefined));
  return opened;
}

function eventsAfterAssistant(
  events: readonly AnyVerifiedJournalEvent[],
  assistantId: EventId,
): readonly AnyVerifiedJournalEvent[] {
  const index = events.findIndex(
    (event) =>
      event.type === "cache_checkpoint_created" &&
      event.payload.sourceAssistantEventId === assistantId,
  );
  assert.notEqual(index, -1);
  return Object.freeze(events.slice(index + 1));
}

function eventTypes(
  events: readonly AnyVerifiedJournalEvent[],
): readonly AnyVerifiedJournalEvent["type"][] {
  return events.map((event) => event.type);
}

function openPreparedEffects(
  events: readonly AnyVerifiedJournalEvent[],
): readonly PreparedEvent[] {
  const transitioned = new Set(
    events
      .filter(
        (event) =>
          event.type === "effect_completed" ||
          event.type === "effect_indeterminate" ||
          event.type === "effect_reconciled",
      )
      .map((event) => event.payload.effectId),
  );
  return events.filter(
    (event): event is PreparedEvent =>
      event.type === "effect_prepared" &&
      !transitioned.has(event.payload.effectId),
  );
}

function countType(
  events: readonly AnyVerifiedJournalEvent[],
  type: AnyVerifiedJournalEvent["type"],
): number {
  return events.filter((event) => event.type === type).length;
}

async function startRecoveryAndMarkIndeterminate(
  opened: OpenJournalResult,
  prepared: PreparedEvent,
): Promise<void> {
  const events = opened.writer.events;
  const assistant = events.findLast(
    (event): event is AssistantEvent => event.type === "assistant_committed",
  );
  assert.ok(assistant);
  const lastBlob = events.findLast(
    (event) =>
      event.type === "user_committed" ||
      event.type === "assistant_committed" ||
      event.type === "tool_result_committed",
  );
  assert.ok(lastBlob);
  const durability = new JournalToolDurability({
    scope: {
      sessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      runId: RUN_ID,
      sourceAssistantEventId: assistant.id,
    },
    writer: opened.writer,
    artifacts: opened.artifacts,
    blobs: await createBlobStore(opened.paths.sessionDir),
    blobPosition: {
      blobIndex: lastBlob.payload.blobIndex + 1,
      previousChainHash: lastBlob.payload.chainHash,
    },
  });
  await assert.rejects(
    durability.indeterminate(
      { effectId: prepared.payload.effectId, event: prepared },
      "crash_gap",
    ),
    ToolDurabilityError,
  );
  const terminal = opened.writer.events.at(-1);
  assert.equal(terminal?.type, "run_interrupted");
  await opened.writer.append({
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    ...(terminal === undefined ? {} : { parentId: terminal.id }),
    payload: { cause: "recovery", previousRunId: RUN_ID },
  });
}

async function appendNotExecutedReconciliation(
  opened: OpenJournalResult,
  prepared: PreparedEvent,
): Promise<void> {
  const evidenceBytes = utf8Bytes(
    "operator verified the target retained its pre-publication bytes",
  );
  const descriptor = await opened.artifacts.publishArtifact(evidenceBytes, {
    lineCount: 1,
    mediaType: "text/plain; charset=utf-8",
    artifactType: "operator_evidence",
    streamBytes: null,
    hardLimitReached: null,
    descendantsReaped: null,
    toolCallId: null,
    terminal: null,
  });
  await opened.writer.append({
    type: "artifact_published",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    payload: { artifactId: EVIDENCE_ID, ...descriptor },
  });
  await opened.writer.append({
    type: "effect_reconciled",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    payload: {
      effectId: prepared.payload.effectId,
      resolution: "proven_not_executed",
      evidenceArtifactId: EVIDENCE_ID,
    },
  });
}

test("crash before effect_prepared proves the write was not executed", async (t) => {
  const seeded = await seedWorkspace(t);
  await crashAt(seeded.workspace, "before_prepared");
  const recovered = await recoverAfterCrash(t, seeded.workspace, "b");
  const tail = eventsAfterAssistant(recovered.replay.events, seeded.assistant.id);
  assert.deepEqual(eventTypes(tail), []);
  assert.deepEqual(openPreparedEffects(tail), []);
  await assert.rejects(readFile(seeded.targetPath), { code: "ENOENT" });
  await recovered.writer.close();
});

test("prepared then crash before target publication does not rerun and explicit evidence closes it", async (t) => {
  const seeded = await seedWorkspace(t, "before\n");
  const identityBeforeCrash = await stat(seeded.targetPath);
  await crashAt(seeded.workspace, "prepared_before_publish");
  const recovered = await recoverAfterCrash(t, seeded.workspace, "b");
  const crashTail = eventsAfterAssistant(
    recovered.replay.events,
    seeded.assistant.id,
  );
  assert.deepEqual(eventTypes(crashTail), [
    "permission_decided",
    "effect_prepared",
  ]);
  assert.equal(await readFile(seeded.targetPath, "utf8"), "before\n");
  const identityAfterCrash = await stat(seeded.targetPath);
  assert.equal(identityAfterCrash.dev, identityBeforeCrash.dev);
  assert.equal(identityAfterCrash.ino, identityBeforeCrash.ino);
  assert.equal(
    await readFile(join(seeded.workspace, TEMP_NAME), "utf8"),
    "once\n",
  );
  const prepared = openPreparedEffects(crashTail);
  assert.equal(prepared.length, 1);
  assert.equal(countType(crashTail, "effect_completed"), 0);
  assert.equal(countType(crashTail, "effect_indeterminate"), 0);
  assert.equal(countType(crashTail, "tool_result_committed"), 0);

  await startRecoveryAndMarkIndeterminate(recovered, prepared[0]!);
  await appendNotExecutedReconciliation(recovered, prepared[0]!);
  await recovered.writer.close();

  const verified = await reopenClean(t, seeded.workspace, "e");
  const finalTail = eventsAfterAssistant(
    verified.replay.events,
    seeded.assistant.id,
  );
  assert.equal(countType(finalTail, "effect_prepared"), 1);
  assert.equal(countType(finalTail, "effect_indeterminate"), 1);
  assert.equal(countType(finalTail, "run_interrupted"), 1);
  assert.equal(countType(finalTail, "effect_reconciled"), 1);
  assert.equal(countType(finalTail, "effect_completed"), 0);
  assert.equal(countType(finalTail, "tool_result_committed"), 0);
  assert.deepEqual(openPreparedEffects(finalTail), []);
  assert.equal(await readFile(seeded.targetPath, "utf8"), "before\n");
  await verified.writer.close();
});

test("published then crash before effect_completed remains one indeterminate attempt", async (t) => {
  const seeded = await seedWorkspace(t);
  await crashAt(seeded.workspace, "published_before_completed");
  const recovered = await recoverAfterCrash(t, seeded.workspace, "b");
  const crashTail = eventsAfterAssistant(
    recovered.replay.events,
    seeded.assistant.id,
  );
  assert.deepEqual(eventTypes(crashTail), [
    "permission_decided",
    "effect_prepared",
  ]);
  assert.equal(await readFile(seeded.targetPath, "utf8"), "once\n");
  await assert.rejects(readFile(join(seeded.workspace, TEMP_NAME)), {
    code: "ENOENT",
  });
  const prepared = openPreparedEffects(crashTail);
  assert.equal(prepared.length, 1);

  await startRecoveryAndMarkIndeterminate(recovered, prepared[0]!);
  await recovered.writer.close();
  const verified = await reopenClean(t, seeded.workspace, "e");
  const finalTail = eventsAfterAssistant(
    verified.replay.events,
    seeded.assistant.id,
  );
  assert.equal(countType(finalTail, "effect_prepared"), 1);
  assert.equal(countType(finalTail, "effect_indeterminate"), 1);
  assert.equal(countType(finalTail, "run_interrupted"), 1);
  assert.equal(countType(finalTail, "effect_completed"), 0);
  assert.equal(countType(finalTail, "effect_reconciled"), 0);
  assert.equal(countType(finalTail, "tool_result_committed"), 0);
  assert.deepEqual(openPreparedEffects(finalTail), []);
  assert.equal(await readFile(seeded.targetPath, "utf8"), "once\n");
  await verified.writer.close();
});

test("completed effect survives a later crash without an indeterminate append", async (t) => {
  const seeded = await seedWorkspace(t);
  await crashAt(seeded.workspace, "completed");
  const recovered = await recoverAfterCrash(t, seeded.workspace, "b");
  const crashTail = eventsAfterAssistant(
    recovered.replay.events,
    seeded.assistant.id,
  );
  assert.deepEqual(eventTypes(crashTail), [
    "permission_decided",
    "effect_prepared",
    "artifact_published",
    "effect_completed",
    "tool_result_committed",
  ]);
  assert.equal(await readFile(seeded.targetPath, "utf8"), "once\n");
  assert.deepEqual(openPreparedEffects(crashTail), []);
  assert.equal(countType(crashTail, "effect_indeterminate"), 0);

  const prepared = crashTail.find(
    (event): event is PreparedEvent => event.type === "effect_prepared",
  );
  assert.ok(prepared);
  const blobs = await createBlobStore(recovered.paths.sessionDir);
  const lastBlob = recovered.replay.events.findLast(
    (event) => event.type === "tool_result_committed",
  );
  assert.equal(lastBlob?.type, "tool_result_committed");
  if (lastBlob?.type !== "tool_result_committed") {
    assert.fail("completed fixture did not commit its tool result");
  }
  const durability = new JournalToolDurability({
    scope: {
      sessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      runId: RUN_ID,
      sourceAssistantEventId: seeded.assistant.id,
    },
    writer: recovered.writer,
    artifacts: recovered.artifacts,
    blobs,
    blobPosition: {
      blobIndex: lastBlob.payload.blobIndex + 1,
      previousChainHash: lastBlob.payload.chainHash,
    },
  });
  await assert.rejects(
    durability.indeterminate(
      { effectId: prepared.payload.effectId, event: prepared },
      "crash_gap",
    ),
    ToolDurabilityError,
  );
  await recovered.writer.close();

  const verified = await reopenClean(t, seeded.workspace, "e");
  const finalTail = eventsAfterAssistant(
    verified.replay.events,
    seeded.assistant.id,
  );
  assert.equal(countType(finalTail, "effect_prepared"), 1);
  assert.equal(countType(finalTail, "effect_completed"), 1);
  assert.equal(countType(finalTail, "effect_indeterminate"), 0);
  assert.equal(countType(finalTail, "run_interrupted"), 0);
  assert.equal(countType(finalTail, "tool_result_committed"), 1);
  assert.equal(await readFile(seeded.targetPath, "utf8"), "once\n");
  await verified.writer.close();
});
