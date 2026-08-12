import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { materializeAssistant } from "../../src/bytes/assistant.js";
import { utf8Bytes } from "../../src/bytes/ops.js";
import { DEEPSEEK_MODEL } from "../../src/bytes/request.js";
import type { FrozenBytes } from "../../src/bytes/types.js";
import type {
  CompletedDeepSeekResponse,
  DeepSeekUsage,
  ToolCall,
} from "../../src/ds/types.js";
import {
  openJournal,
  openJournalReadOnly,
  type AnyVerifiedJournalEvent,
  type ArtifactId,
  type CanonicalTimestamp,
  type EffectId,
  type EventId,
  type EventIdentitySource,
  type RunId,
  type SessionId,
  type ToolCallId,
} from "../../src/journal/index.js";
import {
  reconcileSessionFixture,
  recoverSessionFixture,
  runSessionFixture,
  SessionInterruptedError,
  SessionKernelError,
} from "../../src/session/index.js";

const FIXED_AT = "2026-08-05T09:00:00.000Z" as CanonicalTimestamp;
const fixedClock = Object.freeze({ now: () => FIXED_AT });

interface SeededIndeterminate {
  readonly effectId: EffectId;
  readonly recoveryRunId: RunId;
  readonly toolCallId: ToolCallId;
}

interface TreeEntry {
  readonly path: string;
  readonly kind: "directory" | "file" | "symlink" | "other";
  readonly mode: string;
  readonly size: string;
  readonly contentHash: string | null;
  readonly linkTarget: string | null;
}

function sessionId(fill: string): SessionId {
  return `ses_${fill.repeat(32)}` as SessionId;
}

function eventIds(fill: string): EventIdentitySource {
  let counter = 0;
  return Object.freeze({
    nextEventId: () => {
      counter += 1;
      return `evt_${fill.repeat(16)}${counter.toString(16).padStart(16, "0")}` as EventId;
    },
  });
}

async function workspace(t: TestContext, label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `flashcoder-reconcile-${label}-`));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

function usage(rawFinishReason: string): DeepSeekUsage {
  return Object.freeze({
    promptTokens: 12,
    promptCacheHitTokens: 2,
    promptCacheMissTokens: 10,
    completionTokens: 4,
    reasoningTokens: 1,
    rawFinishReason,
  });
}

function response(input: Readonly<{
  readonly content: string;
  readonly requestId: string;
  readonly toolCalls?: readonly ToolCall[];
}>): CompletedDeepSeekResponse {
  const toolCalls = Object.freeze([...(input.toolCalls ?? [])]);
  return Object.freeze({
    assistantBytes: materializeAssistant({
      content: input.content,
      reasoningContent: "reconciliation fixture",
      toolCalls,
    }),
    content: input.content,
    reasoningContent: "reconciliation fixture",
    toolCalls,
    usage: usage(toolCalls.length === 0 ? "stop" : "tool_calls"),
    providerRequestId: input.requestId,
    responseModel: DEEPSEEK_MODEL,
    systemFingerprint: null,
    semanticDeltaCount: 1,
  });
}

function success(value: CompletedDeepSeekResponse) {
  return Object.freeze({
    kind: "success" as const,
    response: value,
    fragments: Object.freeze([
      value.toolCalls.length === 0
        ? Object.freeze({ kind: "content" as const, text: value.content })
        : Object.freeze({ kind: "tool_call" as const }),
    ]),
  });
}

function toolCall(id: ToolCallId, command: string): ToolCall {
  return Object.freeze({
    id,
    type: "function" as const,
    function: Object.freeze({
      name: "bash",
      arguments: JSON.stringify({ command }),
    }),
  });
}

function evidence(value: unknown, pretty = false): FrozenBytes {
  return utf8Bytes(`${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`);
}

function completedEvidence(effectId: EffectId): FrozenBytes {
  return evidence({
    v: 1,
    effectId,
    resolution: "completed",
    statement: "operator verified that the external command completed",
    terminal: {
      status: "succeeded",
      code: "ok",
      exitCode: 0,
      signal: null,
      descendantsReaped: true,
    },
    records: [
      {
        stream: "stdout",
        enc: "b64",
        bytes: Buffer.from("operator-confirmed-output\n", "utf8").toString("base64"),
      },
    ],
  }, true);
}

function notExecutedEvidence(effectId: EffectId): FrozenBytes {
  return evidence({
    v: 1,
    effectId,
    resolution: "proven_not_executed",
    statement: "operator verified that no external command was started",
  }, true);
}

async function seedIndeterminate(
  root: string,
  id: SessionId,
  ids: EventIdentitySource,
  callId: ToolCallId,
  command: string,
): Promise<SeededIndeterminate> {
  let appends = 0;
  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Reconcile the deliberately ambiguous command.",
      turns: [
        success(response({
          content: "",
          requestId: "reconcile-seed",
          toolCalls: [toolCall(callId, command)],
        })),
      ],
      clock: fixedClock,
      eventIds: ids,
      persistenceControls: {
        fault: (point) => {
          if (point !== "append.after_sync_before_ack") return;
          appends += 1;
          if (appends === 17) throw new Error("crash after effect_prepared");
        },
      },
    }),
    (error: unknown) =>
      error instanceof SessionKernelError && error.code === "durability_failure",
  );
  await assert.rejects(
    recoverSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      turns: [],
      clock: fixedClock,
      eventIds: ids,
    }),
    (error: unknown) =>
      error instanceof SessionInterruptedError &&
      error.reason === "effect_indeterminate",
  );

  const observed = await openJournalReadOnly(root, id);
  const effect = observed.recoveryView.effects.find(
    (candidate) =>
      candidate.toolCallId === callId && candidate.status === "indeterminate",
  );
  assert.ok(effect);
  const recoveryRun = observed.recoveryView.runs.findLast(
    (candidate) => candidate.cause === "recovery",
  );
  assert.ok(recoveryRun);
  assert.equal(recoveryRun.status, "active");
  return Object.freeze({
    effectId: effect.effectId as EffectId,
    recoveryRunId: recoveryRun.runId as RunId,
    toolCallId: callId,
  });
}

function countType(
  events: readonly AnyVerifiedJournalEvent[],
  type: AnyVerifiedJournalEvent["type"],
): number {
  return events.filter((event) => event.type === type).length;
}

function onlyEvent<Type extends AnyVerifiedJournalEvent["type"]>(
  events: readonly AnyVerifiedJournalEvent[],
  type: Type,
  predicate: (
    event: Extract<AnyVerifiedJournalEvent, { readonly type: Type }>,
  ) => boolean = () => true,
): Extract<AnyVerifiedJournalEvent, { readonly type: Type }> {
  const matches = events.filter(
    (event): event is Extract<AnyVerifiedJournalEvent, { readonly type: Type }> =>
      event.type === type && predicate(
        event as Extract<AnyVerifiedJournalEvent, { readonly type: Type }>,
      ),
  );
  assert.equal(matches.length, 1, `expected one ${type}, got ${String(matches.length)}`);
  return matches[0]!;
}

function eventsOfType<Type extends AnyVerifiedJournalEvent["type"]>(
  events: readonly AnyVerifiedJournalEvent[],
  type: Type,
  predicate: (
    event: Extract<AnyVerifiedJournalEvent, { readonly type: Type }>,
  ) => boolean = () => true,
): readonly Extract<AnyVerifiedJournalEvent, { readonly type: Type }>[] {
  return events.filter(
    (event): event is Extract<AnyVerifiedJournalEvent, { readonly type: Type }> =>
      event.type === type && predicate(
        event as Extract<AnyVerifiedJournalEvent, { readonly type: Type }>,
      ),
  );
}

async function readArtifactBytes(
  root: string,
  id: SessionId,
  ids: EventIdentitySource,
  artifactId: ArtifactId,
): Promise<Uint8Array> {
  const opened = await openJournal(root, id, fixedClock, ids);
  try {
    const artifact = onlyEvent(
      opened.writer.events,
      "artifact_published",
      (event) => event.payload.artifactId === artifactId,
    );
    assert.ok(artifact.payload.byteCount > 0);
    return (
      await opened.artifacts.readArtifactRange(artifact.payload.artifactRef, {
        offset: 0,
        maxBytes: artifact.payload.byteCount,
      })
    ).bytes.copy();
  } finally {
    await opened.writer.close();
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function treeSnapshot(root: string): Promise<readonly TreeEntry[]> {
  const entries: TreeEntry[] = [];
  async function visit(path: string, relative: string): Promise<void> {
    const stats = await lstat(path, { bigint: true });
    const kind = stats.isDirectory()
      ? "directory"
      : stats.isFile()
        ? "file"
        : stats.isSymbolicLink()
          ? "symlink"
          : "other";
    entries.push(Object.freeze({
      path: relative,
      kind,
      mode: stats.mode.toString(),
      size: stats.size.toString(),
      contentHash: kind === "file" ? sha256(await readFile(path)) : null,
      linkTarget: kind === "symlink" ? await readlink(path) : null,
    }));
    if (kind !== "directory") return;
    for (const name of (await readdir(path)).sort()) {
      await visit(join(path, name), relative === "." ? name : `${relative}/${name}`);
    }
  }
  await visit(root, ".");
  return Object.freeze(entries);
}

test("completed reconciliation preserves exact evidence/output and continues in the same recovery Run", async (t) => {
  const root = await workspace(t, "completed");
  const id = sessionId("1");
  const ids = eventIds("1");
  const callId = "call_reconcile_completed" as ToolCallId;
  const target = join(root, "completed-marker.txt");
  const seeded = await seedIndeterminate(
    root,
    id,
    ids,
    callId,
    "printf DUPLICATE >> completed-marker.txt",
  );
  await writeFile(target, "EXTERNAL_EFFECT_ALREADY_COMPLETED\n", "utf8");
  const document = completedEvidence(seeded.effectId);

  const result = await reconcileSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    evidenceBytes: document,
    turns: [success(response({ content: "reconciled", requestId: "completed-final" }))],
    clock: fixedClock,
    eventIds: ids,
  });

  assert.equal(result.runId, seeded.recoveryRunId);
  assert.equal(await readFile(target, "utf8"), "EXTERNAL_EFFECT_ALREADY_COMPLETED\n");
  const opened = await openJournal(root, id, fixedClock, ids);
  try {
    const events = opened.writer.events;
    const evidenceEvent = onlyEvent(
      events,
      "artifact_published",
      (event) => event.payload.artifactType === "operator_evidence",
    );
    const output = onlyEvent(
      events,
      "artifact_published",
      (event) =>
        event.payload.artifactType === "tool_output" &&
        event.payload.toolCallId === callId,
    );
    const reconciled = onlyEvent(events, "effect_reconciled");
    assert.equal(reconciled.payload.resolution, "completed");
    if (reconciled.payload.resolution !== "completed") assert.fail("wrong resolution");
    assert.equal(reconciled.runId, seeded.recoveryRunId);
    assert.equal(reconciled.payload.evidenceArtifactId, evidenceEvent.payload.artifactId);
    assert.equal(reconciled.payload.outputArtifactId, output.payload.artifactId);
    assert.deepEqual(output.payload.streamBytes, {
      read: 0,
      stdout: Buffer.byteLength("operator-confirmed-output\n"),
      stderr: 0,
    });
    assert.equal(output.payload.descendantsReaped, true);
    const toolResult = onlyEvent(
      events,
      "tool_result_committed",
      (event) => event.payload.toolCallId === callId,
    );
    assert.equal(toolResult.runId, seeded.recoveryRunId);
    assert.equal(toolResult.payload.sourceEventId, reconciled.id);
    assert.equal(toolResult.payload.effectId, seeded.effectId);
    assert.equal(toolResult.payload.artifactId, output.payload.artifactId);
    const boundary = onlyEvent(
      events,
      "commit_boundary_created",
      (event) => event.payload.sourceEventIds.includes(toolResult.id),
    );
    const snapshot = onlyEvent(
      events,
      "request_snapshot_stored",
      (event) => event.payload.commitBoundaryId === boundary.payload.commitBoundaryId,
    );
    assert.equal(boundary.runId, seeded.recoveryRunId);
    assert.equal(snapshot.runId, seeded.recoveryRunId);
    assert.equal(countType(events, "effect_prepared"), 1);
    assert.equal(countType(events, "effect_completed"), 0);
    assert.equal(countType(events, "effect_reconciled"), 1);
    assert.equal(
      events.filter(
        (event) =>
          event.type === "artifact_published" &&
          event.payload.artifactType === "operator_evidence",
      ).length,
      1,
    );
  } finally {
    await opened.writer.close();
  }
  assert.deepEqual(
    await readArtifactBytes(
      root,
      id,
      ids,
      onlyEvent(
        (await openJournalReadOnly(root, id)).replay.events,
        "artifact_published",
        (event) => event.payload.artifactType === "operator_evidence",
      ).payload.artifactId,
    ),
    document.copy(),
  );
});

test("proven_not_executed publishes evidence then performs exactly one external execution", async (t) => {
  const root = await workspace(t, "not-executed");
  const id = sessionId("2");
  const ids = eventIds("2");
  const callId = "call_reconcile_not_executed" as ToolCallId;
  const target = join(root, "execution-count.txt");
  const seeded = await seedIndeterminate(
    root,
    id,
    ids,
    callId,
    "printf X >> execution-count.txt",
  );
  const document = notExecutedEvidence(seeded.effectId);

  const result = await reconcileSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    evidenceBytes: document,
    turns: [success(response({ content: "executed", requestId: "not-executed-final" }))],
    clock: fixedClock,
    eventIds: ids,
  });

  assert.equal(result.runId, seeded.recoveryRunId);
  assert.equal(await readFile(target, "utf8"), "X");
  const observed = await openJournalReadOnly(root, id);
  const events = observed.replay.events;
  const evidenceEvent = onlyEvent(
    events,
    "artifact_published",
    (event) => event.payload.artifactType === "operator_evidence",
  );
  const reconciled = onlyEvent(events, "effect_reconciled");
  assert.equal(reconciled.payload.resolution, "proven_not_executed");
  assert.equal(reconciled.runId, seeded.recoveryRunId);
  assert.equal(reconciled.payload.evidenceArtifactId, evidenceEvent.payload.artifactId);
  assert.equal(countType(events, "effect_prepared"), 2);
  assert.equal(countType(events, "effect_completed"), 1);
  assert.equal(countType(events, "effect_reconciled"), 1);
  assert.equal(
    events.filter(
      (event) =>
        event.type === "tool_result_committed" &&
        event.payload.toolCallId === callId,
    ).length,
    1,
  );
  assert.deepEqual(
    await readArtifactBytes(root, id, ids, evidenceEvent.payload.artifactId),
    document.copy(),
  );
});

test("invalid reconciliation JSON, closed keys, base64, and terminal fail before any write", async (t) => {
  const root = await workspace(t, "invalid");
  const id = sessionId("3");
  const ids = eventIds("3");
  const callId = "call_reconcile_invalid" as ToolCallId;
  const seeded = await seedIndeterminate(
    root,
    id,
    ids,
    callId,
    "printf INVALID >> must-not-exist.txt",
  );
  const sessionDir = join(root, ".flashcoder", "sessions", id);
  const invalidDocuments: readonly FrozenBytes[] = Object.freeze([
    utf8Bytes("{not-json\n"),
    utf8Bytes(
      `{"v":1,"effectId":"${seeded.effectId}","resolution":"proven_not_executed","statement":"checked","\\u0076":1}\n`,
    ),
    evidence({
      v: 1,
      effectId: seeded.effectId,
      resolution: "proven_not_executed",
      statement: "checked",
      extra: true,
    }),
    evidence({
      v: 1,
      effectId: seeded.effectId,
      resolution: "completed",
      statement: "checked",
      terminal: {
        status: "succeeded",
        code: "ok",
        exitCode: 0,
        signal: null,
        descendantsReaped: true,
      },
      records: [{ stream: "stdout", enc: "b64", bytes: "!!!!" }],
    }),
    evidence({
      v: 1,
      effectId: seeded.effectId,
      resolution: "completed",
      statement: "checked",
      terminal: {
        status: "succeeded",
        code: "nonzero_exit",
        exitCode: 0,
        signal: null,
        descendantsReaped: true,
      },
      records: [],
    }),
  ]);

  for (const document of invalidDocuments) {
    const before = await treeSnapshot(sessionDir);
    await assert.rejects(
      reconcileSessionFixture({
        workspaceRoot: root,
        sessionId: id,
        evidenceBytes: document,
        turns: [],
        clock: fixedClock,
        eventIds: ids,
      }),
    );
    assert.deepEqual(await treeSnapshot(sessionDir), before);
  }
  await assert.rejects(readFile(join(root, "must-not-exist.txt")), {
    code: "ENOENT",
  });
  const observed = await openJournalReadOnly(root, id);
  assert.equal(countType(observed.replay.events, "effect_reconciled"), 0);
  assert.equal(
    observed.replay.events.filter(
      (event) =>
        event.type === "artifact_published" &&
        event.payload.artifactType === "operator_evidence",
    ).length,
    0,
  );
});

for (const [targetAppend, seam] of [
  [1, "evidence"],
  [2, "output"],
  [3, "reconciliation"],
  [4, "result"],
  [5, "boundary"],
  [6, "snapshot"],
] as const) {
  test(`completed reconciliation crash at ${seam} converges without duplicate facts or effects`, async (t) => {
    const root = await workspace(t, `seam-${seam}`);
    const fill = String(targetAppend + 3);
    const id = sessionId(fill);
    const ids = eventIds(fill);
    const callId = `call_reconcile_seam_${seam}` as ToolCallId;
    const target = join(root, "seam-marker.txt");
    const seeded = await seedIndeterminate(
      root,
      id,
      ids,
      callId,
      "printf DUPLICATE >> seam-marker.txt",
    );
    await writeFile(target, "EXTERNAL_EFFECT_ALREADY_COMPLETED\n", "utf8");
    const document = completedEvidence(seeded.effectId);
    let appends = 0;

    await assert.rejects(
      reconcileSessionFixture({
        workspaceRoot: root,
        sessionId: id,
        evidenceBytes: document,
        turns: [],
        clock: fixedClock,
        eventIds: ids,
        persistenceControls: {
          fault: (point: string) => {
            if (point !== "append.after_sync_before_ack") return;
            appends += 1;
            if (appends === targetAppend) {
              throw new Error(`crash at ${seam}`);
            }
          },
        },
      }),
    );

    const result = await reconcileSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      evidenceBytes: document,
      turns: [success(response({ content: "converged", requestId: `seam-${seam}` }))],
      clock: fixedClock,
      eventIds: ids,
    });
    if (seam === "snapshot") {
      assert.notEqual(result.runId, seeded.recoveryRunId);
    } else {
      assert.equal(result.runId, seeded.recoveryRunId);
    }
    assert.equal(await readFile(target, "utf8"), "EXTERNAL_EFFECT_ALREADY_COMPLETED\n");

    const observed = await openJournalReadOnly(root, id);
    const events = observed.replay.events;
    const evidenceEvents = eventsOfType(
      events,
      "artifact_published",
      (event) =>
        event.payload.artifactType === "operator_evidence",
    );
    const outputEvents = eventsOfType(
      events,
      "artifact_published",
      (event) =>
        event.payload.artifactType === "tool_output" &&
        event.payload.toolCallId === callId,
    );
    const reconciliationEvents = eventsOfType(
      events,
      "effect_reconciled",
    );
    const resultEvents = eventsOfType(
      events,
      "tool_result_committed",
      (event) =>
        event.payload.toolCallId === callId,
    );
    assert.equal(evidenceEvents.length, 1);
    assert.equal(outputEvents.length, 1);
    assert.equal(reconciliationEvents.length, 1);
    assert.equal(resultEvents.length, 1);
    assert.equal(countType(events, "effect_prepared"), 1);
    assert.equal(countType(events, "effect_completed"), 0);
    const resultEvent = resultEvents[0]!;
    const boundaries = eventsOfType(
      events,
      "commit_boundary_created",
      (event) =>
        event.payload.sourceEventIds.includes(resultEvent.id),
    );
    assert.equal(boundaries.length, 1);
    const boundary = boundaries[0]!;
    const snapshots = eventsOfType(
      events,
      "request_snapshot_stored",
      (event) =>
        event.payload.commitBoundaryId === boundary.payload.commitBoundaryId,
    );
    assert.equal(snapshots.length, seam === "snapshot" ? 2 : 1);
    assert.equal(evidenceEvents[0]?.runId, seeded.recoveryRunId);
    assert.equal(outputEvents[0]?.runId, seeded.recoveryRunId);
    assert.equal(reconciliationEvents[0]?.runId, seeded.recoveryRunId);
    assert.equal(resultEvent.runId, seeded.recoveryRunId);
    assert.equal(boundary.runId, seeded.recoveryRunId);
    assert.equal(snapshots[0]?.runId, seeded.recoveryRunId);
    if (seam === "snapshot") {
      const original = snapshots[0]!;
      const alias = snapshots[1]!;
      assert.equal(alias.runId, result.runId);
      assert.equal(
        alias.payload.recoveryFromSnapshotId,
        original.payload.requestSnapshotId,
      );
      assert.deepEqual(
        {
          bodyRef: alias.payload.bodyRef,
          bodyHash: alias.payload.bodyHash,
          byteCount: alias.payload.byteCount,
          cacheAbiId: alias.payload.cacheAbiId,
          projectorVersion: alias.payload.projectorVersion,
          headEventId: alias.payload.headEventId,
          commitBoundaryId: alias.payload.commitBoundaryId,
          segmentHashes: alias.payload.segmentHashes,
        },
        {
          bodyRef: original.payload.bodyRef,
          bodyHash: original.payload.bodyHash,
          byteCount: original.payload.byteCount,
          cacheAbiId: original.payload.cacheAbiId,
          projectorVersion: original.payload.projectorVersion,
          headEventId: original.payload.headEventId,
          commitBoundaryId: original.payload.commitBoundaryId,
          segmentHashes: original.payload.segmentHashes,
        },
      );
      const interrupted = onlyEvent(
        events,
        "run_interrupted",
        (event) => event.runId === seeded.recoveryRunId,
      );
      assert.equal(interrupted.payload.reason, "durability_failure");
      assert.equal(interrupted.payload.sourceEventId, original.id);
      const successor = onlyEvent(
        events,
        "run_started",
        (event) => event.runId === result.runId,
      );
      assert.equal(successor.payload.cause, "recovery");
      assert.equal(successor.payload.previousRunId, seeded.recoveryRunId);
    }
    assert.deepEqual(
      await readArtifactBytes(
        root,
        id,
        ids,
        evidenceEvents[0]!.payload.artifactId,
      ),
      document.copy(),
    );
  });
}
