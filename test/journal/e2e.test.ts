import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBlobStore } from "../../src/blob/store.js";
import { materializeUserMessage } from "../../src/bytes/user.js";
import { openJournal } from "../../src/journal/open.js";
import { buildCacheAbiV1 } from "../../src/lineage/cache-abi.js";
import type {
  ArtifactId,
  CacheAbiId,
  CanonicalTimestamp,
  EventId,
  LineageId,
  RunId,
  SessionId,
} from "../../src/journal/types.js";

const SID = `ses_${"1".repeat(32)}` as SessionId;
const LID = `lin_${"2".repeat(32)}` as LineageId;
const RID = `run_${"3".repeat(32)}` as RunId;

function eventIds(fill: string) {
  let counter = 0;
  return {
    nextEventId: () => {
      counter += 1;
      const suffix = `${fill.repeat(31)}${counter.toString(16)}`.slice(-32);
      return `evt_${suffix}` as EventId;
    },
  };
}

const fixedClock = {
  now: () => "2026-08-03T03:00:00.000Z" as CanonicalTimestamp,
};

test("minimal real Journal Artifact restart chain rebuilds identical ids bytes sequence and hashes", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "flashcoder-journal-e2e-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));

  const opened = await openJournal(
    workspace,
    SID,
    fixedClock,
    eventIds("a"),
    { maxWriteBytes: 11 },
  );
  const session = await opened.writer.append({
    type: "session_started",
    sessionId: SID,
    payload: {},
  });

  const cacheAbi = buildCacheAbiV1();
  const manifest = await opened.artifacts.publishArtifact(
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
  const manifestId = `art_${"4".repeat(32)}` as ArtifactId;
  const manifestEvent = await opened.writer.append({
    type: "artifact_published",
    sessionId: SID,
    parentId: session.id,
    payload: {
      artifactId: manifestId,
      ...manifest,
    },
  });
  const abi = manifest.artifactHash as unknown as CacheAbiId;
  await opened.writer.append({
    type: "cache_abi_declared",
    sessionId: SID,
    parentId: manifestEvent.id,
    payload: {
      cacheAbiId: abi,
      manifestArtifactId: manifestId,
      manifestByteCount: manifest.byteCount,
    },
  });
  await opened.writer.append({
    type: "lineage_started",
    sessionId: SID,
    lineageId: LID,
    payload: { cacheAbiId: abi },
  });
  await opened.writer.append({
    type: "lineage_activated",
    sessionId: SID,
    lineageId: LID,
    payload: {
      previousLineageId: null,
      nextLineageId: LID,
      reason: "initial",
    },
  });
  await opened.writer.append({
    type: "run_started",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: { cause: "user", previousRunId: null },
  });

  const userInput = new TextEncoder().encode("请保持这些原始字节🙂\u0000");
  const factArtifact = await opened.artifacts.publishArtifact(userInput, {
    lineCount: null,
    mediaType: "application/octet-stream",
    artifactType: "fact",
    streamBytes: null,
    hardLimitReached: null,
    descendantsReaped: null,
    toolCallId: null,
    terminal: null,
  });
  const factArtifactId = `art_${"5".repeat(32)}` as ArtifactId;
  await opened.writer.append({
    type: "artifact_published",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: { artifactId: factArtifactId, ...factArtifact },
  });
  const fact = await opened.writer.append({
    type: "fact_recorded",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: {
      kind: "user_input",
      artifactId: factArtifactId,
      byteCount: factArtifact.byteCount,
    },
  });
  const blobStore = await createBlobStore(opened.paths.sessionDir, {
    maxWriteBytes: 7,
  });
  const userMessage = materializeUserMessage(
    new TextDecoder("utf-8", { fatal: true }).decode(userInput),
  );
  const userBlob = await blobStore.publish("user", userMessage, {
    blobIndex: 0,
    previousChainHash: null,
  });
  await opened.writer.append({
    type: "user_committed",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    parentId: fact.id,
    payload: { ...userBlob, sourceFactEventIds: [fact.id] },
  });
  const originalHead = opened.writer.head;
  assert.deepEqual(originalHead, {
    seq: 9,
    hash: "sha256:55b4ecadbe863ff8aa4305e362272327774d37f40d4a25af91323113eaa9b866",
  });
  await opened.writer.close();

  const reopened = await openJournal(
    workspace,
    SID,
    fixedClock,
    eventIds("b"),
  );
  assert.deepEqual(reopened.replay.head, originalHead);
  assert.equal(reopened.replay.events.length, 9);
  assert.deepEqual(
    (
      await reopened.artifacts.readArtifactRange(factArtifact.artifactRef, {
        offset: 0,
        maxBytes: userInput.byteLength,
      })
    ).bytes.copy(),
    userInput,
  );
  const replayedUser = reopened.replay.events.at(-1);
  assert.equal(replayedUser?.type, "user_committed");
  if (replayedUser?.type !== "user_committed") assert.fail("missing user event");
  assert.deepEqual(
    (
      await blobStore.load(replayedUser.payload, {
        blobIndex: 0,
        previousChainHash: null,
      })
    ).copy(),
    userMessage.copy(),
  );
  await reopened.writer.close();
});
