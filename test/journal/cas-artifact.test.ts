import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  encodeToolOutputData,
  TOOL_OUTPUT_MEDIA_TYPE,
} from "../../src/artifact/tool-output.js";
import { freezeBytes } from "../../src/bytes/types.js";
import { asToolCallId } from "../../src/bytes/tool-call-id.js";
import { ArtifactStoreError } from "../../src/artifact/errors.js";
import * as fixedCasModule from "../../src/artifact/internal-cas.js";
import {
  createBlobCas,
  createRecoveryCas,
  createSnapshotCas,
} from "../../src/artifact/internal-cas.js";
import {
  artifactRangeLimit,
  createArtifactStore,
} from "../../src/artifact/store.js";
import type {
  ArtifactDescriptor,
  ArtifactMetadata,
  ArtifactRef,
  ArtifactStore,
} from "../../src/artifact/types.js";
import type { PersistenceFaultPoint } from "../../src/journal/faults.js";
import type { ArtifactRef as JournalArtifactRef } from "../../src/journal/types.js";

const encoder = new TextEncoder();
const TOOL_CALL_ID = asToolCallId("call-artifact-store");

async function sessionFixture(t: TestContext): Promise<string> {
  const sessionDir = await mkdtemp(join(tmpdir(), "simpledsh-artifact-"));
  await chmod(sessionDir, 0o700);
  t.after(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });
  return sessionDir;
}

function artifactPath(
  sessionDir: string,
  descriptor: ArtifactDescriptor,
): string {
  return join(sessionDir, descriptor.artifactRef);
}

function textMetadata(
  lineCount: number | null,
  artifactType: ArtifactMetadata["artifactType"] = "fact",
): ArtifactMetadata {
  return {
    lineCount,
    mediaType: "text/plain; charset=utf-8",
    artifactType,
    streamBytes: null,
    hardLimitReached: null,
    descendantsReaped: null,
    toolCallId: null,
    terminal: null,
  };
}

function toolOutputMetadata(
  streamBytes: NonNullable<ArtifactMetadata["streamBytes"]>,
): ArtifactMetadata {
  return {
    lineCount: null,
    mediaType: TOOL_OUTPUT_MEDIA_TYPE,
    artifactType: "tool_output",
    streamBytes,
    hardLimitReached: false,
    descendantsReaped: null,
    toolCallId: TOOL_CALL_ID,
    terminal: {
      status: "succeeded",
      code: "ok",
      exitCode: null,
      signal: null,
      descendantsReaped: null,
    },
  };
}

function digestHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isStoreError(
  error: unknown,
  code: ArtifactStoreError["code"],
): boolean {
  return error instanceof ArtifactStoreError && error.code === code;
}

async function collectArtifactBytes(
  store: ArtifactStore,
  descriptor: ArtifactDescriptor,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  await store.scanArtifact(descriptor, async (bytes) => {
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    chunks.push(bytes.copy());
  });
  return Uint8Array.from(Buffer.concat(chunks));
}

test("artifact CAS publication is no-clobber restart-safe and byte exact", async (t) => {
  const sessionDir = await sessionFixture(t);
  const observedFaults: PersistenceFaultPoint[] = [];
  const store = await createArtifactStore(sessionDir, {
    maxWriteBytes: 2,
    fault(point) {
      observedFaults.push(point);
    },
  });
  const sentinel = encoder.encode("credential-shaped=sk-explicit\n第二行");
  const descriptor = await store.publishArtifact(
    freezeBytes(sentinel),
    textMetadata(2),
  );

  assert.equal(Object.isFrozen(descriptor), true);
  assert.match(
    descriptor.artifactRef,
    /^artifacts\/sha256\/[0-9a-f]{64}$/u,
  );
  assert.equal(descriptor.artifactHash, `sha256:${digestHex(sentinel)}`);
  assert.equal(descriptor.byteCount, sentinel.byteLength);
  assert.deepEqual(
    (await store.readArtifactRange(descriptor.artifactRef, {
      offset: 0,
      maxBytes: artifactRangeLimit,
    })).bytes.copy(),
    sentinel,
  );
  assert.deepEqual(await collectArtifactBytes(store, descriptor), sentinel);
  await store.verifyArtifact(descriptor);

  const targetStats = await lstat(artifactPath(sessionDir, descriptor));
  assert.equal(targetStats.isFile(), true);
  assert.equal(targetStats.mode & 0o777, 0o600);
  for (const directory of ["artifacts", "artifacts/sha256"]) {
    const stats = await lstat(join(sessionDir, directory));
    assert.equal(stats.isDirectory(), true);
    assert.equal(stats.isSymbolicLink(), false);
    assert.equal(stats.mode & 0o777, 0o700);
  }
  assert.equal(
    observedFaults.filter(
      (point) => point === "bootstrap.after_directory_sync_before_parent_sync",
    ).length,
    2,
  );
  assert.equal(observedFaults.includes("cas.after_temp_sync"), true);
  assert.equal(observedFaults.includes("cas.after_link_before_dir_sync"), true);
  assert.equal(observedFaults.includes("cas.after_dir_sync_before_cleanup"), true);

  const reopened = await createArtifactStore(sessionDir, { maxWriteBytes: 1 });
  const duplicate = await reopened.publishArtifact(sentinel, textMetadata(2));
  assert.deepEqual(duplicate, descriptor);
  assert.deepEqual(
    await readdir(join(sessionDir, "artifacts", "sha256")),
    [digestHex(sentinel)],
  );
});

test("Artifact streaming sink serializes chunks and snapshots caller-owned bytes", async (t) => {
  const sessionDir = await sessionFixture(t);
  const store = await createArtifactStore(sessionDir, { maxWriteBytes: 1 });
  const sink = await store.beginArtifact();
  const first = encoder.encode("alpha\n");
  const second = encoder.encode("beta");
  const firstWrite = sink.write(first);
  first.fill(0);
  const secondWrite = sink.write(second);
  second.fill(0);
  await Promise.all([firstWrite, secondWrite]);
  const descriptor = await sink.publish(textMetadata(2));
  assert.deepEqual(
    (
      await store.readArtifactRange(descriptor.artifactRef, {
        offset: 0,
        maxBytes: 10,
      })
    ).bytes.copy(),
    encoder.encode("alpha\nbeta"),
  );
  await store.verifyArtifact(descriptor);
});

test("artifact CAS rejects non-identical collisions unsafe targets and mutations", async (t) => {
  const sessionDir = await sessionFixture(t);
  const store = await createArtifactStore(sessionDir);
  const candidate = encoder.encode("candidate");
  const candidateDigest = digestHex(candidate);
  const collisionPath = join(
    sessionDir,
    "artifacts",
    "sha256",
    candidateDigest,
  );
  await writeFile(collisionPath, encoder.encode("candidaXe"), {
    flag: "wx",
    mode: 0o600,
  });
  await assert.rejects(
    store.publishArtifact(candidate, textMetadata(1)),
    (error: unknown) => isStoreError(error, "cas_collision"),
  );

  await unlink(collisionPath);
  const descriptor = await store.publishArtifact(candidate, textMetadata(1));
  await writeFile(artifactPath(sessionDir, descriptor), encoder.encode("mutati0n"), {
    flag: "w",
    mode: 0o600,
  });
  await assert.rejects(
    store.verifyArtifact(descriptor),
    (error: unknown) => isStoreError(error, "artifact_integrity"),
  );
  await assert.rejects(
    store.scanArtifact(descriptor, () => undefined),
    (error: unknown) => isStoreError(error, "artifact_integrity"),
  );
  await assert.rejects(
    store.readArtifactRange(descriptor.artifactRef, { offset: 0, maxBytes: 1 }),
    (error: unknown) => isStoreError(error, "artifact_integrity"),
  );

  const symlinkBytes = encoder.encode("symlink target must not be reused");
  const symlinkDigest = digestHex(symlinkBytes);
  const symlinkTarget = join(sessionDir, "outside-object");
  const symlinkPath = join(
    sessionDir,
    "artifacts",
    "sha256",
    symlinkDigest,
  );
  await writeFile(symlinkTarget, symlinkBytes, { flag: "wx", mode: 0o600 });
  await symlink(symlinkTarget, symlinkPath);
  await assert.rejects(
    store.publishArtifact(symlinkBytes, textMetadata(1)),
    (error: unknown) => isStoreError(error, "cas_collision"),
  );
});

test("artifact ranges metadata and explicit versions preserve immutable history", async (t) => {
  const sessionDir = await sessionFixture(t);
  const store = await createArtifactStore(sessionDir);
  assert.equal("readAll" in store, false);
  assert.equal("readArtifactBytes" in store, false);

  const originalBytes = encoder.encode("abcdef\n");
  const editedBytes = encoder.encode("abcXYZ\n");
  const original = await store.publishArtifact(originalBytes, textMetadata(1));
  const edited = await store.publishArtifact(editedBytes, textMetadata(1));
  assert.notEqual(original.artifactRef, edited.artifactRef);

  const slice = await store.readArtifactRange(original.artifactRef, {
    offset: 2,
    maxBytes: 3,
  });
  assert.deepEqual(slice.bytes.copy(), encoder.encode("cde"));
  assert.deepEqual(
    {
      offset: slice.offset,
      byteCount: slice.byteCount,
      totalByteCount: slice.totalByteCount,
      eof: slice.eof,
    },
    { offset: 2, byteCount: 3, totalByteCount: 7, eof: false },
  );
  const pastEnd = await store.readArtifactRange(original.artifactRef, {
    offset: 100,
    maxBytes: 9,
  });
  assert.equal(pastEnd.offset, 100);
  assert.equal(pastEnd.byteCount, 0);
  assert.equal(pastEnd.totalByteCount, 7);
  assert.equal(pastEnd.eof, true);
  assert.deepEqual(pastEnd.bytes.copy(), new Uint8Array());

  assert.deepEqual(
    (
      await store.readArtifactRange(edited.artifactRef, {
        offset: 0,
        maxBytes: 7,
      })
    ).bytes.copy(),
    editedBytes,
  );
  assert.deepEqual(
    (
      await store.readArtifactRange(original.artifactRef, {
        offset: 0,
        maxBytes: 7,
      })
    ).bytes.copy(),
    originalBytes,
  );

  for (const options of [
    { offset: -1, maxBytes: 1 },
    { offset: 0.5, maxBytes: 1 },
    { offset: 0, maxBytes: 0 },
    { offset: 0, maxBytes: artifactRangeLimit + 1 },
    { offset: 0, maxBytes: 1, extra: true },
  ]) {
    await assert.rejects(
      store.readArtifactRange(
        original.artifactRef,
        options as { offset: number; maxBytes: number },
      ),
      (error: unknown) => isStoreError(error, "artifact_range"),
    );
  }

  await assert.rejects(
    store.publishArtifact(encoder.encode("one\ntwo"), textMetadata(1)),
    (error: unknown) => isStoreError(error, "artifact_closed_metadata"),
  );
  await assert.rejects(
    store.publishArtifact(encoder.encode("x"), {
      ...textMetadata(null),
      streamBytes: { read: 1, stdout: 0, stderr: 0 },
    }),
    (error: unknown) => isStoreError(error, "artifact_closed_metadata"),
  );
  await assert.rejects(
    store.publishArtifact(
      encoder.encode("xy"),
      toolOutputMetadata({ read: 2, stdout: 0, stderr: 0 }),
    ),
    (error: unknown) => isStoreError(error, "artifact_closed_metadata"),
  );
  const toolPayload = encoder.encode("xyz");
  const framedToolOutput = encodeToolOutputData("read", toolPayload);
  await assert.rejects(
    store.publishArtifact(
      framedToolOutput,
      toolOutputMetadata({ read: 2, stdout: 0, stderr: 0 }),
    ),
    (error: unknown) => isStoreError(error, "artifact_closed_metadata"),
  );
  const toolDescriptor = await store.publishArtifact(
    framedToolOutput,
    toolOutputMetadata({ read: toolPayload.byteLength, stdout: 0, stderr: 0 }),
  );
  assert.deepEqual(toolDescriptor.streamBytes, {
    read: toolPayload.byteLength,
    stdout: 0,
    stderr: 0,
  });
  assert.equal(toolDescriptor.byteCount, toolPayload.byteLength + 6);
  assert.equal(toolDescriptor.lineCount, null);
  assert.equal(toolDescriptor.mediaType, TOOL_OUTPUT_MEDIA_TYPE);
  assert.equal(toolDescriptor.toolCallId, TOOL_CALL_ID);
  assert.deepEqual(toolDescriptor.terminal, {
    status: "succeeded",
    code: "ok",
    exitCode: null,
    signal: null,
    descendantsReaped: null,
  });
  assert.equal(Object.isFrozen(toolDescriptor.streamBytes), true);
  assert.equal(Object.isFrozen(toolDescriptor.terminal), true);
  assert.deepEqual(
    (
      await store.readArtifactRange(toolDescriptor.artifactRef, {
        offset: 0,
        maxBytes: toolDescriptor.byteCount,
      })
    ).bytes.copy(),
    framedToolOutput.copy(),
  );
  await store.verifyArtifact(toolDescriptor);
  await assert.rejects(
    store.publishArtifact(
      new Error("must not traverse exception objects") as unknown as Uint8Array,
      textMetadata(null),
    ),
    TypeError,
  );
});

test("snapshot blob and recovery fixed CAS namespaces remain external and durable", async (t) => {
  const sessionDir = await sessionFixture(t);
  assert.deepEqual(Object.keys(fixedCasModule).sort(), [
    "createArtifactCas",
    "createBlobCas",
    "createRecoveryCas",
    "createSnapshotCas",
    "openArtifactCasReadOnly",
    "openBlobCasReadOnly",
    "openRecoveryCasReadOnly",
    "openSnapshotCasReadOnly",
  ]);

  const snapshot = await createSnapshotCas(sessionDir, { maxWriteBytes: 1 });
  const blob = await createBlobCas(sessionDir, { maxWriteBytes: 2 });
  const recovery = await createRecoveryCas(sessionDir);
  const snapshotBytes = encoder.encode("{}");
  const blobBytes = encoder.encode("small but externally forced by the fixed API");
  const recoveryBytes = encoder.encode("canonical recovery evidence");
  const snapshotObject = await snapshot.publishBytes(snapshotBytes);
  const blobObject = await blob.publishBytes(blobBytes);
  const recoveryObject = await recovery.publishBytes(recoveryBytes);

  assert.match(snapshotObject.ref, /^snapshots\/sha256\/[0-9a-f]{64}$/u);
  assert.match(blobObject.ref, /^blobs\/sha256\/[0-9a-f]{64}$/u);
  assert.match(recoveryObject.ref, /^recovery\/sha256\/[0-9a-f]{64}$/u);
  await snapshot.verifyObject(snapshotObject.ref, snapshotObject);
  await blob.verifyObject(blobObject.ref, blobObject);
  await recovery.verifyObject(recoveryObject.ref, recoveryObject);
  assert.deepEqual(
    (
      await snapshot.readVerifiedRange(snapshotObject.ref, {
        offset: 0,
        maxBytes: 2,
      })
    ).bytes.copy(),
    snapshotBytes,
  );

  for (const directory of ["snapshots", "blobs", "recovery"]) {
    const objectPath = join(sessionDir, directory, "sha256");
    const entries = await readdir(objectPath);
    assert.equal(entries.length, 1);
    assert.equal((await lstat(objectPath)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(objectPath, entries[0]!))).mode & 0o777, 0o600);
  }
});

test("artifact publication retries after every CAS acknowledgement fault boundary", async (t) => {
  for (const [index, faultPoint] of [
    "cas.after_temp_sync",
    "cas.after_link_before_dir_sync",
    "cas.after_dir_sync_before_cleanup",
  ].entries()) {
    const sessionDir = await sessionFixture(t);
    let armed = true;
    const store = await createArtifactStore(sessionDir, {
      maxWriteBytes: 1,
      fault(point) {
        if (armed && point === faultPoint) {
          armed = false;
          throw new Error("injected CAS stop");
        }
      },
    });
    const bytes = encoder.encode(`retry-${index}`);
    await assert.rejects(
      store.publishArtifact(bytes, textMetadata(1)),
      /injected CAS stop/u,
    );
    const descriptor = await store.publishArtifact(bytes, textMetadata(1));
    await store.verifyArtifact(descriptor);
    assert.deepEqual(
      await readdir(join(sessionDir, "artifacts", "sha256")),
      [digestHex(bytes)],
    );
  }
});

test("fresh Artifact namespace bootstrap resumes after the indexed directory fault", async (t) => {
  const sessionDir = await sessionFixture(t);
  let stopped = false;
  await assert.rejects(
    createArtifactStore(sessionDir, {
      fault(point) {
        if (
          !stopped &&
          point === "bootstrap.after_directory_sync_before_parent_sync"
        ) {
          stopped = true;
          throw new Error("injected bootstrap stop");
        }
      },
    }),
    /injected bootstrap stop/u,
  );
  const store = await createArtifactStore(sessionDir);
  const descriptor = await store.publishArtifact(
    encoder.encode("resumed"),
    textMetadata(1),
  );
  await store.verifyArtifact(descriptor);
});

test("Artifact reference types stay structurally compatible with Journal wire types", () => {
  const ref = "artifacts/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as ArtifactRef;
  const journalRef: JournalArtifactRef = ref;
  const roundTripRef: ArtifactRef = journalRef;
  assert.equal(
    roundTripRef,
    "artifacts/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
});
