import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TOOL_OUTPUT_MEDIA_TYPE } from "../../src/artifact/tool-output.js";
import { asToolCallId } from "../../src/bytes/tool-call-id.js";
import { openJournal } from "../../src/journal/open.js";
import {
  createVerifiedJournalEvent,
  encodeVerifiedJournalEvent,
} from "../../src/journal/schema.js";
import type {
  ArtifactId,
  ArtifactRef,
  AttemptId,
  CanonicalTimestamp,
  CommitBoundaryId,
  EventId,
  LineageId,
  RequestSnapshotId,
  RunId,
  SessionId,
  Sha256,
} from "../../src/journal/types.js";

const SESSION_ID = `ses_${"1".repeat(32)}` as SessionId;
const LINEAGE_ID = `lin_${"2".repeat(32)}` as LineageId;
const RUN_ID = `run_${"3".repeat(32)}` as RunId;
const PREVIOUS_HASH = `sha256:${"a".repeat(64)}` as Sha256;
const EMPTY_HASH =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" as Sha256;
const TIMESTAMP = "2026-08-04T00:00:00.000Z" as CanonicalTimestamp;

function eventIds() {
  let next = 0;
  return {
    nextEventId: () => {
      next += 1;
      return `evt_${next.toString(16).padStart(32, "0")}` as EventId;
    },
  };
}

const fixedClock = {
  now: () => TIMESTAMP,
};

test("returned Artifact payload cannot poison bindings before append and reopen", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "simpledsh-event-immutable-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));

  const opened = await openJournal(
    workspace,
    SESSION_ID,
    fixedClock,
    eventIds(),
  );
  await opened.writer.append({
    type: "session_started",
    sessionId: SESSION_ID,
    payload: {},
  });

  const artifactBytes = Uint8Array.of(1, 2, 3);
  const published = await opened.artifacts.publishArtifact(artifactBytes, {
    lineCount: null,
    mediaType: "application/octet-stream",
    artifactType: "fact",
    streamBytes: null,
    hardLimitReached: null,
    descendantsReaped: null,
    toolCallId: null,
    terminal: null,
  });
  const artifactId = `art_${"4".repeat(32)}` as ArtifactId;
  const artifact = await opened.writer.append({
    type: "artifact_published",
    sessionId: SESSION_ID,
    payload: { artifactId, ...published },
  });
  assert.equal(artifact.type, "artifact_published");
  if (artifact.type !== "artifact_published") assert.fail("missing Artifact event");
  assert.ok(Object.isFrozen(artifact.payload));

  assert.throws(() => {
    (artifact.payload as { byteCount: number }).byteCount = 4;
  }, TypeError);
  assert.equal(artifact.payload.byteCount, 3);

  const fact = await opened.writer.append({
    type: "fact_recorded",
    sessionId: SESSION_ID,
    parentId: artifact.id,
    payload: {
      kind: "user_input",
      artifactId,
      byteCount: artifactBytes.byteLength,
    },
  });
  const durableHead = opened.writer.head;
  assert.equal(fact.seq, 3);
  await opened.writer.close();

  const reopened = await openJournal(
    workspace,
    SESSION_ID,
    fixedClock,
    eventIds(),
  );
  assert.deepEqual(reopened.replay.head, durableHead);
  assert.equal(reopened.replay.events.length, 3);
  const replayedArtifact = reopened.replay.events[1];
  assert.equal(replayedArtifact?.type, "artifact_published");
  if (replayedArtifact?.type !== "artifact_published") {
    assert.fail("missing replayed Artifact event");
  }
  assert.ok(Object.isFrozen(replayedArtifact.payload));
  assert.equal(replayedArtifact.payload.byteCount, 3);
  await reopened.writer.close();
});

test("verified nested usage and source arrays are recursively immutable", () => {
  const assistant = createVerifiedJournalEvent(
    {
      type: "assistant_committed",
      sessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      runId: RUN_ID,
      payload: {
        role: "assistant",
        enc: "b64",
        bytes: "",
        byteCount: 0,
        byteHash: EMPTY_HASH,
        blobIndex: 0,
        chainHash: EMPTY_HASH,
        attemptId: `att_${"5".repeat(32)}` as AttemptId,
        requestSnapshotId: `rqs_${"6".repeat(32)}` as RequestSnapshotId,
        providerRequestId: "request-1",
        responseModel: "deepseek-v4-flash",
        systemFingerprint: null,
        semanticDeltaCount: 0,
        usage: {
          promptTokens: 1,
          promptCacheHitTokens: 1,
          promptCacheMissTokens: 0,
          completionTokens: 1,
          reasoningTokens: 1,
          rawFinishReason: "stop",
        },
      },
    },
    {
      seq: 2,
      id: `evt_${"7".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: PREVIOUS_HASH,
    },
  );
  assert.equal(assistant.type, "assistant_committed");
  if (assistant.type !== "assistant_committed") {
    assert.fail("missing assistant event");
  }
  const assistantBytes = encodeVerifiedJournalEvent(assistant).copy();
  assert.ok(Object.isFrozen(assistant.payload.usage));
  assert.throws(() => {
    (assistant.payload.usage as { promptTokens: number }).promptTokens = 2;
  }, TypeError);
  assert.equal(assistant.payload.usage.promptTokens, 1);
  assert.deepEqual(encodeVerifiedJournalEvent(assistant).copy(), assistantBytes);

  const sourceEventId = `evt_${"8".repeat(32)}` as EventId;
  const boundary = createVerifiedJournalEvent(
    {
      type: "commit_boundary_created",
      sessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      runId: RUN_ID,
      payload: {
        commitBoundaryId: `cbd_${"9".repeat(32)}` as CommitBoundaryId,
        cacheCheckpointId: null,
        blobCount: 0,
        chainHash: EMPTY_HASH,
        protocolClosed: true,
        effectsSettled: true,
        sourceEventIds: [sourceEventId],
      },
    },
    {
      seq: 2,
      id: `evt_${"a".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: PREVIOUS_HASH,
    },
  );
  assert.equal(boundary.type, "commit_boundary_created");
  if (boundary.type !== "commit_boundary_created") {
    assert.fail("missing boundary event");
  }
  const boundaryBytes = encodeVerifiedJournalEvent(boundary).copy();
  assert.ok(Object.isFrozen(boundary.payload.sourceEventIds));
  const mutableSources = boundary.payload.sourceEventIds as EventId[];
  assert.throws(() => {
    mutableSources[0] = `evt_${"b".repeat(32)}` as EventId;
  }, TypeError);
  assert.throws(() => {
    mutableSources.push(`evt_${"c".repeat(32)}` as EventId);
  }, TypeError);
  assert.deepEqual(boundary.payload.sourceEventIds, [sourceEventId]);
  assert.deepEqual(encodeVerifiedJournalEvent(boundary).copy(), boundaryBytes);

  const toolArtifact = createVerifiedJournalEvent(
    {
      type: "artifact_published",
      sessionId: SESSION_ID,
      payload: {
        artifactId: `art_${"d".repeat(32)}` as ArtifactId,
        artifactRef: `artifacts/sha256/${EMPTY_HASH.slice("sha256:".length)}` as ArtifactRef,
        artifactHash: EMPTY_HASH,
        byteCount: 0,
        lineCount: null,
        mediaType: TOOL_OUTPUT_MEDIA_TYPE,
        artifactType: "tool_output",
        streamBytes: { read: 0, stdout: 0, stderr: 0 },
        hardLimitReached: false,
        descendantsReaped: null,
        toolCallId: asToolCallId("call-immutable-tool-artifact"),
        terminal: {
          status: "succeeded",
          code: "ok",
          exitCode: null,
          signal: null,
          descendantsReaped: null,
        },
      },
    },
    {
      seq: 2,
      id: `evt_${"d".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: PREVIOUS_HASH,
    },
  );
  assert.equal(toolArtifact.type, "artifact_published");
  if (toolArtifact.type !== "artifact_published") {
    assert.fail("missing tool Artifact event");
  }
  assert.ok(Object.isFrozen(toolArtifact.payload.streamBytes));
  assert.throws(() => {
    (toolArtifact.payload.streamBytes as { stdout: number }).stdout = 1;
  }, TypeError);
  assert.equal(toolArtifact.payload.streamBytes?.stdout, 0);
  assert.ok(Object.isFrozen(toolArtifact.payload.terminal));
  assert.throws(() => {
    Object.assign(toolArtifact.payload.terminal!, { code: "io_error" });
  }, TypeError);
  assert.equal(toolArtifact.payload.terminal?.code, "ok");
});
