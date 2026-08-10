import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openJournal } from "../../src/journal/open.js";
import { createSessionPaths } from "../../src/journal/paths.js";
import type {
  CanonicalTimestamp,
  EventId,
  SessionId,
} from "../../src/journal/types.js";

const SESSION_A = `ses_${"a".repeat(32)}` as SessionId;
const SESSION_B = `ses_${"b".repeat(32)}` as SessionId;
const TIMESTAMP = "2026-08-04T01:00:00.000Z" as CanonicalTimestamp;

const fixedClock = {
  now: () => TIMESTAMP,
};

function eventIds(fill: string) {
  let next = 0;
  return {
    nextEventId: () => {
      next += 1;
      const suffix = `${fill.repeat(31)}${next.toString(16)}`.slice(-32);
      return `evt_${suffix}` as EventId;
    },
  };
}

test("fresh Session A rejects Session B bootstrap before writing bytes", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "simpledsh-session-bind-fresh-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));

  const opened = await openJournal(
    workspace,
    SESSION_A,
    fixedClock,
    eventIds("1"),
  );
  const before = await readFile(opened.paths.logPath);
  await assert.rejects(
    opened.writer.append({
      type: "session_started",
      sessionId: SESSION_B,
      payload: {},
    }),
    { code: "JOURNAL_REFERENCE" },
  );
  assert.deepEqual(await readFile(opened.paths.logPath), before);
  assert.equal(opened.writer.state, "open");

  const accepted = await opened.writer.append({
    type: "session_started",
    sessionId: SESSION_A,
    payload: {},
  });
  assert.equal(accepted.seq, 1);
  await opened.writer.close();
});

test("Session B Journal moved under Session A is rejected without log mutation", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "simpledsh-session-bind-replay-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));

  const source = await openJournal(
    workspace,
    SESSION_B,
    fixedClock,
    eventIds("2"),
  );
  await source.writer.append({
    type: "session_started",
    sessionId: SESSION_B,
    payload: {},
  });
  await source.writer.close();

  const targetPaths = createSessionPaths(workspace, SESSION_A);
  await rename(source.paths.sessionDir, targetPaths.sessionDir);
  const before = await readFile(targetPaths.logPath);

  await assert.rejects(
    openJournal(workspace, SESSION_A, fixedClock, eventIds("3")),
    { code: "JOURNAL_REFERENCE" },
  );
  assert.deepEqual(await readFile(targetPaths.logPath), before);
});

test("open replay view exposes no mutable projection capability", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "simpledsh-session-view-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));

  const opened = await openJournal(
    workspace,
    SESSION_A,
    fixedClock,
    eventIds("4"),
  );
  type PublicReplayHasProjection = "projection" extends keyof typeof opened.replay
    ? true
    : false;
  const publicReplayHasProjection: PublicReplayHasProjection = false;
  assert.equal(publicReplayHasProjection, false);
  assert.ok(Object.isFrozen(opened.replay));
  assert.equal(Object.hasOwn(opened.replay, "projection"), false);
  assert.equal(
    (opened.replay as unknown as { projection?: unknown }).projection,
    undefined,
  );

  await opened.writer.append({
    type: "session_started",
    sessionId: SESSION_A,
    payload: {},
  });
  await opened.writer.close();

  const reopened = await openJournal(
    workspace,
    SESSION_A,
    fixedClock,
    eventIds("5"),
  );
  assert.equal(reopened.replay.events.length, 1);
  assert.equal(reopened.replay.events[0]?.type, "session_started");
  assert.equal(Object.hasOwn(reopened.replay, "projection"), false);
  await reopened.writer.close();
});
