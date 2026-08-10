import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { TOOL_OUTPUT_MEDIA_TYPE } from "../../src/artifact/tool-output.js";
import { sha256Hex, toBase64, utf8Bytes } from "../../src/bytes/ops.js";
import { asToolCallId } from "../../src/bytes/tool-call-id.js";
import {
  createVerifiedJournalEvent,
  decodeJournalRecord,
  encodeVerifiedJournalEvent,
  JOURNAL_EVENT_TYPES,
} from "../../src/journal/schema.js";
import {
  newArtifactId,
  newArtifactVersionId,
  newAttemptId,
  newCacheCheckpointId,
  newCommitBoundaryId,
  newEffectId,
  newEventId,
  newLineageId,
  newRequestSnapshotId,
  newRunId,
  newSessionId,
} from "../../src/journal/identity.js";
import type {
  AnyJournalEventDraft,
  ArtifactId,
  ArtifactRef,
  ArtifactVersionId,
  AttemptId,
  BlobRef,
  CacheAbiId,
  CacheCheckpointId,
  CanonicalTimestamp,
  CommitBoundaryId,
  EffectId,
  EventId,
  LineageId,
  RecoveryRef,
  RequestSnapshotId,
  RunId,
  SessionId,
  Sha256,
  SnapshotRef,
} from "../../src/journal/types.js";

function wire<Type extends string>(value: string): Type {
  return value as Type;
}

const IDS = Object.freeze({
  event: wire<EventId>(`evt_${"1".repeat(32)}`),
  event2: wire<EventId>(`evt_${"2".repeat(32)}`),
  session: wire<SessionId>(`ses_${"3".repeat(32)}`),
  lineage: wire<LineageId>(`lin_${"4".repeat(32)}`),
  lineage2: wire<LineageId>(`lin_${"5".repeat(32)}`),
  run: wire<RunId>(`run_${"6".repeat(32)}`),
  run2: wire<RunId>(`run_${"7".repeat(32)}`),
  snapshot: wire<RequestSnapshotId>(`rqs_${"8".repeat(32)}`),
  attempt: wire<AttemptId>(`att_${"9".repeat(32)}`),
  artifact: wire<ArtifactId>(`art_${"a".repeat(32)}`),
  artifact2: wire<ArtifactId>(`art_${"b".repeat(32)}`),
  artifactVersion: wire<ArtifactVersionId>(`arv_${"c".repeat(32)}`),
  effect: wire<EffectId>(`eff_${"d".repeat(32)}`),
  checkpoint: wire<CacheCheckpointId>(`ccp_${"e".repeat(32)}`),
  boundary: wire<CommitBoundaryId>(`cbd_${"f".repeat(32)}`),
});

const TIMESTAMP = wire<CanonicalTimestamp>("2026-08-03T01:02:03.004Z");
const TOOL_CALL_1 = asToolCallId("call-1");
const TOOL_CALL_2 = asToolCallId("call-2");
const BYTE = utf8Bytes("x");
const BYTE_HASH = wire<Sha256>(`sha256:${sha256Hex(BYTE)}`);
const HASH_A = wire<Sha256>(`sha256:${"a".repeat(64)}`);
const HASH_B = wire<Sha256>(`sha256:${"b".repeat(64)}`);
const CACHE_ABI = HASH_A as unknown as CacheAbiId;
const ARTIFACT_REF = wire<ArtifactRef>(
  `artifacts/sha256/${"a".repeat(64)}`,
);
const SNAPSHOT_REF = wire<SnapshotRef>(
  `snapshots/sha256/${"b".repeat(64)}`,
);
const BLOB_REF = wire<BlobRef>(`blobs/sha256/${"a".repeat(64)}`);
const RECOVERY_REF = wire<RecoveryRef>(
  `recovery/sha256/${"a".repeat(64)}`,
);

const inlineUser = Object.freeze({
  role: "user" as const,
  enc: "b64" as const,
  bytes: toBase64(BYTE),
  byteCount: 1,
  byteHash: BYTE_HASH,
  blobIndex: 0,
  chainHash: BYTE_HASH,
});

const inlineAssistant = Object.freeze({
  role: "assistant" as const,
  enc: "b64" as const,
  bytes: toBase64(BYTE),
  byteCount: 1,
  byteHash: BYTE_HASH,
  blobIndex: 0,
  chainHash: BYTE_HASH,
});

const externalTool = Object.freeze({
  role: "tool" as const,
  enc: "ref" as const,
  blobRef: BLOB_REF,
  byteCount: 65_537,
  byteHash: HASH_A,
  blobIndex: 0,
  chainHash: HASH_A,
});

function scoped(
  type: AnyJournalEventDraft["type"],
  payload: unknown,
): AnyJournalEventDraft {
  return {
    type,
    sessionId: IDS.session,
    lineageId: IDS.lineage,
    runId: IDS.run,
    payload,
  } as AnyJournalEventDraft;
}

function drafts(): readonly AnyJournalEventDraft[] {
  return [
    { type: "session_started", sessionId: IDS.session, payload: {} },
    {
      type: "cache_abi_declared",
      sessionId: IDS.session,
      payload: {
        cacheAbiId: CACHE_ABI,
        manifestArtifactId: IDS.artifact,
        manifestByteCount: 1,
      },
    },
    {
      type: "lineage_started",
      sessionId: IDS.session,
      lineageId: IDS.lineage,
      payload: { cacheAbiId: CACHE_ABI },
    },
    {
      type: "lineage_activated",
      sessionId: IDS.session,
      lineageId: IDS.lineage,
      payload: {
        previousLineageId: null,
        nextLineageId: IDS.lineage,
        reason: "initial",
      },
    },
    scoped("run_started", { cause: "user", previousRunId: null }),
    {
      type: "fact_recorded",
      sessionId: IDS.session,
      payload: { kind: "user_input", artifactId: IDS.artifact, byteCount: 1 },
    },
    scoped("user_committed", {
      ...inlineUser,
      sourceFactEventIds: [IDS.event2],
    }),
    {
      type: "artifact_published",
      sessionId: IDS.session,
      payload: {
        artifactId: IDS.artifact,
        artifactRef: ARTIFACT_REF,
        artifactHash: HASH_A,
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
    },
    {
      type: "artifact_version_created",
      sessionId: IDS.session,
      payload: {
        artifactVersionId: IDS.artifactVersion,
        parentArtifactVersionId: null,
        oldArtifactId: IDS.artifact,
        newArtifactId: IDS.artifact2,
      },
    },
    scoped("request_snapshot_stored", {
      requestSnapshotId: IDS.snapshot,
      bodyRef: SNAPSHOT_REF,
      bodyHash: HASH_B,
      byteCount: 1,
      cacheAbiId: CACHE_ABI,
      projectorVersion: "dsh-projector-v1",
      headEventId: IDS.event2,
      commitBoundaryId: IDS.boundary,
      segmentHashes: [HASH_A, HASH_B],
      recoveryFromSnapshotId: null,
    }),
    scoped("request_attempt_started", {
      attemptId: IDS.attempt,
      requestSnapshotId: IDS.snapshot,
      ordinal: 1,
    }),
    scoped("request_semantic_started", { attemptId: IDS.attempt }),
    scoped("assistant_committed", {
      ...inlineAssistant,
      attemptId: IDS.attempt,
      requestSnapshotId: IDS.snapshot,
      providerRequestId: "req-1",
      responseModel: "deepseek-v4-flash",
      systemFingerprint: null,
      semanticDeltaCount: 2,
      usage: {
        promptTokens: 3,
        promptCacheHitTokens: 1,
        promptCacheMissTokens: 2,
        completionTokens: 4,
        reasoningTokens: 2,
        rawFinishReason: "stop",
      },
    }),
    scoped("request_interrupted", {
      attemptId: IDS.attempt,
      requestSnapshotId: IDS.snapshot,
      outcome: "http_error",
      status: 500,
      retryClass: "server",
      semanticState: "post_semantic",
    }),
    scoped("cache_checkpoint_created", {
      cacheCheckpointId: IDS.checkpoint,
      requestSnapshotId: IDS.snapshot,
      blobCount: 1,
      chainHash: HASH_A,
      promptTokens: 3,
      providerRequestId: "req-1",
      sourceAssistantEventId: IDS.event2,
    }),
    scoped("commit_boundary_created", {
      commitBoundaryId: IDS.boundary,
      cacheCheckpointId: IDS.checkpoint,
      blobCount: 1,
      chainHash: HASH_A,
      protocolClosed: true,
      effectsSettled: true,
      sourceEventIds: [IDS.event2],
    }),
    {
      type: "cache_break",
      sessionId: IDS.session,
      payload: {
        classification: "planned",
        fromLineageId: IDS.lineage,
        toLineageId: IDS.lineage2,
        reason: "abi_change",
        authorizedRevision: "rev-1",
      },
    },
    scoped("integrity_violation", {
      code: "journal_hash",
      relatedEventId: IDS.event2,
      expectedHash: HASH_A,
      actualHash: HASH_B,
    }),
    scoped("permission_decided", {
      toolCallId: TOOL_CALL_1,
      policyDecision: "ask",
      finalDecision: "allow",
      resolution: "interactive",
    }),
    scoped("effect_prepared", {
      effectId: IDS.effect,
      toolCallId: TOOL_CALL_1,
      toolName: "bash",
      argumentsHash: HASH_A,
    }),
    scoped("effect_completed", {
      effectId: IDS.effect,
      toolCallId: TOOL_CALL_1,
      artifactId: IDS.artifact,
      terminal: {
        status: "succeeded",
        code: "ok",
        exitCode: 0,
        signal: null,
        descendantsReaped: true,
      },
    }),
    scoped("effect_indeterminate", {
      effectId: IDS.effect,
      reason: "crash_gap",
    }),
    scoped("effect_reconciled", {
      effectId: IDS.effect,
      resolution: "completed",
      evidenceArtifactId: IDS.artifact,
      outputArtifactId: IDS.artifact2,
      terminal: {
        status: "succeeded",
        code: "ok",
        exitCode: 0,
        signal: null,
        descendantsReaped: true,
      },
    }),
    scoped("tool_result_committed", {
      ...externalTool,
      toolCallId: TOOL_CALL_1,
      effectId: IDS.effect,
      artifactId: IDS.artifact,
      sourceEventId: IDS.event2,
    }),
    scoped("verification_recorded", {
      sourceAssistantEventId: IDS.event2,
      verdict: "tampered",
      exitCode: 0,
      outputArtifactId: IDS.artifact,
      baselineDigest: HASH_B,
      changedProtectedPaths: ["tests/test_add.py"],
    }),
    scoped("run_completed", {
      commitBoundaryId: IDS.boundary,
      sourceAssistantEventId: IDS.event2,
    }),
    scoped("run_interrupted", {
      reason: "request_failed",
      sourceEventId: IDS.event2,
    }),
    {
      type: "journal_tail_recovered",
      sessionId: IDS.session,
      payload: {
        recoveryRef: RECOVERY_REF,
        recoveryHash: HASH_A,
        recoveryByteCount: 10,
        validPrefixSeq: 1,
        validPrefixHash: HASH_B,
        tailByteCount: 1,
        tailHash: BYTE_HASH,
      },
    },
  ];
}

test("canonical v1 envelope golden covers all 28 closed event schemas", () => {
  const values = drafts();
  assert.equal(values.length, 28);
  assert.deepEqual(
    values.map((draft) => draft.type),
    JOURNAL_EVENT_TYPES,
  );

  for (const [index, draft] of values.entries()) {
    const first = index === 0;
    const event = createVerifiedJournalEvent(draft, {
      seq: first ? 1 : 2,
      id: IDS.event,
      at: TIMESTAMP,
      prevHash: first ? null : HASH_B,
    });
    const encoded = encodeVerifiedJournalEvent(event);
    assert.deepEqual(decodeJournalRecord(encoded.copy()), event, draft.type);

    const text = new TextDecoder().decode(encoded.copy());
    const withoutHash = text.slice(0, text.lastIndexOf(',"hash":')) + "}";
    const independent = createHash("sha256").update(withoutHash).digest("hex");
    assert.equal(event.hash, `sha256:${independent}`, draft.type);
  }

  const variants: readonly AnyJournalEventDraft[] = [
    {
      type: "lineage_activated",
      sessionId: IDS.session,
      lineageId: IDS.lineage2,
      payload: {
        previousLineageId: IDS.lineage,
        nextLineageId: IDS.lineage2,
        reason: "abi_change",
      },
    },
    scoped("run_started", { cause: "recovery", previousRunId: IDS.run2 }),
    scoped("user_committed", {
      role: "user",
      enc: "ref",
      blobRef: BLOB_REF,
      byteCount: 65_537,
      byteHash: HASH_A,
      blobIndex: 0,
      chainHash: HASH_A,
      sourceFactEventIds: [IDS.event2],
    }),
    scoped("assistant_committed", {
      role: "assistant",
      enc: "ref",
      blobRef: BLOB_REF,
      byteCount: 65_537,
      byteHash: HASH_A,
      blobIndex: 0,
      chainHash: HASH_A,
      attemptId: IDS.attempt,
      requestSnapshotId: IDS.snapshot,
      providerRequestId: "req-2",
      responseModel: "deepseek-v4-flash",
      systemFingerprint: "fp",
      semanticDeltaCount: 0,
      usage: {
        promptTokens: 0,
        promptCacheHitTokens: 0,
        promptCacheMissTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        rawFinishReason: "length",
      },
    }),
    scoped("tool_result_committed", {
      role: "tool",
      enc: "b64",
      bytes: toBase64(BYTE),
      byteCount: 1,
      byteHash: BYTE_HASH,
      blobIndex: 0,
      chainHash: BYTE_HASH,
      toolCallId: TOOL_CALL_2,
      effectId: null,
      artifactId: null,
      sourceEventId: IDS.event2,
    }),
    scoped("cache_break", {
      classification: "unplanned",
      reason: "request_shape_drift",
      expectedHash: HASH_A,
      actualHash: HASH_B,
      diffArtifactId: IDS.artifact,
    }),
    scoped("effect_reconciled", {
      effectId: IDS.effect,
      resolution: "proven_not_executed",
      evidenceArtifactId: IDS.artifact,
    }),
    scoped("request_interrupted", {
      attemptId: IDS.attempt,
      requestSnapshotId: IDS.snapshot,
      outcome: "transport_error",
      status: null,
      retryClass: "transport_unknown",
      semanticState: "semantic_state_unknown",
    }),
    {
      type: "artifact_published",
      sessionId: IDS.session,
      payload: {
        artifactId: IDS.artifact,
        artifactRef: ARTIFACT_REF,
        artifactHash: HASH_A,
        byteCount: 21,
        lineCount: null,
        mediaType: TOOL_OUTPUT_MEDIA_TYPE,
        artifactType: "tool_output",
        streamBytes: { read: 1, stdout: 1, stderr: 1 },
        hardLimitReached: false,
        descendantsReaped: null,
        toolCallId: TOOL_CALL_2,
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
      type: "artifact_version_created",
      sessionId: IDS.session,
      payload: {
        artifactVersionId: IDS.artifactVersion,
        parentArtifactVersionId: `arv_${"d".repeat(32)}`,
        oldArtifactId: IDS.artifact,
        newArtifactId: IDS.artifact2,
      },
    } as AnyJournalEventDraft,
  ];
  for (const draft of variants) {
    const event = createVerifiedJournalEvent(draft, {
      seq: 2,
      id: IDS.event,
      at: TIMESTAMP,
      prevHash: HASH_B,
    });
    assert.deepEqual(
      decodeJournalRecord(encodeVerifiedJournalEvent(event).copy()),
      event,
      `${draft.type} variant`,
    );
  }

  const first = createVerifiedJournalEvent(values[0]!, {
    seq: 1,
    id: IDS.event,
    at: TIMESTAMP,
    prevHash: null,
  });
  assert.equal(
    new TextDecoder().decode(encodeVerifiedJournalEvent(first).copy()),
    `{"v":1,"seq":1,"id":"${IDS.event}","type":"session_started","sessionId":"${IDS.session}","at":"${TIMESTAMP}","payload":{},"prevHash":null,"hash":"${first.hash}"}`,
  );
});

test("tool-output Artifact and terminal canonical bytes have one literal field order", () => {
  const event = createVerifiedJournalEvent({
    type: "artifact_published",
    sessionId: IDS.session,
    lineageId: IDS.lineage,
    runId: IDS.run,
    payload: {
      artifactId: IDS.artifact,
      artifactRef: ARTIFACT_REF,
      artifactHash: HASH_A,
      byteCount: 0,
      lineCount: null,
      mediaType: TOOL_OUTPUT_MEDIA_TYPE,
      artifactType: "tool_output",
      streamBytes: { read: 0, stdout: 0, stderr: 0 },
      hardLimitReached: false,
      descendantsReaped: null,
      toolCallId: asToolCallId("call-golden"),
      terminal: {
        status: "failed",
        code: "cancelled",
        exitCode: null,
        signal: "SIGTERM",
        descendantsReaped: null,
      },
    },
  }, {
    seq: 2,
    id: IDS.event,
    at: TIMESTAMP,
    prevHash: HASH_B,
  });
  const expected =
    '{"v":1,"seq":2,"id":"evt_11111111111111111111111111111111",' +
    '"type":"artifact_published","sessionId":"ses_33333333333333333333333333333333",' +
    '"lineageId":"lin_44444444444444444444444444444444",' +
    '"runId":"run_66666666666666666666666666666666","at":"2026-08-03T01:02:03.004Z",' +
    '"payload":{"artifactId":"art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",' +
    '"artifactRef":"artifacts/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",' +
    '"artifactHash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",' +
    '"byteCount":0,"lineCount":null,"mediaType":"application/vnd.simpledsh.tool-output.v1",' +
    '"artifactType":"tool_output","streamBytes":{"read":0,"stdout":0,"stderr":0},' +
    '"hardLimitReached":false,"descendantsReaped":null,"toolCallId":"call-golden",' +
    '"terminal":{"status":"failed","code":"cancelled","exitCode":null,' +
    '"signal":"SIGTERM","descendantsReaped":null}},' +
    '"prevHash":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",' +
    '"hash":"sha256:4f6207bf7d496abddeedebbb4f6bf50bfba118a83457cc147e34bf56f5498cad"}';
  assert.equal(
    new TextDecoder().decode(encodeVerifiedJournalEvent(event).copy()),
    expected,
  );
});

test("canonical schema rejects unknown fields invalid scopes ids numbers and Unicode", () => {
  const base = drafts()[0]!;
  const facts = { seq: 1, id: IDS.event, at: TIMESTAMP, prevHash: null } as const;
  assert.throws(() =>
    createVerifiedJournalEvent(
      { ...base, extra: true } as unknown as AnyJournalEventDraft,
      facts,
    ),
  );
  assert.throws(() =>
    createVerifiedJournalEvent(
      { ...base, lineageId: IDS.lineage } as AnyJournalEventDraft,
      facts,
    ),
  );
  assert.throws(() =>
    createVerifiedJournalEvent(
      { ...base, sessionId: "ses_BAD" } as AnyJournalEventDraft,
      facts,
    ),
  );
  assert.throws(() =>
    createVerifiedJournalEvent(base, { ...facts, seq: 1.5 }),
  );
  assert.throws(() =>
    createVerifiedJournalEvent(base, {
      ...facts,
      at: wire<CanonicalTimestamp>("2026-08-03T01:02:03Z\ud800"),
    }),
  );

  const snapshot = drafts().find(
    (draft) => draft.type === "request_snapshot_stored",
  );
  assert.ok(snapshot?.type === "request_snapshot_stored");
  for (const payload of [
    { ...snapshot.payload, projectorVersion: "v1" },
    { ...snapshot.payload, segmentHashes: [HASH_A] },
    { ...snapshot.payload, segmentHashes: [HASH_A, HASH_B, BYTE_HASH] },
    { ...snapshot.payload, segmentHashes: [HASH_A, HASH_A] },
  ]) {
    assert.throws(() =>
      createVerifiedJournalEvent(
        { ...snapshot, payload } as unknown as AnyJournalEventDraft,
        { seq: 2, id: IDS.event, at: TIMESTAMP, prevHash: HASH_B },
      ),
    );
  }

  const valid = encodeVerifiedJournalEvent(
    createVerifiedJournalEvent(base, facts),
  );
  const validText = new TextDecoder().decode(valid.copy());
  assert.throws(() =>
    decodeJournalRecord(new TextEncoder().encode(` ${validText}`)),
  );
  assert.throws(() =>
    decodeJournalRecord(
      new TextEncoder().encode(validText.replace('{"v":1', '{"v":1,"v":1')),
    ),
  );
});

test("opaque identity factories emit only the frozen path-safe wire grammars", () => {
  const cases = [
    [newEventId, /^evt_[0-9a-f]{32}$/u],
    [newSessionId, /^ses_[0-9a-f]{32}$/u],
    [newLineageId, /^lin_[0-9a-f]{32}$/u],
    [newRunId, /^run_[0-9a-f]{32}$/u],
    [newRequestSnapshotId, /^rqs_[0-9a-f]{32}$/u],
    [newAttemptId, /^att_[0-9a-f]{32}$/u],
    [newArtifactId, /^art_[0-9a-f]{32}$/u],
    [newArtifactVersionId, /^arv_[0-9a-f]{32}$/u],
    [newEffectId, /^eff_[0-9a-f]{32}$/u],
    [newCacheCheckpointId, /^ccp_[0-9a-f]{32}$/u],
    [newCommitBoundaryId, /^cbd_[0-9a-f]{32}$/u],
  ] as const;
  const seen = new Set<string>();
  for (const [factory, pattern] of cases) {
    for (let index = 0; index < 4; index += 1) {
      const value = factory();
      assert.match(value, pattern);
      assert.equal(seen.has(value), false);
      seen.add(value);
    }
  }
});
