import { utf8Bytes } from "../bytes/ops.js";
import {
  newLineageId,
  openJournal,
  type ArtifactId,
  type LineageId,
  type SessionId,
  type VerifiedJournalEvent,
} from "../journal/index.js";

/** The prompt that produces the summary. Sent on the Lineage being replaced. */
export const COMPACTION_PROMPT =
  "Write a handover note for whoever continues this work with no memory of it. Cover: what was asked, what you changed and where, what you verified and how, what is still open, and anything you learned about this codebase that would be expensive to rediscover. Be specific — name files, commands and values. This note is the only thing that survives.";

/** Prompt tokens at which the interactive loop compacts on its own. */
export const DEFAULT_COMPACTION_THRESHOLD_TOKENS = 512_000;

export interface CompactionResult {
  readonly fromLineageId: LineageId;
  readonly toLineageId: LineageId;
  readonly summaryArtifactId: ArtifactId;
  readonly replacedPromptTokens: number;
}

/**
 * Replace the conversation with a summary of itself.
 *
 * Two things make this legal rather than a rewrite. The summary is produced on
 * the Lineage being replaced, so reading the whole history is still a cache
 * hit, and the old bytes are never touched — they stay durable and replayable
 * forever. What changes is which Lineage is active: the new one starts empty
 * under the same Cache ABI, and the summary rides in as its first user turn.
 *
 * The caller must already hold a closed tail: no active Run, no pending tool
 * call. Compaction between turns is what keeps it on an episode boundary,
 * which invariant 2 requires — an assistant message and its tool results can
 * never be split by one.
 */
export async function recordCompaction(input: {
  readonly workspaceRoot: string;
  readonly sessionId: SessionId;
  readonly summary: string;
  readonly replacedPromptTokens: number;
  readonly clock?: Parameters<typeof openJournal>[2];
  readonly eventIds?: Parameters<typeof openJournal>[3];
}): Promise<CompactionResult> {
  const opened = await openJournal(
    input.workspaceRoot,
    input.sessionId,
    input.clock ?? (await import("../journal/index.js")).systemJournalClock,
    input.eventIds ??
      (await import("../journal/index.js")).randomEventIdentitySource,
  );
  try {
    const activation = opened.writer.events.reduce<
      VerifiedJournalEvent<"lineage_activated"> | undefined
    >((latest, event) => (event.type === "lineage_activated" ? event : latest), undefined);
    if (activation === undefined) throw new Error("session has no active Lineage");
    const fromLineageId = activation.payload.nextLineageId as LineageId;

    const started = opened.writer.events.find(
      (event): event is VerifiedJournalEvent<"lineage_started"> =>
        event.type === "lineage_started" && event.lineageId === fromLineageId,
    );
    if (started === undefined) throw new Error("active Lineage was never started");

    const sink = await opened.artifacts.beginArtifact();
    await sink.write(utf8Bytes(input.summary));
    const descriptor = await sink.publish({
      lineCount: null,
      mediaType: "text/plain; charset=utf-8",
      artifactType: "fact",
      streamBytes: null,
      hardLimitReached: null,
      descendantsReaped: null,
      toolCallId: null,
      terminal: null,
    });
    const summaryArtifactId = (
      await import("../journal/index.js")
    ).newArtifactId();
    const published = await opened.writer.append({
      type: "artifact_published",
      sessionId: input.sessionId,
      payload: {
        artifactId: summaryArtifactId,
        artifactRef: descriptor.artifactRef,
        artifactHash: descriptor.artifactHash,
        byteCount: descriptor.byteCount,
        lineCount: descriptor.lineCount,
        mediaType: descriptor.mediaType,
        artifactType: descriptor.artifactType,
        streamBytes: descriptor.streamBytes,
        hardLimitReached: descriptor.hardLimitReached,
        descendantsReaped: descriptor.descendantsReaped,
        toolCallId: descriptor.toolCallId,
        terminal: descriptor.terminal,
      },
    });

    const toLineageId = newLineageId();
    await opened.writer.append({
      type: "lineage_started",
      sessionId: input.sessionId,
      lineageId: toLineageId,
      parentId: published.id,
      payload: { cacheAbiId: started.payload.cacheAbiId },
    });
    await opened.writer.append({
      type: "cache_break",
      sessionId: input.sessionId,
      payload: {
        classification: "planned",
        fromLineageId,
        toLineageId,
        reason: "compaction",
        summaryArtifactId,
        replacedPromptTokens: input.replacedPromptTokens,
      },
    });
    await opened.writer.append({
      type: "lineage_activated",
      sessionId: input.sessionId,
      lineageId: toLineageId,
      payload: {
        previousLineageId: fromLineageId,
        nextLineageId: toLineageId,
        reason: "compaction",
      },
    });
    return Object.freeze({
      fromLineageId,
      toLineageId,
      summaryArtifactId,
      replacedPromptTokens: input.replacedPromptTokens,
    });
  } finally {
    await opened.writer.close();
  }
}

/**
 * The summary a freshly compacted Lineage still has to carry.
 *
 * Returns null once that Lineage has a Run of its own, because by then the
 * summary is already in its prefix.
 */
export async function pendingCompactionSummary(
  workspaceRoot: string,
  sessionId: SessionId,
): Promise<string | null> {
  const journal = await import("../journal/index.js");
  const opened = await journal.openJournalReadOnly(workspaceRoot, sessionId);
  const events = opened.replay.events;
  const activation = events.reduce<
    VerifiedJournalEvent<"lineage_activated"> | undefined
  >((latest, event) => (event.type === "lineage_activated" ? event : latest), undefined);
  if (activation?.payload.reason !== "compaction") return null;
  const lineageId = activation.payload.nextLineageId;
  if (events.some((event) => event.type === "run_started" && event.lineageId === lineageId)) {
    return null;
  }
  const abandon = events.findLast(
    (event): event is VerifiedJournalEvent<"cache_break"> =>
      event.type === "cache_break" &&
      event.payload.classification === "planned" &&
      event.payload.reason === "compaction" &&
      event.payload.toLineageId === lineageId,
  );
  if (abandon === undefined) return null;
  const broken = abandon.payload;
  if (broken.classification !== "planned" || broken.reason !== "compaction") {
    return null;
  }
  const artifact = events.find(
    (event): event is VerifiedJournalEvent<"artifact_published"> =>
      event.type === "artifact_published" &&
      event.payload.artifactId === broken.summaryArtifactId,
  );
  if (artifact === undefined) return null;
  const { openArtifactStoreReadOnly } = await import("../artifact/store.js");
  const store = await openArtifactStoreReadOnly(
    journal.createSessionPaths(workspaceRoot, sessionId).sessionDir,
  );
  const range = await store.readArtifactRange(artifact.payload.artifactRef, {
    offset: 0,
    maxBytes: artifact.payload.byteCount,
  });
  return new TextDecoder("utf-8").decode(range.bytes.copy());
}
