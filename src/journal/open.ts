import type { FileHandle } from "node:fs/promises";

import {
  createBlobCas,
  createRecoveryCas,
  createSnapshotCas,
  openBlobCasReadOnly,
  openRecoveryCasReadOnly,
  openSnapshotCasReadOnly,
  type FixedCas,
} from "../artifact/internal-cas.js";
import {
  createArtifactStore,
  openArtifactStoreReadOnly,
} from "../artifact/store.js";
import type {
  ArtifactDescriptor,
  ArtifactStore,
  BlobRef as ArtifactBlobRef,
  RecoveryRef as ArtifactRecoveryRef,
  Sha256 as ArtifactSha256,
  SnapshotRef as ArtifactSnapshotRef,
} from "../artifact/types.js";
import { freezeBytes, type FrozenBytes } from "../bytes/types.js";
import type {
  JournalReferenceVerifier,
  RecoveryViewV1,
} from "./bindings.js";
import { journalError } from "./errors.js";
import type { PersistenceTestControls } from "./faults.js";
import {
  acquireWriterLease,
  observeWriterLeasePassive,
  releaseWriterLease,
  type PassiveWriterLeaseObservation,
  type WriterLease,
} from "./lease.js";
import {
  bootstrapSession,
  createSessionPaths,
  openExistingSessionLog,
  openExistingSessionLogReadOnly,
  type SessionPaths,
} from "./paths.js";
import {
  repairTornJournal,
  verifyRecoveryObjectReference,
} from "./recovery.js";
import { replayJournal, type JournalReplayResult } from "./replay.js";
import type {
  AnyVerifiedJournalEvent,
  BlobRef,
  EventIdentitySource,
  JournalClock,
  JournalPayloadByType,
  SessionId,
  Sha256,
  SnapshotRef,
} from "./types.js";
import {
  JournalWriter,
  type JournalAppendPreflight,
} from "./writer.js";

const INTERNAL_RANGE_BYTES = 32_768;

export interface OpenJournalResult {
  readonly paths: SessionPaths;
  readonly writer: JournalWriter;
  readonly replay: OpenJournalReplayResult;
  readonly recoveryView: () => RecoveryViewV1;
  readonly artifacts: ArtifactStore;
}

export interface ReadOnlyJournalObservation {
  readonly stable: boolean;
  readonly initialLogByteCount: number;
  readonly finalLogByteCount: number;
  readonly leaseStable: boolean;
  readonly initialLease: PassiveWriterLeaseObservation;
  readonly finalLease: PassiveWriterLeaseObservation;
}

export interface OpenJournalReadOnlyResult {
  readonly paths: SessionPaths;
  readonly replay: OpenJournalReplayResult;
  readonly recoveryView: RecoveryViewV1;
  readonly observation: ReadOnlyJournalObservation;
}

export type OpenJournalReplayResult = Omit<
  JournalReplayResult,
  "projection"
>;

async function loadFixedCasObject<Ref extends ArtifactBlobRef>(
  cas: FixedCas<Ref>,
  ref: Ref,
): Promise<FrozenBytes> {
  const verified = await cas.verifyObject(ref);
  const bytes = new Uint8Array(verified.byteCount);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const range = await cas.readVerifiedRange(ref, {
      offset,
      maxBytes: Math.min(INTERNAL_RANGE_BYTES, bytes.byteLength - offset),
    });
    if (range.byteCount === 0) throw new Error("verified CAS object made no progress");
    bytes.set(range.bytes.copy(), offset);
    offset += range.byteCount;
  }
  return freezeBytes(bytes);
}

function artifactDescriptor(
  payload: JournalPayloadByType["artifact_published"],
): ArtifactDescriptor {
  return {
    artifactRef: payload.artifactRef,
    artifactHash: payload.artifactHash,
    byteCount: payload.byteCount,
    lineCount: payload.lineCount,
    mediaType: payload.mediaType,
    artifactType: payload.artifactType,
    streamBytes: payload.streamBytes,
    hardLimitReached: payload.hardLimitReached,
    descendantsReaped: payload.descendantsReaped,
    toolCallId: payload.toolCallId,
    terminal: payload.terminal,
  };
}

async function loadArtifactObject(
  artifacts: ArtifactStore,
  payload: JournalPayloadByType["artifact_published"],
): Promise<FrozenBytes> {
  const bytes = new Uint8Array(payload.byteCount);
  let offset = 0;
  await artifacts.scanArtifact(artifactDescriptor(payload), (chunk) => {
    const copy = chunk.copy();
    bytes.set(copy, offset);
    offset += copy.byteLength;
  });
  if (offset !== bytes.byteLength) {
    throw new Error("verified Artifact scan made incomplete progress");
  }
  return freezeBytes(bytes);
}

function referenceVerifier(
  artifacts: ArtifactStore,
  blobs: FixedCas<ArtifactBlobRef>,
  snapshots: FixedCas<ArtifactSnapshotRef>,
  recovery: FixedCas<ArtifactRecoveryRef>,
): JournalReferenceVerifier {
  return {
    loadBlob: async (ref: BlobRef) =>
      loadFixedCasObject(blobs, ref as ArtifactBlobRef),
    loadArtifact: async (payload) => loadArtifactObject(artifacts, payload),
    scanArtifact: async (payload, visit) => {
      await artifacts.scanArtifact(artifactDescriptor(payload), visit);
    },
    verifyArtifact: async (
      payload: JournalPayloadByType["artifact_published"],
    ) => {
      await artifacts.verifyArtifact(artifactDescriptor(payload));
    },
    verifySnapshot: async (
      ref: SnapshotRef,
      hash: Sha256,
      byteCount: number,
    ) => {
      await snapshots.verifyObject(ref as ArtifactSnapshotRef, {
        hash: hash as ArtifactSha256,
        byteCount,
      });
    },
    verifyRecovery: async (payload, sessionId, validPrefixByteCount) =>
      verifyRecoveryObjectReference(
        recovery,
        payload,
        sessionId,
        validPrefixByteCount,
      ),
  };
}

function writerLeaseAdapter(lease: WriterLease): {
  release(log: FileHandle): Promise<void>;
} {
  return {
    release: async (log) => {
      await releaseWriterLease(lease, log);
    },
  };
}

function assertExpectedSession(
  replay: JournalReplayResult,
  expectedSessionId: SessionId,
): void {
  const recordedSessionId = replay.events[0]?.sessionId;
  if (
    recordedSessionId !== undefined &&
    recordedSessionId !== expectedSessionId
  ) {
    throw journalError("JOURNAL_REFERENCE");
  }
}

function sessionBoundPreflight(
  expectedSessionId: SessionId,
  delegate: JournalAppendPreflight,
): JournalAppendPreflight {
  return Object.freeze({
    prepare: async (event: AnyVerifiedJournalEvent) => {
      if (event.sessionId !== expectedSessionId) {
        throw journalError("JOURNAL_REFERENCE");
      }
      return delegate.prepare(event);
    },
  });
}

function publicReplayResult(
  replay: JournalReplayResult,
): OpenJournalReplayResult {
  return Object.freeze({
    events: replay.events,
    head: replay.head,
    projectionSnapshot: replay.projectionSnapshot,
    validPrefixByteCount: replay.validPrefixByteCount,
    totalByteCount: replay.totalByteCount,
    tornTail: replay.tornTail,
  });
}

export async function openJournal(
  workspaceRoot: string,
  sessionId: SessionId,
  clock: JournalClock,
  eventIds: EventIdentitySource,
  controls?: PersistenceTestControls,
): Promise<OpenJournalResult> {
  const paths = createSessionPaths(workspaceRoot, sessionId);
  await bootstrapSession(paths, controls);
  let log = await openExistingSessionLog(paths);
  let lease: WriterLease | undefined;
  try {
    lease = await acquireWriterLease(paths, clock.now(), controls);
    const [artifacts, blobs, snapshots, recovery] = await Promise.all([
      createArtifactStore(paths.sessionDir, controls),
      createBlobCas(paths.sessionDir, controls),
      createSnapshotCas(paths.sessionDir, controls),
      createRecoveryCas(paths.sessionDir, controls),
    ]);
    const verifier = referenceVerifier(artifacts, blobs, snapshots, recovery);
    let replay = await replayJournal(log, verifier);
    assertExpectedSession(replay, sessionId);
    if (replay.tornTail !== null) {
      const repaired = await repairTornJournal(
        paths,
        log,
        replay,
        verifier,
        clock,
        eventIds,
        controls,
      );
      log = repaired.log;
      replay = repaired.replay;
      assertExpectedSession(replay, sessionId);
    }
    const writer = new JournalWriter({
      log,
      head: replay.head,
      initialEvents: replay.events,
      clock,
      eventIds,
      preflight: sessionBoundPreflight(sessionId, replay.projection),
      lease: writerLeaseAdapter(lease),
      ...(controls === undefined ? {} : { controls }),
    });
    return Object.freeze({
      paths,
      writer,
      replay: publicReplayResult(replay),
      recoveryView: () => replay.projection.recoveryView(),
      artifacts,
    });
  } catch (error) {
    if (lease === undefined) {
      await log.close().catch(() => undefined);
    } else {
      await releaseWriterLease(lease, log).catch(() => undefined);
    }
    throw error;
  }
}

function sameLogObservation(
  left: Awaited<ReturnType<FileHandle["stat"]>>,
  right: Awaited<ReturnType<FileHandle["stat"]>>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export async function openJournalReadOnly(
  workspaceRoot: string,
  sessionId: SessionId,
): Promise<OpenJournalReadOnlyResult> {
  const paths = createSessionPaths(workspaceRoot, sessionId);
  const log = await openExistingSessionLogReadOnly(paths);
  try {
    const initialLog = await log.stat();
    if (!Number.isSafeInteger(initialLog.size) || initialLog.size < 0) {
      throw journalError("JOURNAL_IO");
    }
    const initialLease = await observeWriterLeasePassive(paths);
    const [artifacts, blobs, snapshots, recovery] = await Promise.all([
      openArtifactStoreReadOnly(paths.sessionDir),
      openBlobCasReadOnly(paths.sessionDir),
      openSnapshotCasReadOnly(paths.sessionDir),
      openRecoveryCasReadOnly(paths.sessionDir),
    ]);
    const replay = await replayJournal(
      log,
      referenceVerifier(artifacts, blobs, snapshots, recovery),
      initialLog.size,
    );
    assertExpectedSession(replay, sessionId);
    const finalLog = await log.stat();
    const finalLease = await observeWriterLeasePassive(paths);
    return Object.freeze({
      paths,
      replay: publicReplayResult(replay),
      recoveryView: replay.projection.recoveryView(),
      observation: Object.freeze({
        stable:
          sameLogObservation(initialLog, finalLog) &&
          replay.totalByteCount === initialLog.size,
        initialLogByteCount: initialLog.size,
        finalLogByteCount: finalLog.size,
        leaseStable:
          initialLease.fingerprint === finalLease.fingerprint &&
          initialLease.state === finalLease.state &&
          initialLease.verifiable === finalLease.verifiable,
        initialLease,
        finalLease,
      }),
    });
  } finally {
    await log.close().catch(() => undefined);
  }
}
