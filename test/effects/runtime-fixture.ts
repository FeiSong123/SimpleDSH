import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";

import { createBlobStore } from "../../src/blob/store.js";
import { materializeAssistant } from "../../src/bytes/assistant.js";
import { utf8Bytes } from "../../src/bytes/ops.js";
import { buildDeepSeekRequestSnapshot } from "../../src/bytes/request.js";
import { materializeUserMessage } from "../../src/bytes/user.js";
import type { ToolCall } from "../../src/ds/types.js";
import type { ToolSchemaProfile } from "../../src/bytes/schemas.js";
import type { PersistenceTestControls } from "../../src/journal/faults.js";
import { openJournal, type OpenJournalResult } from "../../src/journal/open.js";
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
import {
  buildCacheAbiV1,
  toolResultProfileForCacheAbi,
  type FrozenCacheAbiManifest,
} from "../../src/lineage/cache-abi.js";
import { toolSchemaProfileForBytes } from "../../src/bytes/schemas.js";
import type { DeepSeekWebSearchExecutor } from "../../src/ds/web-search.js";
import { createSnapshotStore } from "../../src/snapshot/store.js";
import { JournalToolDurability } from "../../src/tool/durability.js";
import { ToolRuntime } from "../../src/tool/runtime.js";

export const RUNTIME_FIXTURE_SESSION_ID =
  `ses_${"1".repeat(32)}` as SessionId;
const LINEAGE_ID = `lin_${"2".repeat(32)}` as LineageId;
const RUN_ID = `run_${"3".repeat(32)}` as RunId;
const MANIFEST_ID = `art_${"4".repeat(32)}` as ArtifactId;
const FACT_ID = `art_${"5".repeat(32)}` as ArtifactId;
const BOUNDARY_ID = `cbd_${"6".repeat(32)}` as CommitBoundaryId;
const SNAPSHOT_ID = `rqs_${"7".repeat(32)}` as RequestSnapshotId;
const ATTEMPT_ID = `att_${"8".repeat(32)}` as AttemptId;
const CHECKPOINT_ID = `ccp_${"9".repeat(32)}` as CacheCheckpointId;
const TIMESTAMP = "2026-08-04T04:00:00.000Z" as CanonicalTimestamp;
const REPO_ROOT = resolve(process.cwd());

type DurabilityOptions = ConstructorParameters<typeof JournalToolDurability>[0];

export interface RuntimeFixture {
  readonly workspace: string;
  readonly opened: OpenJournalResult;
  readonly runtime: ToolRuntime;
  readonly durability: JournalToolDurability;
  readonly assistant: Extract<
    AnyVerifiedJournalEvent,
    { readonly type: "assistant_committed" }
  >;
  readonly checkpoint: Extract<
    AnyVerifiedJournalEvent,
    { readonly type: "cache_checkpoint_created" }
  >;
  readonly calls: readonly ToolCall[];
  readonly closeWriter: () => Promise<void>;
}

export interface RuntimeFixtureOptions {
  readonly controls?: PersistenceTestControls;
  readonly durabilityFactory?: (
    options: DurabilityOptions,
  ) => JournalToolDurability;
  readonly fileMutationControls?: ConstructorParameters<typeof ToolRuntime>[0]["fileMutationControls"];
  readonly toolsProfile?: ToolSchemaProfile;
  readonly cacheAbi?: FrozenCacheAbiManifest;
  readonly webSearch?: DeepSeekWebSearchExecutor;
}

export function runtimeFixtureEventIds(
  prefix = "0",
): { readonly nextEventId: () => EventId } {
  if (!/^[0-9a-f]$/u.test(prefix)) {
    throw new TypeError("event id prefix must be one lowercase hex digit");
  }
  let counter = 0;
  return {
    nextEventId: () => {
      counter += 1;
      return `evt_${prefix}${counter.toString(16).padStart(31, "0")}` as EventId;
    },
  };
}

export const runtimeFixtureClock = Object.freeze({
  now: () => TIMESTAMP,
});

export function toolCall(
  id: string,
  name: string,
  argumentsText: string,
): ToolCall {
  return Object.freeze({
    id,
    type: "function" as const,
    function: Object.freeze({ name, arguments: argumentsText }),
  });
}

export async function createRuntimeFixture(
  t: TestContext,
  calls: readonly ToolCall[],
  options: RuntimeFixtureOptions = {},
): Promise<RuntimeFixture> {
  const workspace = await mkdtemp(join(tmpdir(), "simpledsh-runtime-"));
  const opened = await openJournal(
    workspace,
    RUNTIME_FIXTURE_SESSION_ID,
    runtimeFixtureClock,
    runtimeFixtureEventIds(),
    options.controls,
  );
  let writerClosed = false;
  const closeWriter = async (): Promise<void> => {
    if (writerClosed) return;
    writerClosed = true;
    await opened.writer.close();
  };
  t.after(async () => {
    try {
      await closeWriter().catch(() => undefined);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  const session = await opened.writer.append({
    type: "session_started",
    sessionId: RUNTIME_FIXTURE_SESSION_ID,
    payload: {},
  });
  const cacheAbi = options.cacheAbi ?? buildCacheAbiV1();
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
    sessionId: RUNTIME_FIXTURE_SESSION_ID,
    parentId: session.id,
    payload: {
      artifactId: MANIFEST_ID,
      ...manifestDescriptor,
    },
  });
  await opened.writer.append({
    type: "cache_abi_declared",
    sessionId: RUNTIME_FIXTURE_SESSION_ID,
    parentId: manifest.id,
    payload: {
      cacheAbiId: cacheAbi.cacheAbiId,
      manifestArtifactId: MANIFEST_ID,
      manifestByteCount: cacheAbi.manifestBytes.byteLength,
    },
  });
  await opened.writer.append({
    type: "lineage_started",
    sessionId: RUNTIME_FIXTURE_SESSION_ID,
    lineageId: LINEAGE_ID,
    payload: { cacheAbiId: cacheAbi.cacheAbiId },
  });
  await opened.writer.append({
    type: "lineage_activated",
    sessionId: RUNTIME_FIXTURE_SESSION_ID,
    lineageId: LINEAGE_ID,
    payload: {
      previousLineageId: null,
      nextLineageId: LINEAGE_ID,
      reason: "initial",
    },
  });
  await opened.writer.append({
    type: "run_started",
    sessionId: RUNTIME_FIXTURE_SESSION_ID,
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
    sessionId: RUNTIME_FIXTURE_SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: { artifactId: FACT_ID, ...factDescriptor },
  });
  const fact = await opened.writer.append({
    type: "fact_recorded",
    sessionId: RUNTIME_FIXTURE_SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      kind: "user_input",
      artifactId: FACT_ID,
      byteCount: factBytes.byteLength,
    },
  });

  const blobs = await createBlobStore(opened.paths.sessionDir, options.controls);
  const userBytes = materializeUserMessage("u");
  const userBlob = await blobs.publish("user", userBytes, {
    blobIndex: 0,
    previousChainHash: null,
  });
  const user = await opened.writer.append({
    type: "user_committed",
    sessionId: RUNTIME_FIXTURE_SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    parentId: fact.id,
    payload: { ...userBlob, sourceFactEventIds: [fact.id] },
  });
  const boundary = await opened.writer.append({
    type: "commit_boundary_created",
    sessionId: RUNTIME_FIXTURE_SESSION_ID,
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
  const snapshots = await createSnapshotStore(
    opened.paths.sessionDir,
    options.controls,
  );
  const snapshot = await snapshots.publish(request.body);
  await opened.writer.append({
    type: "request_snapshot_stored",
    sessionId: RUNTIME_FIXTURE_SESSION_ID,
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
    sessionId: RUNTIME_FIXTURE_SESSION_ID,
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
    toolCalls: calls,
  });
  const assistantBlob = await blobs.publish("assistant", assistantBytes, {
    blobIndex: 1,
    previousChainHash: userBlob.chainHash,
  });
  const assistantEvent = await opened.writer.append({
    type: "assistant_committed",
    sessionId: RUNTIME_FIXTURE_SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      ...assistantBlob,
      attemptId: ATTEMPT_ID,
      requestSnapshotId: SNAPSHOT_ID,
      providerRequestId: "runtime-fixture-request",
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
  assert.equal(assistantEvent.type, "assistant_committed");
  if (assistantEvent.type !== "assistant_committed") {
    assert.fail("fixture did not commit an assistant event");
  }
  const checkpoint = await opened.writer.append({
    type: "cache_checkpoint_created",
    sessionId: RUNTIME_FIXTURE_SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      cacheCheckpointId: CHECKPOINT_ID,
      requestSnapshotId: SNAPSHOT_ID,
      sourceAssistantEventId: assistantEvent.id,
      providerRequestId: "runtime-fixture-request",
      promptTokens: 1,
      blobCount: 2,
      chainHash: assistantBlob.chainHash,
    },
  });
  assert.equal(checkpoint.type, "cache_checkpoint_created");
  if (checkpoint.type !== "cache_checkpoint_created") {
    assert.fail("fixture did not commit an assistant checkpoint");
  }

  const durabilityOptions: DurabilityOptions = {
    scope: {
      sessionId: RUNTIME_FIXTURE_SESSION_ID,
      lineageId: LINEAGE_ID,
      runId: RUN_ID,
      sourceAssistantEventId: assistantEvent.id,
    },
    writer: opened.writer,
    artifacts: opened.artifacts,
    blobs,
    blobPosition: {
      blobIndex: 2,
      previousChainHash: assistantBlob.chainHash,
    },
  };
  const durability = options.durabilityFactory?.(durabilityOptions) ??
    new JournalToolDurability(durabilityOptions);
  const runtime = new ToolRuntime({
    durability,
    cwd: workspace,
    storageRoot: opened.paths.dshDir,
    canonicalEnvPath: join(REPO_ROOT, ".env"),
    umask: 0o022,
    toolsProfile: options.toolsProfile ?? toolSchemaProfileForBytes(cacheAbi.toolsBlob),
    resultProfile: toolResultProfileForCacheAbi(cacheAbi),
    ...(options.webSearch === undefined ? {} : { webSearch: options.webSearch }),
    ...(options.fileMutationControls === undefined
      ? {}
      : { fileMutationControls: options.fileMutationControls }),
  });
  return Object.freeze({
    workspace,
    opened,
    runtime,
    durability,
    assistant: assistantEvent,
    checkpoint,
    calls: Object.freeze([...calls]),
    closeWriter,
  });
}
