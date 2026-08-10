import { sha256Hex } from "../bytes/ops.js";
import type { FrozenBytes } from "../bytes/types.js";
import {
  loadAndAssertCacheAbi,
  PROJECTOR_VERSION_V1,
  type FrozenCacheAbiManifest,
} from "../lineage/cache-abi.js";
import { encodeVerifiedJournalEvent } from "../journal/schema.js";
import type { SnapshotDescriptor, SnapshotStore } from "../snapshot/store.js";
import { projectV1, type ProjectV1Input } from "./projector.js";
import { JournalWriter } from "../journal/writer.js";
import type {
  AnyVerifiedJournalEvent,
  JournalEventDraft,
  LineageId,
  RequestSnapshotId,
  RunId,
  SessionId,
  Sha256,
} from "../journal/types.js";

type CommitBoundaryEvent = Extract<
  AnyVerifiedJournalEvent,
  { readonly type: "commit_boundary_created" }
>;
type ScopedCommitBoundaryEvent = CommitBoundaryEvent & {
  readonly lineageId: LineageId;
  readonly runId: RunId;
};

export type RequestSnapshotStoredEvent = Extract<
  AnyVerifiedJournalEvent,
  { readonly type: "request_snapshot_stored" }
>;

export interface StoreProjectedSnapshotV1Input {
  readonly snapshotStore: SnapshotStore;
  readonly journal: JournalWriter;
  readonly requestSnapshotId: RequestSnapshotId;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly projectionInput: ProjectV1Input;
}

export interface StoreRecoveryAliasV1Input {
  readonly snapshotStore: SnapshotStore;
  readonly journal: JournalWriter;
  readonly cacheAbi: FrozenCacheAbiManifest;
  readonly sourceSnapshotEvent: RequestSnapshotStoredEvent;
  readonly requestSnapshotId: RequestSnapshotId;
  readonly sessionId: SessionId;
  readonly lineageId: LineageId;
  readonly runId: RunId;
}

function invalidSnapshot(message: string): never {
  throw new TypeError(message);
}

function assertExactDataKeys(
  value: unknown,
  expected: readonly string[],
  message: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== expected.length ||
    !expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  ) {
    invalidSnapshot(message);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      invalidSnapshot(message);
    }
  }
}

function validateRecoverySourceMetadata(
  source: RequestSnapshotStoredEvent,
): void {
  assertExactDataKeys(
    source,
    [
      "v",
      "seq",
      "id",
      "type",
      "sessionId",
      "lineageId",
      "runId",
      "parentId",
      "at",
      "payload",
      "prevHash",
      "hash",
    ],
    "Snapshot recovery alias metadata is invalid",
  );
  if (source.type !== "request_snapshot_stored") {
    invalidSnapshot("Snapshot recovery alias metadata is invalid");
  }
  assertExactDataKeys(
    source.payload,
    [
      "requestSnapshotId",
      "bodyRef",
      "bodyHash",
      "byteCount",
      "cacheAbiId",
      "projectorVersion",
      "headEventId",
      "commitBoundaryId",
      "segmentHashes",
      "recoveryFromSnapshotId",
    ],
    "Snapshot recovery alias metadata is invalid",
  );
  try {
    encodeVerifiedJournalEvent(source);
  } catch {
    invalidSnapshot("Snapshot recovery alias metadata is invalid");
  }
}

function bodyIdentity(body: FrozenBytes): {
  readonly bodyHash: Sha256;
  readonly byteCount: number;
} {
  return Object.freeze({
    bodyHash: `sha256:${sha256Hex(body)}` as Sha256,
    byteCount: body.byteLength,
  });
}

function assertDescriptorMatches(
  descriptor: SnapshotDescriptor,
  expected: { readonly bodyHash: Sha256; readonly byteCount: number },
): void {
  if (
    descriptor.bodyHash !== expected.bodyHash ||
    descriptor.byteCount !== expected.byteCount ||
    descriptor.bodyRef !==
      `snapshots/sha256/${expected.bodyHash.slice("sha256:".length)}`
  ) {
    invalidSnapshot("Snapshot descriptor does not match the exact body bytes");
  }
}

function selectedBoundary(
  input: ProjectV1Input,
  headEventId: string,
  segmentHashes: readonly [Sha256, Sha256],
): ScopedCommitBoundaryEvent {
  const matches = input.journalFacts.filter(
    (event): event is CommitBoundaryEvent =>
      event.id === headEventId && event.type === "commit_boundary_created",
  );
  const boundary = matches[0];
  if (
    matches.length !== 1 ||
    boundary === undefined ||
    boundary.lineageId !== input.lineageId ||
    boundary.runId === undefined ||
    boundary.payload.commitBoundaryId !== input.commitBoundaryId ||
    boundary.payload.chainHash !== segmentHashes[1] ||
    input.cacheAbi.headerHash !== segmentHashes[0] ||
    segmentHashes[0] === segmentHashes[1]
  ) {
    return invalidSnapshot(
      "Projector result does not bind to the selected Commit Boundary",
    );
  }
  return boundary as ScopedCommitBoundaryEvent;
}

function assertStoredEventMatches(
  event: AnyVerifiedJournalEvent,
  draft: JournalEventDraft<"request_snapshot_stored">,
): asserts event is RequestSnapshotStoredEvent {
  if (
    event.type !== "request_snapshot_stored" ||
    event.sessionId !== draft.sessionId ||
    event.lineageId !== draft.lineageId ||
    event.runId !== draft.runId ||
    event.parentId !== draft.parentId ||
    event.payload.requestSnapshotId !== draft.payload.requestSnapshotId ||
    event.payload.bodyRef !== draft.payload.bodyRef ||
    event.payload.bodyHash !== draft.payload.bodyHash ||
    event.payload.byteCount !== draft.payload.byteCount ||
    event.payload.cacheAbiId !== draft.payload.cacheAbiId ||
    event.payload.projectorVersion !== draft.payload.projectorVersion ||
    event.payload.headEventId !== draft.payload.headEventId ||
    event.payload.commitBoundaryId !== draft.payload.commitBoundaryId ||
    event.payload.segmentHashes.length !== 2 ||
    event.payload.segmentHashes[0] !== draft.payload.segmentHashes[0] ||
    event.payload.segmentHashes[1] !== draft.payload.segmentHashes[1] ||
    event.payload.recoveryFromSnapshotId !==
      draft.payload.recoveryFromSnapshotId
  ) {
    invalidSnapshot("Journal returned a different Snapshot event");
  }
}

export async function storeProjectedSnapshotV1(
  input: StoreProjectedSnapshotV1Input,
): Promise<RequestSnapshotStoredEvent> {
  const projection = projectV1(input.projectionInput);
  const boundary = selectedBoundary(
    input.projectionInput,
    projection.headEventId,
    projection.segmentHashes,
  );
  if (boundary.sessionId !== input.sessionId) {
    invalidSnapshot("Projector target Session differs from its selected Boundary");
  }
  const expected = bodyIdentity(projection.body);
  const descriptor = await input.snapshotStore.publish(projection.body);
  assertDescriptorMatches(descriptor, expected);

  const draft: JournalEventDraft<"request_snapshot_stored"> = {
    type: "request_snapshot_stored",
    sessionId: input.sessionId,
    lineageId: input.projectionInput.lineageId,
    runId: input.runId,
    parentId: boundary.id,
    payload: {
      requestSnapshotId: input.requestSnapshotId,
      bodyRef: descriptor.bodyRef,
      bodyHash: expected.bodyHash,
      byteCount: expected.byteCount,
      cacheAbiId: input.projectionInput.cacheAbi.cacheAbiId,
      projectorVersion: PROJECTOR_VERSION_V1,
      headEventId: boundary.id,
      commitBoundaryId: input.projectionInput.commitBoundaryId,
      segmentHashes: projection.segmentHashes,
      recoveryFromSnapshotId: null,
    },
  };
  const event = await input.journal.append(draft);
  assertStoredEventMatches(event, draft);
  return event;
}

export async function storeRecoveryAliasV1(
  input: StoreRecoveryAliasV1Input,
): Promise<RequestSnapshotStoredEvent> {
  const source = input.sourceSnapshotEvent;
  validateRecoverySourceMetadata(source);
  let loadedCacheAbi: FrozenCacheAbiManifest;
  try {
    loadedCacheAbi = loadAndAssertCacheAbi(input.cacheAbi);
  } catch {
    return invalidSnapshot("Snapshot recovery alias Cache ABI provenance is invalid");
  }
  if (
    source.sessionId !== input.sessionId ||
    source.lineageId !== input.lineageId ||
    source.runId === undefined ||
    source.runId === input.runId ||
    source.parentId !== source.payload.headEventId ||
    source.payload.cacheAbiId !== loadedCacheAbi.cacheAbiId ||
    source.payload.projectorVersion !== PROJECTOR_VERSION_V1 ||
    source.payload.segmentHashes.length !== 2 ||
    source.payload.segmentHashes[0] !== loadedCacheAbi.headerHash ||
    source.payload.segmentHashes[0] === source.payload.segmentHashes[1]
  ) {
    return invalidSnapshot("Snapshot recovery alias provenance is invalid");
  }
  const descriptor: SnapshotDescriptor = {
    bodyRef: source.payload.bodyRef,
    bodyHash: source.payload.bodyHash,
    byteCount: source.payload.byteCount,
  };

  // Only a fully validated identity may cause a CAS read. The body is still
  // verified before the alias can become durable in the recovery Run.
  const body = await input.snapshotStore.load(descriptor);
  const expected = bodyIdentity(body);
  assertDescriptorMatches(descriptor, expected);

  const draft: JournalEventDraft<"request_snapshot_stored"> = {
    type: "request_snapshot_stored",
    sessionId: input.sessionId,
    lineageId: input.lineageId,
    runId: input.runId,
    parentId: source.payload.headEventId,
    payload: {
      requestSnapshotId: input.requestSnapshotId,
      bodyRef: source.payload.bodyRef,
      bodyHash: source.payload.bodyHash,
      byteCount: source.payload.byteCount,
      cacheAbiId: source.payload.cacheAbiId,
      projectorVersion: source.payload.projectorVersion,
      headEventId: source.payload.headEventId,
      commitBoundaryId: source.payload.commitBoundaryId,
      segmentHashes: source.payload.segmentHashes,
      recoveryFromSnapshotId: source.payload.requestSnapshotId,
    },
  };
  const event = await input.journal.append(draft);
  assertStoredEventMatches(event, draft);
  return event;
}
