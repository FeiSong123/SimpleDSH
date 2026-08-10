import { randomBytes } from "node:crypto";

import type {
  ArtifactId,
  ArtifactVersionId,
  AttemptId,
  CacheCheckpointId,
  CanonicalTimestamp,
  CommitBoundaryId,
  EffectId,
  EventId,
  EventIdentitySource,
  JournalClock,
  LineageId,
  RequestSnapshotId,
  RunId,
  SessionId,
} from "./types.js";

function opaque(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export function newEventId(): EventId {
  return opaque("evt") as EventId;
}

export function newSessionId(): SessionId {
  return opaque("ses") as SessionId;
}

export function newLineageId(): LineageId {
  return opaque("lin") as LineageId;
}

export function newRunId(): RunId {
  return opaque("run") as RunId;
}

export function newRequestSnapshotId(): RequestSnapshotId {
  return opaque("rqs") as RequestSnapshotId;
}

export function newAttemptId(): AttemptId {
  return opaque("att") as AttemptId;
}

export function newArtifactId(): ArtifactId {
  return opaque("art") as ArtifactId;
}

export function newArtifactVersionId(): ArtifactVersionId {
  return opaque("arv") as ArtifactVersionId;
}

export function newEffectId(): EffectId {
  return opaque("eff") as EffectId;
}

export function newCacheCheckpointId(): CacheCheckpointId {
  return opaque("ccp") as CacheCheckpointId;
}

export function newCommitBoundaryId(): CommitBoundaryId {
  return opaque("cbd") as CommitBoundaryId;
}

export const randomEventIdentitySource: EventIdentitySource = Object.freeze({
  nextEventId: newEventId,
});

export const systemJournalClock: JournalClock = Object.freeze({
  now: () => new Date().toISOString() as CanonicalTimestamp,
});
