import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";

import { advanceBlobPrefix, INLINE_BLOB_LIMIT } from "../../src/blob/store.js";
import { materializeAssistant } from "../../src/bytes/assistant.js";
import {
  bytesEqual,
  sha256Hex,
  toBase64,
  utf8Bytes,
} from "../../src/bytes/ops.js";
import { materializeUserMessage } from "../../src/bytes/user.js";
import type { FrozenBytes } from "../../src/bytes/types.js";
import { projectV1 } from "../../src/ctx/projector.js";
import { storeRecoveryAliasV1 } from "../../src/ctx/snapshot.js";
import { JournalWriter } from "../../src/journal/writer.js";
import { createVerifiedJournalEvent } from "../../src/journal/schema.js";
import type {
  AnyJournalEventDraft,
  AnyVerifiedJournalEvent,
  ArtifactId,
  ArtifactRef,
  AttemptId,
  BlobPayload,
  BlobRef,
  CacheCheckpointId,
  CanonicalTimestamp,
  CommitBoundaryId,
  EventId,
  JournalEventDraft,
  JournalEventType,
  LineageId,
  RequestSnapshotId,
  RunId,
  SessionId,
  Sha256,
  SnapshotRef,
  VerifiedJournalEvent,
} from "../../src/journal/types.js";
import {
  buildCacheAbiV1,
  type FrozenCacheAbiManifest,
} from "../../src/lineage/cache-abi.js";
import * as lineageApi from "../../src/lineage/index.js";
import { selectLineagePrefixV1 } from "../../src/lineage/prefix.js";
import { createSnapshotStore } from "../../src/snapshot/store.js";
import type { SnapshotStore } from "../../src/snapshot/store.js";

const TIMESTAMP = "2026-08-04T02:03:04.005Z" as CanonicalTimestamp;
const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

function opaque<Value>(prefix: string, digit: string): Value {
  return `${prefix}_${digit.repeat(32)}` as Value;
}

function digest(bytes: FrozenBytes): Sha256 {
  return `sha256:${sha256Hex(bytes)}` as Sha256;
}

function artifactRef(hash: Sha256): ArtifactRef {
  return `artifacts/sha256/${hash.slice("sha256:".length)}` as ArtifactRef;
}

function blobRef(hash: Sha256): BlobRef {
  return `blobs/sha256/${hash.slice("sha256:".length)}` as BlobRef;
}

function snapshotRef(hash: Sha256): SnapshotRef {
  return `snapshots/sha256/${hash.slice("sha256:".length)}` as SnapshotRef;
}

class JournalFacts {
  readonly events: AnyVerifiedJournalEvent[] = [];
  #previousHash: Sha256 | null = null;

  append<Type extends JournalEventType>(
    draft: JournalEventDraft<Type>,
  ): VerifiedJournalEvent<Type> {
    const seq = this.events.length + 1;
    const event = createVerifiedJournalEvent(draft as AnyJournalEventDraft, {
      seq,
      id: `evt_${seq.toString(16).padStart(32, "0")}` as EventId,
      at: TIMESTAMP,
      prevHash: this.#previousHash,
    }) as VerifiedJournalEvent<Type>;
    this.events.push(event as AnyVerifiedJournalEvent);
    this.#previousHash = event.hash;
    return event;
  }
}

interface ContextFixture {
  readonly builder: JournalFacts;
  readonly cacheAbi: FrozenCacheAbiManifest;
  readonly sessionId: SessionId;
  readonly lineageId: LineageId;
  readonly runId: RunId;
  readonly boundaryId: CommitBoundaryId;
  readonly boundaryEvent: VerifiedJournalEvent<"commit_boundary_created">;
  readonly userBytes: FrozenBytes;
  readonly chainHash: Sha256;
  readonly externalBlobs: ReadonlyMap<BlobRef, FrozenBytes>;
}

function contextFixture(options: {
  readonly sessionDigit: string;
  readonly lineageDigit: string;
  readonly runDigit: string;
  readonly content: string;
  readonly external?: boolean;
}): ContextFixture {
  const builder = new JournalFacts();
  const cacheAbi = buildCacheAbiV1();
  const sessionId = opaque<SessionId>("ses", options.sessionDigit);
  const lineageId = opaque<LineageId>("lin", options.lineageDigit);
  const runId = opaque<RunId>("run", options.runDigit);
  const manifestArtifactId = opaque<ArtifactId>("art", "4");
  const factArtifactId = opaque<ArtifactId>("art", "5");
  const boundaryId = opaque<CommitBoundaryId>("cbd", "6");

  builder.append({ type: "session_started", sessionId, payload: {} });
  const manifestHash = cacheAbi.cacheAbiId as unknown as Sha256;
  const manifest = builder.append({
    type: "artifact_published",
    sessionId,
    payload: {
      artifactId: manifestArtifactId,
      artifactRef: artifactRef(manifestHash),
      artifactHash: manifestHash,
      byteCount: cacheAbi.manifestBytes.byteLength,
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
  builder.append({
    type: "cache_abi_declared",
    sessionId,
    parentId: manifest.id,
    payload: {
      cacheAbiId: cacheAbi.cacheAbiId,
      manifestArtifactId,
      manifestByteCount: cacheAbi.manifestBytes.byteLength,
    },
  });
  builder.append({
    type: "lineage_started",
    sessionId,
    lineageId,
    payload: { cacheAbiId: cacheAbi.cacheAbiId },
  });
  builder.append({
    type: "lineage_activated",
    sessionId,
    lineageId,
    payload: {
      previousLineageId: null,
      nextLineageId: lineageId,
      reason: "initial",
    },
  });
  builder.append({
    type: "run_started",
    sessionId,
    lineageId,
    runId,
    payload: { cause: "user", previousRunId: null },
  });

  const factBytes = utf8Bytes(options.content);
  const factHash = digest(factBytes);
  const factArtifact = builder.append({
    type: "artifact_published",
    sessionId,
    lineageId,
    runId,
    payload: {
      artifactId: factArtifactId,
      artifactRef: artifactRef(factHash),
      artifactHash: factHash,
      byteCount: factBytes.byteLength,
      lineCount: 1,
      mediaType: "text/plain",
      artifactType: "fact",
      streamBytes: null,
      hardLimitReached: null,
      descendantsReaped: null,
      toolCallId: null,
      terminal: null,
    },
  });
  const fact = builder.append({
    type: "fact_recorded",
    sessionId,
    lineageId,
    runId,
    parentId: factArtifact.id,
    payload: {
      kind: "user_input",
      artifactId: factArtifactId,
      byteCount: factBytes.byteLength,
    },
  });

  const userBytes = materializeUserMessage(options.content);
  const chainHash = digest(userBytes);
  const externalBlobs = new Map<BlobRef, FrozenBytes>();
  let blob: BlobPayload<"user">;
  if (options.external === true) {
    if (userBytes.byteLength <= INLINE_BLOB_LIMIT) {
      throw new TypeError("external acceptance fixture must exceed inline limit");
    }
    const ref = blobRef(chainHash);
    externalBlobs.set(ref, userBytes);
    blob = {
      role: "user",
      enc: "ref",
      blobRef: ref,
      byteCount: userBytes.byteLength,
      byteHash: chainHash,
      blobIndex: 0,
      chainHash,
    };
  } else {
    blob = {
      role: "user",
      enc: "b64",
      bytes: toBase64(userBytes),
      byteCount: userBytes.byteLength,
      byteHash: chainHash,
      blobIndex: 0,
      chainHash,
    };
  }
  const user = builder.append({
    type: "user_committed",
    sessionId,
    lineageId,
    runId,
    parentId: fact.id,
    payload: { ...blob, sourceFactEventIds: [fact.id] },
  });
  const boundaryEvent = builder.append({
    type: "commit_boundary_created",
    sessionId,
    lineageId,
    runId,
    parentId: user.id,
    payload: {
      commitBoundaryId: boundaryId,
      cacheCheckpointId: null,
      blobCount: 1,
      chainHash,
      protocolClosed: true,
      effectsSettled: true,
      sourceEventIds: [user.id],
    },
  });

  return {
    builder,
    cacheAbi,
    sessionId,
    lineageId,
    runId,
    boundaryId,
    boundaryEvent,
    userBytes,
    chainHash,
    externalBlobs,
  };
}

function projectionInput(value: ContextFixture) {
  return {
    cacheAbi: value.cacheAbi,
    journalFacts: value.builder.events,
    externalBlobs: value.externalBlobs,
    lineageId: value.lineageId,
    commitBoundaryId: value.boundaryId,
  } as const;
}

test("cross-process snapshot bytes reconstruct exactly from serialized Journal facts and immutable bytes", () => {
  const value = contextFixture({
    sessionDigit: "1",
    lineageDigit: "2",
    runDigit: "3",
    content: `cross-process-${"x".repeat(INLINE_BLOB_LIMIT + 32)}`,
    external: true,
  });
  const expected = projectV1(projectionInput(value));
  const childProgram = `
    import { freezeBytes } from ${JSON.stringify(pathToFileURL(resolve(projectRoot, "dist/src/bytes/types.js")).href)};
    import { sha256Hex, toBase64 } from ${JSON.stringify(pathToFileURL(resolve(projectRoot, "dist/src/bytes/ops.js")).href)};
    import { projectV1 } from ${JSON.stringify(pathToFileURL(resolve(projectRoot, "dist/src/ctx/projector.js")).href)};
    import { loadCacheAbiV1 } from ${JSON.stringify(pathToFileURL(resolve(projectRoot, "dist/src/lineage/cache-abi.js")).href)};
    let serialized = "";
    for await (const chunk of process.stdin) serialized += chunk;
    const input = JSON.parse(serialized);
    const manifest = freezeBytes(Uint8Array.from(Buffer.from(input.manifest, "base64")));
    const cacheAbi = loadCacheAbiV1(manifest, input.cacheAbiId);
    const externalBlobs = new Map(input.externalBlobs.map(([ref, bytes]) => [
      ref,
      freezeBytes(Uint8Array.from(Buffer.from(bytes, "base64"))),
    ]));
    const result = projectV1({
      cacheAbi,
      journalFacts: input.journalFacts,
      externalBlobs,
      lineageId: input.lineageId,
      commitBoundaryId: input.commitBoundaryId,
    });
    process.stdout.write(JSON.stringify({
      body: toBase64(result.body),
      bodyHash: "sha256:" + sha256Hex(result.body),
      headEventId: result.headEventId,
      segmentHashes: result.segmentHashes,
    }));
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", childProgram],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: {},
      input: JSON.stringify({
        manifest: toBase64(value.cacheAbi.manifestBytes),
        cacheAbiId: value.cacheAbi.cacheAbiId,
        journalFacts: value.builder.events,
        externalBlobs: [...value.externalBlobs].map(([ref, bytes]) => [
          ref,
          toBase64(bytes),
        ]),
        lineageId: value.lineageId,
        commitBoundaryId: value.boundaryId,
      }),
      maxBuffer: 2 * 1024 * 1024,
      timeout: 10_000,
    },
  );

  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  const actual = JSON.parse(child.stdout) as {
    readonly body: string;
    readonly bodyHash: Sha256;
    readonly headEventId: EventId;
    readonly segmentHashes: readonly [Sha256, Sha256];
  };
  assert.equal(actual.body, toBase64(expected.body));
  assert.equal(actual.bodyHash, digest(expected.body));
  assert.equal(actual.headEventId, expected.headEventId);
  assert.deepEqual(actual.segmentHashes, expected.segmentHashes);
});

test("same ABI independent lineage keeps opaque Session identities and exposes no child/fork surface", () => {
  const first = contextFixture({
    sessionDigit: "1",
    lineageDigit: "2",
    runDigit: "3",
    content: "same immutable request",
  });
  const second = contextFixture({
    sessionDigit: "7",
    lineageDigit: "8",
    runDigit: "9",
    content: "same immutable request",
  });
  const firstProjection = projectV1(projectionInput(first));
  const secondProjection = projectV1(projectionInput(second));

  assert.notEqual(first.sessionId, second.sessionId);
  assert.notEqual(first.lineageId, second.lineageId);
  assert.equal(first.cacheAbi.cacheAbiId, second.cacheAbi.cacheAbiId);
  assert.equal(bytesEqual(firstProjection.body, secondProjection.body), true);
  assert.equal(digest(firstProjection.body), digest(secondProjection.body));
  assert.equal(first.lineageId.startsWith("lin_"), true);
  assert.equal(second.lineageId.startsWith("lin_"), true);
  assert.deepEqual(
    Object.keys(lineageApi).filter((name) => /child|fork|branch/iu.test(name)),
    [],
  );
});

test("Cache Checkpoint and Commit Boundary remain non-interchangeable and an unsafe checkpoint cannot satisfy commit closure", () => {
  const value = contextFixture({
    sessionDigit: "1",
    lineageDigit: "2",
    runDigit: "3",
    content: "read before closing",
  });
  const initialProjection = projectV1(projectionInput(value));
  const snapshotId = opaque<RequestSnapshotId>("rqs", "7");
  const snapshotHash = digest(initialProjection.body);
  value.builder.append({
    type: "request_snapshot_stored",
    sessionId: value.sessionId,
    lineageId: value.lineageId,
    runId: value.runId,
    parentId: value.boundaryEvent.id,
    payload: {
      requestSnapshotId: snapshotId,
      bodyRef: snapshotRef(snapshotHash),
      bodyHash: snapshotHash,
      byteCount: initialProjection.body.byteLength,
      cacheAbiId: value.cacheAbi.cacheAbiId,
      projectorVersion: "dsh-projector-v1",
      headEventId: value.boundaryEvent.id,
      commitBoundaryId: value.boundaryId,
      segmentHashes: initialProjection.segmentHashes,
      recoveryFromSnapshotId: null,
    },
  });
  const attemptId = opaque<AttemptId>("att", "8");
  value.builder.append({
    type: "request_attempt_started",
    sessionId: value.sessionId,
    lineageId: value.lineageId,
    runId: value.runId,
    payload: { attemptId, requestSnapshotId: snapshotId, ordinal: 1 },
  });
  value.builder.append({
    type: "request_semantic_started",
    sessionId: value.sessionId,
    lineageId: value.lineageId,
    runId: value.runId,
    payload: { attemptId },
  });
  const assistantBytes = materializeAssistant({
    content: "",
    reasoningContent: "the read result is still pending",
    toolCalls: [
      {
        id: "call_pending_read",
        type: "function",
        function: { name: "read", arguments: '{"path":"pending.txt"}' },
      },
    ],
  });
  const assistantHash = digest(assistantBytes);
  const assistantChain = advanceBlobPrefix(assistantBytes, {
    blobIndex: 1,
    previousChainHash: value.chainHash,
  });
  const assistant = value.builder.append({
    type: "assistant_committed",
    sessionId: value.sessionId,
    lineageId: value.lineageId,
    runId: value.runId,
    payload: {
      role: "assistant",
      enc: "b64",
      bytes: toBase64(assistantBytes),
      byteCount: assistantBytes.byteLength,
      byteHash: assistantHash,
      blobIndex: 1,
      chainHash: assistantChain,
      attemptId,
      requestSnapshotId: snapshotId,
      providerRequestId: "provider-checkpoint",
      responseModel: "DeepSeek-V4-Flash-0731",
      systemFingerprint: "fp-checkpoint",
      semanticDeltaCount: 1,
      usage: {
        promptTokens: 11,
        promptCacheHitTokens: 7,
        promptCacheMissTokens: 4,
        completionTokens: 3,
        reasoningTokens: 2,
        rawFinishReason: "tool_calls",
      },
    },
  });
  const checkpointId = opaque<CacheCheckpointId>("ccp", "9");
  const checkpoint = value.builder.append({
    type: "cache_checkpoint_created",
    sessionId: value.sessionId,
    lineageId: value.lineageId,
    runId: value.runId,
    payload: {
      cacheCheckpointId: checkpointId,
      requestSnapshotId: snapshotId,
      blobCount: 2,
      chainHash: assistantChain,
      promptTokens: 11,
      providerRequestId: "provider-checkpoint",
      sourceAssistantEventId: assistant.id,
    },
  });
  const unsafeBoundaryId = opaque<CommitBoundaryId>("cbd", "a");
  const unsafeBoundary = value.builder.append({
    type: "commit_boundary_created",
    sessionId: value.sessionId,
    lineageId: value.lineageId,
    runId: value.runId,
    payload: {
      commitBoundaryId: unsafeBoundaryId,
      cacheCheckpointId: checkpointId,
      blobCount: 2,
      chainHash: assistantChain,
      protocolClosed: true,
      effectsSettled: true,
      sourceEventIds: [assistant.id],
    },
  });

  const acceptsOnlyCommitBoundary = (id: CommitBoundaryId): string => id;
  assert.equal(acceptsOnlyCommitBoundary(unsafeBoundaryId), unsafeBoundaryId);
  // @ts-expect-error Cache Checkpoint ids cannot satisfy Commit Boundary APIs.
  assert.equal(acceptsOnlyCommitBoundary(checkpointId), checkpointId);
  assert.equal(checkpoint.type, "cache_checkpoint_created");
  assert.equal(unsafeBoundary.type, "commit_boundary_created");
  assert.equal("commitBoundaryId" in checkpoint.payload, false);
  assert.equal("cacheCheckpointId" in unsafeBoundary.payload, true);
  assert.throws(
    () =>
      selectLineagePrefixV1({
        cacheAbi: value.cacheAbi,
        journalFacts: value.builder.events,
        externalBlobs: value.externalBlobs,
        lineageId: value.lineageId,
        commitBoundaryId: unsafeBoundaryId,
      }),
    /Commit Boundary is not derived from a closed prefix/u,
  );
});

async function acceptanceWriter(t: TestContext): Promise<JournalWriter> {
  const directory = await mkdtemp(join(tmpdir(), "simpledsh-acceptance-journal-"));
  const handle = await open(join(directory, "log.jsonl"), "ax+", 0o600);
  let ordinal = 0;
  const writer = new JournalWriter({
    log: handle,
    head: { seq: 0, hash: null },
    clock: { now: () => TIMESTAMP },
    eventIds: {
      nextEventId: () => {
        ordinal += 1;
        return `evt_${(200 + ordinal).toString(16).padStart(32, "0")}` as EventId;
      },
    },
    preflight: {
      prepare: async () => ({ commit: () => undefined }),
    },
    lease: {
      release: async (log: FileHandle) => log.close(),
    },
  });
  t.after(async () => {
    await writer.close();
    await rm(directory, { recursive: true, force: true });
  });
  return writer;
}

test("immutable snapshot lookup returns exact bytes and retry/recovery never re-materialize", async (t) => {
  const value = contextFixture({
    sessionDigit: "1",
    lineageDigit: "2",
    runDigit: "3",
    content: "store once and recover by identity",
  });
  const projection = projectV1(projectionInput(value));
  const sessionDirectory = await mkdtemp(
    join(tmpdir(), "simpledsh-acceptance-snapshot-"),
  );
  t.after(() => rm(sessionDirectory, { recursive: true, force: true }));
  const durableStore = await createSnapshotStore(sessionDirectory);
  const descriptor = await durableStore.publish(projection.body);

  const exposedCopy = projection.body.copy();
  exposedCopy.fill(0);
  const retryOne = await durableStore.load(descriptor);
  const retryTwo = await durableStore.load(descriptor);
  assert.equal(bytesEqual(retryOne, projection.body), true);
  assert.equal(bytesEqual(retryTwo, projection.body), true);
  assert.equal(bytesEqual(retryOne, retryTwo), true);
  assert.equal(descriptor.bodyHash, digest(projection.body));
  assert.equal(descriptor.byteCount, projection.body.byteLength);

  const sourceSnapshotId = opaque<RequestSnapshotId>("rqs", "7");
  const source = value.builder.append({
    type: "request_snapshot_stored",
    sessionId: value.sessionId,
    lineageId: value.lineageId,
    runId: value.runId,
    parentId: value.boundaryEvent.id,
    payload: {
      requestSnapshotId: sourceSnapshotId,
      ...descriptor,
      cacheAbiId: value.cacheAbi.cacheAbiId,
      projectorVersion: "dsh-projector-v1",
      headEventId: value.boundaryEvent.id,
      commitBoundaryId: value.boundaryId,
      segmentHashes: projection.segmentHashes,
      recoveryFromSnapshotId: null,
    },
  });
  const journal = await acceptanceWriter(t);
  let loadCount = 0;
  let publishCount = 0;
  const recoveryStore: SnapshotStore = {
    publish: async () => {
      publishCount += 1;
      throw new Error("recovery must not publish or materialize");
    },
    load: async (identity) => {
      loadCount += 1;
      return durableStore.load(identity);
    },
    verify: async (identity) => durableStore.verify(identity),
  };
  const recoveryRunId = opaque<RunId>("run", "b");
  const aliasInput = {
    snapshotStore: recoveryStore,
    journal,
    cacheAbi: value.cacheAbi,
    sourceSnapshotEvent: source,
    requestSnapshotId: opaque<RequestSnapshotId>("rqs", "c"),
    sessionId: value.sessionId,
    lineageId: value.lineageId,
    runId: recoveryRunId,
  } as const;
  assert.equal(
    Object.prototype.hasOwnProperty.call(aliasInput, "projectionInput"),
    false,
  );
  const alias = await storeRecoveryAliasV1(aliasInput);

  assert.equal(loadCount, 1);
  assert.equal(publishCount, 0);
  assert.equal(alias.payload.bodyRef, descriptor.bodyRef);
  assert.equal(alias.payload.bodyHash, descriptor.bodyHash);
  assert.equal(alias.payload.byteCount, descriptor.byteCount);
  assert.deepEqual(alias.payload.segmentHashes, projection.segmentHashes);
  assert.equal(alias.payload.recoveryFromSnapshotId, sourceSnapshotId);
  assert.equal(bytesEqual(await durableStore.load(descriptor), projection.body), true);
});
