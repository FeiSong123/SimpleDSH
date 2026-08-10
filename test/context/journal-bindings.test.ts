import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  encodeToolOutputHardLimit,
  encodeToolOutputData,
  RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES,
  TOOL_OUTPUT_MEDIA_TYPE,
  type ToolOutputStream,
} from "../../src/artifact/tool-output.js";
import type {
  EffectTerminal,
  ToolTerminal,
} from "../../src/artifact/terminal.js";
import { advanceBlobPrefix } from "../../src/blob/store.js";
import { materializeAssistant } from "../../src/bytes/assistant.js";
import {
  concatBytes,
  lengthPrefix,
  sha256Hex,
  toBase64,
  utf8Bytes,
} from "../../src/bytes/ops.js";
import {
  buildDeepSeekRequestSnapshotWithTools,
} from "../../src/bytes/request.js";
import { LEGACY_CANONICAL_TOOLS_BYTES } from "../../src/bytes/schemas.js";
import { PREVIOUS_SYSTEM_MESSAGE_BYTES } from "../../src/bytes/system.js";
import { materializeToolResultMessage } from "../../src/bytes/tool-result.js";
import { freezeBytes, type FrozenBytes } from "../../src/bytes/types.js";
import { materializeUserMessage } from "../../src/bytes/user.js";
import {
  JournalBindingProjection,
  type JournalReferenceVerifier,
} from "../../src/journal/bindings.js";
import { replayJournal } from "../../src/journal/replay.js";
import {
  createVerifiedJournalEvent,
  encodeVerifiedJournalEvent,
} from "../../src/journal/schema.js";
import type {
  AnyJournalEventDraft,
  AnyVerifiedJournalEvent,
  ArtifactId,
  ArtifactRef,
  AttemptId,
  BlobPayload,
  CacheAbiId,
  CacheCheckpointId,
  CanonicalTimestamp,
  CommitBoundaryId,
  EffectId,
  EventId,
  JournalPayloadByType,
  LineageId,
  RequestSnapshotId,
  RunId,
  SessionId,
  Sha256,
  SnapshotRef,
  ToolCallId,
  VerifiedJournalEvent,
} from "../../src/journal/types.js";
import {
  buildCacheAbiV1,
  buildCacheAbiV2,
  loadCacheAbiV1,
  MODEL_TUPLE_BYTES,
  PROJECTOR_VERSION_V1,
  PROTOCOL_VERSION_V1,
  type FrozenCacheAbiManifest,
} from "../../src/lineage/cache-abi.js";
import { projectArtifactToolResult } from "../../src/artifact/tool-result.js";

const SESSION_ID = `ses_${"1".repeat(32)}` as SessionId;
const LINEAGE_ID = `lin_${"2".repeat(32)}` as LineageId;
const RUN_ID = `run_${"3".repeat(32)}` as RunId;
const RECOVERY_RUN_ID = `run_${"4".repeat(32)}` as RunId;
const TIMESTAMP = "2026-08-04T00:00:00.000Z" as CanonicalTimestamp;
const SUCCEEDED_TERMINAL = Object.freeze({
  status: "succeeded",
  code: "ok",
  exitCode: null,
  signal: null,
  descendantsReaped: null,
}) satisfies ToolTerminal;

function objectId<Id extends string>(prefix: string, ordinal: number): Id {
  return `${prefix}_${ordinal.toString(16).padStart(32, "0")}` as Id;
}

function digest(bytes: FrozenBytes): Sha256 {
  return `sha256:${sha256Hex(bytes)}` as Sha256;
}

function legacyV4CacheAbi(): FrozenCacheAbiManifest {
  const manifest = concatBytes([
    utf8Bytes("dsh-cache-abi-v1\0"),
    lengthPrefix(utf8Bytes(PROTOCOL_VERSION_V1)),
    lengthPrefix(utf8Bytes(PROJECTOR_VERSION_V1)),
    lengthPrefix(MODEL_TUPLE_BYTES),
    lengthPrefix(PREVIOUS_SYSTEM_MESSAGE_BYTES),
    lengthPrefix(LEGACY_CANONICAL_TOOLS_BYTES),
  ]);
  return loadCacheAbiV1(
    manifest,
    `sha256:${sha256Hex(manifest)}` as CacheAbiId,
  );
}

function artifactRef(hash: Sha256): ArtifactRef {
  return `artifacts/sha256/${hash.slice("sha256:".length)}` as ArtifactRef;
}

function snapshotRef(hash: Sha256): SnapshotRef {
  return `snapshots/sha256/${hash.slice("sha256:".length)}` as SnapshotRef;
}

function sameBytes(left: FrozenBytes, right: FrozenBytes): boolean {
  return Buffer.from(left.copy()).equals(Buffer.from(right.copy()));
}

type PublishedArtifactEvent = Extract<
  AnyVerifiedJournalEvent,
  { readonly type: "artifact_published" }
>;

interface PublishArtifactOptions {
  readonly artifactType: "fact" | "tool_output" | "operator_evidence";
  readonly mediaType: string;
  readonly lineageId: LineageId;
  readonly runId: RunId;
  readonly lineCount: number | null;
  readonly toolCallId?: ToolCallId;
  readonly terminal?: ToolTerminal | null;
  readonly toolStream?: ToolOutputStream | null;
  readonly hardLimitReached?: boolean;
  readonly descendantsReaped?: boolean | null;
}

function artifactResultProjection(options: {
  readonly artifact: PublishedArtifactEvent;
  readonly framedBytes: FrozenBytes;
  readonly toolCallId: ToolCallId;
  readonly toolName: "bash" | "edit" | "read" | "write";
  readonly terminalSource: "artifact" | "effect";
  readonly terminal: ToolTerminal;
  readonly readOffset?: number;
  readonly resultProfile?: "verbose-v1" | "compact-v2";
}): ReturnType<typeof projectArtifactToolResult> {
  const streamBytes = options.artifact.payload.streamBytes;
  if (streamBytes === null) {
    throw new TypeError("tool result fixture requires stream metadata");
  }
  return projectArtifactToolResult({
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    toolsProfile: "edit-v5",
    resultProfile: options.resultProfile ?? "verbose-v1",
    terminalSource: options.terminalSource,
    ...(options.readOffset === undefined
      ? {}
      : { readOffset: options.readOffset }),
    artifact: {
      artifactId: options.artifact.payload.artifactId,
      artifactRef: options.artifact.payload.artifactRef,
      artifactSha256: options.artifact.payload.artifactHash,
      byteCount: options.artifact.payload.byteCount,
      payloadBytes: streamBytes,
      hardLimitReached: options.artifact.payload.hardLimitReached ?? false,
    },
    terminal: options.terminal,
    framedBytes: options.framedBytes,
  });
}

class BindingHarness {
  readonly cacheAbi: FrozenCacheAbiManifest;
  readonly events: AnyVerifiedJournalEvent[] = [];
  readonly projection: JournalBindingProjection;
  readonly verifier: JournalReferenceVerifier;
  readonly #artifacts = new Map<ArtifactRef, FrozenBytes>();
  readonly #blobs = new Map<string, FrozenBytes>();
  readonly #snapshots = new Map<SnapshotRef, FrozenBytes>();
  #nextArtifact = 1;

  constructor(cacheAbi: FrozenCacheAbiManifest = buildCacheAbiV1()) {
    this.cacheAbi = cacheAbi;
    this.verifier = {
      loadBlob: async (ref) => {
        const bytes = this.#blobs.get(ref);
        if (bytes === undefined) throw new Error("missing in-memory Blob");
        return bytes;
      },
      loadArtifact: async (payload) => {
        const bytes = this.#artifacts.get(payload.artifactRef);
        if (bytes === undefined) throw new Error("missing in-memory Artifact");
        return bytes;
      },
      scanArtifact: async (payload, visit) => {
        const bytes = this.#artifacts.get(payload.artifactRef);
        if (bytes === undefined) throw new Error("missing in-memory Artifact");
        visit(bytes);
      },
      verifyArtifact: async (payload) => {
        const bytes = this.#artifacts.get(payload.artifactRef);
        if (
          bytes === undefined ||
          digest(bytes) !== payload.artifactHash ||
          bytes.byteLength !== payload.byteCount ||
          artifactRef(payload.artifactHash) !== payload.artifactRef
        ) {
          throw new Error("invalid in-memory Artifact");
        }
      },
      verifySnapshot: async (ref, hash, byteCount) => {
        const bytes = this.#snapshots.get(ref);
        if (
          bytes === undefined ||
          digest(bytes) !== hash ||
          bytes.byteLength !== byteCount ||
          snapshotRef(hash) !== ref
        ) {
          throw new Error("invalid in-memory Snapshot");
        }
      },
      verifyRecovery: async () => undefined,
    };
    this.projection = new JournalBindingProjection(this.verifier);
  }

  make(draft: AnyJournalEventDraft): AnyVerifiedJournalEvent {
    const previous = this.events.at(-1);
    return createVerifiedJournalEvent(draft, {
      seq: this.events.length + 1,
      id: objectId<EventId>("evt", this.events.length + 1),
      at: TIMESTAMP,
      prevHash: previous?.hash ?? null,
    });
  }

  async accept(draft: AnyJournalEventDraft): Promise<AnyVerifiedJournalEvent> {
    const event = this.make(draft);
    await this.projection.accept(event);
    this.events.push(event);
    return event;
  }

  async reject(draft: AnyJournalEventDraft): Promise<void> {
    await assert.rejects(this.projection.accept(this.make(draft)), {
      code: "JOURNAL_REFERENCE",
    });
  }

  async bootstrap(): Promise<void> {
    await this.accept({
      type: "session_started",
      sessionId: SESSION_ID,
      payload: {},
    });
    const manifestId = objectId<ArtifactId>("art", this.#nextArtifact++);
    const manifestHash = this.cacheAbi.cacheAbiId as unknown as Sha256;
    const manifestRef = artifactRef(manifestHash);
    this.#artifacts.set(manifestRef, this.cacheAbi.manifestBytes);
    const manifest = await this.accept({
      type: "artifact_published",
      sessionId: SESSION_ID,
      payload: {
        artifactId: manifestId,
        artifactRef: manifestRef,
        artifactHash: manifestHash,
        byteCount: this.cacheAbi.manifestBytes.byteLength,
        lineCount: null,
        mediaType: "application/octet-stream",
        artifactType: "cache_abi_manifest",
        streamBytes: null,
        hardLimitReached: null,
        descendantsReaped: null,
        toolCallId: null,
        terminal: null,
      },
    });
    await this.accept({
      type: "cache_abi_declared",
      sessionId: SESSION_ID,
      parentId: manifest.id,
      payload: {
        cacheAbiId: this.cacheAbi.cacheAbiId,
        manifestArtifactId: manifestId,
        manifestByteCount: this.cacheAbi.manifestBytes.byteLength,
      },
    });
    await this.accept({
      type: "lineage_started",
      sessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      payload: { cacheAbiId: this.cacheAbi.cacheAbiId },
    });
    await this.accept({
      type: "lineage_activated",
      sessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      payload: {
        previousLineageId: null,
        nextLineageId: LINEAGE_ID,
        reason: "initial",
      },
    });
    await this.accept({
      type: "run_started",
      sessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      runId: RUN_ID,
      payload: { cause: "user", previousRunId: null },
    });
  }

  async addUser(content: string): Promise<{
    readonly bytes: FrozenBytes;
    readonly event: AnyVerifiedJournalEvent;
  }> {
    const factBytes = utf8Bytes(content);
    const artifact = await this.publishArtifact(factBytes, {
      artifactType: "fact",
      mediaType: "text/plain",
      lineageId: LINEAGE_ID,
      runId: RUN_ID,
      lineCount: 1,
    });
    const fact = await this.accept({
      type: "fact_recorded",
      sessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      runId: RUN_ID,
      payload: {
        kind: "user_input",
        artifactId: artifact.payload.artifactId,
        byteCount: factBytes.byteLength,
      },
    });
    const bytes = materializeUserMessage(content);
    const blob = this.inlineBlob("user", bytes);
    const event = await this.accept({
      type: "user_committed",
      sessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      runId: RUN_ID,
      parentId: fact.id,
      payload: { ...blob, sourceFactEventIds: [fact.id] },
    });
    return { bytes, event };
  }

  inlineBlob<Role extends "user" | "assistant" | "tool">(
    role: Role,
    bytes: FrozenBytes,
  ): BlobPayload<Role> {
    const prefix = this.projection.snapshot();
    const chainHash = advanceBlobPrefix(bytes, {
      blobIndex: prefix.blobCount,
      previousChainHash: prefix.chainHash,
    });
    return {
      role,
      enc: "b64",
      bytes: toBase64(bytes),
      byteCount: bytes.byteLength,
      byteHash: digest(bytes),
      blobIndex: prefix.blobCount,
      chainHash,
    };
  }

  stageArtifact(
    bytes: FrozenBytes,
    options: PublishArtifactOptions,
  ): AnyJournalEventDraft {
    const isToolOutput = options.artifactType === "tool_output";
    if (isToolOutput) {
      if (options.mediaType !== TOOL_OUTPUT_MEDIA_TYPE) {
        throw new TypeError("tool output fixture must use the frozen media type");
      }
      if (options.lineCount !== null) {
        throw new TypeError("tool output fixture must not declare lineCount");
      }
      if (options.toolCallId === undefined || options.terminal === undefined) {
        throw new TypeError("tool output fixture needs toolCallId and terminal");
      }
      if (
        bytes.byteLength > 0 &&
        (options.toolStream === undefined || options.toolStream === null)
      ) {
        throw new TypeError("nonempty tool output fixture needs a stream");
      }
    }
    const stream = options.toolStream ?? null;
    const hardLimitReached = options.hardLimitReached ?? false;
    if (
      isToolOutput &&
      hardLimitReached &&
      bytes.byteLength !== RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES
    ) {
      throw new TypeError("hard-limit fixture needs exactly the raw byte limit");
    }
    const dataFrame =
      isToolOutput && bytes.byteLength > 0
        ? encodeToolOutputData(stream ?? "read", bytes)
        : bytes;
    const artifactBytes =
      isToolOutput && hardLimitReached
        ? concatBytes([
            dataFrame,
            encodeToolOutputHardLimit(stream ?? "read"),
          ])
        : dataFrame;
    const artifactId = objectId<ArtifactId>("art", this.#nextArtifact++);
    const hash = digest(artifactBytes);
    const ref = artifactRef(hash);
    this.#artifacts.set(ref, artifactBytes);
    return {
      type: "artifact_published",
      sessionId: SESSION_ID,
      lineageId: options.lineageId,
      runId: options.runId,
      payload: {
        artifactId,
        artifactRef: ref,
        artifactHash: hash,
        byteCount: artifactBytes.byteLength,
        lineCount: options.lineCount,
        mediaType: options.mediaType,
        artifactType: options.artifactType,
        streamBytes: isToolOutput
          ? {
              read: stream === "read" ? bytes.byteLength : 0,
              stdout: stream === "stdout" ? bytes.byteLength : 0,
              stderr: stream === "stderr" ? bytes.byteLength : 0,
            }
          : null,
        hardLimitReached: isToolOutput ? hardLimitReached : null,
        descendantsReaped: isToolOutput
          ? (options.descendantsReaped ?? null)
          : null,
        toolCallId: isToolOutput ? (options.toolCallId ?? null) : null,
        terminal: isToolOutput ? (options.terminal ?? null) : null,
      },
    };
  }

  async publishArtifact(
    bytes: FrozenBytes,
    options: PublishArtifactOptions,
  ): Promise<Extract<AnyVerifiedJournalEvent, { readonly type: "artifact_published" }>> {
    return (await this.accept(this.stageArtifact(bytes, options))) as Extract<
      AnyVerifiedJournalEvent,
      { readonly type: "artifact_published" }
    >;
  }

  async addBoundary(
    id: CommitBoundaryId,
    sourceEventIds: readonly EventId[],
    runId: RunId = RUN_ID,
  ): Promise<Extract<AnyVerifiedJournalEvent, { readonly type: "commit_boundary_created" }>> {
    const prefix = this.projection.snapshot();
    if (prefix.chainHash === null) throw new Error("boundary needs a Blob prefix");
    return (await this.accept({
      type: "commit_boundary_created",
      sessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      runId,
      payload: {
        commitBoundaryId: id,
        cacheCheckpointId: null,
        blobCount: prefix.blobCount,
        chainHash: prefix.chainHash,
        protocolClosed: true,
        effectsSettled: true,
        sourceEventIds,
      },
    })) as Extract<
      AnyVerifiedJournalEvent,
      { readonly type: "commit_boundary_created" }
    >;
  }

  boundaryDraft(
    id: CommitBoundaryId,
    sourceEventIds: readonly EventId[],
    runId: RunId = RUN_ID,
  ): AnyJournalEventDraft {
    const prefix = this.projection.snapshot();
    if (prefix.chainHash === null) throw new Error("boundary needs a Blob prefix");
    return {
      type: "commit_boundary_created",
      sessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      runId,
      payload: {
        commitBoundaryId: id,
        cacheCheckpointId: null,
        blobCount: prefix.blobCount,
        chainHash: prefix.chainHash,
        protocolClosed: true,
        effectsSettled: true,
        sourceEventIds,
      },
    };
  }

  registerSnapshot(bytes: FrozenBytes): {
    readonly ref: SnapshotRef;
    readonly hash: Sha256;
  } {
    const hash = digest(bytes);
    const ref = snapshotRef(hash);
    this.#snapshots.set(ref, bytes);
    return { ref, hash };
  }

  overwriteArtifactForTest(ref: ArtifactRef, bytes: FrozenBytes): void {
    this.#artifacts.set(ref, bytes);
  }
}

interface BoundarySetup {
  readonly harness: BindingHarness;
  readonly user: Awaited<ReturnType<BindingHarness["addUser"]>>;
  readonly boundary: Extract<
    AnyVerifiedJournalEvent,
    { readonly type: "commit_boundary_created" }
  >;
  readonly body: FrozenBytes;
}

async function throughBoundary(
  cacheAbi: FrozenCacheAbiManifest = buildCacheAbiV1(),
): Promise<BoundarySetup> {
  const harness = new BindingHarness(cacheAbi);
  await harness.bootstrap();
  const user = await harness.addUser("journal cuts");
  const boundary = await harness.addBoundary(
    objectId<CommitBoundaryId>("cbd", 1),
    [user.event.id],
  );
  const body = buildDeepSeekRequestSnapshotWithTools(
    [harness.cacheAbi.systemBlob, user.bytes],
    harness.cacheAbi.toolsBlob,
  ).body;
  return { harness, user, boundary, body };
}

function snapshotPayload(
  setup: BoundarySetup,
  requestSnapshotId: RequestSnapshotId,
): JournalPayloadByType["request_snapshot_stored"] {
  const stored = setup.harness.registerSnapshot(setup.body);
  return {
    requestSnapshotId,
    bodyRef: stored.ref,
    bodyHash: stored.hash,
    byteCount: setup.body.byteLength,
    cacheAbiId: setup.harness.cacheAbi.cacheAbiId,
    projectorVersion: "dsh-projector-v1",
    headEventId: setup.boundary.id,
    commitBoundaryId: setup.boundary.payload.commitBoundaryId,
    segmentHashes: [
      setup.harness.cacheAbi.headerHash,
      setup.boundary.payload.chainHash,
    ],
    recoveryFromSnapshotId: null,
  };
}

async function acceptSourceSnapshot(setup: BoundarySetup): Promise<{
  readonly id: RequestSnapshotId;
  readonly event: AnyVerifiedJournalEvent;
  readonly payload: JournalPayloadByType["request_snapshot_stored"];
}> {
  const id = objectId<RequestSnapshotId>("rqs", 1);
  const payload = snapshotPayload(setup, id);
  const event = await setup.harness.accept({
    type: "request_snapshot_stored",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    parentId: setup.boundary.id,
    payload,
  });
  return { id, event, payload };
}

async function withAssistant(
  calls: readonly {
    readonly id: ToolCallId;
    readonly name: "bash" | "edit" | "read" | "write";
    readonly arguments: string;
  }[],
  options: {
    readonly checkpoint?: boolean;
    readonly cacheAbi?: FrozenCacheAbiManifest;
  } = {},
): Promise<{
  readonly harness: BindingHarness;
  readonly assistant: AnyVerifiedJournalEvent;
}> {
  const setup = await throughBoundary(options.cacheAbi);
  const source = await acceptSourceSnapshot(setup);
  const attemptId = objectId<AttemptId>("att", 1);
  await setup.harness.accept({
    type: "request_attempt_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      attemptId,
      requestSnapshotId: source.id,
      ordinal: 1,
    },
  });
  const bytes = materializeAssistant({
    content: "",
    reasoningContent: "use the requested tools",
    toolCalls: calls.map((call) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: call.arguments },
    })),
  });
  const assistant = await setup.harness.accept({
    type: "assistant_committed",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      ...setup.harness.inlineBlob("assistant", bytes),
      attemptId,
      requestSnapshotId: source.id,
      providerRequestId: "provider-request-1",
      responseModel: "deepseek-v4-flash",
      systemFingerprint: null,
      semanticDeltaCount: 0,
      usage: {
        promptTokens: 5,
        promptCacheHitTokens: 2,
        promptCacheMissTokens: 3,
        completionTokens: 2,
        reasoningTokens: 1,
        rawFinishReason: "tool_calls",
      },
    },
  });
  if (options.checkpoint !== false) {
    if (assistant.type !== "assistant_committed") {
      assert.fail("tool fixture assistant was not committed");
    }
    await setup.harness.accept({
      type: "cache_checkpoint_created",
      sessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      runId: RUN_ID,
      parentId: assistant.id,
      payload: {
        cacheCheckpointId: objectId<CacheCheckpointId>("ccp", 9),
        requestSnapshotId: source.id,
        blobCount: assistant.payload.blobIndex + 1,
        chainHash: assistant.payload.chainHash,
        promptTokens: assistant.payload.usage.promptTokens,
        providerRequestId: assistant.payload.providerRequestId,
        sourceAssistantEventId: assistant.id,
      },
    });
  }
  return { harness: setup.harness, assistant };
}

test("tool-calling assistant requires its Cache Checkpoint before permission or interruption", async () => {
  const callId = "call_checkpoint_gate" as ToolCallId;
  const { harness, assistant } = await withAssistant(
    [{ id: callId, name: "read", arguments: '{"path":"a"}' }],
    { checkpoint: false },
  );
  await harness.reject({
    type: "permission_decided",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      toolCallId: callId,
      policyDecision: "allow",
      finalDecision: "allow",
      resolution: "policy",
    },
  });
  await harness.reject({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: { reason: "cancelled", sourceEventId: assistant.id },
  });
  if (assistant.type !== "assistant_committed") {
    assert.fail("tool fixture assistant was not committed");
  }
  await harness.accept({
    type: "cache_checkpoint_created",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    parentId: assistant.id,
    payload: {
      cacheCheckpointId: objectId<CacheCheckpointId>("ccp", 8),
      requestSnapshotId: assistant.payload.requestSnapshotId,
      blobCount: assistant.payload.blobIndex + 1,
      chainHash: assistant.payload.chainHash,
      promptTokens: assistant.payload.usage.promptTokens,
      providerRequestId: assistant.payload.providerRequestId,
      sourceAssistantEventId: assistant.id,
    },
  });
  await harness.accept({
    type: "permission_decided",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      toolCallId: callId,
      policyDecision: "allow",
      finalDecision: "allow",
      resolution: "policy",
    },
  });
});

test("legacy v4 missing replace_all remains a fieldless invalid result across replay", async (t) => {
  const callId = "call_legacy_edit_missing_replace_all" as ToolCallId;
  const missingReplaceAll =
    '{"path":"output.txt","old_string":"old","new_string":"new"}';
  const legacy = await withAssistant(
    [{ id: callId, name: "edit", arguments: missingReplaceAll }],
    { cacheAbi: legacyV4CacheAbi() },
  );
  const pending = legacy.harness.projection
    .recoveryView()
    .toolCalls.find((call) => call.toolCallId === callId);
  assert.equal(pending?.toolsProfile, "edit-v4");
  assert.equal(pending?.validatedArguments, null);
  assert.equal(pending?.validationCode, "invalid_arguments");

  const resultBytes = materializeToolResultMessage(callId, {
    kind: "static",
    status: "invalid",
    code: "invalid_arguments",
  });
  const result = await legacy.harness.accept(
    toolResultDraft(legacy.harness, {
      toolCallId: callId,
      bytes: resultBytes,
      artifactId: null,
      effectId: null,
      sourceEventId: legacy.assistant.id,
    }),
  );
  assert.deepEqual(
    legacy.harness.events
      .slice(legacy.harness.events.indexOf(legacy.assistant) + 1)
      .map((event) => event.type),
    ["cache_checkpoint_created", "tool_result_committed"],
  );

  const directory = await mkdtemp(join(tmpdir(), "simpledsh-legacy-edit-v4-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const replayed = await replayEvents(
    join(directory, "legacy-edit.jsonl"),
    legacy.harness,
    legacy.harness.events,
  );
  assert.equal(replayed.head.hash, result.hash);
  const replayedCall = replayed.projection
    .recoveryView()
    .toolCalls.find((call) => call.toolCallId === callId);
  assert.equal(replayedCall?.toolsProfile, "edit-v4");
  assert.equal(replayedCall?.validationCode, "invalid_arguments");
  assert.equal(replayedCall?.resultEventId, result.id);

  const active = await withAssistant([
    {
      id: "call_active_edit_missing_replace_all" as ToolCallId,
      name: "edit",
      arguments: missingReplaceAll,
    },
  ]);
  const activeCall = active.harness.projection.recoveryView().toolCalls.at(-1);
  assert.equal(activeCall?.toolsProfile, "edit-v5");
  assert.equal(activeCall?.validationCode, null);
  assert.deepEqual(activeCall?.validatedArguments, {
    name: "edit",
    value: {
      path: "output.txt",
      oldString: "old",
      newString: "new",
      replaceAll: false,
    },
  });
});

function toolResultDraft(
  harness: BindingHarness,
  options: {
    readonly toolCallId: ToolCallId;
    readonly bytes: FrozenBytes;
    readonly artifactId: ArtifactId | null;
    readonly effectId: EffectId | null;
    readonly sourceEventId: EventId;
    readonly runId?: RunId;
  },
): AnyJournalEventDraft {
  return {
    type: "tool_result_committed",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: options.runId ?? RUN_ID,
    payload: {
      ...harness.inlineBlob("tool", options.bytes),
      toolCallId: options.toolCallId,
      effectId: options.effectId,
      artifactId: options.artifactId,
      sourceEventId: options.sourceEventId,
    },
  };
}

type MatrixToolName = "bash" | "edit" | "read" | "write";
type MatrixTerminalSource = "artifact" | "effect";

interface TerminalSourceCase {
  readonly label: string;
  readonly toolName: MatrixToolName;
  readonly source: MatrixTerminalSource;
  readonly terminal: ToolTerminal;
  readonly hardLimitReached?: boolean;
  readonly artifactDescendantsReaped?: boolean | null;
  readonly cacheAbi?: FrozenCacheAbiManifest;
}

function matrixArguments(toolName: MatrixToolName): string {
  switch (toolName) {
    case "read":
      return '{"path":"input.txt"}';
    case "write":
      return '{"path":"output.txt","content":"ok"}';
    case "edit":
      return '{"path":"output.txt","old_string":"old","new_string":"new","replace_all":false}';
    case "bash":
      return '{"command":"printf ok","timeout":5}';
  }
}

function matrixTerminal(
  toolName: MatrixToolName,
  source: MatrixTerminalSource,
  code: ToolTerminal["code"],
): ToolTerminal {
  const status: ToolTerminal["status"] =
    code === "ok"
      ? "succeeded"
      : code === "invalid_arguments"
        ? "invalid"
        : code === "bash_supervisor_unavailable" ||
            code === "credential_shield_unavailable"
          ? "unavailable"
          : "failed";
  const exitCode =
    code === "nonzero_exit"
      ? 7
      : code === "ok" && toolName === "bash" && source === "effect"
        ? 0
        : null;
  const signal =
    code === "signaled" ||
    code === "timeout" ||
    code === "cancelled" ||
    code === "output_limit"
      ? "SIGTERM"
      : null;
  return Object.freeze({
    status,
    code,
    exitCode,
    signal,
    descendantsReaped:
      toolName === "bash" && source === "effect" ? false : null,
  });
}

function replaceTerminal(
  terminal: ToolTerminal,
  changes: Partial<ToolTerminal>,
): ToolTerminal {
  return Object.freeze({ ...terminal, ...changes });
}

let hardLimitPayload: FrozenBytes | undefined;

function matrixOutputBytes(hardLimitReached: boolean): FrozenBytes {
  if (!hardLimitReached) return utf8Bytes("");
  hardLimitPayload ??= freezeBytes(
    new Uint8Array(RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES),
  );
  return hardLimitPayload;
}

async function stageTerminalSourceCase(
  item: TerminalSourceCase,
): Promise<{
  readonly harness: BindingHarness;
  readonly terminalDraft: AnyJournalEventDraft;
}> {
  const callId = "call_terminal_matrix" as ToolCallId;
  const argumentsText = matrixArguments(item.toolName);
  const { harness } = await withAssistant(
    [{ id: callId, name: item.toolName, arguments: argumentsText }],
    item.cacheAbi === undefined ? {} : { cacheAbi: item.cacheAbi },
  );
  await harness.accept({
    type: "permission_decided",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      toolCallId: callId,
      policyDecision: "allow",
      finalDecision: "allow",
      resolution: "policy",
    },
  });

  const hardLimitReached = item.hardLimitReached ?? false;
  const editMatchCount =
    item.source === "artifact" && item.toolName === "edit"
      ? item.terminal.code === "edit_no_match"
        ? "0"
        : item.terminal.code === "edit_not_unique"
          ? "2"
          : undefined
      : undefined;
  const bytes = editMatchCount === undefined
    ? matrixOutputBytes(hardLimitReached)
    : utf8Bytes(editMatchCount);
  const toolStream = editMatchCount !== undefined
    ? "stdout"
    : hardLimitReached
      ? item.toolName === "read"
        ? "read"
        : "stdout"
      : null;
  if (item.source === "artifact") {
    return {
      harness,
      terminalDraft: harness.stageArtifact(bytes, {
        artifactType: "tool_output",
        mediaType: TOOL_OUTPUT_MEDIA_TYPE,
        lineageId: LINEAGE_ID,
        runId: RUN_ID,
        lineCount: null,
        toolCallId: callId,
        terminal: item.terminal,
        toolStream,
        hardLimitReached,
        descendantsReaped: item.artifactDescendantsReaped ?? null,
      }),
    };
  }
  if (item.toolName === "read") {
    throw new TypeError("read has no Effect terminal source");
  }

  const effectId = objectId<EffectId>("eff", 1);
  await harness.accept({
    type: "effect_prepared",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      effectId,
      toolCallId: callId,
      toolName: item.toolName,
      argumentsHash: digest(utf8Bytes(argumentsText)),
    },
  });
  const output = await harness.publishArtifact(bytes, {
    artifactType: "tool_output",
    mediaType: TOOL_OUTPUT_MEDIA_TYPE,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    lineCount: null,
    toolCallId: callId,
    terminal: null,
    toolStream,
    hardLimitReached,
    descendantsReaped:
      item.artifactDescendantsReaped ??
      (item.toolName === "bash" ? false : null),
  });
  return {
    harness,
    terminalDraft: {
      type: "effect_completed",
      sessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      runId: RUN_ID,
      payload: {
        effectId,
        toolCallId: callId,
        artifactId: output.payload.artifactId,
        terminal: item.terminal as EffectTerminal,
      },
    },
  };
}

async function replayEvents(
  path: string,
  harness: BindingHarness,
  events: readonly AnyVerifiedJournalEvent[],
): Promise<Awaited<ReturnType<typeof replayJournal>>> {
  const journal =
    events
      .map((event) =>
        Buffer.from(encodeVerifiedJournalEvent(event).copy()).toString("utf8"),
      )
      .join("\n") + "\n";
  await writeFile(path, journal, { mode: 0o600 });
  const handle = await open(path, "r");
  try {
    return await replayJournal(handle, harness.verifier);
  } finally {
    await handle.close();
  }
}

test("Run admission and interruption terminal are single-owner and replay exact", async (t) => {
  const setup = await throughBoundary();
  const thirdRunId = objectId<RunId>("run", 5);
  const parallelDraft: AnyJournalEventDraft = {
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    payload: { cause: "recovery", previousRunId: RUN_ID },
  };
  const invalidParallel = setup.harness.make(parallelDraft);
  await setup.harness.reject(parallelDraft);

  const directory = await mkdtemp(join(tmpdir(), "simpledsh-run-admission-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    replayEvents(
      join(directory, "parallel-run.jsonl"),
      setup.harness,
      [...setup.harness.events, invalidParallel],
    ),
    { code: "JOURNAL_REFERENCE" },
  );

  await setup.harness.reject({
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: thirdRunId,
    payload: { cause: "user", previousRunId: null },
  });
  await setup.harness.reject({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      reason: "cancelled",
      sourceEventId: setup.harness.events[0]!.id,
    },
  });

  const firstTerminal = await setup.harness.accept({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      reason: "cancelled",
      sourceEventId: setup.boundary.id,
    },
  });
  await setup.harness.reject({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      reason: "cancelled",
      sourceEventId: setup.boundary.id,
    },
  });
  await setup.harness.reject({
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    payload: { cause: "user", previousRunId: null },
  });

  const recovery = await setup.harness.accept({
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    parentId: firstTerminal.id,
    payload: { cause: "recovery", previousRunId: RUN_ID },
  });
  await setup.harness.reject({
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: thirdRunId,
    payload: { cause: "recovery", previousRunId: RECOVERY_RUN_ID },
  });
  await setup.harness.reject({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    payload: {
      reason: "cancelled",
      sourceEventId: setup.boundary.id,
    },
  });
  const recoveryTerminal = await setup.harness.accept({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    payload: {
      reason: "cancelled",
      sourceEventId: recovery.id,
    },
  });

  await setup.harness.reject({
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: thirdRunId,
    payload: { cause: "recovery", previousRunId: RUN_ID },
  });
  const thirdRun = await setup.harness.accept({
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: thirdRunId,
    parentId: recoveryTerminal.id,
    payload: { cause: "recovery", previousRunId: RECOVERY_RUN_ID },
  });
  assert.equal(thirdRun.runId, thirdRunId);
});

test("pre-semantic retry is exact and post-semantic interruption must terminalize next", async (t) => {
  const setup = await throughBoundary();
  const source = await acceptSourceSnapshot(setup);
  const firstAttemptId = objectId<AttemptId>("att", 1);
  await setup.harness.accept({
    type: "request_attempt_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      attemptId: firstAttemptId,
      requestSnapshotId: source.id,
      ordinal: 1,
    },
  });
  await setup.harness.reject({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      reason: "cancelled",
      sourceEventId: source.event.id,
    },
  });
  await setup.harness.accept({
    type: "request_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      attemptId: firstAttemptId,
      requestSnapshotId: source.id,
      outcome: "transport_error",
      status: null,
      retryClass: "transport_unknown",
      semanticState: "pre_semantic",
    },
  });

  const wrongOrdinalDraft: AnyJournalEventDraft = {
    type: "request_attempt_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      attemptId: objectId<AttemptId>("att", 2),
      requestSnapshotId: source.id,
      ordinal: 3,
    },
  };
  const invalidRetry = setup.harness.make(wrongOrdinalDraft);
  await setup.harness.reject(wrongOrdinalDraft);
  await setup.harness.reject({
    type: "request_attempt_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      attemptId: objectId<AttemptId>("att", 3),
      requestSnapshotId: objectId<RequestSnapshotId>("rqs", 99),
      ordinal: 1,
    },
  });

  const directory = await mkdtemp(join(tmpdir(), "simpledsh-run-retry-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    replayEvents(
      join(directory, "wrong-retry-ordinal.jsonl"),
      setup.harness,
      [...setup.harness.events, invalidRetry],
    ),
    { code: "JOURNAL_REFERENCE" },
  );

  const secondAttemptId = objectId<AttemptId>("att", 4);
  await setup.harness.accept({
    type: "request_attempt_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      attemptId: secondAttemptId,
      requestSnapshotId: source.id,
      ordinal: 2,
    },
  });
  await setup.harness.accept({
    type: "request_semantic_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: { attemptId: secondAttemptId },
  });
  const interrupted = await setup.harness.accept({
    type: "request_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      attemptId: secondAttemptId,
      requestSnapshotId: source.id,
      outcome: "cancelled",
      status: null,
      retryClass: "cancelled",
      semanticState: "post_semantic",
    },
  });
  await setup.harness.reject({
    type: "request_attempt_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      attemptId: objectId<AttemptId>("att", 5),
      requestSnapshotId: source.id,
      ordinal: 3,
    },
  });
  await setup.harness.accept({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      reason: "semantic_interrupted",
      sourceEventId: interrupted.id,
    },
  });

  const unknownSetup = await throughBoundary();
  const unknownSource = await acceptSourceSnapshot(unknownSetup);
  const unknownAttemptId = objectId<AttemptId>("att", 10);
  await unknownSetup.harness.accept({
    type: "request_attempt_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      attemptId: unknownAttemptId,
      requestSnapshotId: unknownSource.id,
      ordinal: 1,
    },
  });
  const unknown = await unknownSetup.harness.accept({
    type: "request_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      attemptId: unknownAttemptId,
      requestSnapshotId: unknownSource.id,
      outcome: "durability_error",
      status: null,
      retryClass: "unknown",
      semanticState: "semantic_state_unknown",
    },
  });
  await unknownSetup.harness.reject({
    type: "request_attempt_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      attemptId: objectId<AttemptId>("att", 11),
      requestSnapshotId: unknownSource.id,
      ordinal: 2,
    },
  });
  await unknownSetup.harness.accept({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      reason: "durability_failure",
      sourceEventId: unknown.id,
    },
  });
});

test("final no-tool assistant closes checkpoint, Boundary, and Run contiguously", async (t) => {
  const setup = await throughBoundary();
  const source = await acceptSourceSnapshot(setup);
  const attemptId = objectId<AttemptId>("att", 1);
  await setup.harness.accept({
    type: "request_attempt_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      attemptId,
      requestSnapshotId: source.id,
      ordinal: 1,
    },
  });
  await setup.harness.accept({
    type: "request_semantic_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: { attemptId },
  });
  const assistantBytes = materializeAssistant({
    content: "done",
    reasoningContent: "finished",
    toolCalls: [],
  });
  const assistant = (await setup.harness.accept({
    type: "assistant_committed",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      ...setup.harness.inlineBlob("assistant", assistantBytes),
      attemptId,
      requestSnapshotId: source.id,
      providerRequestId: "provider-final",
      responseModel: "deepseek-v4-flash",
      systemFingerprint: null,
      semanticDeltaCount: 1,
      usage: {
        promptTokens: 8,
        promptCacheHitTokens: 3,
        promptCacheMissTokens: 5,
        completionTokens: 4,
        reasoningTokens: 2,
        rawFinishReason: "stop",
      },
    },
  })) as Extract<AnyVerifiedJournalEvent, { readonly type: "assistant_committed" }>;

  await setup.harness.reject({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: { reason: "cancelled", sourceEventId: assistant.id },
  });
  const checkpointId = objectId<CacheCheckpointId>("ccp", 1);
  await setup.harness.accept({
    type: "cache_checkpoint_created",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      cacheCheckpointId: checkpointId,
      requestSnapshotId: source.id,
      blobCount: assistant.payload.blobIndex + 1,
      chainHash: assistant.payload.chainHash,
      promptTokens: assistant.payload.usage.promptTokens,
      providerRequestId: assistant.payload.providerRequestId,
      sourceAssistantEventId: assistant.id,
    },
  });
  await setup.harness.reject(
    setup.harness.boundaryDraft(
      objectId<CommitBoundaryId>("cbd", 2),
      [assistant.id],
    ),
  );
  const finalBoundaryId = objectId<CommitBoundaryId>("cbd", 3);
  const prefix = setup.harness.projection.snapshot();
  assert.ok(prefix.chainHash !== null);
  const finalBoundary = (await setup.harness.accept({
    type: "commit_boundary_created",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      commitBoundaryId: finalBoundaryId,
      cacheCheckpointId: checkpointId,
      blobCount: prefix.blobCount,
      chainHash: prefix.chainHash,
      protocolClosed: true,
      effectsSettled: true,
      sourceEventIds: [assistant.id],
    },
  })) as Extract<
    AnyVerifiedJournalEvent,
    { readonly type: "commit_boundary_created" }
  >;
  await setup.harness.reject({
    type: "run_completed",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      commitBoundaryId: objectId<CommitBoundaryId>("cbd", 99),
      sourceAssistantEventId: assistant.id,
    },
  });
  const completed = await setup.harness.accept({
    type: "run_completed",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      commitBoundaryId: finalBoundary.payload.commitBoundaryId,
      sourceAssistantEventId: assistant.id,
    },
  });
  await setup.harness.reject({
    type: "run_completed",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      commitBoundaryId: finalBoundary.payload.commitBoundaryId,
      sourceAssistantEventId: assistant.id,
    },
  });
  await setup.harness.reject({
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    parentId: completed.id,
    payload: { cause: "recovery", previousRunId: RUN_ID },
  });

  const directory = await mkdtemp(join(tmpdir(), "simpledsh-run-completion-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const replayed = await replayEvents(
    join(directory, "complete-run.jsonl"),
    setup.harness,
    setup.harness.events,
  );
  assert.equal(replayed.head.hash, completed.hash);
});

test("source-phase terminal matrix survives append and close/reopen replay", async (t) => {
  const legalCases: readonly TerminalSourceCase[] = [
    ...(["ok", "invalid_arguments", "io_error"] as const).map((code) => ({
      label: `read Artifact ${code}`,
      toolName: "read" as const,
      source: "artifact" as const,
      terminal: matrixTerminal("read", "artifact", code),
    })),
    ...(["invalid_arguments", "io_error"] as const).map((code) => ({
      label: `write pre-effect ${code}`,
      toolName: "write" as const,
      source: "artifact" as const,
      terminal: matrixTerminal("write", "artifact", code),
    })),
    ...([
      "invalid_arguments",
      "io_error",
      "edit_no_match",
      "edit_not_unique",
    ] as const).map((code) => ({
      label: `edit pre-effect ${code}`,
      toolName: "edit" as const,
      source: "artifact" as const,
      terminal: matrixTerminal("edit", "artifact", code),
    })),
    {
      label: "bash pre-effect frozen unavailable spelling",
      toolName: "bash",
      source: "artifact",
      terminal: matrixTerminal(
        "bash",
        "artifact",
        "bash_supervisor_unavailable",
      ),
    },
    ...(["write", "edit"] as const).flatMap((toolName) =>
      (["ok", "io_error", "target_changed"] as const).map((code) => ({
        label: `${toolName} Effect ${code}`,
        toolName,
        source: "effect" as const,
        terminal: matrixTerminal(toolName, "effect", code),
      })),
    ),
    ...([
      "ok",
      "io_error",
      "nonzero_exit",
      "signaled",
      "timeout",
      "cancelled",
      "output_limit",
    ] as const).map((code) => ({
      label: `bash Effect ${code}`,
      toolName: "bash" as const,
      source: "effect" as const,
      terminal: matrixTerminal("bash", "effect", code),
      ...(code === "output_limit" ? { hardLimitReached: true } : {}),
    })),
  ];
  const directory = await mkdtemp(join(tmpdir(), "simpledsh-terminal-matrix-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  for (const [index, item] of legalCases.entries()) {
    const staged = await stageTerminalSourceCase(item);
    const terminalEvent = await staged.harness.accept(staged.terminalDraft);
    const replayed = await replayEvents(
      join(directory, `legal-${index}.jsonl`),
      staged.harness,
      staged.harness.events,
    );
    assert.equal(replayed.head.hash, terminalEvent.hash, item.label);
    assert.equal(
      replayed.events.length,
      staged.harness.events.length,
      item.label,
    );
  }
});

test("active edit match count rejects result disagreement and CAS tampering", async (t) => {
  const terminal = matrixTerminal("edit", "artifact", "edit_not_unique");
  const staged = await stageTerminalSourceCase({
    label: "active edit count tamper",
    toolName: "edit",
    source: "artifact",
    terminal,
  });
  const artifact = (await staged.harness.accept(
    staged.terminalDraft,
  )) as PublishedArtifactEvent;
  const callId = artifact.payload.toolCallId;
  assert.ok(callId !== null);
  const framedCount = encodeToolOutputData("stdout", utf8Bytes("2"));
  const projected = artifactResultProjection({
    artifact,
    framedBytes: framedCount,
    toolCallId: callId,
    toolName: "edit",
    terminalSource: "artifact",
    terminal,
  });
  assert.equal(projected.content.matchCount, 2);

  const mismatched = materializeToolResultMessage(callId, {
    ...projected.content,
    matchCount: 3,
  });
  await staged.harness.reject(
    toolResultDraft(staged.harness, {
      toolCallId: callId,
      bytes: mismatched,
      artifactId: artifact.payload.artifactId,
      effectId: null,
      sourceEventId: artifact.id,
    }),
  );
  const result = await staged.harness.accept(
    toolResultDraft(staged.harness, {
      toolCallId: callId,
      bytes: projected.messageBytes,
      artifactId: artifact.payload.artifactId,
      effectId: null,
      sourceEventId: artifact.id,
    }),
  );

  const directory = await mkdtemp(join(tmpdir(), "simpledsh-edit-count-tamper-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const intact = await replayEvents(
    join(directory, "intact.jsonl"),
    staged.harness,
    staged.harness.events,
  );
  assert.equal(intact.head.hash, result.hash);

  staged.harness.overwriteArtifactForTest(
    artifact.payload.artifactRef,
    encodeToolOutputData("stdout", utf8Bytes("3")),
  );
  await assert.rejects(
    replayEvents(
      join(directory, "tampered.jsonl"),
      staged.harness,
      staged.harness.events,
    ),
    { code: "JOURNAL_REFERENCE" },
  );
});

test("durable Cache ABI selects exactly one verbose-v1 or compact-v2 result parser", async () => {
  for (const [cacheAbi, admitted, rejected] of [
    [buildCacheAbiV1(), "verbose-v1", "compact-v2"],
    [buildCacheAbiV2(), "compact-v2", "verbose-v1"],
  ] as const) {
    const terminal = matrixTerminal("read", "artifact", "ok");
    const staged = await stageTerminalSourceCase({
      label: admitted,
      toolName: "read",
      source: "artifact",
      terminal,
      cacheAbi,
    });
    const artifact = (await staged.harness.accept(
      staged.terminalDraft,
    )) as PublishedArtifactEvent;
    const callId = artifact.payload.toolCallId;
    assert.ok(callId !== null);
    const admittedProjection = artifactResultProjection({
      artifact,
      framedBytes: utf8Bytes(""),
      toolCallId: callId,
      toolName: "read",
      terminalSource: "artifact",
      terminal,
      resultProfile: admitted,
    });
    const rejectedProjection = artifactResultProjection({
      artifact,
      framedBytes: utf8Bytes(""),
      toolCallId: callId,
      toolName: "read",
      terminalSource: "artifact",
      terminal,
      resultProfile: rejected,
    });
    await staged.harness.reject(
      toolResultDraft(staged.harness, {
        toolCallId: callId,
        bytes: rejectedProjection.messageBytes,
        artifactId: artifact.payload.artifactId,
        effectId: null,
        sourceEventId: artifact.id,
      }),
    );
    await staged.harness.accept(
      toolResultDraft(staged.harness, {
        toolCallId: callId,
        bytes: admittedProjection.messageBytes,
        artifactId: artifact.payload.artifactId,
        effectId: null,
        sourceEventId: artifact.id,
      }),
    );
    const binding = staged.harness.projection.recoveryView().toolCalls.at(-1);
    assert.equal(binding?.resultProfile, admitted);
  }
});

test("source-phase terminal violations fail append and hash-valid replay", async (t) => {
  const bashEffectOk = matrixTerminal("bash", "effect", "ok");
  const bashEffectIoError = matrixTerminal("bash", "effect", "io_error");
  const invalidCases: readonly TerminalSourceCase[] = [
    {
      label: "legacy credential terminal",
      toolName: "bash",
      source: "artifact",
      terminal: matrixTerminal(
        "bash",
        "artifact",
        "credential_shield_unavailable",
      ),
    },
    {
      label: "read wrong-phase target_changed",
      toolName: "read",
      source: "artifact",
      terminal: matrixTerminal("read", "artifact", "target_changed"),
    },
    {
      label: "write pre-effect ok",
      toolName: "write",
      source: "artifact",
      terminal: matrixTerminal("write", "artifact", "ok"),
    },
    {
      label: "edit pre-effect target_changed",
      toolName: "edit",
      source: "artifact",
      terminal: matrixTerminal("edit", "artifact", "target_changed"),
    },
    {
      label: "bash pre-effect io_error",
      toolName: "bash",
      source: "artifact",
      terminal: matrixTerminal("bash", "artifact", "io_error"),
    },
    {
      label: "write Effect edit_no_match",
      toolName: "write",
      source: "effect",
      terminal: matrixTerminal("write", "effect", "edit_no_match"),
    },
    {
      label: "edit Effect nonzero_exit",
      toolName: "edit",
      source: "effect",
      terminal: matrixTerminal("edit", "effect", "nonzero_exit"),
    },
    {
      label: "bash Effect target_changed",
      toolName: "bash",
      source: "effect",
      terminal: matrixTerminal("bash", "effect", "target_changed"),
    },
    {
      label: "file terminal carries process exit",
      toolName: "read",
      source: "artifact",
      terminal: replaceTerminal(
        matrixTerminal("read", "artifact", "ok"),
        { exitCode: 0 },
      ),
    },
    {
      label: "successful bash omits process exit",
      toolName: "bash",
      source: "effect",
      terminal: replaceTerminal(bashEffectOk, { exitCode: null }),
    },
    {
      label: "output_limit omits hard-limit marker",
      toolName: "bash",
      source: "effect",
      terminal: matrixTerminal("bash", "effect", "output_limit"),
    },
    {
      label: "non-output_limit carries hard-limit marker",
      toolName: "bash",
      source: "effect",
      terminal: bashEffectOk,
      hardLimitReached: true,
    },
    {
      label: "pre-effect bash carries cleanup observation",
      toolName: "bash",
      source: "artifact",
      terminal: replaceTerminal(
        matrixTerminal(
          "bash",
          "artifact",
          "bash_supervisor_unavailable",
        ),
        { descendantsReaped: false },
      ),
    },
    {
      label: "Effect bash omits cleanup observation",
      toolName: "bash",
      source: "effect",
      terminal: replaceTerminal(bashEffectIoError, {
        descendantsReaped: null,
      }),
      artifactDescendantsReaped: false,
    },
    {
      label: "hash-valid Effect bash cleanup mismatch",
      toolName: "bash",
      source: "effect",
      terminal: replaceTerminal(bashEffectIoError, {
        descendantsReaped: true,
      }),
      artifactDescendantsReaped: false,
    },
    {
      label: "file Effect carries cleanup observation",
      toolName: "write",
      source: "effect",
      terminal: replaceTerminal(
        matrixTerminal("write", "effect", "io_error"),
        { descendantsReaped: false },
      ),
    },
  ];
  const directory = await mkdtemp(
    join(tmpdir(), "simpledsh-terminal-rejections-"),
  );
  t.after(async () => rm(directory, { recursive: true, force: true }));

  for (const [index, item] of invalidCases.entries()) {
    const staged = await stageTerminalSourceCase(item);
    await staged.harness.reject(staged.terminalDraft);
    const invalidEvent = staged.harness.make(staged.terminalDraft);
    await assert.rejects(
      replayEvents(
        join(directory, `invalid-${index}.jsonl`),
        staged.harness,
        [...staged.harness.events, invalidEvent],
      ),
      { code: "JOURNAL_REFERENCE" },
      item.label,
    );
  }
});

test("noncanonical user bytes are rejected before any boundary or snapshot", async () => {
  const harness = new BindingHarness();
  await harness.bootstrap();
  const input = utf8Bytes("not canonicalized");
  const artifact = await harness.publishArtifact(input, {
    artifactType: "fact",
    mediaType: "text/plain",
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    lineCount: 1,
  });
  const fact = await harness.accept({
    type: "fact_recorded",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      kind: "user_input",
      artifactId: artifact.payload.artifactId,
      byteCount: input.byteLength,
    },
  });
  const noncanonical = utf8Bytes(
    '{"content":"not canonicalized","role":"user"}',
  );
  await harness.reject({
    type: "user_committed",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    parentId: fact.id,
    payload: {
      ...harness.inlineBlob("user", noncanonical),
      sourceFactEventIds: [fact.id],
    },
  });
  assert.equal(harness.projection.snapshot().blobCount, 0);
  assert.equal(
    harness.projection.snapshot().objectIds.some((id) => id.startsWith("cbd_")),
    false,
  );
  assert.equal(
    harness.projection.snapshot().objectIds.some((id) => id.startsWith("rqs_")),
    false,
  );
});

test("true boundary assertions cannot close an open request attempt", async () => {
  const setup = await throughBoundary();
  const source = await acceptSourceSnapshot(setup);
  const attempt = await setup.harness.accept({
    type: "request_attempt_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      attemptId: objectId<AttemptId>("att", 1),
      requestSnapshotId: source.id,
      ordinal: 1,
    },
  });
  await setup.harness.reject(
    setup.harness.boundaryDraft(
      objectId<CommitBoundaryId>("cbd", 2),
      [attempt.id],
    ),
  );
});

test("two tool calls require canonical embedded ids and declaration-order results", async () => {
  const firstId = "call_first" as ToolCallId;
  const secondId = "call_second" as ToolCallId;
  const { harness, assistant } = await withAssistant([
    { id: firstId, name: "read", arguments: '{"path":"a"}' },
    { id: secondId, name: "read", arguments: '{"path":"b"}' },
  ]);
  await harness.accept({
    type: "permission_decided",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      toolCallId: firstId,
      policyDecision: "allow",
      finalDecision: "allow",
      resolution: "policy",
    },
  });
  await harness.accept({
    type: "permission_decided",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      toolCallId: secondId,
      policyDecision: "allow",
      finalDecision: "allow",
      resolution: "policy",
    },
  });
  await harness.reject(
    harness.boundaryDraft(objectId<CommitBoundaryId>("cbd", 2), [assistant.id]),
  );

  const secondRaw = utf8Bytes("second output");
  const secondFramed = encodeToolOutputData("read", secondRaw);
  const secondOutput = await harness.publishArtifact(secondRaw, {
    artifactType: "tool_output",
    mediaType: TOOL_OUTPUT_MEDIA_TYPE,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    lineCount: null,
    toolCallId: secondId,
    terminal: SUCCEEDED_TERMINAL,
    toolStream: "read",
  });
  const secondProjection = artifactResultProjection({
    artifact: secondOutput,
    framedBytes: secondFramed,
    toolCallId: secondId,
    toolName: "read",
    terminalSource: "artifact",
    terminal: SUCCEEDED_TERMINAL,
  });
  const secondBytes = secondProjection.messageBytes;
  await harness.reject(
    toolResultDraft(harness, {
      toolCallId: secondId,
      bytes: secondBytes,
      artifactId: secondOutput.payload.artifactId,
      effectId: null,
      sourceEventId: secondOutput.id,
    }),
  );

  const firstRaw = utf8Bytes("first output");
  const firstFramed = encodeToolOutputData("read", firstRaw);
  const firstOutput = await harness.publishArtifact(firstRaw, {
    artifactType: "tool_output",
    mediaType: TOOL_OUTPUT_MEDIA_TYPE,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    lineCount: null,
    toolCallId: firstId,
    terminal: SUCCEEDED_TERMINAL,
    toolStream: "read",
  });
  const firstProjection = artifactResultProjection({
    artifact: firstOutput,
    framedBytes: firstFramed,
    toolCallId: firstId,
    toolName: "read",
    terminalSource: "artifact",
    terminal: SUCCEEDED_TERMINAL,
  });
  const firstBytes = firstProjection.messageBytes;
  const wrongEmbeddedId = materializeToolResultMessage(
    secondId,
    firstProjection.content,
  );
  await harness.reject(
    toolResultDraft(harness, {
      toolCallId: firstId,
      bytes: wrongEmbeddedId,
      artifactId: firstOutput.payload.artifactId,
      effectId: null,
      sourceEventId: firstOutput.id,
    }),
  );
  const canonicalText = Buffer.from(firstBytes.copy()).toString("utf8");
  const noncanonical = utf8Bytes(
    canonicalText.replace(',"tool_call_id"', ', "tool_call_id"'),
  );
  await harness.reject(
    toolResultDraft(harness, {
      toolCallId: firstId,
      bytes: noncanonical,
      artifactId: firstOutput.payload.artifactId,
      effectId: null,
      sourceEventId: firstOutput.id,
    }),
  );
  const firstResult = await harness.accept(
    toolResultDraft(harness, {
      toolCallId: firstId,
      bytes: firstBytes,
      artifactId: firstOutput.payload.artifactId,
      effectId: null,
      sourceEventId: firstOutput.id,
    }),
  );
  await harness.reject(
    toolResultDraft(harness, {
      toolCallId: firstId,
      bytes: firstBytes,
      artifactId: firstOutput.payload.artifactId,
      effectId: null,
      sourceEventId: firstOutput.id,
    }),
  );
  await harness.reject(
    harness.boundaryDraft(objectId<CommitBoundaryId>("cbd", 2), [firstResult.id]),
  );
  const secondResult = await harness.accept(
    toolResultDraft(harness, {
      toolCallId: secondId,
      bytes: secondBytes,
      artifactId: secondOutput.payload.artifactId,
      effectId: null,
      sourceEventId: secondOutput.id,
    }),
  );
  await harness.addBoundary(objectId<CommitBoundaryId>("cbd", 2), [
    firstResult.id,
    secondResult.id,
  ]);
});

async function commitReadResult(
  harness: BindingHarness,
  callId: ToolCallId,
  runId: RunId,
  content: string,
): Promise<
  Extract<AnyVerifiedJournalEvent, { readonly type: "tool_result_committed" }>
> {
  const raw = utf8Bytes(content);
  const framed = encodeToolOutputData("read", raw);
  const output = await harness.publishArtifact(raw, {
    artifactType: "tool_output",
    mediaType: TOOL_OUTPUT_MEDIA_TYPE,
    lineageId: LINEAGE_ID,
    runId,
    lineCount: null,
    toolCallId: callId,
    terminal: SUCCEEDED_TERMINAL,
    toolStream: "read",
  });
  return (await harness.accept(
    toolResultDraft(harness, {
      toolCallId: callId,
      bytes: artifactResultProjection({
        artifact: output,
        framedBytes: framed,
        toolCallId: callId,
        toolName: "read",
        terminalSource: "artifact",
        terminal: SUCCEEDED_TERMINAL,
      }).messageBytes,
      artifactId: output.payload.artifactId,
      effectId: null,
      sourceEventId: output.id,
      runId,
    }),
  )) as Extract<
    AnyVerifiedJournalEvent,
    { readonly type: "tool_result_committed" }
  >;
}

test("complete tool tail creates its same-Run Boundary before interruption", async (t) => {
  const callId = "call_boundary_first" as ToolCallId;
  const { harness } = await withAssistant([
    { id: callId, name: "read", arguments: '{"path":"boundary.txt"}' },
  ]);
  await harness.accept({
    type: "permission_decided",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      toolCallId: callId,
      policyDecision: "allow",
      finalDecision: "allow",
      resolution: "policy",
    },
  });
  const result = await commitReadResult(
    harness,
    callId,
    RUN_ID,
    "durable result",
  );
  const prematureTerminalDraft: AnyJournalEventDraft = {
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: { reason: "cancelled", sourceEventId: result.id },
  };
  const invalidPrematureTerminal = harness.make(prematureTerminalDraft);
  const invalidTrace = [...harness.events, invalidPrematureTerminal];
  await harness.reject(prematureTerminalDraft);
  const boundary = await harness.addBoundary(
    objectId<CommitBoundaryId>("cbd", 2),
    [result.id],
    RUN_ID,
  );
  const terminal = await harness.accept({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: { reason: "cancelled", sourceEventId: boundary.id },
  });
  await harness.accept({
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    parentId: terminal.id,
    payload: { cause: "recovery", previousRunId: RUN_ID },
  });

  const directory = await mkdtemp(join(tmpdir(), "simpledsh-boundary-first-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    replayEvents(
      join(directory, "premature-terminal.jsonl"),
      harness,
      invalidTrace,
    ),
    { code: "JOURNAL_REFERENCE" },
  );
  const replayed = await replayEvents(
    join(directory, "boundary-before-terminal.jsonl"),
    harness,
    harness.events,
  );
  assert.equal(replayed.events.at(-2)?.hash, terminal.hash);
});

test("tool Boundary cites one ordered batch completed across recovery Runs", async (t) => {
  const firstId = "call_cross_run_first" as ToolCallId;
  const secondId = "call_cross_run_second" as ToolCallId;
  const { harness } = await withAssistant([
    { id: firstId, name: "read", arguments: '{"path":"first.txt"}' },
    { id: secondId, name: "read", arguments: '{"path":"second.txt"}' },
  ]);
  for (const callId of [firstId, secondId]) {
    await harness.accept({
      type: "permission_decided",
      sessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      runId: RUN_ID,
      payload: {
        toolCallId: callId,
        policyDecision: "allow",
        finalDecision: "allow",
        resolution: "policy",
      },
    });
  }
  const firstResult = await commitReadResult(
    harness,
    firstId,
    RUN_ID,
    "first result",
  );
  const oldTerminal = await harness.accept({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: { reason: "cancelled", sourceEventId: firstResult.id },
  });
  await harness.accept({
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    parentId: oldTerminal.id,
    payload: { cause: "recovery", previousRunId: RUN_ID },
  });
  const secondResult = await commitReadResult(
    harness,
    secondId,
    RECOVERY_RUN_ID,
    "second result",
  );
  await harness.reject({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    payload: { reason: "cancelled", sourceEventId: secondResult.id },
  });
  const boundary = await harness.addBoundary(
    objectId<CommitBoundaryId>("cbd", 2),
    [firstResult.id, secondResult.id],
    RECOVERY_RUN_ID,
  );
  const terminal = await harness.accept({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    payload: { reason: "cancelled", sourceEventId: boundary.id },
  });

  const directory = await mkdtemp(join(tmpdir(), "simpledsh-cross-run-batch-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const replayed = await replayEvents(
    join(directory, "complete.jsonl"),
    harness,
    harness.events,
  );
  assert.equal(replayed.head.hash, terminal.hash);
});

async function writeEffectSetup(): Promise<{
  readonly harness: BindingHarness;
  readonly callId: ToolCallId;
  readonly argumentsHash: Sha256;
  readonly assistant: AnyVerifiedJournalEvent;
}> {
  const callId = "call_write" as ToolCallId;
  const args = '{"path":"out.txt","content":"ok"}';
  const { harness, assistant } = await withAssistant([
    { id: callId, name: "write", arguments: args },
  ]);
  await harness.accept({
    type: "permission_decided",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      toolCallId: callId,
      policyDecision: "allow",
      finalDecision: "allow",
      resolution: "policy",
    },
  });
  return {
    harness,
    callId,
    argumentsHash: digest(utf8Bytes(args)),
    assistant,
  };
}

test("prepared and indeterminate effects cannot satisfy a true boundary", async () => {
  const prepared = await writeEffectSetup();
  const effectId = objectId<EffectId>("eff", 1);
  const preparedEvent = await prepared.harness.accept({
    type: "effect_prepared",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      effectId,
      toolCallId: prepared.callId,
      toolName: "write",
      argumentsHash: prepared.argumentsHash,
    },
  });
  await prepared.harness.reject(
    prepared.harness.boundaryDraft(
      objectId<CommitBoundaryId>("cbd", 2),
      [preparedEvent.id],
    ),
  );

  const indeterminate = await writeEffectSetup();
  const indeterminateEffectId = objectId<EffectId>("eff", 1);
  await indeterminate.harness.accept({
    type: "effect_prepared",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      effectId: indeterminateEffectId,
      toolCallId: indeterminate.callId,
      toolName: "write",
      argumentsHash: indeterminate.argumentsHash,
    },
  });
  const indeterminateEvent = await indeterminate.harness.accept({
    type: "effect_indeterminate",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      effectId: indeterminateEffectId,
      reason: "crash_gap",
    },
  });
  await indeterminate.harness.reject(
    indeterminate.harness.boundaryDraft(
      objectId<CommitBoundaryId>("cbd", 2),
      [indeterminateEvent.id],
    ),
  );
});

test("append and replay reject new work while a tool Effect is unsettled", async (t) => {
  const setup = await writeEffectSetup();
  const effectId = objectId<EffectId>("eff", 1);
  await setup.harness.accept({
    type: "effect_prepared",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      effectId,
      toolCallId: setup.callId,
      toolName: "write",
      argumentsHash: setup.argumentsHash,
    },
  });

  const input = utf8Bytes("must wait");
  const artifact = await setup.harness.publishArtifact(input, {
    artifactType: "fact",
    mediaType: "text/plain",
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    lineCount: 1,
  });
  const fact = await setup.harness.accept({
    type: "fact_recorded",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      kind: "user_input",
      artifactId: artifact.payload.artifactId,
      byteCount: input.byteLength,
    },
  });
  const userDraft: AnyJournalEventDraft = {
    type: "user_committed",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    parentId: fact.id,
    payload: {
      ...setup.harness.inlineBlob("user", materializeUserMessage("must wait")),
      sourceFactEventIds: [fact.id],
    },
  };
  const invalidUser = setup.harness.make(userDraft);
  await setup.harness.reject(userDraft);

  const source = setup.harness.events.find(
    (event): event is Extract<
      AnyVerifiedJournalEvent,
      { readonly type: "request_snapshot_stored" }
    > => event.type === "request_snapshot_stored",
  );
  assert.ok(source !== undefined);
  await setup.harness.reject({
    type: "request_attempt_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      attemptId: objectId<AttemptId>("att", 2),
      requestSnapshotId: source.payload.requestSnapshotId,
      ordinal: 2,
    },
  });

  const indeterminate = await setup.harness.accept({
    type: "effect_indeterminate",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: { effectId, reason: "crash_gap" },
  });
  await setup.harness.accept({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      reason: "effect_indeterminate",
      sourceEventId: indeterminate.id,
    },
  });
  await setup.harness.accept({
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    payload: { cause: "recovery", previousRunId: RUN_ID },
  });
  await setup.harness.reject({
    type: "request_snapshot_stored",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    parentId: source.payload.headEventId,
    payload: {
      ...source.payload,
      requestSnapshotId: objectId<RequestSnapshotId>("rqs", 2),
      recoveryFromSnapshotId: source.payload.requestSnapshotId,
    },
  });

  const directory = await mkdtemp(join(tmpdir(), "simpledsh-stage04-closure-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "journal.jsonl");
  const journal = [...setup.harness.events.slice(0, invalidUser.seq - 1), invalidUser]
    .map((event) =>
      Buffer.from(encodeVerifiedJournalEvent(event).copy()).toString("utf8"),
    )
    .join("\n");
  await writeFile(path, `${journal}\n`, { mode: 0o600 });
  const handle = await open(path, "r");
  try {
    await assert.rejects(replayJournal(handle, setup.harness.verifier), {
      code: "JOURNAL_REFERENCE",
    });
  } finally {
    await handle.close();
  }
});

test("completed effect plus its canonical tool result permits a boundary", async () => {
  const setup = await writeEffectSetup();
  const effectId = objectId<EffectId>("eff", 1);
  await setup.harness.accept({
    type: "effect_prepared",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      effectId,
      toolCallId: setup.callId,
      toolName: "write",
      argumentsHash: setup.argumentsHash,
    },
  });
  const outputRaw = utf8Bytes("");
  const output = await setup.harness.publishArtifact(outputRaw, {
    artifactType: "tool_output",
    mediaType: TOOL_OUTPUT_MEDIA_TYPE,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    lineCount: null,
    toolCallId: setup.callId,
    terminal: null,
    toolStream: null,
  });
  const completed = await setup.harness.accept({
    type: "effect_completed",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      effectId,
      toolCallId: setup.callId,
      artifactId: output.payload.artifactId,
      terminal: SUCCEEDED_TERMINAL,
    },
  });
  const outputBytes = artifactResultProjection({
    artifact: output,
    framedBytes: outputRaw,
    toolCallId: setup.callId,
    toolName: "write",
    terminalSource: "effect",
    terminal: SUCCEEDED_TERMINAL,
  }).messageBytes;
  await setup.harness.reject(
    toolResultDraft(setup.harness, {
      toolCallId: setup.callId,
      bytes: outputBytes,
      artifactId: null,
      effectId: null,
      sourceEventId: setup.assistant.id,
    }),
  );
  const result = await setup.harness.accept(
    toolResultDraft(setup.harness, {
      toolCallId: setup.callId,
      bytes: outputBytes,
      artifactId: output.payload.artifactId,
      effectId,
      sourceEventId: completed.id,
    }),
  );
  await setup.harness.addBoundary(objectId<CommitBoundaryId>("cbd", 2), [
    result.id,
  ]);
});

test("reconciled completed effect requires recovery-scoped evidence and output", async () => {
  const setup = await writeEffectSetup();
  const effectId = objectId<EffectId>("eff", 1);
  await setup.harness.accept({
    type: "effect_prepared",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      effectId,
      toolCallId: setup.callId,
      toolName: "write",
      argumentsHash: setup.argumentsHash,
    },
  });
  const emptyOutput = utf8Bytes("");
  const wrongRunOutput = await setup.harness.publishArtifact(
    emptyOutput,
    {
      artifactType: "tool_output",
      mediaType: TOOL_OUTPUT_MEDIA_TYPE,
      lineageId: LINEAGE_ID,
      runId: RUN_ID,
      lineCount: null,
      toolCallId: setup.callId,
      terminal: null,
      toolStream: null,
    },
  );
  const indeterminate = await setup.harness.accept({
    type: "effect_indeterminate",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: { effectId, reason: "crash_gap" },
  });
  const oldRunTerminal = await setup.harness.accept({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      reason: "effect_indeterminate",
      sourceEventId: indeterminate.id,
    },
  });
  await setup.harness.accept({
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    parentId: oldRunTerminal.id,
    payload: { cause: "recovery", previousRunId: RUN_ID },
  });
  const evidence = await setup.harness.publishArtifact(utf8Bytes("operator proof"), {
    artifactType: "operator_evidence",
    mediaType: "text/plain",
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    lineCount: 1,
  });
  await setup.harness.reject({
    type: "effect_reconciled",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    payload: {
      effectId,
      resolution: "completed",
      evidenceArtifactId: evidence.payload.artifactId,
      outputArtifactId: wrongRunOutput.payload.artifactId,
      terminal: SUCCEEDED_TERMINAL,
    },
  });

  const output = await setup.harness.publishArtifact(emptyOutput, {
    artifactType: "tool_output",
    mediaType: TOOL_OUTPUT_MEDIA_TYPE,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    lineCount: null,
    toolCallId: setup.callId,
    terminal: null,
    toolStream: null,
  });
  const reconciled = await setup.harness.accept({
    type: "effect_reconciled",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    payload: {
      effectId,
      resolution: "completed",
      evidenceArtifactId: evidence.payload.artifactId,
      outputArtifactId: output.payload.artifactId,
      terminal: SUCCEEDED_TERMINAL,
    },
  });
  const outputBytes = artifactResultProjection({
    artifact: output,
    framedBytes: emptyOutput,
    toolCallId: setup.callId,
    toolName: "write",
    terminalSource: "effect",
    terminal: SUCCEEDED_TERMINAL,
  }).messageBytes;
  await setup.harness.reject(
    toolResultDraft(setup.harness, {
      toolCallId: setup.callId,
      bytes: outputBytes,
      artifactId: null,
      effectId: null,
      sourceEventId: setup.assistant.id,
      runId: RECOVERY_RUN_ID,
    }),
  );
  const result = await setup.harness.accept(
    toolResultDraft(setup.harness, {
      toolCallId: setup.callId,
      bytes: outputBytes,
      artifactId: output.payload.artifactId,
      effectId,
      sourceEventId: reconciled.id,
      runId: RECOVERY_RUN_ID,
    }),
  );
  await setup.harness.addBoundary(
    objectId<CommitBoundaryId>("cbd", 2),
    [result.id],
    RECOVERY_RUN_ID,
  );
});

test("a pre-Snapshot recovery crash still gets fresh projection then a second crash aliases the same body hash", async (t) => {
  const setup = await throughBoundary();
  const terminal = await setup.harness.accept({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      reason: "durability_failure",
      sourceEventId: setup.boundary.id,
    },
  });
  const firstRecovery = await setup.harness.accept({
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    parentId: terminal.id,
    payload: { cause: "recovery", previousRunId: RUN_ID },
  });
  const preSnapshotCrash = await setup.harness.accept({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    payload: {
      reason: "durability_failure",
      sourceEventId: firstRecovery.id,
    },
  });
  const freshRecoveryRunId = objectId<RunId>("run", 5);
  await setup.harness.accept({
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: freshRecoveryRunId,
    parentId: preSnapshotCrash.id,
    payload: { cause: "recovery", previousRunId: RECOVERY_RUN_ID },
  });
  const snapshotId = objectId<RequestSnapshotId>("rqs", 4);
  const payload = snapshotPayload(setup, snapshotId);
  const freshEvent = await setup.harness.accept({
    type: "request_snapshot_stored",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: freshRecoveryRunId,
    parentId: setup.boundary.id,
    payload,
  });
  if (freshEvent.type !== "request_snapshot_stored") {
    assert.fail("fresh projection did not store a Snapshot");
  }
  const fresh = freshEvent;
  await setup.harness.reject({
    type: "request_snapshot_stored",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: freshRecoveryRunId,
    parentId: setup.boundary.id,
    payload: {
      ...payload,
      requestSnapshotId: objectId<RequestSnapshotId>("rqs", 5),
    },
  });

  const secondCrash = await setup.harness.accept({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: freshRecoveryRunId,
    payload: {
      reason: "durability_failure",
      sourceEventId: fresh.id,
    },
  });
  const secondRecoveryRunId = objectId<RunId>("run", 6);
  await setup.harness.accept({
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: secondRecoveryRunId,
    parentId: secondCrash.id,
    payload: {
      cause: "recovery",
      previousRunId: freshRecoveryRunId,
    },
  });
  await setup.harness.reject({
    type: "request_snapshot_stored",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: secondRecoveryRunId,
    parentId: setup.boundary.id,
    payload: {
      ...fresh.payload,
      requestSnapshotId: objectId<RequestSnapshotId>("rqs", 7),
      recoveryFromSnapshotId: null,
    },
  });
  const aliasEvent = await setup.harness.accept({
    type: "request_snapshot_stored",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: secondRecoveryRunId,
    parentId: setup.boundary.id,
    payload: {
      ...fresh.payload,
      requestSnapshotId: objectId<RequestSnapshotId>("rqs", 6),
      recoveryFromSnapshotId: fresh.payload.requestSnapshotId,
    },
  });
  if (aliasEvent.type !== "request_snapshot_stored") {
    assert.fail("second recovery did not store a Snapshot alias");
  }
  const alias = aliasEvent;
  assert.equal(fresh.payload.recoveryFromSnapshotId, null);
  assert.equal(alias.payload.recoveryFromSnapshotId, fresh.payload.requestSnapshotId);
  assert.equal(alias.payload.bodyHash, fresh.payload.bodyHash);
  assert.equal(alias.payload.bodyRef, fresh.payload.bodyRef);
  assert.equal(alias.payload.byteCount, fresh.payload.byteCount);

  const directory = await mkdtemp(join(tmpdir(), "simpledsh-fresh-recovery-snapshot-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const replayed = await replayEvents(
    join(directory, "fresh-recovery.jsonl"),
    setup.harness,
    setup.harness.events,
  );
  assert.equal(replayed.head.hash, alias.hash);
});

test("recovery rejects a stale Snapshot alias after a newer durable tool Boundary", async (t) => {
  const callId = "call_stale_snapshot" as ToolCallId;
  const { harness } = await withAssistant([
    { id: callId, name: "read", arguments: '{"path":"current.txt"}' },
  ]);
  const sourceSnapshot = harness.events.find(
    (event): event is VerifiedJournalEvent<"request_snapshot_stored"> =>
      event.type === "request_snapshot_stored",
  );
  assert.ok(sourceSnapshot);
  await harness.accept({
    type: "permission_decided",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      toolCallId: callId,
      policyDecision: "allow",
      finalDecision: "allow",
      resolution: "policy",
    },
  });
  const result = await commitReadResult(
    harness,
    callId,
    RUN_ID,
    "newer durable tool output",
  );
  const currentBoundary = await harness.addBoundary(
    objectId<CommitBoundaryId>("cbd", 8),
    [result.id],
  );
  const interrupted = await harness.accept({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      reason: "durability_failure",
      sourceEventId: currentBoundary.id,
    },
  });
  await harness.accept({
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    parentId: interrupted.id,
    payload: { cause: "recovery", previousRunId: RUN_ID },
  });

  const staleDraft: AnyJournalEventDraft = {
    type: "request_snapshot_stored",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    parentId: sourceSnapshot.payload.headEventId,
    payload: {
      ...sourceSnapshot.payload,
      requestSnapshotId: objectId<RequestSnapshotId>("rqs", 8),
      recoveryFromSnapshotId: sourceSnapshot.payload.requestSnapshotId,
    },
  };
  const staleEvent = harness.make(staleDraft);
  await harness.reject(staleDraft);
  const directory = await mkdtemp(join(tmpdir(), "simpledsh-stale-snapshot-alias-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    replayEvents(
      join(directory, "stale-alias.jsonl"),
      harness,
      [...harness.events, staleEvent],
    ),
    { code: "JOURNAL_REFERENCE" },
  );

  const currentBody = utf8Bytes("current durable prefix request body");
  const currentDescriptor = harness.registerSnapshot(currentBody);
  const currentPayload: JournalPayloadByType["request_snapshot_stored"] = {
    requestSnapshotId: objectId<RequestSnapshotId>("rqs", 9),
    bodyRef: currentDescriptor.ref,
    bodyHash: currentDescriptor.hash,
    byteCount: currentBody.byteLength,
    cacheAbiId: harness.cacheAbi.cacheAbiId,
    projectorVersion: "dsh-projector-v1",
    headEventId: currentBoundary.id,
    commitBoundaryId: currentBoundary.payload.commitBoundaryId,
    segmentHashes: [
      harness.cacheAbi.headerHash,
      currentBoundary.payload.chainHash,
    ],
    recoveryFromSnapshotId: null,
  };
  const currentSnapshot = await harness.accept({
    type: "request_snapshot_stored",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    parentId: currentBoundary.id,
    payload: currentPayload,
  });
  const secondCrash = await harness.accept({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    payload: {
      reason: "durability_failure",
      sourceEventId: currentSnapshot.id,
    },
  });
  const aliasRunId = objectId<RunId>("run", 8);
  await harness.accept({
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: aliasRunId,
    parentId: secondCrash.id,
    payload: { cause: "recovery", previousRunId: RECOVERY_RUN_ID },
  });
  const alias = await harness.accept({
    type: "request_snapshot_stored",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: aliasRunId,
    parentId: currentBoundary.id,
    payload: {
      ...currentPayload,
      requestSnapshotId: objectId<RequestSnapshotId>("rqs", 10),
      recoveryFromSnapshotId: currentPayload.requestSnapshotId,
    },
  });
  assert.equal(
    (alias.payload as JournalPayloadByType["request_snapshot_stored"])
      .bodyHash,
    currentPayload.bodyHash,
  );
});

test("snapshot identity and recovery alias are schema- and binding-exact", async (t) => {
  const setup = await throughBoundary();
  const sourceId = objectId<RequestSnapshotId>("rqs", 1);
  const sourcePayload = snapshotPayload(setup, sourceId);
  const baseDraft = {
    type: "request_snapshot_stored",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    parentId: setup.boundary.id,
    payload: sourcePayload,
  } as const;

  assert.throws(
    () =>
      setup.harness.make({
        ...baseDraft,
        payload: {
          ...sourcePayload,
          projectorVersion: "dsh-projector-v2",
        },
      } as unknown as AnyJournalEventDraft),
    { code: "JOURNAL_SCHEMA" },
  );
  assert.throws(
    () =>
      setup.harness.make({
        ...baseDraft,
        payload: { ...sourcePayload, segmentHashes: [sourcePayload.segmentHashes[0]] },
      } as unknown as AnyJournalEventDraft),
    { code: "JOURNAL_SCHEMA" },
  );
  await setup.harness.reject({
    ...baseDraft,
    payload: { ...sourcePayload, headEventId: setup.user.event.id },
  });
  await setup.harness.reject({
    ...baseDraft,
    payload: {
      ...sourcePayload,
      segmentHashes: [
        sourcePayload.segmentHashes[1],
        sourcePayload.segmentHashes[0],
      ],
    },
  });
  const sourceEvent = await setup.harness.accept(baseDraft);

  const sameRunAlias: JournalPayloadByType["request_snapshot_stored"] = {
    ...sourcePayload,
    requestSnapshotId: objectId<RequestSnapshotId>("rqs", 2),
    recoveryFromSnapshotId: sourceId,
  };
  await setup.harness.reject({
    type: "request_snapshot_stored",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    parentId: sourceEvent.id,
    payload: sameRunAlias,
  });
  const oldRunTerminal = await setup.harness.accept({
    type: "run_interrupted",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: { reason: "durability_failure", sourceEventId: sourceEvent.id },
  });
  const recoveryRun = await setup.harness.accept({
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    parentId: oldRunTerminal.id,
    payload: { cause: "recovery", previousRunId: RUN_ID },
  });
  const aliasPayload: JournalPayloadByType["request_snapshot_stored"] = {
    ...sameRunAlias,
    requestSnapshotId: objectId<RequestSnapshotId>("rqs", 3),
  };
  await setup.harness.reject({
    type: "request_snapshot_stored",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    parentId: recoveryRun.id,
    payload: aliasPayload,
  });
  await setup.harness.reject({
    type: "request_snapshot_stored",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    parentId: setup.boundary.id,
    payload: { ...aliasPayload, byteCount: aliasPayload.byteCount + 1 },
  });
  await setup.harness.reject({
    type: "request_snapshot_stored",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    parentId: setup.boundary.id,
    payload: { ...aliasPayload, headEventId: setup.user.event.id },
  });
  const aliasEvent = await setup.harness.accept({
    type: "request_snapshot_stored",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
    parentId: setup.boundary.id,
    payload: aliasPayload,
  });
  assert.equal(
    (aliasEvent.payload as JournalPayloadByType["request_snapshot_stored"])
      .recoveryFromSnapshotId,
    sourceId,
  );

  const directory = await mkdtemp(join(tmpdir(), "simpledsh-stage04-bindings-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "journal.jsonl");
  const journal =
    setup.harness.events
      .map((event) => Buffer.from(encodeVerifiedJournalEvent(event).copy()).toString("utf8"))
      .join("\n") + "\n";
  await writeFile(path, journal, { mode: 0o600 });
  const handle = await open(path, "r");
  try {
    const replayed = await replayJournal(handle, setup.harness.verifier);
    assert.equal(replayed.events.length, setup.harness.events.length);
    assert.equal(replayed.projectionSnapshot.blobCount, 1);
    assert.equal(replayed.projectionSnapshot.chainHash, setup.boundary.payload.chainHash);
    assert.equal(replayed.head.hash, aliasEvent.hash);
  } finally {
    await handle.close();
  }
});

test("the in-memory verifier returns exact immutable ABI and request bytes", async () => {
  const setup = await throughBoundary();
  const source = await acceptSourceSnapshot(setup);
  const loadedManifest = await setup.harness.verifier.loadArtifact(
    setup.harness.events.find(
      (event): event is Extract<
        AnyVerifiedJournalEvent,
        { readonly type: "artifact_published" }
      > =>
        event.type === "artifact_published" &&
        event.payload.artifactType === "cache_abi_manifest",
    )!.payload,
  );
  assert.equal(sameBytes(loadedManifest, setup.harness.cacheAbi.manifestBytes), true);
  await setup.harness.verifier.verifySnapshot(
    source.payload.bodyRef,
    source.payload.bodyHash,
    source.payload.byteCount,
  );
  assert.equal(source.payload.cacheAbiId as CacheAbiId, setup.harness.cacheAbi.cacheAbiId);
});
