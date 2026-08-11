import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createArtifactStore } from "../../src/artifact/store.js";
import { createBlobStore } from "../../src/blob/store.js";
import { createVerifiedJournalEvent } from "../../src/journal/schema.js";
import type {
  AnyJournalEventDraft,
  CanonicalTimestamp,
  EventId,
  SessionId,
} from "../../src/journal/types.js";

async function fixture(t: TestContext, name: string) {
  const workspace = await mkdtemp(join(tmpdir(), `flashcoder-${name}-`));
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  const sessionDir = join(
    workspace,
    ".flashcoder",
    "sessions",
    `ses_${"1".repeat(32)}`,
  );
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  await chmod(sessionDir, 0o700);
  return { workspace, sessionDir };
}

async function fileContents(root: string): Promise<readonly Uint8Array[]> {
  const contents: Uint8Array[] = [];
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) contents.push(await readFile(child));
    }
  };
  if ((await lstat(root)).isDirectory()) await visit(root);
  return contents;
}

test("credential secret env and Error objects are never captured implicitly", async (t) => {
  const { workspace, sessionDir } = await fixture(t, "credential");
  const sentinel = `stage03-secret-${Date.now()}-${Math.random()}`;
  const envKey = "SIMPLEDSH_STAGE03_SECRET_TEST";
  const previous = process.env[envKey];
  process.env[envKey] = sentinel;
  t.after(() => {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
  });
  await writeFile(join(workspace, ".env"), `DEEPSEEK_API_KEY=${sentinel}\n`, {
    mode: 0o600,
  });

  const artifacts = await createArtifactStore(sessionDir);
  const benign = new TextEncoder().encode("benign explicit evidence");
  await artifacts.publishArtifact(benign, {
    lineCount: 1,
    mediaType: "text/plain",
    artifactType: "fact",
    streamBytes: null,
    hardLimitReached: null,
    descendantsReaped: null,
    toolCallId: null,
    terminal: null,
  });

  const secretError = new Error(`outer ${sentinel}`, {
    cause: new Error(`cause ${sentinel}`),
  });
  await assert.rejects(
    artifacts.publishArtifact(
      secretError as unknown as Uint8Array,
      {
        lineCount: 0,
        mediaType: "text/plain",
        artifactType: "fact",
        streamBytes: null,
        hardLimitReached: null,
        descendantsReaped: null,
        toolCallId: null,
        terminal: null,
      },
    ),
    (error: unknown) => {
      assert.doesNotMatch(String(error), new RegExp(sentinel, "u"));
      return true;
    },
  );
  assert.throws(
    () =>
      createVerifiedJournalEvent(
        {
          type: "session_started",
          sessionId: `ses_${"1".repeat(32)}` as SessionId,
          payload: secretError,
        } as unknown as AnyJournalEventDraft,
        {
          seq: 1,
          id: `evt_${"2".repeat(32)}` as EventId,
          at: "2026-08-03T00:00:00.000Z" as CanonicalTimestamp,
          prevHash: null,
        },
      ),
    (error: unknown) => {
      assert.doesNotMatch(String(error), new RegExp(sentinel, "u"));
      return true;
    },
  );

  const encodedSentinel = Buffer.from(sentinel, "utf8");
  for (const bytes of await fileContents(join(workspace, ".flashcoder"))) {
    assert.equal(Buffer.from(bytes).includes(encodedSentinel), false);
  }
});

test("explicit opaque sentinel FrozenBytes roundtrips unchanged", async (t) => {
  const { sessionDir } = await fixture(t, "opaque");
  const sentinel = new TextEncoder().encode("explicit-secret-shaped-bytes\u0000🙂");
  const artifacts = await createArtifactStore(sessionDir);
  const descriptor = await artifacts.publishArtifact(sentinel, {
    lineCount: null,
    mediaType: "application/octet-stream",
    artifactType: "operator_evidence",
    streamBytes: null,
    hardLimitReached: null,
    descendantsReaped: null,
    toolCallId: null,
    terminal: null,
  });
  assert.deepEqual(
    (
      await artifacts.readArtifactRange(descriptor.artifactRef, {
        offset: 0,
        maxBytes: sentinel.byteLength,
      })
    ).bytes.copy(),
    sentinel,
  );

  const blobs = await createBlobStore(sessionDir);
  const payload = await blobs.publish("user", sentinel, {
    blobIndex: 0,
    previousChainHash: null,
  });
  assert.deepEqual(
    (
      await blobs.load(payload, {
        blobIndex: 0,
        previousChainHash: null,
      })
    ).copy(),
    sentinel,
  );
});
