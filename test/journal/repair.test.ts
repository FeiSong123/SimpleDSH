import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  appendFile,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { inspectWriterLease, quarantineWriterLease } from "../../src/journal/lease.js";
import { openJournal } from "../../src/journal/open.js";
import { createSessionPaths } from "../../src/journal/paths.js";
import type { PersistenceFaultPoint } from "../../src/journal/faults.js";
import type {
  CanonicalTimestamp,
  EventId,
  SessionId,
} from "../../src/journal/types.js";

const SID = `ses_${"1".repeat(32)}` as SessionId;

function clock(value = "2026-08-03T00:00:00.000Z") {
  return { now: () => value as CanonicalTimestamp };
}

function ids(hex: string) {
  let counter = 0;
  return {
    nextEventId: () => {
      counter += 1;
      return `evt_${counter.toString(16).padStart(1, hex).slice(-32).padStart(32, hex)}` as EventId;
    },
  };
}

async function preparedWorkspace(t: TestContext): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "simpledsh-repair-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  const opened = await openJournal(workspace, SID, clock(), ids("1"));
  await opened.writer.append({
    type: "session_started",
    sessionId: SID,
    payload: {},
  });
  await opened.writer.close();
  await appendFile(opened.paths.logPath, new TextEncoder().encode('{"torn":'));
  return workspace;
}

async function crashAt(
  workspace: string,
  point: PersistenceFaultPoint,
): Promise<void> {
  const worker = join(
    process.cwd(),
    "dist/test/journal/crash-worker.js",
  );
  const child = spawn(process.execPath, [worker, workspace, SID, point], {
    stdio: "ignore",
    env: { PATH: process.env["PATH"] ?? "" },
  });
  const [code, signal] = (await once(child, "exit")) as [
    number | null,
    NodeJS.Signals | null,
  ];
  assert.equal(code, null, point);
  assert.equal(signal, "SIGKILL", point);
}

test("atomic repair survives every indexed crash boundary with exactly one recovery fact", async (t) => {
  const points: readonly PersistenceFaultPoint[] = [
    "repair.after_recovery_publish",
    "repair.after_temp_prefix",
    "repair.after_temp_event",
    "repair.after_temp_sync",
    "repair.after_rename_before_dir_sync",
    "repair.after_dir_sync",
  ];
  for (const [index, point] of points.entries()) {
    await t.test(point, async (childTest) => {
      const workspace = await preparedWorkspace(childTest);
      await crashAt(workspace, point);
      const paths = createSessionPaths(workspace, SID);
      const stale = await inspectWriterLease(paths);
      assert.equal(stale.state, "stale-proven-dead");
      await quarantineWriterLease(paths, stale, {
        confirmedNoConcurrentStart: true,
      });

      const reopened = await openJournal(
        workspace,
        SID,
        clock(`2026-08-03T02:00:0${index}.000Z`),
        ids("b"),
      );
      const recoveryEvents = reopened.replay.events.filter(
        (event) => event.type === "journal_tail_recovered",
      );
      assert.equal(recoveryEvents.length, 1, point);
      assert.equal(reopened.replay.events.length, 2, point);
      assert.equal(reopened.replay.tornTail, null, point);
      await reopened.writer.close();

      const log = await readFile(paths.logPath);
      assert.equal(log[log.byteLength - 1], 0x0a, point);
      assert.equal(
        new TextDecoder().decode(log).split("journal_tail_recovered").length - 1,
        1,
        point,
      );
    });
  }
});

test("valid torn tail is repaired to the exact prefix plus one canonical fact", async (t) => {
  const workspace = await preparedWorkspace(t);
  const paths = createSessionPaths(workspace, SID);
  const before = await readFile(paths.logPath);
  const validPrefixByteCount = before.byteLength - '{"torn":'.length;
  const expectedPrefix = before.subarray(0, validPrefixByteCount);
  const opened = await openJournal(workspace, SID, clock(), ids("c"));
  assert.equal(opened.replay.events.length, 2);
  assert.equal(opened.replay.events[1]?.type, "journal_tail_recovered");
  await opened.writer.close();
  const repaired = await readFile(paths.logPath);
  assert.deepEqual(repaired.subarray(0, validPrefixByteCount), expectedPrefix);
  assert.equal(repaired[repaired.byteLength - 1], 0x0a);
});
