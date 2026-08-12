import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { type TestContext } from "node:test";

import {
  openJournalReadOnly,
  type CanonicalTimestamp,
  type EventId,
  type EventIdentitySource,
  type SessionId,
} from "../../src/journal/index.js";
import {
  recoverSessionFixture,
  runSessionFixture,
  SessionKernelError,
} from "../../src/session/index.js";

const FIXED_AT = "2026-08-05T08:00:00.000Z" as CanonicalTimestamp;
const fixedClock = Object.freeze({ now: () => FIXED_AT });

interface TreeEntry {
  readonly path: string;
  readonly kind: "directory" | "file" | "symlink" | "other";
  readonly mode: number;
  readonly byteCount: number;
  readonly contentHash: string | null;
  readonly linkTarget: string | null;
}

function sessionId(sequence: number): SessionId {
  return `ses_${sequence.toString(16).padStart(32, "0")}` as SessionId;
}

function eventIds(sequence: number): EventIdentitySource {
  let counter = 0;
  const prefix = sequence.toString(16).padStart(16, "0");
  return Object.freeze({
    nextEventId: () => {
      counter += 1;
      const suffix = counter.toString(16).padStart(16, "0");
      return `evt_${prefix}${suffix}` as EventId;
    },
  });
}

async function workspace(t: TestContext, label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `flashcoder-partial-${label}-`));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function treeInventory(root: string): Promise<readonly TreeEntry[]> {
  const entries: TreeEntry[] = [];
  async function visit(parent: string): Promise<void> {
    const names = (await readdir(parent)).sort();
    for (const name of names) {
      const path = join(parent, name);
      const stats = await lstat(path);
      const common = {
        path: relative(root, path),
        mode: stats.mode & 0o777,
        byteCount: stats.size,
      } as const;
      if (stats.isDirectory()) {
        entries.push({
          ...common,
          kind: "directory",
          contentHash: null,
          linkTarget: null,
        });
        await visit(path);
      } else if (stats.isFile()) {
        entries.push({
          ...common,
          kind: "file",
          contentHash: sha256(await readFile(path)),
          linkTarget: null,
        });
      } else if (stats.isSymbolicLink()) {
        entries.push({
          ...common,
          kind: "symlink",
          contentHash: null,
          linkTarget: await readlink(path),
        });
      } else {
        entries.push({
          ...common,
          kind: "other",
          contentHash: null,
          linkTarget: null,
        });
      }
    }
  }
  await visit(root);
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

function isIncompleteBootstrap(error: unknown): boolean {
  assert.ok(error instanceof SessionKernelError);
  assert.equal(error.code, "incomplete_bootstrap");
  return true;
}

const PHYSICAL_BOOTSTRAP_SEAMS = Object.freeze([
  ...Array.from({ length: 11 }, (_, index) =>
    Object.freeze({
      label: `directory-${String(index + 1).padStart(2, "0")}`,
      point: "bootstrap.after_directory_sync_before_parent_sync" as const,
      occurrence: index + 1,
    }),
  ),
  Object.freeze({
    label: "log-synced-before-session-sync",
    point: "bootstrap.after_log_sync_before_session_sync" as const,
    occurrence: 1,
  }),
  Object.freeze({
    label: "session-synced-before-writer-open",
    point: "bootstrap.after_session_sync" as const,
    occurrence: 1,
  }),
]);

test("I02 physical bootstrap seams remain existing-only and byte-for-byte read only", async (t) => {
  let sequence = 1;
  for (const seam of PHYSICAL_BOOTSTRAP_SEAMS) {
    await t.test(seam.label, async (subtest) => {
      const current = sequence;
      sequence += 1;
      const root = await workspace(subtest, seam.label);
      const id = sessionId(current);
      let occurrences = 0;
      let injected = false;
      await assert.rejects(
        runSessionFixture({
          workspaceRoot: root,
          sessionId: id,
          userInput: "This input must never be inferred after partial bootstrap.",
          environmentFacts: {
            date: "2026-08-05",
            cwd: root,
            git: "branch: test\nstatus:\n",
          },
          turns: [],
          clock: fixedClock,
          eventIds: eventIds(current),
          persistenceControls: {
            fault: (point) => {
              if (point !== seam.point) return;
              occurrences += 1;
              if (occurrences === seam.occurrence) {
                injected = true;
                throw new Error(`physical bootstrap crash: ${seam.label}`);
              }
            },
          },
        }),
      );
      assert.equal(injected, true, "the named physical crash seam was reached");

      const before = await treeInventory(root);
      const writeSideEffects: string[] = [];
      let sends = 0;
      await assert.rejects(
        recoverSessionFixture({
          workspaceRoot: root,
          sessionId: id,
          turns: [],
          clock: fixedClock,
          eventIds: eventIds(current + 0x100),
          onBeforeSend: () => {
            sends += 1;
          },
          persistenceControls: {
            fault: (point) => {
              writeSideEffects.push(point);
            },
          },
        }),
        isIncompleteBootstrap,
      );
      assert.equal(sends, 0);
      assert.deepEqual(
        writeSideEffects,
        [],
        "incomplete physical bootstrap must be classified before bootstrap, lease, CAS, repair, or append",
      );
      assert.deepEqual(await treeInventory(root), before);
    });
  }
});

test("I02 durable identity prefixes before run_started invent no Run and remain read only", async (t) => {
  for (const targetAppend of [1, 2, 3, 4, 5] as const) {
    await t.test(`identity-append-${String(targetAppend)}`, async (subtest) => {
      const current = 0x200 + targetAppend;
      const root = await workspace(subtest, `identity-${String(targetAppend)}`);
      const id = sessionId(current);
      let appends = 0;
      let injected = false;
      await assert.rejects(
        runSessionFixture({
          workspaceRoot: root,
          sessionId: id,
          userInput: "Identity-prefix input must remain unknown.",
          turns: [],
          clock: fixedClock,
          eventIds: eventIds(current),
          persistenceControls: {
            fault: (point) => {
              if (point !== "append.after_sync_before_ack") return;
              appends += 1;
              if (appends === targetAppend) {
                injected = true;
                throw new Error(`identity crash ${String(targetAppend)}`);
              }
            },
          },
        }),
      );
      assert.equal(injected, true, "the named identity append was durable");

      const before = await treeInventory(root);
      const writeSideEffects: string[] = [];
      let sends = 0;
      await assert.rejects(
        recoverSessionFixture({
          workspaceRoot: root,
          sessionId: id,
          turns: [],
          clock: fixedClock,
          eventIds: eventIds(current + 0x100),
          onBeforeSend: () => {
            sends += 1;
          },
          persistenceControls: {
            fault: (point) => {
              writeSideEffects.push(point);
            },
          },
        }),
        isIncompleteBootstrap,
      );
      assert.equal(sends, 0);
      assert.deepEqual(
        writeSideEffects,
        [],
        "identity-only recovery must not acquire a writer lease or append",
      );
      assert.deepEqual(await treeInventory(root), before);
    });
  }
});

const I03_FORBIDDEN_EVENTS = new Set([
  "user_committed",
  "request_snapshot_stored",
  "request_attempt_started",
  "request_semantic_started",
  "request_interrupted",
  "assistant_committed",
  "cache_checkpoint_created",
  "commit_boundary_created",
  "permission_decided",
  "effect_prepared",
  "effect_completed",
  "effect_indeterminate",
  "effect_reconciled",
  "tool_result_committed",
  "run_completed",
]);

test("I03 run and source-fact prefixes interrupt the old Run once without materializing a task", async (t) => {
  for (const targetAppend of [6, 7, 8, 9, 10, 11, 12, 13, 14] as const) {
    await t.test(`source-prefix-append-${String(targetAppend)}`, async (subtest) => {
      const current = 0x300 + targetAppend;
      const root = await workspace(subtest, `source-${String(targetAppend)}`);
      const id = sessionId(current);
      let appends = 0;
      let injected = false;
      await assert.rejects(
        runSessionFixture({
          workspaceRoot: root,
          sessionId: id,
          userInput: "Never guess whether the optional fact set is complete.",
          environmentFacts: {
            date: "2026-08-05",
            cwd: root,
            git: "branch: test\nstatus:\n",
          },
          turns: [],
          clock: fixedClock,
          eventIds: eventIds(current),
          persistenceControls: {
            fault: (point) => {
              if (point !== "append.after_sync_before_ack") return;
              appends += 1;
              if (appends === targetAppend) {
                injected = true;
                throw new Error(`source-fact crash ${String(targetAppend)}`);
              }
            },
          },
        }),
      );
      assert.equal(injected, true, "the named source-fact append was durable");

      const before = await openJournalReadOnly(root, id);
      const beforeEvents = before.replay.events;
      const source = beforeEvents.at(-1);
      assert.ok(source);
      assert.equal(
        beforeEvents.filter((event) => event.type === "run_started").length,
        1,
      );
      assert.equal(
        beforeEvents.some((event) => event.type === "user_committed"),
        false,
      );
      const blobInventory = await treeInventory(before.paths.blobsDir);
      const snapshotInventory = await treeInventory(before.paths.snapshotsDir);
      let sends = 0;
      await assert.rejects(
        recoverSessionFixture({
          workspaceRoot: root,
          sessionId: id,
          turns: [],
          clock: fixedClock,
          eventIds: eventIds(current + 0x100),
          onBeforeSend: () => {
            sends += 1;
          },
        }),
      );
      assert.equal(sends, 0);

      const afterFirst = await openJournalReadOnly(root, id);
      assert.deepEqual(
        afterFirst.replay.events.slice(0, beforeEvents.length),
        beforeEvents,
        "recovery must preserve the authoritative partial prefix",
      );
      const appended = afterFirst.replay.events.slice(beforeEvents.length);
      assert.equal(appended.length, 1);
      const interruption = appended[0];
      assert.equal(interruption?.type, "run_interrupted");
      if (interruption?.type !== "run_interrupted") {
        assert.fail("I03 may append only run_interrupted");
      }
      assert.equal(interruption.payload.reason, "durability_failure");
      assert.equal(interruption.payload.sourceEventId, source.id);
      assert.equal(
        afterFirst.replay.events.filter(
          (event) => event.type === "run_started" && event.payload.cause === "recovery",
        ).length,
        0,
      );
      assert.equal(
        afterFirst.replay.events.some((event) =>
          I03_FORBIDDEN_EVENTS.has(event.type),
        ),
        false,
      );
      assert.deepEqual(await treeInventory(before.paths.blobsDir), blobInventory);
      assert.deepEqual(
        await treeInventory(before.paths.snapshotsDir),
        snapshotInventory,
      );

      const afterFirstLog = await readFile(afterFirst.paths.logPath);
      const appendSideEffects: string[] = [];
      await assert.rejects(
        recoverSessionFixture({
          workspaceRoot: root,
          sessionId: id,
          turns: [],
          clock: fixedClock,
          eventIds: eventIds(current + 0x200),
          onBeforeSend: () => {
            sends += 1;
          },
          persistenceControls: {
            fault: (point) => {
              if (
                point.startsWith("append.") ||
                point.startsWith("cas.") ||
                point.startsWith("repair.")
              ) {
                appendSideEffects.push(point);
              }
            },
          },
        }),
      );
      assert.equal(sends, 0);
      assert.deepEqual(appendSideEffects, []);
      assert.deepEqual(await readFile(afterFirst.paths.logPath), afterFirstLog);
      const afterSecond = await openJournalReadOnly(root, id);
      assert.equal(
        afterSecond.replay.events.filter(
          (event) =>
            event.type === "run_interrupted" &&
            event.payload.reason === "durability_failure",
        ).length,
        1,
      );
    });
  }
});
