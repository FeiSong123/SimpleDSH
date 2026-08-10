import { buildDeepSeekRequestSnapshotWithTools } from "../bytes/request.js";
import { reasoningEffortFromTuple } from "../lineage/cache-abi.js";
import type { FrozenBytes } from "../bytes/types.js";
import {
  loadAndAssertCacheAbi,
  type FrozenCacheAbiManifest,
} from "../lineage/cache-abi.js";
import { selectLineagePrefixV1 } from "../lineage/prefix.js";
import type {
  AnyVerifiedJournalEvent,
  BlobRef,
  CommitBoundaryId,
  EventId,
  LineageId,
  Sha256,
} from "../journal/types.js";

export interface ProjectV1Input {
  readonly cacheAbi: FrozenCacheAbiManifest;
  readonly journalFacts: readonly AnyVerifiedJournalEvent[];
  readonly externalBlobs: ReadonlyMap<BlobRef, FrozenBytes>;
  readonly lineageId: LineageId;
  readonly commitBoundaryId: CommitBoundaryId;
}

export interface ProjectV1Result {
  readonly blobs: readonly FrozenBytes[];
  readonly body: FrozenBytes;
  readonly headEventId: EventId;
  readonly segmentHashes: readonly [Sha256, Sha256];
}

export type ProjectV1Output = ProjectV1Result;

export function projectV1(input: ProjectV1Input): ProjectV1Result {
  const loaded = loadAndAssertCacheAbi(input.cacheAbi);

  const prefix = selectLineagePrefixV1({
    cacheAbi: loaded,
    journalFacts: input.journalFacts,
    externalBlobs: input.externalBlobs,
    lineageId: input.lineageId,
    commitBoundaryId: input.commitBoundaryId,
  });
  if (loaded.headerHash === prefix.chainHash) {
    throw new TypeError("Projector segment hashes must be distinct");
  }

  const blobs = Object.freeze([loaded.systemBlob, ...prefix.roleBlobs]);
  // The effort comes from the Lineage's own durable manifest, never from a
  // caller argument: replay and recovery must reproduce the exact bytes.
  const effort = reasoningEffortFromTuple(loaded.modelTupleBytes);
  if (effort === null) {
    throw new TypeError("Cache ABI model tuple is not canonical");
  }
  const snapshot = buildDeepSeekRequestSnapshotWithTools(
    blobs,
    loaded.toolsBlob,
    effort,
  );
  const segmentHashes = Object.freeze([
    loaded.headerHash,
    prefix.chainHash,
  ]) as readonly [Sha256, Sha256];

  return Object.freeze({
    blobs,
    body: snapshot.body,
    headEventId: prefix.boundaryEventId,
    segmentHashes,
  });
}
