import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JournalBindingProjection } from "../../src/journal/bindings.js";
import { inspectWriterLease, quarantineWriterLease } from "../../src/journal/lease.js";
import { openJournal } from "../../src/journal/open.js";
import { createSessionPaths } from "../../src/journal/paths.js";
import { JournalWriter } from "../../src/journal/writer.js";
import type {
  AnyJournalEventDraft,
  CanonicalTimestamp,
  EventId,
  JournalClock,
  SessionId,
} from "../../src/journal/types.js";

function sessionId(): SessionId {
  return `ses_${"1".repeat(32)}` as SessionId;
}

function sessionStarted(): AnyJournalEventDraft {
  return { type: "session_started", sessionId: sessionId(), payload: {} };
}

function plannedBreak(): AnyJournalEventDraft {
  return {
    type: "cache_break",
    sessionId: sessionId(),
    payload: {
      classification: "planned",
      fromLineageId: `lin_${"2".repeat(32)}`,
      toLineageId: `lin_${"3".repeat(32)}`,
      reason: "abi_change",
      authorizedRevision: "r1",
    },
  } as AnyJournalEventDraft;
}

function fixedClock(): JournalClock {
  return {
    now: () => "2026-08-03T00:00:00.000Z" as CanonicalTimestamp,
  };
}

function eventIds() {
  let next = 0;
  return {
    nextEventId: () => {
      next += 1;
      return `evt_${next.toString(16).padStart(32, "0")}` as EventId;
    },
  };
}

const preflight = {
  prepare: async () => ({ commit: () => undefined }),
};

test("journal append serializes short writes and acknowledges only after fsync", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flashcoder-writer-"));
  const path = join(directory, "log.jsonl");
  const handle = await open(path, "ax+", 0o600);
  const points: string[] = [];
  const writer = new JournalWriter({
    log: handle,
    head: { seq: 0, hash: null },
    clock: fixedClock(),
    eventIds: eventIds(),
    preflight,
    lease: {
      release: async (log) => {
        await log.close();
      },
    },
    controls: {
      maxWriteBytes: 7,
      fault: (point) => {
        points.push(point);
      },
    },
  });
  const initialView = writer.events;

  const [first, second] = await Promise.all([
    writer.append(sessionStarted()),
    writer.append(plannedBreak()),
  ]);
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(second.prevHash, first.hash);
  assert.deepEqual(writer.head, { seq: 2, hash: second.hash });
  assert.ok(Object.isFrozen(initialView));
  assert.deepEqual(initialView, []);
  assert.ok(Object.isFrozen(writer.events));
  assert.deepEqual(writer.events, [first, second]);
  assert.equal(points.filter((point) => point === "append.before_sync").length, 2);
  assert.equal(
    points.filter((point) => point === "append.after_sync_before_ack").length,
    2,
  );
  assert.ok(points.filter((point) => point === "append.after_write_chunk").length > 2);
  await writer.close();

  const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /"seq":1/u);
  assert.match(lines[1]!, /"seq":2/u);
});

test("journal append failure poisons the writer and permits no later append", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flashcoder-poison-"));
  const path = join(directory, "log.jsonl");
  const handle = await open(path, "ax+", 0o600);
  let inject = true;
  const writer = new JournalWriter({
    log: handle,
    head: { seq: 0, hash: null },
    clock: fixedClock(),
    eventIds: eventIds(),
    preflight,
    lease: {
      release: async (log) => {
        await log.close();
      },
    },
    controls: {
      fault: (point) => {
        if (point === "append.before_sync" && inject) {
          inject = false;
          throw new Error("injected");
        }
      },
    },
  });

  await assert.rejects(writer.append(sessionStarted()), { code: "JOURNAL_IO" });
  const afterFailure = (await stat(path)).size;
  await assert.rejects(writer.append(plannedBreak()), {
    code: "JOURNAL_POISONED",
  });
  assert.equal((await stat(path)).size, afterFailure);
  assert.equal(writer.state, "poisoned");
  assert.deepEqual(writer.events, []);
  await writer.close();
});

test("acknowledged event view does not advance across after-sync ambiguity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flashcoder-ack-view-"));
  const path = join(directory, "log.jsonl");
  const handle = await open(path, "ax+", 0o600);
  const writer = new JournalWriter({
    log: handle,
    head: { seq: 0, hash: null },
    clock: fixedClock(),
    eventIds: eventIds(),
    preflight,
    lease: {
      release: async (log) => {
        await log.close();
      },
    },
    controls: {
      fault: (point) => {
        if (point === "append.after_sync_before_ack") throw new Error("injected");
      },
    },
  });

  const before = writer.events;
  await assert.rejects(writer.append(sessionStarted()), { code: "JOURNAL_IO" });
  assert.equal(writer.state, "poisoned");
  assert.strictEqual(writer.events, before);
  assert.deepEqual(writer.events, []);
  assert.ok((await stat(path)).size > 0);
  await writer.close();
});

test("journal append preflights identity and references before any bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flashcoder-preflight-"));
  const path = join(directory, "log.jsonl");
  const handle = await open(path, "ax+", 0o600);
  const projection = new JournalBindingProjection({
    loadBlob: async () => {
      throw new Error("not expected");
    },
    loadArtifact: async () => {
      throw new Error("not expected");
    },
    scanArtifact: async () => {
      throw new Error("not expected");
    },
    verifyArtifact: async () => undefined,
    verifySnapshot: async () => undefined,
    verifyRecovery: async () => undefined,
  });
  const writer = new JournalWriter({
    log: handle,
    head: { seq: 0, hash: null },
    clock: fixedClock(),
    eventIds: eventIds(),
    preflight: projection,
    lease: {
      release: async (log) => {
        await log.close();
      },
    },
  });
  await writer.append(sessionStarted());
  const acceptedSize = (await stat(path)).size;
  await assert.rejects(
    writer.append({
      type: "cache_abi_declared",
      sessionId: sessionId(),
      payload: {
        cacheAbiId: `sha256:${"a".repeat(64)}`,
        manifestArtifactId: `art_${"b".repeat(32)}`,
        manifestByteCount: 1,
      },
    } as AnyJournalEventDraft),
    { code: "JOURNAL_REFERENCE" },
  );
  assert.equal((await stat(path)).size, acceptedSize);
  assert.equal(writer.state, "open");
  await writer.close();
});

test("journal close drains accepted appends and rejects later work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flashcoder-close-"));
  const path = join(directory, "log.jsonl");
  const handle = await open(path, "ax+", 0o600);
  const writer = new JournalWriter({
    log: handle,
    head: { seq: 0, hash: null },
    clock: fixedClock(),
    eventIds: eventIds(),
    preflight,
    lease: {
      release: async (log) => {
        await log.close();
      },
    },
    controls: { maxWriteBytes: 3 },
  });
  const accepted = writer.append(sessionStarted());
  const closing = writer.close();
  await assert.rejects(writer.append(plannedBreak()), {
    code: "JOURNAL_CLOSED",
  });
  const event = await accepted;
  await closing;
  assert.equal(event.seq, 1);
  assert.equal((await readFile(path, "utf8")).split("\n").length, 2);
  assert.equal(writer.state, "closed");
});

test("journal record durable before acknowledgement is recovered as the committed fact", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "flashcoder-ack-crash-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  const sid = sessionId();
  const initial = await openJournal(workspace, sid, fixedClock(), eventIds());
  const started = await initial.writer.append(sessionStarted());
  assert.deepEqual(initial.writer.events, [started]);
  await initial.writer.close();

  const worker = join(
    process.cwd(),
    "dist/test/journal/append-crash-worker.js",
  );
  const child = spawn(
    process.execPath,
    [worker, workspace, sid, "append.after_sync_before_ack"],
    {
      stdio: "ignore",
      env: { PATH: process.env["PATH"] ?? "" },
    },
  );
  const [code, signal] = (await once(child, "exit")) as [
    number | null,
    NodeJS.Signals | null,
  ];
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");

  const paths = createSessionPaths(workspace, sid);
  const stale = await inspectWriterLease(paths);
  assert.equal(stale.state, "stale-proven-dead");
  await quarantineWriterLease(paths, stale, {
    confirmedNoConcurrentStart: true,
  });
  const reopened = await openJournal(workspace, sid, fixedClock(), eventIds());
  assert.deepEqual(
    reopened.replay.events.map((event) => event.type),
    ["session_started", "integrity_violation"],
  );
  assert.deepEqual(reopened.writer.events, reopened.replay.events);
  await reopened.writer.close();
});
