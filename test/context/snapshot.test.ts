import assert from "node:assert/strict";
import type { FileHandle } from "node:fs/promises";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  bytesEqual,
  sha256Hex,
  toBase64,
  utf8Bytes,
} from "../../src/bytes/ops.js";
import { buildDeepSeekRequestSnapshot } from "../../src/bytes/request.js";
import { materializeUserMessage } from "../../src/bytes/user.js";
import type { FrozenBytes } from "../../src/bytes/types.js";
import {
  storeProjectedSnapshotV1,
  storeRecoveryAliasV1,
  type RequestSnapshotStoredEvent,
} from "../../src/ctx/snapshot.js";
import { createVerifiedJournalEvent } from "../../src/journal/schema.js";
import type {
  AnyJournalEventDraft,
  AnyVerifiedJournalEvent,
  ArtifactId,
  ArtifactRef,
  CanonicalTimestamp,
  CommitBoundaryId,
  EventId,
  RequestSnapshotId,
  LineageId,
  RunId,
  SessionId,
  Sha256,
  SnapshotRef,
} from "../../src/journal/types.js";
import { JournalWriter } from "../../src/journal/writer.js";
import {
  buildCacheAbiV1,
  type FrozenCacheAbiManifest,
} from "../../src/lineage/cache-abi.js";
import type {
  SnapshotDescriptor,
  SnapshotStore,
} from "../../src/snapshot/store.js";

const SESSION_ID = `ses_${"1".repeat(32)}` as SessionId;
const LINEAGE_ID = `lin_${"2".repeat(32)}` as LineageId;
const SOURCE_RUN_ID = `run_${"3".repeat(32)}` as RunId;
const RECOVERY_RUN_ID = `run_${"4".repeat(32)}` as RunId;
const SECOND_RECOVERY_RUN_ID = `run_${"a".repeat(32)}` as RunId;
const MANIFEST_ARTIFACT_ID = `art_${"5".repeat(32)}` as ArtifactId;
const FACT_ARTIFACT_ID = `art_${"6".repeat(32)}` as ArtifactId;
const BOUNDARY_ID = `cbd_${"7".repeat(32)}` as CommitBoundaryId;
const SOURCE_SNAPSHOT_ID = `rqs_${"8".repeat(32)}` as RequestSnapshotId;
const NEW_SNAPSHOT_ID = `rqs_${"9".repeat(32)}` as RequestSnapshotId;
const ALIAS_SNAPSHOT_ID = `rqs_${"a".repeat(32)}` as RequestSnapshotId;
const TIMESTAMP = "2026-08-04T00:00:00.000Z" as CanonicalTimestamp;

interface ProjectionFixture {
  readonly cacheAbi: FrozenCacheAbiManifest;
  readonly events: readonly AnyVerifiedJournalEvent[];
  readonly body: FrozenBytes;
  readonly bodyDescriptor: SnapshotDescriptor;
  readonly boundaryEventId: EventId;
  readonly chainHash: Sha256;
}

function artifactRef(hash: Sha256): ArtifactRef {
  return `artifacts/sha256/${hash.slice("sha256:".length)}` as ArtifactRef;
}

function snapshotDescriptor(body: FrozenBytes): SnapshotDescriptor {
  const hex = sha256Hex(body);
  return Object.freeze({
    bodyRef: `snapshots/sha256/${hex}` as SnapshotRef,
    bodyHash: `sha256:${hex}` as Sha256,
    byteCount: body.byteLength,
  });
}

function projectionFixture(): ProjectionFixture {
  const cacheAbi = buildCacheAbiV1();
  const events: AnyVerifiedJournalEvent[] = [];
  const append = (draft: AnyJournalEventDraft): AnyVerifiedJournalEvent => {
    const previous = events.at(-1);
    const event = createVerifiedJournalEvent(draft, {
      seq: events.length + 1,
      id: `evt_${(events.length + 1).toString(16).padStart(32, "0")}` as EventId,
      at: TIMESTAMP,
      prevHash: previous?.hash ?? null,
    });
    events.push(event);
    return event;
  };

  append({ type: "session_started", sessionId: SESSION_ID, payload: {} });
  const manifestHash = cacheAbi.cacheAbiId as unknown as Sha256;
  const manifest = append({
    type: "artifact_published",
    sessionId: SESSION_ID,
    payload: {
      artifactId: MANIFEST_ARTIFACT_ID,
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
  append({
    type: "cache_abi_declared",
    sessionId: SESSION_ID,
    parentId: manifest.id,
    payload: {
      cacheAbiId: cacheAbi.cacheAbiId,
      manifestArtifactId: MANIFEST_ARTIFACT_ID,
      manifestByteCount: cacheAbi.manifestBytes.byteLength,
    },
  });
  append({
    type: "lineage_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    payload: { cacheAbiId: cacheAbi.cacheAbiId },
  });
  append({
    type: "lineage_activated",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    payload: {
      previousLineageId: null,
      nextLineageId: LINEAGE_ID,
      reason: "initial",
    },
  });
  append({
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: SOURCE_RUN_ID,
    payload: { cause: "user", previousRunId: null },
  });

  const userInput = utf8Bytes("persist before append");
  const factHash = `sha256:${sha256Hex(userInput)}` as Sha256;
  append({
    type: "artifact_published",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: SOURCE_RUN_ID,
    payload: {
      artifactId: FACT_ARTIFACT_ID,
      artifactRef: artifactRef(factHash),
      artifactHash: factHash,
      byteCount: userInput.byteLength,
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
  const fact = append({
    type: "fact_recorded",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: SOURCE_RUN_ID,
    payload: {
      kind: "user_input",
      artifactId: FACT_ARTIFACT_ID,
      byteCount: userInput.byteLength,
    },
  });
  const userBlob = materializeUserMessage("persist before append");
  const chainHash = `sha256:${sha256Hex(userBlob)}` as Sha256;
  const user = append({
    type: "user_committed",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: SOURCE_RUN_ID,
    parentId: fact.id,
    payload: {
      role: "user",
      enc: "b64",
      bytes: toBase64(userBlob),
      byteCount: userBlob.byteLength,
      byteHash: chainHash,
      blobIndex: 0,
      chainHash,
      sourceFactEventIds: [fact.id],
    },
  });
  const boundary = append({
    type: "commit_boundary_created",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: SOURCE_RUN_ID,
    parentId: user.id,
    payload: {
      commitBoundaryId: BOUNDARY_ID,
      cacheCheckpointId: null,
      blobCount: 1,
      chainHash,
      protocolClosed: true,
      effectsSettled: true,
      sourceEventIds: [user.id],
    },
  });
  const body = buildDeepSeekRequestSnapshot([
    cacheAbi.systemBlob,
    userBlob,
  ]).body;

  return Object.freeze({
    cacheAbi,
    events: Object.freeze(events),
    body,
    bodyDescriptor: snapshotDescriptor(body),
    boundaryEventId: boundary.id,
    chainHash,
  });
}

async function journalWriter(
  t: TestContext,
  order: string[],
  failBeforeSync = false,
): Promise<JournalWriter> {
  const directory = await mkdtemp(join(tmpdir(), "simpledsh-snapshot-"));
  const handle = await open(join(directory, "log.jsonl"), "ax+", 0o600);
  let nextEvent = 0;
  const writer = new JournalWriter({
    log: handle,
    head: { seq: 0, hash: null },
    clock: { now: () => TIMESTAMP },
    eventIds: {
      nextEventId: () => {
        nextEvent += 1;
        return `evt_${(100 + nextEvent).toString(16).padStart(32, "0")}` as EventId;
      },
    },
    preflight: {
      prepare: async () => {
        order.push("append");
        return { commit: () => undefined };
      },
    },
    lease: {
      release: async (log: FileHandle) => log.close(),
    },
    ...(failBeforeSync
      ? {
          controls: {
            fault: (point: string) => {
              if (point === "append.before_sync") {
                throw new Error("injected append durability failure");
              }
            },
          },
        }
      : {}),
  });
  t.after(async () => {
    await writer.close();
    await rm(directory, { recursive: true, force: true });
  });
  return writer;
}

function recordingStore(
  value: ProjectionFixture,
  order: string[],
  loadedBody = value.body,
): SnapshotStore {
  return {
    publish: async (body) => {
      order.push("publish");
      assert.equal(bytesEqual(body, value.body), true);
      return value.bodyDescriptor;
    },
    load: async (descriptor) => {
      order.push("load");
      assert.deepEqual(descriptor, value.bodyDescriptor);
      return loadedBody;
    },
    verify: async () => undefined,
  };
}

function sourceSnapshot(
  value: ProjectionFixture,
  payloadOverrides: Partial<RequestSnapshotStoredEvent["payload"]> = {},
): RequestSnapshotStoredEvent {
  const event = createVerifiedJournalEvent(
    {
      type: "request_snapshot_stored",
      sessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      runId: SOURCE_RUN_ID,
      parentId: value.boundaryEventId,
      payload: {
        requestSnapshotId: SOURCE_SNAPSHOT_ID,
        ...value.bodyDescriptor,
        cacheAbiId: value.cacheAbi.cacheAbiId,
        projectorVersion: "dsh-projector-v1",
        headEventId: value.boundaryEventId,
        commitBoundaryId: BOUNDARY_ID,
        segmentHashes: [value.cacheAbi.headerHash, value.chainHash],
        recoveryFromSnapshotId: null,
        ...payloadOverrides,
      },
    },
    {
      seq: 11,
      id: `evt_${"b".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: `sha256:${"c".repeat(64)}` as Sha256,
    },
  );
  if (event.type !== "request_snapshot_stored") {
    throw new TypeError("fixture did not create a Snapshot event");
  }
  return event;
}

test("snapshot bytes publish before the durable request_snapshot_stored append", async (t) => {
  const value = projectionFixture();
  const order: string[] = [];
  const journal = await journalWriter(t, order);
  const event = await storeProjectedSnapshotV1({
    snapshotStore: recordingStore(value, order),
    journal,
    requestSnapshotId: NEW_SNAPSHOT_ID,
    sessionId: SESSION_ID,
    runId: SOURCE_RUN_ID,
    projectionInput: {
      cacheAbi: value.cacheAbi,
      journalFacts: value.events,
      externalBlobs: new Map(),
      lineageId: LINEAGE_ID,
      commitBoundaryId: BOUNDARY_ID,
    },
  });

  assert.deepEqual(order, ["publish", "append"]);
  assert.equal(event.sessionId, SESSION_ID);
  assert.equal(event.lineageId, LINEAGE_ID);
  assert.equal(event.runId, SOURCE_RUN_ID);
  assert.equal(event.parentId, value.boundaryEventId);
  assert.deepEqual(event.payload, {
    requestSnapshotId: NEW_SNAPSHOT_ID,
    ...value.bodyDescriptor,
    cacheAbiId: value.cacheAbi.cacheAbiId,
    projectorVersion: "dsh-projector-v1",
    headEventId: value.boundaryEventId,
    commitBoundaryId: BOUNDARY_ID,
    segmentHashes: [value.cacheAbi.headerHash, value.chainHash],
    recoveryFromSnapshotId: null,
  });
});

test("Boundary crash fresh projection then a second crash aliases the identical body exactly once", async (t) => {
  const value = projectionFixture();
  const order: string[] = [];
  const journal = await journalWriter(t, order);
  const predecessorBoundary = value.events.at(-1);

  assert.equal(predecessorBoundary?.type, "commit_boundary_created");
  assert.equal(predecessorBoundary?.runId, SOURCE_RUN_ID);

  const event = await storeProjectedSnapshotV1({
    snapshotStore: recordingStore(value, order),
    journal,
    requestSnapshotId: NEW_SNAPSHOT_ID,
    sessionId: SESSION_ID,
    runId: RECOVERY_RUN_ID,
    projectionInput: {
      cacheAbi: value.cacheAbi,
      journalFacts: value.events,
      externalBlobs: new Map(),
      lineageId: LINEAGE_ID,
      commitBoundaryId: BOUNDARY_ID,
    },
  });

  assert.deepEqual(order, ["publish", "append"]);
  assert.equal(event.runId, RECOVERY_RUN_ID);
  assert.notEqual(event.runId, predecessorBoundary?.runId);
  assert.equal(event.parentId, value.boundaryEventId);
  assert.equal(event.payload.headEventId, value.boundaryEventId);
  assert.equal(event.payload.commitBoundaryId, BOUNDARY_ID);
  assert.equal(event.payload.requestSnapshotId, NEW_SNAPSHOT_ID);
  assert.equal(event.payload.recoveryFromSnapshotId, null);

  const alias = await storeRecoveryAliasV1({
    snapshotStore: recordingStore(value, order),
    journal,
    cacheAbi: value.cacheAbi,
    sourceSnapshotEvent: event,
    requestSnapshotId: ALIAS_SNAPSHOT_ID,
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: SECOND_RECOVERY_RUN_ID,
  });
  assert.deepEqual(order, ["publish", "append", "load", "append"]);
  assert.equal(alias.runId, SECOND_RECOVERY_RUN_ID);
  assert.equal(alias.payload.requestSnapshotId, ALIAS_SNAPSHOT_ID);
  assert.equal(alias.payload.recoveryFromSnapshotId, NEW_SNAPSHOT_ID);
  assert.equal(alias.payload.bodyRef, event.payload.bodyRef);
  assert.equal(alias.payload.bodyHash, event.payload.bodyHash);
  assert.equal(alias.payload.byteCount, event.payload.byteCount);
});

test("append failure leaves only an orphan published body and never acknowledges a Snapshot", async (t) => {
  const value = projectionFixture();
  const order: string[] = [];
  const journal = await journalWriter(t, order, true);

  await assert.rejects(
    storeProjectedSnapshotV1({
      snapshotStore: recordingStore(value, order),
      journal,
      requestSnapshotId: NEW_SNAPSHOT_ID,
      sessionId: SESSION_ID,
      runId: SOURCE_RUN_ID,
      projectionInput: {
        cacheAbi: value.cacheAbi,
        journalFacts: value.events,
        externalBlobs: new Map(),
        lineageId: LINEAGE_ID,
        commitBoundaryId: BOUNDARY_ID,
      },
    }),
    { code: "JOURNAL_IO" },
  );
  assert.deepEqual(order, ["publish", "append"]);
  assert.equal(journal.state, "poisoned");
});

test("recovery alias validates identity, loads, then copies it without Projector or publish", async (t) => {
  const value = projectionFixture();
  const source = sourceSnapshot(value);
  const order: string[] = [];
  const baseStore = recordingStore(value, order);
  const store: SnapshotStore = {
    ...baseStore,
    publish: async () => {
      throw new Error("recovery alias must not publish or serialize");
    },
  };
  const journal = await journalWriter(t, order);
  const event = await storeRecoveryAliasV1({
    snapshotStore: store,
    journal,
    cacheAbi: value.cacheAbi,
    sourceSnapshotEvent: source,
    requestSnapshotId: NEW_SNAPSHOT_ID,
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RECOVERY_RUN_ID,
  });

  assert.deepEqual(order, ["load", "append"]);
  assert.equal(event.sessionId, source.sessionId);
  assert.equal(event.lineageId, source.lineageId);
  assert.equal(event.runId, RECOVERY_RUN_ID);
  assert.notEqual(event.runId, source.runId);
  assert.equal(event.parentId, source.payload.headEventId);
  assert.deepEqual(event.payload, {
    ...source.payload,
    requestSnapshotId: NEW_SNAPSHOT_ID,
    recoveryFromSnapshotId: SOURCE_SNAPSHOT_ID,
  });
});

test("recovery alias rejects loaded-byte and source header mismatches before append", async (t) => {
  const value = projectionFixture();
  const source = sourceSnapshot(value);

  {
    const order: string[] = [];
    const journal = await journalWriter(t, order);
    await assert.rejects(
      storeRecoveryAliasV1({
        snapshotStore: recordingStore(value, order, utf8Bytes("different")),
        journal,
        cacheAbi: value.cacheAbi,
        sourceSnapshotEvent: source,
        requestSnapshotId: NEW_SNAPSHOT_ID,
        sessionId: SESSION_ID,
        lineageId: LINEAGE_ID,
        runId: RECOVERY_RUN_ID,
      }),
      /exact body bytes/u,
    );
    assert.deepEqual(order, ["load"]);
  }

  {
    const order: string[] = [];
    const journal = await journalWriter(t, order);
    const forged = sourceSnapshot(value, {
      segmentHashes: [
        `sha256:${"f".repeat(64)}` as Sha256,
        source.payload.segmentHashes[1],
      ],
    });
    await assert.rejects(
      storeRecoveryAliasV1({
        snapshotStore: recordingStore(value, order),
        journal,
        cacheAbi: value.cacheAbi,
        sourceSnapshotEvent: forged,
        requestSnapshotId: NEW_SNAPSHOT_ID,
        sessionId: SESSION_ID,
        lineageId: LINEAGE_ID,
        runId: RECOVERY_RUN_ID,
      }),
      /provenance/u,
    );
    assert.deepEqual(order, []);
  }
});

test("new Snapshot rejects a store descriptor that disagrees with projected bytes", async (t) => {
  const value = projectionFixture();
  const order: string[] = [];
  const journal = await journalWriter(t, order);
  const store: SnapshotStore = {
    publish: async () => {
      order.push("publish");
      return {
        ...value.bodyDescriptor,
        byteCount: value.bodyDescriptor.byteCount + 1,
      };
    },
    load: async () => value.body,
    verify: async () => undefined,
  };

  await assert.rejects(
    storeProjectedSnapshotV1({
      snapshotStore: store,
      journal,
      requestSnapshotId: NEW_SNAPSHOT_ID,
      sessionId: SESSION_ID,
      runId: SOURCE_RUN_ID,
      projectionInput: {
        cacheAbi: value.cacheAbi,
        journalFacts: value.events,
        externalBlobs: new Map(),
        lineageId: LINEAGE_ID,
        commitBoundaryId: BOUNDARY_ID,
      },
    }),
    /exact body bytes/u,
  );
  assert.deepEqual(order, ["publish"]);
});

test("recovery alias rejects a forged outward Cache ABI before loading the body", async (t) => {
  const value = projectionFixture();
  const order: string[] = [];
  const journal = await journalWriter(t, order);
  const forgedCacheAbi = {
    ...value.cacheAbi,
    headerHash: `sha256:${"f".repeat(64)}` as Sha256,
  } as FrozenCacheAbiManifest;

  await assert.rejects(
    storeRecoveryAliasV1({
      snapshotStore: recordingStore(value, order),
      journal,
      cacheAbi: forgedCacheAbi,
      sourceSnapshotEvent: sourceSnapshot(value),
      requestSnapshotId: NEW_SNAPSHOT_ID,
      sessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      runId: RECOVERY_RUN_ID,
    }),
    /provenance/u,
  );
  assert.deepEqual(order, []);
});

test("recovery alias rejects forbidden ABI and source metadata keys before CAS I/O", async (t) => {
  const value = projectionFixture();
  const source = sourceSnapshot(value);

  const forgedCacheAbis: readonly FrozenCacheAbiManifest[] = [
    { ...value.cacheAbi, model: "deepseek-v4-flash" } as unknown as FrozenCacheAbiManifest,
    {
      ...value.cacheAbi,
      endpoint: "https://example.invalid",
    } as unknown as FrozenCacheAbiManifest,
  ];
  for (const cacheAbi of forgedCacheAbis) {
    const order: string[] = [];
    const journal = await journalWriter(t, order);
    await assert.rejects(
      storeRecoveryAliasV1({
        snapshotStore: recordingStore(value, order),
        journal,
        cacheAbi,
        sourceSnapshotEvent: source,
        requestSnapshotId: NEW_SNAPSHOT_ID,
        sessionId: SESSION_ID,
        lineageId: LINEAGE_ID,
        runId: RECOVERY_RUN_ID,
      }),
      /Cache ABI provenance/u,
    );
    assert.deepEqual(order, []);
  }

  const forgedSources: readonly RequestSnapshotStoredEvent[] = [
    {
      ...source,
      endpoint: "https://example.invalid",
    } as unknown as RequestSnapshotStoredEvent,
    {
      ...source,
      payload: { ...source.payload, providerRequestId: "forbidden" },
    } as unknown as RequestSnapshotStoredEvent,
  ];
  for (const sourceSnapshotEvent of forgedSources) {
    const order: string[] = [];
    const journal = await journalWriter(t, order);
    await assert.rejects(
      storeRecoveryAliasV1({
        snapshotStore: recordingStore(value, order),
        journal,
        cacheAbi: value.cacheAbi,
        sourceSnapshotEvent,
        requestSnapshotId: NEW_SNAPSHOT_ID,
        sessionId: SESSION_ID,
        lineageId: LINEAGE_ID,
        runId: RECOVERY_RUN_ID,
      }),
      /metadata/u,
    );
    assert.deepEqual(order, []);
  }
});
