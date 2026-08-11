import assert from "node:assert/strict";
import { mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  encodeToolOutputData,
  TOOL_OUTPUT_MEDIA_TYPE,
} from "../../src/artifact/tool-output.js";
import { advanceBlobPrefix } from "../../src/blob/store.js";
import { sha256Hex, toBase64, utf8Bytes } from "../../src/bytes/ops.js";
import { asToolCallId } from "../../src/bytes/tool-call-id.js";
import { materializeUserMessage } from "../../src/bytes/user.js";
import type { JournalReferenceVerifier } from "../../src/journal/bindings.js";
import {
  createVerifiedJournalEvent,
  encodeVerifiedJournalEvent,
} from "../../src/journal/schema.js";
import { replayJournal } from "../../src/journal/replay.js";
import { JournalWriter } from "../../src/journal/writer.js";
import { buildCacheAbiV1 } from "../../src/lineage/cache-abi.js";
import { projectArtifactToolResult } from "../../src/artifact/tool-result.js";
import type {
  AnyJournalEventDraft,
  AnyVerifiedJournalEvent,
  ArtifactId,
  ArtifactRef,
  AttemptId,
  CacheAbiId,
  CacheCheckpointId,
  CanonicalTimestamp,
  CommitBoundaryId,
  EventId,
  LineageId,
  RequestSnapshotId,
  RunId,
  SessionId,
  Sha256,
  SnapshotRef,
  ToolTerminal,
} from "../../src/journal/types.js";

const SID = `ses_${"1".repeat(32)}` as SessionId;
const LID = `lin_${"2".repeat(32)}` as LineageId;
const RID = `run_${"3".repeat(32)}` as RunId;
const MANIFEST_ID = `art_${"4".repeat(32)}` as ArtifactId;
const FACT_ID = `art_${"5".repeat(32)}` as ArtifactId;
const BOUNDARY_ID = `cbd_${"6".repeat(32)}` as CommitBoundaryId;
const SNAPSHOT_ID = `rqs_${"7".repeat(32)}` as RequestSnapshotId;
const TIMESTAMP = "2026-08-03T00:00:00.000Z" as CanonicalTimestamp;
const BASE_CACHE_ABI = buildCacheAbiV1();
const CHANGED_CACHE_ABI = buildCacheAbiV1(utf8Bytes("changed"));
const MANIFEST_HASH = BASE_CACHE_ABI.cacheAbiId as unknown as Sha256;
const FACT_HASH = `sha256:${"b".repeat(64)}` as Sha256;
const SNAPSHOT_HASH = `sha256:${"c".repeat(64)}` as Sha256;
const ABI = MANIFEST_HASH as unknown as CacheAbiId;
const ABI_MANIFESTS = new Map([
  [String(BASE_CACHE_ABI.cacheAbiId), BASE_CACHE_ABI.manifestBytes],
  [String(CHANGED_CACHE_ABI.cacheAbiId), CHANGED_CACHE_ABI.manifestBytes],
]);

const verifier: JournalReferenceVerifier = {
  loadBlob: async () => {
    throw new Error("not expected");
  },
  loadArtifact: async (payload) => {
    const bytes = ABI_MANIFESTS.get(String(payload.artifactHash));
    if (bytes === undefined) throw new Error("not a Cache ABI manifest");
    return bytes;
  },
  scanArtifact: async (payload, visit) => {
    const bytes = ABI_MANIFESTS.get(String(payload.artifactHash));
    if (bytes === undefined) throw new Error("not a Cache ABI manifest");
    visit(bytes);
  },
  verifyArtifact: async () => undefined,
  verifySnapshot: async () => undefined,
  verifyRecovery: async () => undefined,
};

function ref(namespace: "artifacts" | "snapshots", hash: Sha256): string {
  return `${namespace}/sha256/${hash.slice("sha256:".length)}`;
}

function minimalEvents(): readonly AnyVerifiedJournalEvent[] {
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

  append({ type: "session_started", sessionId: SID, payload: {} });
  const manifest = append({
    type: "artifact_published",
    sessionId: SID,
    payload: {
      artifactId: MANIFEST_ID,
      artifactRef: ref("artifacts", MANIFEST_HASH) as ArtifactRef,
      artifactHash: MANIFEST_HASH,
      byteCount: BASE_CACHE_ABI.manifestBytes.byteLength,
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
    sessionId: SID,
    parentId: manifest.id,
    payload: {
      cacheAbiId: ABI,
      manifestArtifactId: MANIFEST_ID,
      manifestByteCount: BASE_CACHE_ABI.manifestBytes.byteLength,
    },
  });
  append({
    type: "lineage_started",
    sessionId: SID,
    lineageId: LID,
    payload: { cacheAbiId: ABI },
  });
  append({
    type: "lineage_activated",
    sessionId: SID,
    lineageId: LID,
    payload: {
      previousLineageId: null,
      nextLineageId: LID,
      reason: "initial",
    },
  });
  append({
    type: "run_started",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: { cause: "user", previousRunId: null },
  });
  append({
    type: "artifact_published",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: {
      artifactId: FACT_ID,
      artifactRef: ref("artifacts", FACT_HASH) as ArtifactRef,
      artifactHash: FACT_HASH,
      byteCount: 1,
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
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: { kind: "user_input", artifactId: FACT_ID, byteCount: 1 },
  });
  const bytes = materializeUserMessage("u");
  const byteHash = `sha256:${sha256Hex(bytes)}` as Sha256;
  const user = append({
    type: "user_committed",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    parentId: fact.id,
    payload: {
      role: "user",
      enc: "b64",
      bytes: toBase64(bytes),
      byteCount: bytes.byteLength,
      byteHash,
      blobIndex: 0,
      chainHash: byteHash,
      sourceFactEventIds: [fact.id],
    },
  });
  const boundary = append({
    type: "commit_boundary_created",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    parentId: user.id,
    payload: {
      commitBoundaryId: BOUNDARY_ID,
      cacheCheckpointId: null,
      blobCount: 1,
      chainHash: byteHash,
      protocolClosed: true,
      effectsSettled: true,
      sourceEventIds: [user.id],
    },
  });
  append({
    type: "request_snapshot_stored",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    parentId: boundary.id,
    payload: {
      requestSnapshotId: SNAPSHOT_ID,
      bodyRef: ref("snapshots", SNAPSHOT_HASH) as SnapshotRef,
      bodyHash: SNAPSHOT_HASH,
      byteCount: 2,
      cacheAbiId: ABI,
      projectorVersion: "dsh-projector-v1",
      headEventId: boundary.id,
      commitBoundaryId: BOUNDARY_ID,
      segmentHashes: [BASE_CACHE_ABI.headerHash, byteHash],
      recoveryFromSnapshotId: null,
    },
  });
  return events;
}

function journalBytes(events: readonly AnyVerifiedJournalEvent[]): Uint8Array {
  return new TextEncoder().encode(
    events
      .map((event) => new TextDecoder().decode(encodeVerifiedJournalEvent(event).copy()))
      .join("\n") + "\n",
  );
}

async function replayBytes(
  bytes: Uint8Array,
  selectedVerifier: JournalReferenceVerifier = verifier,
) {
  const directory = await mkdtemp(join(tmpdir(), "flashcoder-replay-"));
  const path = join(directory, "log.jsonl");
  await writeFile(path, bytes, { mode: 0o600 });
  const handle = await open(path, "r");
  try {
    return await replayJournal(handle, selectedVerifier);
  } finally {
    await handle.close();
  }
}

test("rebuild from Journal and referenced bytes is deterministic without metadata", async () => {
  const bytes = journalBytes(minimalEvents());
  const first = await replayBytes(bytes);
  const second = await replayBytes(bytes);
  assert.deepEqual(first.events, second.events);
  assert.deepEqual(first.head, second.head);
  assert.deepEqual(first.projectionSnapshot, second.projectionSnapshot);
  assert.equal(first.events.length, 11);
  assert.equal(first.projectionSnapshot.blobCount, 1);
  assert.equal(first.tornTail, null);
  assert.equal(first.validPrefixByteCount, bytes.byteLength);
});

test("Journal append and replay reject output_limit neither/both terminal mutations", async (t) => {
  const session = minimalEvents()[0]!;
  const directory = await mkdtemp(join(tmpdir(), "flashcoder-output-limit-append-"));
  const path = join(directory, "log.jsonl");
  const handle = await open(path, "ax+", 0o600);
  let nextEvent = 0;
  const writer = new JournalWriter({
    log: handle,
    head: { seq: 0, hash: null },
    clock: { now: () => TIMESTAMP },
    eventIds: {
      nextEventId: () => {
        nextEvent += 1;
        return `evt_${nextEvent.toString(16).padStart(32, "0")}` as EventId;
      },
    },
    preflight: {
      prepare: async () => ({ commit: () => undefined }),
    },
    lease: {
      release: async (log) => log.close(),
    },
  });
  t.after(async () => writer.close());
  await writer.append({ type: "session_started", sessionId: SID, payload: {} });

  const valid = createVerifiedJournalEvent(
    {
      type: "effect_completed",
      sessionId: SID,
      lineageId: LID,
      runId: RID,
      payload: {
        effectId: `eff_${"e".repeat(32)}` as never,
        toolCallId: asToolCallId("call-output-limit"),
        artifactId: `art_${"f".repeat(32)}` as ArtifactId,
        terminal: {
          status: "failed",
          code: "output_limit",
          exitCode: 137,
          signal: null,
          descendantsReaped: true,
        },
      },
    },
    {
      seq: 2,
      id: `evt_${"e".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: session.hash,
    },
  );
  for (const [exitCode, signal] of [
    [null, null],
    [137, "SIGKILL"],
  ] as const) {
    const invalidDraft = {
      type: "effect_completed",
      sessionId: SID,
      lineageId: LID,
      runId: RID,
      payload: {
        effectId: `eff_${"e".repeat(32)}`,
        toolCallId: "call-output-limit",
        artifactId: `art_${"f".repeat(32)}`,
        terminal: {
          status: "failed",
          code: "output_limit",
          exitCode,
          signal,
          descendantsReaped: true,
        },
      },
    } as unknown as AnyJournalEventDraft;
    await assert.rejects(writer.append(invalidDraft), { code: "JOURNAL_SCHEMA" });

    const parsed = JSON.parse(
      new TextDecoder().decode(encodeVerifiedJournalEvent(valid).copy()),
    ) as Record<string, unknown>;
    const payload = parsed["payload"] as Record<string, unknown>;
    const terminal = payload["terminal"] as Record<string, unknown>;
    terminal["exitCode"] = exitCode;
    terminal["signal"] = signal;
    const { hash: _oldHash, ...preimage } = parsed;
    const mutationHash = `sha256:${sha256Hex(utf8Bytes(JSON.stringify(preimage)))}`;
    parsed["hash"] = mutationHash;
    assert.equal(
      parsed["hash"],
      `sha256:${sha256Hex(utf8Bytes(JSON.stringify(preimage)))}`,
      "mutation fixture must carry the hash of its exact preimage",
    );
    const bytes = new TextEncoder().encode(
      `${new TextDecoder().decode(encodeVerifiedJournalEvent(session).copy())}\n` +
      `${JSON.stringify(parsed)}\n`,
    );
    await assert.rejects(replayBytes(bytes), { code: "JOURNAL_SCHEMA" });
  }

  assert.equal((await readFile(path, "utf8")).trimEnd().split("\n").length, 1);
  await writer.close();
});

test("Commit Boundary derives closure instead of trusting true payload flags", async () => {
  const events = [...minimalEvents()];
  const append = (draft: AnyJournalEventDraft): AnyVerifiedJournalEvent => {
    const previous = events.at(-1)!;
    const event = createVerifiedJournalEvent(draft, {
      seq: events.length + 1,
      id: `evt_${(events.length + 1).toString(16).padStart(32, "0")}` as EventId,
      at: TIMESTAMP,
      prevHash: previous.hash,
    });
    events.push(event);
    return event;
  };
  append({
    type: "request_attempt_started",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: {
      attemptId: `att_${"f".repeat(32)}` as AttemptId,
      requestSnapshotId: SNAPSHOT_ID,
      ordinal: 1,
    },
  });
  const user = events[8]!;
  append({
    type: "commit_boundary_created",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: {
      commitBoundaryId: `cbd_${"f".repeat(32)}` as CommitBoundaryId,
      cacheCheckpointId: null,
      blobCount: 1,
      chainHash: (user.payload as { chainHash: Sha256 }).chainHash,
      protocolClosed: true,
      effectsSettled: true,
      sourceEventIds: [user.id],
    },
  });
  await assert.rejects(replayBytes(journalBytes(events)), {
    code: "JOURNAL_REFERENCE",
  });
});

test("replay rejects missing mismatched future and cross-namespace references", async () => {
  const complete = minimalEvents();
  const session = complete[0]!;
  const missingArtifact = createVerifiedJournalEvent(
    {
      type: "cache_abi_declared",
      sessionId: SID,
      payload: {
        cacheAbiId: ABI,
        manifestArtifactId: MANIFEST_ID,
        manifestByteCount: BASE_CACHE_ABI.manifestBytes.byteLength,
      },
    },
    {
      seq: 2,
      id: `evt_${"f".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: session.hash,
    },
  );
  await assert.rejects(replayBytes(journalBytes([session, missingArtifact])), {
    code: "JOURNAL_REFERENCE",
  });

  const badVerifier: JournalReferenceVerifier = {
    ...verifier,
    verifySnapshot: async () => {
      throw new Error("missing");
    },
  };
  await assert.rejects(replayBytes(journalBytes(minimalEvents()), badVerifier), {
    code: "JOURNAL_REFERENCE",
  });
  await assert.rejects(
    replayBytes(journalBytes(minimalEvents()), {
      ...verifier,
      loadArtifact: async () => utf8Bytes("hash-valid descriptor, bad ABI bytes"),
    }),
    { code: "JOURNAL_REFERENCE" },
  );

  const duplicateEventId = createVerifiedJournalEvent(
    {
      type: "cache_break",
      sessionId: SID,
      payload: {
        classification: "planned",
        fromLineageId: LID,
        toLineageId: `lin_${"9".repeat(32)}` as LineageId,
        reason: "abi_change",
        authorizedRevision: "r1",
      },
    },
    {
      seq: 2,
      id: session.id,
      at: TIMESTAMP,
      prevHash: session.hash,
    },
  );
  await assert.rejects(replayBytes(journalBytes([session, duplicateEventId])), {
    code: "JOURNAL_REFERENCE",
  });

  const firstArtifact = complete[1]!;
  const reboundArtifact = createVerifiedJournalEvent(
    {
      type: "artifact_published",
      sessionId: SID,
      payload: firstArtifact.payload as typeof complete[1]["payload"],
    } as AnyJournalEventDraft,
    {
      seq: 3,
      id: `evt_${"d".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: firstArtifact.hash,
    },
  );
  await assert.rejects(
    replayBytes(journalBytes([session, firstArtifact, reboundArtifact])),
    { code: "JOURNAL_REFERENCE" },
  );

  const futureParent = createVerifiedJournalEvent(
    {
      type: "cache_break",
      sessionId: SID,
      parentId: `evt_${"f".repeat(32)}` as EventId,
      payload: {
        classification: "planned",
        fromLineageId: LID,
        toLineageId: `lin_${"9".repeat(32)}` as LineageId,
        reason: "abi_change",
        authorizedRevision: "r1",
      },
    },
    {
      seq: 2,
      id: `evt_${"e".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: session.hash,
    },
  );
  await assert.rejects(replayBytes(journalBytes([session, futureParent])), {
    code: "JOURNAL_REFERENCE",
  });

  const throughRun = complete.slice(0, 6);
  const runHead = throughRun.at(-1)!;
  const wrongSourceBytes = utf8Bytes("wrong-source");
  const wrongSourceHash = `sha256:${sha256Hex(wrongSourceBytes)}` as Sha256;
  const wrongTypeSource = createVerifiedJournalEvent(
    {
      type: "user_committed",
      sessionId: SID,
      lineageId: LID,
      runId: RID,
      payload: {
        role: "user",
        enc: "b64",
        bytes: toBase64(wrongSourceBytes),
        byteCount: wrongSourceBytes.byteLength,
        byteHash: wrongSourceHash,
        blobIndex: 0,
        chainHash: wrongSourceHash,
        sourceFactEventIds: [session.id],
      },
    },
    {
      seq: throughRun.length + 1,
      id: `evt_${"f".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: runHead.hash,
    },
  );
  await assert.rejects(
    replayBytes(journalBytes([...throughRun, wrongTypeSource])),
    { code: "JOURNAL_REFERENCE" },
  );
});

test("corruption with LF or without a session prefix fails closed without mutation", async () => {
  const events = minimalEvents();
  const first = journalBytes([events[0]!]);
  const secondLine = new TextDecoder().decode(
    encodeVerifiedJournalEvent(events[1]!).copy(),
  );
  const corrupted = new TextEncoder().encode(
    `${new TextDecoder().decode(first)} ${secondLine}\n`,
  );
  await assert.rejects(replayBytes(corrupted), { code: "JOURNAL_CANONICAL" });

  await assert.rejects(replayBytes(new TextEncoder().encode('{"v":1')), {
    code: "JOURNAL_TORN_WITHOUT_PREFIX",
  });
});

test("identity ordering and prefix summaries fail closed when hash-valid facts conflict", async () => {
  const complete = minimalEvents();
  const throughLineage = complete.slice(0, 4);
  const lineageHead = throughLineage.at(-1)!;
  const runBeforeActivation = createVerifiedJournalEvent(
    {
      type: "run_started",
      sessionId: SID,
      lineageId: LID,
      runId: RID,
      payload: { cause: "user", previousRunId: null },
    },
    {
      seq: throughLineage.length + 1,
      id: `evt_${"a".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: lineageHead.hash,
    },
  );
  await assert.rejects(
    replayBytes(journalBytes([...throughLineage, runBeforeActivation])),
    { code: "JOURNAL_REFERENCE" },
  );

  const throughActivation = complete.slice(0, 5);
  const activationHead = throughActivation.at(-1)!;
  const duplicateInitial = createVerifiedJournalEvent(
    {
      type: "lineage_activated",
      sessionId: SID,
      lineageId: LID,
      payload: {
        previousLineageId: null,
        nextLineageId: LID,
        reason: "initial",
      },
    },
    {
      seq: throughActivation.length + 1,
      id: `evt_${"b".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: activationHead.hash,
    },
  );
  await assert.rejects(
    replayBytes(journalBytes([...throughActivation, duplicateInitial])),
    { code: "JOURNAL_REFERENCE" },
  );

  const throughAbi = complete.slice(0, 3);
  const abiHead = throughAbi.at(-1)!;
  const changedProjectInstructions = createVerifiedJournalEvent(
    {
      type: "artifact_published",
      sessionId: SID,
      payload: {
        artifactId: `art_${"9".repeat(32)}` as ArtifactId,
        artifactRef: ref("artifacts", SNAPSHOT_HASH) as ArtifactRef,
        artifactHash: SNAPSHOT_HASH,
        byteCount: 1,
        lineCount: 1,
        mediaType: "text/plain",
        artifactType: "project_instructions",
        streamBytes: null,
        hardLimitReached: null,
        descendantsReaped: null,
        toolCallId: null,
        terminal: null,
      },
    },
    {
      seq: throughAbi.length + 1,
      id: `evt_${"c".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: abiHead.hash,
    },
  );
  const changedProjectFact = createVerifiedJournalEvent(
    {
      type: "fact_recorded",
      sessionId: SID,
      payload: {
        kind: "project_instructions",
        artifactId: `art_${"9".repeat(32)}` as ArtifactId,
        byteCount: 1,
      },
    },
    {
      seq: throughAbi.length + 2,
      id: `evt_${"d".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: changedProjectInstructions.hash,
    },
  );
  assert.equal(
    (
      await replayBytes(
        journalBytes([
          ...throughAbi,
          changedProjectInstructions,
          changedProjectFact,
        ]),
      )
    ).events.at(-1)?.id,
    changedProjectFact.id,
  );
  const oldAbiLineage = createVerifiedJournalEvent(
    {
      type: "lineage_started",
      sessionId: SID,
      lineageId: `lin_${"8".repeat(32)}` as LineageId,
      payload: { cacheAbiId: ABI },
    },
    {
      seq: throughAbi.length + 3,
      id: `evt_${"e".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: changedProjectFact.hash,
    },
  );
  const oldAbiActivation = createVerifiedJournalEvent(
    {
      type: "lineage_activated",
      sessionId: SID,
      lineageId: `lin_${"8".repeat(32)}` as LineageId,
      payload: {
        previousLineageId: null,
        nextLineageId: `lin_${"8".repeat(32)}` as LineageId,
        reason: "initial",
      },
    },
    {
      seq: throughAbi.length + 4,
      id: `evt_${"f".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: oldAbiLineage.hash,
    },
  );
  await assert.rejects(
    replayBytes(
      journalBytes([
        ...throughAbi,
        changedProjectInstructions,
        changedProjectFact,
        oldAbiLineage,
        oldAbiActivation,
      ]),
    ),
    { code: "JOURNAL_REFERENCE" },
  );

  const throughUser = complete.slice(0, 9);
  const userHead = throughUser.at(-1)!;
  const wrongBoundarySummary = createVerifiedJournalEvent(
    {
      type: "commit_boundary_created",
      sessionId: SID,
      lineageId: LID,
      runId: RID,
      payload: {
        commitBoundaryId: `cbd_${"9".repeat(32)}` as CommitBoundaryId,
        cacheCheckpointId: null,
        blobCount: 0,
        chainHash: (userHead.payload as { chainHash: Sha256 }).chainHash,
        protocolClosed: true,
        effectsSettled: true,
        sourceEventIds: [userHead.id],
      },
    },
    {
      seq: throughUser.length + 1,
      id: `evt_${"d".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: userHead.hash,
    },
  );
  await assert.rejects(
    replayBytes(journalBytes([...throughUser, wrongBoundarySummary])),
    { code: "JOURNAL_REFERENCE" },
  );

  const sameAbiLineage = createVerifiedJournalEvent(
    {
      type: "lineage_started",
      sessionId: SID,
      lineageId: `lin_${"9".repeat(32)}` as LineageId,
      payload: { cacheAbiId: ABI },
    },
    {
      seq: throughActivation.length + 1,
      id: `evt_${"e".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: activationHead.hash,
    },
  );
  assert.equal(
    (
      await replayBytes(journalBytes([...throughActivation, sameAbiLineage]))
    ).events.at(-1)?.id,
    sameAbiLineage.id,
  );

  const changed: AnyVerifiedJournalEvent[] = [...complete];
  const appendChanged = (draft: AnyJournalEventDraft): AnyVerifiedJournalEvent => {
    const previous = changed.at(-1)!;
    const event = createVerifiedJournalEvent(draft, {
      seq: changed.length + 1,
      id: `evt_${(changed.length + 1).toString(16).padStart(32, "0")}` as EventId,
      at: TIMESTAMP,
      prevHash: previous.hash,
    });
    changed.push(event);
    return event;
  };
  appendChanged({
    type: "run_interrupted",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: {
      reason: "durability_failure",
      sourceEventId: complete.at(-1)!.id,
    },
  });
  const changedInstructionsHash = `sha256:${"f".repeat(64)}` as Sha256;
  const changedInstructionsId = `art_${"6".repeat(32)}` as ArtifactId;
  appendChanged({
    type: "artifact_published",
    sessionId: SID,
    payload: {
      artifactId: changedInstructionsId,
      artifactRef: ref(
        "artifacts",
        changedInstructionsHash,
      ) as ArtifactRef,
      artifactHash: changedInstructionsHash,
      byteCount: 1,
      lineCount: 1,
      mediaType: "text/plain",
      artifactType: "project_instructions",
      streamBytes: null,
      hardLimitReached: null,
      descendantsReaped: null,
      toolCallId: null,
      terminal: null,
    },
  });
  appendChanged({
    type: "fact_recorded",
    sessionId: SID,
    payload: {
      kind: "project_instructions",
      artifactId: changedInstructionsId,
      byteCount: 1,
    },
  });
  const newHash = CHANGED_CACHE_ABI.cacheAbiId as unknown as Sha256;
  const newAbi = newHash as unknown as CacheAbiId;
  const newManifestId = `art_${"9".repeat(32)}` as ArtifactId;
  appendChanged({
    type: "artifact_published",
    sessionId: SID,
    payload: {
      artifactId: newManifestId,
      artifactRef: ref("artifacts", newHash) as ArtifactRef,
      artifactHash: newHash,
      byteCount: CHANGED_CACHE_ABI.manifestBytes.byteLength,
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
  appendChanged({
    type: "cache_abi_declared",
    sessionId: SID,
    payload: {
      cacheAbiId: newAbi,
      manifestArtifactId: newManifestId,
      manifestByteCount: CHANGED_CACHE_ABI.manifestBytes.byteLength,
    },
  });
  appendChanged({
    type: "lineage_started",
    sessionId: SID,
    lineageId: `lin_${"9".repeat(32)}` as LineageId,
    payload: { cacheAbiId: newAbi },
  });
  const beforeBreak = [...changed];
  appendChanged({
    type: "cache_break",
    sessionId: SID,
    payload: {
      classification: "planned",
      fromLineageId: LID,
      toLineageId: `lin_${"9".repeat(32)}` as LineageId,
      reason: "abi_change",
      authorizedRevision: "reviewed-revision",
    },
  });
  const activation = appendChanged({
    type: "lineage_activated",
    sessionId: SID,
    lineageId: `lin_${"9".repeat(32)}` as LineageId,
    payload: {
      previousLineageId: LID,
      nextLineageId: `lin_${"9".repeat(32)}` as LineageId,
      reason: "abi_change",
    },
  });
  assert.equal((await replayBytes(journalBytes(changed))).events.at(-1)?.id, activation.id);

  const newRunId = `run_${"9".repeat(32)}` as RunId;
  appendChanged({
    type: "run_started",
    sessionId: SID,
    lineageId: `lin_${"9".repeat(32)}` as LineageId,
    runId: newRunId,
    payload: { cause: "user", previousRunId: null },
  });
  const newFactArtifactId = `art_${"8".repeat(32)}` as ArtifactId;
  const newFactHash = `sha256:${"e".repeat(64)}` as Sha256;
  appendChanged({
    type: "artifact_published",
    sessionId: SID,
    lineageId: `lin_${"9".repeat(32)}` as LineageId,
    runId: newRunId,
    payload: {
      artifactId: newFactArtifactId,
      artifactRef: ref("artifacts", newFactHash) as ArtifactRef,
      artifactHash: newFactHash,
      byteCount: 1,
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
  const newFact = appendChanged({
    type: "fact_recorded",
    sessionId: SID,
    lineageId: `lin_${"9".repeat(32)}` as LineageId,
    runId: newRunId,
    payload: {
      kind: "user_input",
      artifactId: newFactArtifactId,
      byteCount: 1,
    },
  });
  const newLineageBytes = materializeUserMessage("new-lineage");
  const newLineageHash = `sha256:${sha256Hex(newLineageBytes)}` as Sha256;
  const firstNewLineageBlob = appendChanged({
    type: "user_committed",
    sessionId: SID,
    lineageId: `lin_${"9".repeat(32)}` as LineageId,
    runId: newRunId,
    payload: {
      role: "user",
      enc: "b64",
      bytes: toBase64(newLineageBytes),
      byteCount: newLineageBytes.byteLength,
      byteHash: newLineageHash,
      blobIndex: 0,
      chainHash: newLineageHash,
      sourceFactEventIds: [newFact.id],
    },
  });
  assert.equal(
    (await replayBytes(journalBytes(changed))).events.at(-1)?.id,
    firstNewLineageBlob.id,
  );

  const beforeBreakHead = beforeBreak.at(-1)!;
  const activationWithoutBreak = createVerifiedJournalEvent(
    {
      type: "lineage_activated",
      sessionId: SID,
      lineageId: `lin_${"9".repeat(32)}` as LineageId,
      payload: {
        previousLineageId: LID,
        nextLineageId: `lin_${"9".repeat(32)}` as LineageId,
        reason: "abi_change",
      },
    },
    {
      seq: beforeBreak.length + 1,
      id: `evt_${"f".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: beforeBreakHead.hash,
    },
  );
  await assert.rejects(
    replayBytes(journalBytes([...beforeBreak, activationWithoutBreak])),
    { code: "JOURNAL_REFERENCE" },
  );
});

test("tool and effect references may cross Runs but never Lineages", async () => {
  const base: AnyVerifiedJournalEvent[] = [...minimalEvents()];
  const append = (
    events: AnyVerifiedJournalEvent[],
    draft: AnyJournalEventDraft,
  ): AnyVerifiedJournalEvent => {
    const previous = events.at(-1)!;
    const event = createVerifiedJournalEvent(draft, {
      seq: events.length + 1,
      id: `evt_${(events.length + 1).toString(16).padStart(32, "0")}` as EventId,
      at: TIMESTAMP,
      prevHash: previous.hash,
    });
    events.push(event);
    return event;
  };

  const attemptId = `att_${"9".repeat(32)}` as AttemptId;
  const toolCallId = asToolCallId("call-a");
  append(base, {
    type: "request_attempt_started",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: { attemptId, requestSnapshotId: SNAPSHOT_ID, ordinal: 1 },
  } as AnyJournalEventDraft);
  append(base, {
    type: "request_semantic_started",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: { attemptId },
  } as AnyJournalEventDraft);
  const assistantBytes = utf8Bytes(
    JSON.stringify({
      role: "assistant",
      content: "",
      reasoning_content: "reason",
      tool_calls: [
        {
          id: toolCallId,
          type: "function",
          function: {
            name: "read",
            arguments: JSON.stringify({ path: "README.md" }),
          },
        },
      ],
    }),
  );
  const assistantHash = `sha256:${sha256Hex(assistantBytes)}` as Sha256;
  const userChain = (base[8]!.payload as { chainHash: Sha256 }).chainHash;
  const assistantChain = advanceBlobPrefix(assistantBytes, {
    blobIndex: 1,
    previousChainHash: userChain,
  });
  const assistantEvent = append(base, {
    type: "assistant_committed",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: {
      role: "assistant",
      enc: "b64",
      bytes: toBase64(assistantBytes),
      byteCount: assistantBytes.byteLength,
      byteHash: assistantHash,
      blobIndex: 1,
      chainHash: assistantChain,
      attemptId,
      requestSnapshotId: SNAPSHOT_ID,
      providerRequestId: "request-a",
      responseModel: "deepseek-v4-flash",
      systemFingerprint: null,
      semanticDeltaCount: 1,
      usage: {
        promptTokens: 1,
        promptCacheHitTokens: 0,
        promptCacheMissTokens: 1,
        completionTokens: 1,
        reasoningTokens: 1,
        rawFinishReason: "tool_calls",
      },
    },
  } as AnyJournalEventDraft);
  const assistantCheckpoint = append(base, {
    type: "cache_checkpoint_created",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    parentId: assistantEvent.id,
    payload: {
      cacheCheckpointId: `ccp_${"8".repeat(32)}` as CacheCheckpointId,
      requestSnapshotId: SNAPSHOT_ID,
      blobCount: 2,
      chainHash: assistantChain,
      promptTokens: 1,
      providerRequestId: "request-a",
      sourceAssistantEventId: assistantEvent.id,
    },
  });

  const sameLineage = [...base];
  const recoveryRunId = `run_${"8".repeat(32)}` as RunId;
  const oldRunTerminal = append(sameLineage, {
    type: "run_interrupted",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: {
      reason: "durability_failure",
      sourceEventId: assistantCheckpoint.id,
    },
  });
  append(sameLineage, {
    type: "run_started",
    sessionId: SID,
    lineageId: LID,
    runId: recoveryRunId,
    parentId: oldRunTerminal.id,
    payload: { cause: "recovery", previousRunId: RID },
  });
  const recoveredPermission = append(sameLineage, {
    type: "permission_decided",
    sessionId: SID,
    lineageId: LID,
    runId: recoveryRunId,
    payload: {
      toolCallId,
      policyDecision: "allow",
      finalDecision: "allow",
      resolution: "policy",
    },
  });
  const readPayload = utf8Bytes("first line\nsecond line");
  const framedRead = encodeToolOutputData("read", readPayload);
  const readArtifactHash = `sha256:${sha256Hex(framedRead)}` as Sha256;
  const readArtifactRef = ref("artifacts", readArtifactHash) as ArtifactRef;
  const readArtifactId = `art_${"6".repeat(32)}` as ArtifactId;
  const readTerminal = Object.freeze({
    status: "succeeded",
    code: "ok",
    exitCode: null,
    signal: null,
    descendantsReaped: null,
  }) satisfies ToolTerminal;
  const readArtifact = append(sameLineage, {
    type: "artifact_published",
    sessionId: SID,
    lineageId: LID,
    runId: recoveryRunId,
    parentId: recoveredPermission.id,
    payload: {
      artifactId: readArtifactId,
      artifactRef: readArtifactRef,
      artifactHash: readArtifactHash,
      byteCount: framedRead.byteLength,
      lineCount: null,
      mediaType: TOOL_OUTPUT_MEDIA_TYPE,
      artifactType: "tool_output",
      streamBytes: {
        read: readPayload.byteLength,
        stdout: 0,
        stderr: 0,
      },
      hardLimitReached: false,
      descendantsReaped: null,
      toolCallId,
      terminal: readTerminal,
    },
  });
  const projectedRead = projectArtifactToolResult({
    toolCallId,
    toolName: "read",
    toolsProfile: "edit-v5",
    resultProfile: "verbose-v1",
    terminalSource: "artifact",
    readOffset: 0,
    artifact: {
      artifactId: readArtifactId,
      artifactRef: readArtifactRef,
      artifactSha256: readArtifactHash,
      byteCount: framedRead.byteLength,
      payloadBytes: {
        read: readPayload.byteLength,
        stdout: 0,
        stderr: 0,
      },
      hardLimitReached: false,
    },
    terminal: readTerminal,
    framedBytes: framedRead,
  });
  const toolResultHash = `sha256:${sha256Hex(projectedRead.messageBytes)}` as Sha256;
  const toolResultChain = advanceBlobPrefix(projectedRead.messageBytes, {
    blobIndex: 2,
    previousChainHash: assistantChain,
  });
  const toolResult = append(sameLineage, {
    type: "tool_result_committed",
    sessionId: SID,
    lineageId: LID,
    runId: recoveryRunId,
    parentId: readArtifact.id,
    payload: {
      role: "tool",
      enc: "b64",
      bytes: toBase64(projectedRead.messageBytes),
      byteCount: projectedRead.messageBytes.byteLength,
      byteHash: toolResultHash,
      blobIndex: 2,
      chainHash: toolResultChain,
      toolCallId,
      effectId: null,
      artifactId: readArtifactId,
      sourceEventId: readArtifact.id,
    },
  });
  const sameLineageVerifier: JournalReferenceVerifier = {
    ...verifier,
    loadArtifact: async (payload) =>
      payload.artifactHash === readArtifactHash
        ? framedRead
        : verifier.loadArtifact(payload),
    scanArtifact: async (payload, visit) => {
      if (payload.artifactHash === readArtifactHash) {
        visit(framedRead);
        return;
      }
      await verifier.scanArtifact(payload, visit);
    },
  };
  assert.equal(
    (
      await replayBytes(
        journalBytes(sameLineage),
        sameLineageVerifier,
      )
    ).events.at(-1)?.id,
    toolResult.id,
  );

  const crossLineage = [...base];
  const nextAbiHash = CHANGED_CACHE_ABI.cacheAbiId as unknown as Sha256;
  const nextAbi = nextAbiHash as unknown as CacheAbiId;
  const nextManifestId = `art_${"9".repeat(32)}` as ArtifactId;
  append(crossLineage, {
    type: "artifact_published",
    sessionId: SID,
    payload: {
      artifactId: nextManifestId,
      artifactRef: ref("artifacts", nextAbiHash) as ArtifactRef,
      artifactHash: nextAbiHash,
      byteCount: CHANGED_CACHE_ABI.manifestBytes.byteLength,
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
  append(crossLineage, {
    type: "cache_abi_declared",
    sessionId: SID,
    payload: {
      cacheAbiId: nextAbi,
      manifestArtifactId: nextManifestId,
      manifestByteCount: CHANGED_CACHE_ABI.manifestBytes.byteLength,
    },
  });
  const nextLineageId = `lin_${"9".repeat(32)}` as LineageId;
  append(crossLineage, {
    type: "lineage_started",
    sessionId: SID,
    lineageId: nextLineageId,
    payload: { cacheAbiId: nextAbi },
  });
  append(crossLineage, {
    type: "cache_break",
    sessionId: SID,
    payload: {
      classification: "planned",
      fromLineageId: LID,
      toLineageId: nextLineageId,
      reason: "abi_change",
      authorizedRevision: "reviewed-revision",
    },
  });
  const throughBreak = [...crossLineage];
  const staleCheckpoint = createVerifiedJournalEvent(
    {
      type: "cache_checkpoint_created",
      sessionId: SID,
      lineageId: LID,
      runId: RID,
      payload: {
        cacheCheckpointId: `ccp_${"9".repeat(32)}` as CacheCheckpointId,
        requestSnapshotId: SNAPSHOT_ID,
        blobCount: 2,
        chainHash: assistantChain,
        promptTokens: 1,
        providerRequestId: "request-a",
        sourceAssistantEventId: assistantEvent.id,
      },
    },
    {
      seq: throughBreak.length + 1,
      id: `evt_${"f".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: throughBreak.at(-1)!.hash,
    },
  );
  await assert.rejects(
    replayBytes(journalBytes([...throughBreak, staleCheckpoint])),
    { code: "JOURNAL_REFERENCE" },
  );
  append(crossLineage, {
    type: "lineage_activated",
    sessionId: SID,
    lineageId: nextLineageId,
    payload: {
      previousLineageId: LID,
      nextLineageId,
      reason: "abi_change",
    },
  });
  const nextRunId = `run_${"9".repeat(32)}` as RunId;
  append(crossLineage, {
    type: "run_started",
    sessionId: SID,
    lineageId: nextLineageId,
    runId: nextRunId,
    payload: { cause: "user", previousRunId: null },
  });
  append(crossLineage, {
    type: "permission_decided",
    sessionId: SID,
    lineageId: nextLineageId,
    runId: nextRunId,
    payload: {
      toolCallId,
      policyDecision: "allow",
      finalDecision: "allow",
      resolution: "policy",
    },
  });
  await assert.rejects(replayBytes(journalBytes(crossLineage)), {
    code: "JOURNAL_REFERENCE",
  });
});

test("torn tail recovery preserves incomplete and unframed-complete suffix bytes", async () => {
  const committed = journalBytes([minimalEvents()[0]!]);
  for (const tail of [
    new TextEncoder().encode('{"v":1'),
    encodeVerifiedJournalEvent(minimalEvents()[1]!).copy(),
  ]) {
    const combined = new Uint8Array(committed.byteLength + tail.byteLength);
    combined.set(committed);
    combined.set(tail, committed.byteLength);
    const result = await replayBytes(combined);
    assert.deepEqual(result.tornTail?.copy(), tail);
    assert.equal(result.validPrefixByteCount, committed.byteLength);
    assert.equal(result.totalByteCount, combined.byteLength);
    assert.equal(result.events.length, 1);
  }
});

test("version alias attempt and repair source bindings are single-valued", async () => {
  const complete = minimalEvents();

  const crossRun = createVerifiedJournalEvent(
    {
      type: "run_started",
      sessionId: SID,
      lineageId: LID,
      runId: `run_${"9".repeat(32)}` as RunId,
      payload: { cause: "recovery", previousRunId: RID },
    },
    {
      seq: complete.length + 1,
      id: `evt_${"7".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: complete.at(-1)!.hash,
    },
  );
  const crossRunAttempt = createVerifiedJournalEvent(
    {
      type: "request_attempt_started",
      sessionId: SID,
      lineageId: LID,
      runId: `run_${"9".repeat(32)}` as RunId,
      payload: {
        attemptId: `att_${"8".repeat(32)}`,
        requestSnapshotId: SNAPSHOT_ID,
        ordinal: 1,
      },
    } as AnyJournalEventDraft,
    {
      seq: complete.length + 2,
      id: `evt_${"8".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: crossRun.hash,
    },
  );
  await assert.rejects(
    replayBytes(journalBytes([...complete, crossRun, crossRunAttempt])),
    { code: "JOURNAL_REFERENCE" },
  );

  const throughArtifacts = complete.slice(0, 7);
  const artifactHead = throughArtifacts.at(-1)!;
  const firstVersion = createVerifiedJournalEvent(
    {
      type: "artifact_version_created",
      sessionId: SID,
      payload: {
        artifactVersionId: `arv_${"1".repeat(32)}`,
        parentArtifactVersionId: null,
        oldArtifactId: MANIFEST_ID,
        newArtifactId: FACT_ID,
      },
    } as AnyJournalEventDraft,
    {
      seq: throughArtifacts.length + 1,
      id: `evt_${"a".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: artifactHead.hash,
    },
  );
  const conflictingChild = createVerifiedJournalEvent(
    {
      type: "artifact_version_created",
      sessionId: SID,
      payload: {
        artifactVersionId: `arv_${"2".repeat(32)}`,
        parentArtifactVersionId: `arv_${"1".repeat(32)}`,
        oldArtifactId: MANIFEST_ID,
        newArtifactId: FACT_ID,
      },
    } as AnyJournalEventDraft,
    {
      seq: throughArtifacts.length + 2,
      id: `evt_${"b".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: firstVersion.hash,
    },
  );
  await assert.rejects(
    replayBytes(
      journalBytes([...throughArtifacts, firstVersion, conflictingChild]),
    ),
    { code: "JOURNAL_REFERENCE" },
  );

  const mismatchedFactArtifactType = createVerifiedJournalEvent(
    {
      type: "fact_recorded",
      sessionId: SID,
      lineageId: LID,
      runId: RID,
      payload: {
        kind: "project_instructions",
        artifactId: FACT_ID,
        byteCount: 1,
      },
    },
    {
      seq: throughArtifacts.length + 1,
      id: `evt_${"9".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: artifactHead.hash,
    },
  );
  await assert.rejects(
    replayBytes(
      journalBytes([...throughArtifacts, mismatchedFactArtifactType]),
    ),
    { code: "JOURNAL_REFERENCE" },
  );

  const snapshotHead = complete.at(-1)!;
  const mismatchedAlias = createVerifiedJournalEvent(
    {
      type: "request_snapshot_stored",
      sessionId: SID,
      lineageId: LID,
      runId: RID,
      payload: {
        requestSnapshotId: `rqs_${"9".repeat(32)}`,
        bodyRef: ref("snapshots", FACT_HASH),
        bodyHash: FACT_HASH,
        byteCount: 2,
        cacheAbiId: ABI,
        projectorVersion: "dsh-projector-v1",
        headEventId: complete[9]!.id,
        commitBoundaryId: BOUNDARY_ID,
        segmentHashes: [
          BASE_CACHE_ABI.headerHash,
          (complete[8]!.payload as { chainHash: Sha256 }).chainHash,
        ],
        recoveryFromSnapshotId: SNAPSHOT_ID,
      },
    } as unknown as AnyJournalEventDraft,
    {
      seq: complete.length + 1,
      id: `evt_${"c".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: snapshotHead.hash,
    },
  );
  await assert.rejects(
    replayBytes(journalBytes([...complete, mismatchedAlias])),
    { code: "JOURNAL_REFERENCE" },
  );

  const attempt = createVerifiedJournalEvent(
    {
      type: "request_attempt_started",
      sessionId: SID,
      lineageId: LID,
      runId: RID,
      payload: {
        attemptId: `att_${"9".repeat(32)}`,
        requestSnapshotId: SNAPSHOT_ID,
        ordinal: 1,
      },
    } as AnyJournalEventDraft,
    {
      seq: complete.length + 1,
      id: `evt_${"d".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: snapshotHead.hash,
    },
  );
  const terminal = createVerifiedJournalEvent(
    {
      type: "request_interrupted",
      sessionId: SID,
      lineageId: LID,
      runId: RID,
      payload: {
        attemptId: `att_${"9".repeat(32)}`,
        requestSnapshotId: SNAPSHOT_ID,
        outcome: "timeout",
        status: null,
        retryClass: "timeout",
        semanticState: "pre_semantic",
      },
    } as AnyJournalEventDraft,
    {
      seq: complete.length + 2,
      id: `evt_${"e".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: attempt.hash,
    },
  );
  const duplicateTerminal = createVerifiedJournalEvent(
    {
      type: "request_interrupted",
      sessionId: SID,
      lineageId: LID,
      runId: RID,
      payload: {
        attemptId: `att_${"9".repeat(32)}`,
        requestSnapshotId: SNAPSHOT_ID,
        outcome: "cancelled",
        status: null,
        retryClass: "cancelled",
        semanticState: "pre_semantic",
      },
    } as AnyJournalEventDraft,
    {
      seq: complete.length + 3,
      id: `evt_${"f".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: terminal.hash,
    },
  );
  await assert.rejects(
    replayBytes(
      journalBytes([...complete, attempt, terminal, duplicateTerminal]),
    ),
    { code: "JOURNAL_REFERENCE" },
  );

  const session = complete[0]!;
  const recoveryPayload = {
    recoveryRef: `recovery/sha256/${MANIFEST_HASH.slice("sha256:".length)}`,
    recoveryHash: MANIFEST_HASH,
    recoveryByteCount: 10,
    validPrefixSeq: 1,
    validPrefixHash: session.hash,
    tailByteCount: 1,
    tailHash: FACT_HASH,
  };
  const recovered = createVerifiedJournalEvent(
    {
      type: "journal_tail_recovered",
      sessionId: SID,
      payload: recoveryPayload,
    } as AnyJournalEventDraft,
    {
      seq: 2,
      id: `evt_${"9".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: session.hash,
    },
  );
  const physicalPrefixBytes = journalBytes([session]).byteLength;
  let observedPrefixBytes: number | undefined;
  await replayBytes(journalBytes([session, recovered]), {
    ...verifier,
    verifyRecovery: async (_payload, _sessionId, validPrefixByteCount) => {
      observedPrefixBytes = validPrefixByteCount;
      if (validPrefixByteCount !== physicalPrefixBytes) {
        throw new Error("wrong physical recovery prefix");
      }
    },
  });
  assert.equal(observedPrefixBytes, physicalPrefixBytes);
  await assert.rejects(
    replayBytes(journalBytes([session, recovered]), {
      ...verifier,
      verifyRecovery: async (_payload, _sessionId, validPrefixByteCount) => {
        if (validPrefixByteCount !== physicalPrefixBytes + 1) {
          throw new Error("recovery object prefix mismatch");
        }
      },
    }),
    { code: "JOURNAL_REFERENCE" },
  );
  const duplicateRecovery = createVerifiedJournalEvent(
    {
      type: "journal_tail_recovered",
      sessionId: SID,
      payload: {
        ...recoveryPayload,
        validPrefixSeq: 2,
        validPrefixHash: recovered.hash,
      },
    } as AnyJournalEventDraft,
    {
      seq: 3,
      id: `evt_${"8".repeat(32)}` as EventId,
      at: TIMESTAMP,
      prevHash: recovered.hash,
    },
  );
  await assert.rejects(
    replayBytes(journalBytes([session, recovered, duplicateRecovery])),
    { code: "JOURNAL_REFERENCE" },
  );
});
