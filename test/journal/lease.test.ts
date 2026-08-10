import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { JournalError } from "../../src/journal/errors.js";
import {
  acquireWriterLease,
  inspectWriterLease,
  quarantineWriterLease,
  releaseWriterLease,
} from "../../src/journal/lease.js";
import {
  bootstrapSession,
  createSessionPaths,
  type SessionPaths,
} from "../../src/journal/paths.js";
import type { CanonicalTimestamp } from "../../src/journal/types.js";

const SESSION_ID = "ses_0123456789abcdef0123456789abcdef";
const AT = "2026-08-04T00:00:00.000Z" as CanonicalTimestamp;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<{
  readonly root: string;
  readonly paths: SessionPaths;
}> {
  const root = await mkdtemp(join(tmpdir(), "simpledsh-lease-"));
  roots.push(root);
  return { root, paths: createSessionPaths(root, SESSION_ID) };
}

function hasCode(code: JournalError["code"]): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof JournalError && error.code === code;
}

async function assertMode(path: string, expected: number): Promise<void> {
  const stats = await lstat(path);
  assert.equal(stats.mode & 0o777, expected);
}

async function stoppedChildPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const pid = child.pid;
  assert.notEqual(pid, undefined);
  const exited = once(child, "exit");
  assert.equal(child.kill("SIGTERM"), true);
  await exited;
  return pid as number;
}

async function crashLeaseAt(
  root: string,
  point: "lease.after_mkdir" | "lease.after_owner_sync",
): Promise<void> {
  const worker = join(process.cwd(), "dist/test/journal/crash-worker.js");
  const child = spawn(process.execPath, [worker, root, SESSION_ID, point], {
    stdio: "ignore",
    env: { PATH: process.env["PATH"] ?? "" },
  });
  const [code, signal] = (await once(child, "exit")) as [
    number | null,
    NodeJS.Signals | null,
  ];
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
}

async function writeManualOwner(
  paths: SessionPaths,
  pid: number,
  acquiredAt = AT,
): Promise<void> {
  await mkdir(paths.writerLockDir, { mode: 0o700 });
  const line =
    `{"v":1,"pid":${pid},"nonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",` +
    `"acquiredAt":"${acquiredAt}"}\n`;
  const ownerPath = join(paths.writerLockDir, "owner.json");
  await writeFile(ownerPath, line, { encoding: "utf8", mode: 0o600 });
  await chmod(ownerPath, 0o600);
}

test("permission modes remain 0700 and 0600 while unsafe existing paths fail closed", async () => {
  const { paths } = await workspace();
  const faultPoints: string[] = [];
  await bootstrapSession(paths, {
    fault: (point) => {
      faultPoints.push(point);
    },
  });

  for (const path of [
    paths.dshDir,
    paths.sessionsDir,
    paths.sessionDir,
    join(paths.sessionDir, "blobs"),
    paths.blobsDir,
    join(paths.sessionDir, "snapshots"),
    paths.snapshotsDir,
    join(paths.sessionDir, "artifacts"),
    paths.artifactsDir,
    join(paths.sessionDir, "recovery"),
    paths.recoveryDir,
  ]) {
    await assertMode(path, 0o700);
  }
  await assertMode(paths.logPath, 0o600);
  assert.equal(
    faultPoints.filter(
      (point) =>
        point === "bootstrap.after_directory_sync_before_parent_sync",
    ).length,
    11,
  );
  assert.deepEqual(faultPoints.slice(-2), [
    "bootstrap.after_log_sync_before_session_sync",
    "bootstrap.after_session_sync",
  ]);

  await chmod(paths.logPath, 0o644);
  await assert.rejects(bootstrapSession(paths), hasCode("JOURNAL_UNSAFE_PATH"));

  const widened = await workspace();
  await mkdir(widened.paths.dshDir, { mode: 0o755 });
  await chmod(widened.paths.dshDir, 0o755);
  await assert.rejects(
    bootstrapSession(widened.paths),
    hasCode("JOURNAL_UNSAFE_PATH"),
  );

  const linked = await workspace();
  const linkTarget = join(linked.root, "link-target");
  await mkdir(linkTarget, { mode: 0o700 });
  await symlink(linkTarget, linked.paths.dshDir);
  await assert.rejects(
    bootstrapSession(linked.paths),
    hasCode("JOURNAL_UNSAFE_PATH"),
  );

  assert.throws(
    () => createSessionPaths(linked.root, "../not-a-session"),
    hasCode("JOURNAL_UNSAFE_PATH"),
  );

  for (const crashPoint of [
    "bootstrap.after_directory_sync_before_parent_sync",
    "bootstrap.after_log_sync_before_session_sync",
    "bootstrap.after_session_sync",
  ] as const) {
    const interrupted = await workspace();
    let injected = false;
    await assert.rejects(
      bootstrapSession(interrupted.paths, {
        fault: (point) => {
          if (!injected && point === crashPoint) {
            injected = true;
            throw new Error("injected bootstrap stop");
          }
        },
      }),
    );
    assert.equal(injected, true);
    await bootstrapSession(interrupted.paths);
    await assertMode(interrupted.paths.sessionDir, 0o700);
    await assertMode(interrupted.paths.logPath, 0o600);
  }
});

test("single writer rejects concurrent lease and nonce-safe close never removes another owner", async () => {
  const first = await workspace();
  await bootstrapSession(first.paths);
  const lease = await acquireWriterLease(first.paths, AT, {
    maxWriteBytes: 3,
  });
  const inspection = await inspectWriterLease(first.paths);
  assert.equal(inspection.state, "live");
  assert.equal(inspection.owner.pid, process.pid);
  assert.equal(inspection.owner.nonce, lease.owner.nonce);
  assert.match(lease.owner.nonce, /^[0-9a-f]{32}$/u);

  const ownerPath = join(first.paths.writerLockDir, "owner.json");
  const ownerLine = await readFile(ownerPath, "utf8");
  assert.equal(
    ownerLine,
    `{"v":1,"pid":${process.pid},"nonce":"${lease.owner.nonce}",` +
      `"acquiredAt":"${AT}"}\n`,
  );
  await assertMode(first.paths.writerLockDir, 0o700);
  await assertMode(ownerPath, 0o600);
  await assert.rejects(
    acquireWriterLease(first.paths, AT),
    hasCode("JOURNAL_LEASE_LIVE"),
  );

  const firstLog = await open(first.paths.logPath, "a");
  const releasedPath = await releaseWriterLease(lease, firstLog);
  assert.equal((await inspectWriterLease(first.paths)).state, "absent");
  assert.equal((await lstat(releasedPath)).isDirectory(), true);
  assert.equal(
    await readFile(join(releasedPath, "owner.json"), "utf8"),
    ownerLine,
  );

  const replaced = await workspace();
  await bootstrapSession(replaced.paths);
  const replacedLease = await acquireWriterLease(replaced.paths, AT);
  const replacedOwnerPath = join(replaced.paths.writerLockDir, "owner.json");
  const otherOwner =
    `{"v":1,"pid":${process.pid},` +
    `"nonce":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",` +
    `"acquiredAt":"${AT}"}\n`;
  await writeFile(replacedOwnerPath, otherOwner, { encoding: "utf8" });
  const replacedLog = await open(replaced.paths.logPath, "a");
  await assert.rejects(
    releaseWriterLease(replacedLease, replacedLog),
    hasCode("JOURNAL_LEASE_CHANGED"),
  );
  assert.equal((await lstat(replaced.paths.writerLockDir)).isDirectory(), true);
  assert.equal(await readFile(replacedOwnerPath, "utf8"), otherOwner);
});

test("writer lease inspection and explicit quarantine distinguish live stale and ambiguous owners", async () => {
  const stale = await workspace();
  await bootstrapSession(stale.paths);
  const deadPid = await stoppedChildPid();
  await writeManualOwner(stale.paths, deadPid);
  const staleInspection = await inspectWriterLease(stale.paths);
  assert.equal(staleInspection.state, "stale-proven-dead");
  await assert.rejects(
    acquireWriterLease(stale.paths, AT),
    hasCode("JOURNAL_LEASE_HELD"),
  );

  const changedOwner =
    `{"v":1,"pid":${deadPid},` +
    `"nonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",` +
    '"acquiredAt":"2026-08-04T00:00:01.000Z"}\n';
  await writeFile(join(stale.paths.writerLockDir, "owner.json"), changedOwner, {
    encoding: "utf8",
  });
  await assert.rejects(
    quarantineWriterLease(stale.paths, staleInspection, {
      confirmedNoConcurrentStart: true,
    }),
    hasCode("JOURNAL_LEASE_CHANGED"),
  );
  assert.equal((await lstat(stale.paths.writerLockDir)).isDirectory(), true);

  const freshStale = await inspectWriterLease(stale.paths);
  assert.equal(freshStale.state, "stale-proven-dead");
  const quarantined = await quarantineWriterLease(stale.paths, freshStale, {
    confirmedNoConcurrentStart: true,
  });
  assert.equal(quarantined.previousState, "stale-proven-dead");
  assert.equal((await lstat(quarantined.quarantinePath)).isDirectory(), true);
  assert.equal((await inspectWriterLease(stale.paths)).state, "absent");

  const ambiguous = await workspace();
  await bootstrapSession(ambiguous.paths);
  await mkdir(ambiguous.paths.writerLockDir, { mode: 0o700 });
  const ambiguousInspection = await inspectWriterLease(ambiguous.paths);
  assert.equal(ambiguousInspection.state, "ambiguous");
  assert.equal(ambiguousInspection.verifiable, true);
  await assert.rejects(
    quarantineWriterLease(ambiguous.paths, ambiguousInspection, {
      confirmedNoConcurrentStart: true,
    }),
    hasCode("JOURNAL_LEASE_AMBIGUOUS"),
  );
  const forced = await quarantineWriterLease(
    ambiguous.paths,
    ambiguousInspection,
    { confirmedNoConcurrentStart: true, forceAmbiguous: true },
  );
  assert.equal(forced.previousState, "ambiguous");
  assert.equal((await inspectWriterLease(ambiguous.paths)).state, "absent");

  const live = await workspace();
  await bootstrapSession(live.paths);
  await acquireWriterLease(live.paths, AT);
  const liveInspection = await inspectWriterLease(live.paths);
  assert.equal(liveInspection.state, "live");
  await assert.rejects(
    quarantineWriterLease(live.paths, liveInspection, {
      confirmedNoConcurrentStart: true,
      forceAmbiguous: true,
    }),
    hasCode("JOURNAL_LEASE_LIVE"),
  );
  assert.equal((await lstat(live.paths.writerLockDir)).isDirectory(), true);

  for (const [point, expectedState] of [
    ["lease.after_mkdir", "ambiguous"],
    ["lease.after_owner_sync", "stale-proven-dead"],
  ] as const) {
    const crashed = await workspace();
    await bootstrapSession(crashed.paths);
    await crashLeaseAt(crashed.root, point);
    const crashedInspection = await inspectWriterLease(crashed.paths);
    assert.equal(crashedInspection.state, expectedState, point);
    await quarantineWriterLease(
      crashed.paths,
      crashedInspection,
      expectedState === "ambiguous"
        ? { confirmedNoConcurrentStart: true, forceAmbiguous: true }
        : { confirmedNoConcurrentStart: true },
    );
    assert.equal((await inspectWriterLease(crashed.paths)).state, "absent");
  }
});
