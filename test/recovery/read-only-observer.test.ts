import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { materializeAssistant } from "../../src/bytes/assistant.js";
import type { CompletedDeepSeekResponse } from "../../src/ds/types.js";
import { openJournal, openJournalReadOnly } from "../../src/journal/open.js";
import type {
  AnyJournalEventDraft,
  ArtifactId,
  CanonicalTimestamp,
  EventId,
  EventIdentitySource,
  SessionId,
} from "../../src/journal/types.js";
import { runSessionFixture } from "../../src/session/index.js";

const FIXED_AT = "2026-08-05T00:00:00.000Z" as CanonicalTimestamp;
const fixedClock = Object.freeze({ now: () => FIXED_AT });

interface InventoryEntry {
  readonly path: string;
  readonly kind: "directory" | "file" | "symlink" | "other";
  readonly mode: string;
  readonly inode: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
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
      const suffix = counter.toString(16);
      return `evt_${fill.repeat(32 - suffix.length)}${suffix}` as EventId;
    },
  });
}

async function workspace(t: TestContext, label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `flashcoder-recovery-${label}-`));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

function completedResponse(): CompletedDeepSeekResponse {
  const content = "completed";
  return Object.freeze({
    assistantBytes: materializeAssistant({
      content,
      reasoningContent: "The task is complete.",
      toolCalls: Object.freeze([]),
    }),
    content,
    reasoningContent: "The task is complete.",
    toolCalls: Object.freeze([]),
    usage: Object.freeze({
      promptTokens: 10,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 10,
      completionTokens: 4,
      reasoningTokens: 2,
      rawFinishReason: "stop",
    }),
    providerRequestId: "fixture-read-only-completed",
    responseModel: "deepseek-v4-flash",
    systemFingerprint: null,
    semanticDeltaCount: 1,
  });
}

async function createCompletedSession(
  root: string,
  id: SessionId,
): Promise<void> {
  const response = completedResponse();
  const result = await runSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "Complete this deterministic fixture.",
    turns: Object.freeze([
      Object.freeze({
        kind: "success" as const,
        response,
        fragments: Object.freeze([
          Object.freeze({ kind: "content" as const, text: response.content }),
        ]),
      }),
    ]),
    clock: fixedClock,
    eventIds: eventIds("a"),
  });
  assert.equal(result.status, "completed");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function filesystemInventory(root: string): Promise<readonly InventoryEntry[]> {
  const entries: InventoryEntry[] = [];

  async function visit(absolutePath: string, relativePath: string): Promise<void> {
    const stats = await lstat(absolutePath, { bigint: true });
    const kind = stats.isDirectory()
      ? "directory"
      : stats.isFile()
        ? "file"
        : stats.isSymbolicLink()
          ? "symlink"
          : "other";
    const contentHash = kind === "file"
      ? sha256(await readFile(absolutePath))
      : null;
    const linkTarget = kind === "symlink" ? await readlink(absolutePath) : null;
    entries.push(Object.freeze({
      path: relativePath,
      kind,
      mode: stats.mode.toString(),
      inode: stats.ino.toString(),
      size: stats.size.toString(),
      mtimeNs: stats.mtimeNs.toString(),
      ctimeNs: stats.ctimeNs.toString(),
      contentHash,
      linkTarget,
    }));

    if (kind !== "directory") return;
    for (const name of (await readdir(absolutePath)).sort()) {
      await visit(
        join(absolutePath, name),
        relativePath === "." ? name : `${relativePath}/${name}`,
      );
    }
  }

  await visit(root, ".");
  return Object.freeze(entries);
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertDeepFrozen(nested, seen);
}

function sessionStarted(id: SessionId): AnyJournalEventDraft {
  return { type: "session_started", sessionId: id, payload: {} };
}

test("completed Session opens read-only from durable facts without filesystem mutation", async (t) => {
  const root = await workspace(t, "completed-read-only");
  const id = sessionId("1");
  await createCompletedSession(root, id);
  const sessionDir = join(root, ".flashcoder", "sessions", id);
  const before = await filesystemInventory(sessionDir);

  const observed = await openJournalReadOnly(root, id);

  assert.equal(observed.replay.tornTail, null);
  assert.equal(observed.replay.events.at(-1)?.type, "run_completed");
  assertDeepFrozen(observed.recoveryView);
  assert.equal(observed.recoveryView.sessionId, id);
  assert.equal(observed.recoveryView.runs.at(-1)?.status, "completed");
  assert.equal(observed.observation.stable, true);
  assert.equal(observed.observation.leaseStable, true);
  assert.equal(observed.observation.initialLease.state, "absent");
  assert.equal(observed.observation.finalLease.state, "absent");
  assert.deepEqual(await filesystemInventory(sessionDir), before);
});

test("active writer remains open while passive read-only observation neither signals nor mutates", async (t) => {
  const root = await workspace(t, "active-writer");
  const id = sessionId("2");
  const opened = await openJournal(root, id, fixedClock, eventIds("b"));
  t.after(async () => opened.writer.close().catch(() => undefined));
  await opened.writer.append(sessionStarted(id));
  const before = await filesystemInventory(opened.paths.sessionDir);
  const originalKill = process.kill;
  let signalProbeCount = 0;
  process.kill = (() => {
    signalProbeCount += 1;
    throw new Error("passive observation attempted a process signal/probe");
  }) as typeof process.kill;

  try {
    const observed = await openJournalReadOnly(root, id);
    assert.equal(observed.replay.events.length, 1);
    assert.equal(observed.replay.events[0]?.type, "session_started");
    assert.equal(observed.observation.stable, true);
    assert.equal(observed.observation.leaseStable, true);
    assert.equal(observed.observation.initialLease.state, "owner-observed");
    assert.equal(observed.observation.finalLease.state, "owner-observed");
    if (observed.observation.initialLease.state === "owner-observed") {
      assert.equal(observed.observation.initialLease.owner.pid, process.pid);
    }
    assert.equal(opened.writer.state, "open");
    assert.equal(signalProbeCount, 0);
    assert.deepEqual(await filesystemInventory(opened.paths.sessionDir), before);
  } finally {
    process.kill = originalKill;
  }
});

test("read-only replay reports a torn suffix byte-exactly and performs no repair", async (t) => {
  const root = await workspace(t, "torn-tail");
  const id = sessionId("3");
  const opened = await openJournal(root, id, fixedClock, eventIds("c"));
  await opened.writer.append(sessionStarted(id));
  await opened.writer.close();
  const tail = new TextEncoder().encode('{"partial":true');
  await appendFile(opened.paths.logPath, tail);
  const beforeLog = await readFile(opened.paths.logPath);
  const before = await filesystemInventory(opened.paths.sessionDir);

  const observed = await openJournalReadOnly(root, id);

  assert.deepEqual(observed.replay.tornTail?.copy(), tail);
  assert.deepEqual(
    observed.replay.events.map((event) => event.type),
    ["session_started"],
  );
  assert.equal(
    observed.replay.events.some((event) => event.type === "journal_tail_recovered"),
    false,
  );
  assert.equal(observed.observation.stable, true);
  assert.equal(observed.observation.initialLogByteCount, beforeLog.byteLength);
  assert.equal(observed.observation.finalLogByteCount, beforeLog.byteLength);
  assert.deepEqual(await readFile(opened.paths.logPath), beforeLog);
  assert.deepEqual(await filesystemInventory(opened.paths.sessionDir), before);
});

test("RecoveryView is deeply immutable and advances only after writer acknowledgement", async (t) => {
  const root = await workspace(t, "recovery-view");
  let failAfterSyncBeforeAck = false;
  const id = sessionId("4");
  const opened = await openJournal(
    root,
    id,
    fixedClock,
    eventIds("d"),
    {
      fault: (point) => {
        if (failAfterSyncBeforeAck && point === "append.after_sync_before_ack") {
          throw new Error("injected acknowledgement ambiguity");
        }
      },
    },
  );
  t.after(async () => opened.writer.close().catch(() => undefined));
  const initial = opened.recoveryView();
  assertDeepFrozen(initial);
  assert.equal(initial.sessionId, undefined);

  const acknowledged = await opened.writer.append(sessionStarted(id));
  const afterAcknowledged = opened.recoveryView();
  assertDeepFrozen(afterAcknowledged);
  assert.equal(afterAcknowledged.sessionId, id);
  assert.deepEqual(opened.writer.events, [acknowledged]);
  assert.equal(initial.sessionId, undefined);

  const manifest = await opened.artifacts.publishArtifact(
    new Uint8Array([0x62]),
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
  failAfterSyncBeforeAck = true;
  await assert.rejects(
    opened.writer.append({
      type: "artifact_published",
      sessionId: id,
      payload: {
        artifactId: `art_${"c".repeat(32)}` as ArtifactId,
        ...manifest,
      },
    }),
    { code: "JOURNAL_IO" },
  );
  const afterAmbiguousAppend = opened.recoveryView();
  assertDeepFrozen(afterAmbiguousAppend);
  assert.deepEqual(afterAmbiguousAppend, afterAcknowledged);
  assert.deepEqual(afterAmbiguousAppend.artifacts, []);
  assert.deepEqual(opened.writer.events, [acknowledged]);
  assert.equal(opened.writer.state, "poisoned");
});
