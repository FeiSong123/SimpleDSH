import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createArtifactStore } from "../../src/artifact/store.js";
import {
  createToolOutputFrameParser,
  createToolOutputFrameWriter,
  encodeToolOutputData,
  TOOL_OUTPUT_MEDIA_TYPE,
  type ToolOutputFrameSummary,
  type ToolOutputFrameWriter,
  type ToolOutputStream,
} from "../../src/artifact/tool-output.js";
import type {
  ArtifactChunkVisitor,
  ArtifactDescriptor,
  ArtifactMetadata,
  ArtifactRangeOptions,
  ArtifactRef,
  ArtifactStore,
  Sha256,
} from "../../src/artifact/types.js";
import { concatBytes, utf8Bytes } from "../../src/bytes/ops.js";
import { asToolCallId } from "../../src/bytes/tool-call-id.js";
import { freezeBytes, type FrozenBytes } from "../../src/bytes/types.js";
import {
  createFileToolBoundary,
  executePreparedFileMutation,
  executeReadFile,
  FileToolIntegrityError,
  preflightFileMutation,
  resolveFileSubject,
  type ActiveArtifactBindings,
  type FileMutationFaultPoint,
  type FileToolBoundary,
  type PreparedFileMutation,
} from "../../src/tool/file.js";
import type {
  EditArguments,
  ReadArguments,
  WriteArguments,
} from "../../src/bytes/tool-arguments.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TOOL_CALL_ID = asToolCallId("call-file-effects");

interface FileFixture {
  readonly root: string;
  readonly cwd: string;
  readonly storageRoot: string;
  readonly envPath: string;
  readonly boundary: FileToolBoundary;
}

interface CapturedOutput {
  readonly payload: Uint8Array;
  readonly streams: readonly ToolOutputStream[];
  readonly frameSummary: ToolOutputFrameSummary;
}

async function fileFixture(t: TestContext): Promise<FileFixture> {
  const root = await mkdtemp(join(tmpdir(), "simpledsh-file-"));
  const cwd = join(root, "workspace");
  const storageRoot = join(root, "session");
  const envPath = join(cwd, ".env");
  await mkdir(cwd, { mode: 0o700 });
  await mkdir(storageRoot, { mode: 0o700 });
  await writeFile(envPath, "SECRET=fixture\n", { mode: 0o600 });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const canonicalCwd = await realpath(cwd);
  const canonicalStorageRoot = await realpath(storageRoot);
  const canonicalEnvPath = await realpath(envPath);
  const boundary = createFileToolBoundary({
    cwd: canonicalCwd,
    storageRoot: canonicalStorageRoot,
    canonicalEnvPath,
    umask: 0o027,
  });
  return Object.freeze({
    root,
    cwd: canonicalCwd,
    storageRoot: canonicalStorageRoot,
    envPath: canonicalEnvPath,
    boundary,
  });
}

function readArguments(path: string, offset = 0, limit = 200): ReadArguments {
  return Object.freeze({ path, offset, limit });
}

function writeArguments(path: string, content: string): WriteArguments {
  return Object.freeze({ path, content });
}

function editArguments(
  path: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): EditArguments {
  return Object.freeze({ path, oldString, newString, replaceAll });
}

function captureWriter(): Readonly<{
  writer: ToolOutputFrameWriter;
  finish(): Promise<CapturedOutput>;
}> {
  const frames: Uint8Array[] = [];
  const writer = createToolOutputFrameWriter({
    async write(bytes: Uint8Array | FrozenBytes) {
      frames.push(bytes instanceof Uint8Array ? Uint8Array.from(bytes) : bytes.copy());
    },
  });
  return Object.freeze({
    writer,
    async finish() {
      const frameSummary = await writer.finish();
      const payload: number[] = [];
      const streams: ToolOutputStream[] = [];
      const parser = createToolOutputFrameParser({
        data(stream, bytes) {
          streams.push(stream);
          payload.push(...bytes);
        },
      });
      parser.push(concatBytes(frames));
      assert.deepEqual(parser.finish(), frameSummary);
      return Object.freeze({
        payload: Uint8Array.from(payload),
        streams: Object.freeze(streams),
        frameSummary,
      });
    },
  });
}

async function capturePathRead(
  boundary: FileToolBoundary,
  path: string,
  offset = 0,
  limit = 200,
): Promise<Readonly<{
  failure: Awaited<ReturnType<typeof executeReadFile>>;
  output: CapturedOutput;
}>> {
  const subject = resolveFileSubject(boundary, "read", path);
  const capture = captureWriter();
  const failure = await executeReadFile(
    boundary,
    subject,
    readArguments(path, offset, limit),
    capture.writer,
  );
  return Object.freeze({ failure, output: await capture.finish() });
}

async function prepareWrite(
  boundary: FileToolBoundary,
  path: string,
  content: string,
): Promise<PreparedFileMutation> {
  const subject = resolveFileSubject(boundary, "write", path);
  const result = await preflightFileMutation(
    boundary,
    subject,
    writeArguments(path, content),
  );
  if (!("tool" in result)) assert.fail(`write preflight failed: ${result.code}`);
  return result;
}

async function prepareEdit(
  boundary: FileToolBoundary,
  path: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): Promise<PreparedFileMutation> {
  const subject = resolveFileSubject(boundary, "edit", path);
  const result = await preflightFileMutation(
    boundary,
    subject,
    editArguments(path, oldString, newString, replaceAll),
  );
  if (!("tool" in result)) assert.fail(`edit preflight failed: ${result.code}`);
  return result;
}

async function tempEntries(parent: string): Promise<string[]> {
  return (await readdir(parent)).filter((name) => name.startsWith(".dsh-tmp-"));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code !== "ENOENT"
    );
  }
}

function fakeToolOutputDescriptor(
  artifactRef: ArtifactRef,
  byteCount: number,
): ArtifactDescriptor {
  const hashHex = "f".repeat(64);
  return Object.freeze({
    artifactRef,
    artifactHash: `sha256:${hashHex}` as Sha256,
    byteCount,
    lineCount: null,
    mediaType: TOOL_OUTPUT_MEDIA_TYPE,
    artifactType: "tool_output",
    streamBytes: Object.freeze({ read: 0, stdout: 0, stderr: 0 }),
    hardLimitReached: false,
    descendantsReaped: null,
    toolCallId: TOOL_CALL_ID,
    terminal: Object.freeze({
      status: "succeeded",
      code: "ok",
      exitCode: null,
      signal: null,
      descendantsReaped: null,
    }),
  });
}

function memoryArtifactStore(bytes: Uint8Array): ArtifactStore {
  const snapshot = Uint8Array.from(bytes);
  return Object.freeze({
    async beginArtifact() {
      throw new Error("unused fake ArtifactStore operation");
    },
    async publishArtifact() {
      throw new Error("unused fake ArtifactStore operation");
    },
    async readArtifactRange() {
      throw new Error("Artifact-backed read must use one verified scan");
    },
    async scanArtifact(
      _descriptor: ArtifactDescriptor,
      visit: ArtifactChunkVisitor,
    ) {
      await visit(freezeBytes(snapshot));
    },
    async verifyArtifact() {},
  });
}

function observedArtifactStore(delegate: ArtifactStore): Readonly<{
  store: ArtifactStore;
  counts: { scans: number; ranges: number };
}> {
  const counts = { scans: 0, ranges: 0 };
  const store: ArtifactStore = Object.freeze({
    beginArtifact: () => delegate.beginArtifact(),
    publishArtifact: (
      bytes: Uint8Array | FrozenBytes,
      metadata: ArtifactMetadata,
    ) => delegate.publishArtifact(bytes, metadata),
    readArtifactRange: (ref: ArtifactRef, options: ArtifactRangeOptions) => {
      counts.ranges += 1;
      return delegate.readArtifactRange(ref, options);
    },
    scanArtifact: (
      descriptor: ArtifactDescriptor,
      visit: ArtifactChunkVisitor,
    ) => {
      counts.scans += 1;
      return delegate.scanArtifact(descriptor, visit);
    },
    verifyArtifact: (descriptor: ArtifactDescriptor) =>
      delegate.verifyArtifact(descriptor),
  });
  return Object.freeze({ store, counts });
}

test("file subjects deny protected paths directly and preserve component boundaries", async (t) => {
  const fixture = await fileFixture(t);
  const protectedInputs = [
    fixture.envPath,
    fixture.storageRoot,
    join(fixture.storageRoot, "artifact"),
  ];
  for (const tool of ["read", "write", "edit"] as const) {
    for (const path of protectedInputs) {
      const subject = resolveFileSubject(fixture.boundary, tool, path);
      assert.equal(subject.kind, "path");
      assert.equal(subject.directDecision, "deny");
    }
  }

  for (const path of [
    `${fixture.envPath}.backup`,
    join(`${fixture.storageRoot}-other`, "artifact"),
  ]) {
    const subject = resolveFileSubject(fixture.boundary, "read", path);
    assert.equal(subject.kind, "path");
    assert.equal(subject.directDecision, "allow");
  }

  const deniedRead = resolveFileSubject(fixture.boundary, "read", fixture.envPath);
  const capture = captureWriter();
  await assert.rejects(
    executeReadFile(
      fixture.boundary,
      deniedRead,
      readArguments(fixture.envPath),
      capture.writer,
    ),
    /requires an allowed subject/u,
  );
  const deniedWrite = resolveFileSubject(
    fixture.boundary,
    "write",
    fixture.storageRoot,
  );
  await assert.rejects(
    preflightFileMutation(
      fixture.boundary,
      deniedWrite,
      writeArguments(fixture.storageRoot, "blocked"),
    ),
    /requires an allowed path subject/u,
  );
});

test("only an exact active Artifact ref is a read handle", async (t) => {
  const fixture = await fileFixture(t);
  const ref = `artifacts/sha256/${"a".repeat(64)}` as ArtifactRef;
  const bytes = encodeToolOutputData("read", utf8Bytes("bound\n")).copy();
  const descriptor = fakeToolOutputDescriptor(ref, bytes.byteLength);
  const binding = Object.freeze({
    artifactId: `art_${"1".repeat(32)}`,
    descriptor,
    store: memoryArtifactStore(bytes),
  });
  const bindings: ActiveArtifactBindings = new Map([[ref, binding]]);
  const boundary = createFileToolBoundary({
    cwd: fixture.cwd,
    storageRoot: fixture.storageRoot,
    canonicalEnvPath: fixture.envPath,
    umask: 0o027,
    artifacts: bindings,
  });

  assert.equal(resolveFileSubject(boundary, "read", ref).kind, "artifact");
  assert.equal(resolveFileSubject(boundary, "read", `${ref}0`).kind, "path");
  assert.equal(
    resolveFileSubject(
      boundary,
      "read",
      `artifacts/sha256/${"b".repeat(64)}`,
    ).kind,
    "path",
  );
  assert.equal(resolveFileSubject(boundary, "write", ref).kind, "path");
  assert.equal(resolveFileSubject(boundary, "edit", ref).kind, "path");
});

test("path guards reject aliases and unsafe final components before file effects", async (t) => {
  const fixture = await fileFixture(t);

  const alias = join(fixture.cwd, "storage-alias");
  await symlink(fixture.storageRoot, alias);
  const aliasPath = join(alias, "new.txt");
  const aliasSubject = resolveFileSubject(fixture.boundary, "write", aliasPath);
  assert.equal(aliasSubject.directDecision, "allow");
  assert.deepEqual(
    await preflightFileMutation(
      fixture.boundary,
      aliasSubject,
      writeArguments(aliasPath, "blocked"),
    ),
    { kind: "settled", status: "invalid", code: "invalid_arguments" },
  );

  const ordinary = join(fixture.cwd, "ordinary.txt");
  await writeFile(ordinary, "ordinary");
  const finalSymlink = join(fixture.cwd, "final-symlink");
  await symlink(ordinary, finalSymlink);
  assert.deepEqual(
    await preflightFileMutation(
      fixture.boundary,
      resolveFileSubject(fixture.boundary, "write", finalSymlink),
      writeArguments(finalSymlink, "blocked"),
    ),
    { kind: "settled", status: "invalid", code: "invalid_arguments" },
  );

  const hardlink = join(fixture.cwd, "hardlink.txt");
  await link(ordinary, hardlink);
  assert.deepEqual(
    await preflightFileMutation(
      fixture.boundary,
      resolveFileSubject(fixture.boundary, "write", ordinary),
      writeArguments(ordinary, "blocked"),
    ),
    { kind: "settled", status: "invalid", code: "invalid_arguments" },
  );

  const directoryTarget = join(fixture.cwd, "directory-target");
  await mkdir(directoryTarget);
  assert.deepEqual(
    await preflightFileMutation(
      fixture.boundary,
      resolveFileSubject(fixture.boundary, "write", directoryTarget),
      writeArguments(directoryTarget, "blocked"),
    ),
    { kind: "settled", status: "invalid", code: "invalid_arguments" },
  );

  const missingParentTarget = join(fixture.cwd, "missing-parent", "file.txt");
  assert.deepEqual(
    await preflightFileMutation(
      fixture.boundary,
      resolveFileSubject(fixture.boundary, "write", missingParentTarget),
      writeArguments(missingParentTarget, "blocked"),
    ),
    { kind: "settled", status: "invalid", code: "invalid_arguments" },
  );

  const missingFinal = join(fixture.cwd, "missing-final.txt");
  assert.deepEqual((await capturePathRead(fixture.boundary, missingFinal)).failure, {
    kind: "settled",
    status: "failed",
    code: "io_error",
  });
  assert.deepEqual(
    await preflightFileMutation(
      fixture.boundary,
      resolveFileSubject(fixture.boundary, "edit", missingFinal),
      editArguments(missingFinal, "old", "new"),
    ),
    { kind: "settled", status: "failed", code: "io_error" },
  );
  const newWrite = await preflightFileMutation(
    fixture.boundary,
    resolveFileSubject(fixture.boundary, "write", missingFinal),
    writeArguments(missingFinal, "allowed"),
  );
  assert.equal("tool" in newWrite, true);
});

test("ordinary reads use zero-based LF records and preserve arbitrary bytes", async (t) => {
  const fixture = await fileFixture(t);
  const path = join(fixture.cwd, "records.bin");
  await writeFile(path, encoder.encode("a\n\nβ\nlast"));

  const middle = await capturePathRead(fixture.boundary, path, 1, 2);
  assert.equal(middle.failure, undefined);
  assert.equal(decoder.decode(middle.output.payload), "\nβ\n");
  assert.deepEqual(middle.output.streams, ["read", "read"]);

  const eof = await capturePathRead(fixture.boundary, path, 4, 1);
  assert.equal(eof.failure, undefined);
  assert.equal(eof.output.payload.byteLength, 0);
  assert.deepEqual(eof.output.streams, []);

  await writeFile(path, new Uint8Array());
  const empty = await capturePathRead(fixture.boundary, path, 0, 1);
  assert.equal(empty.failure, undefined);
  assert.equal(empty.output.payload.byteLength, 0);

  const binary = Uint8Array.of(0, 0xff, 0x0a, 0xc3, 0x28, 0x0a);
  await writeFile(path, binary);
  const binaryRead = await capturePathRead(fixture.boundary, path, 0, 2);
  assert.equal(binaryRead.failure, undefined);
  assert.deepEqual(binaryRead.output.payload, binary);

  const longFirstRecord = `${"x".repeat(33_000)}\nsecond\n`;
  await writeFile(path, longFirstRecord);
  const splitChunk = await capturePathRead(fixture.boundary, path, 1, 1);
  assert.equal(splitChunk.failure, undefined);
  assert.equal(decoder.decode(splitChunk.output.payload), "second\n");
});

test("Artifact handle reads fully validate framing and expose only logical payload", async (t) => {
  const fixture = await fileFixture(t);
  const store = await createArtifactStore(fixture.storageRoot);
  const first = utf8Bytes("skip\nke");
  const second = utf8Bytes("ep-1\n");
  const third = utf8Bytes("keep-2\ntrailing");
  const framed = concatBytes([
    encodeToolOutputData("stdout", first),
    encodeToolOutputData("stderr", second),
    encodeToolOutputData("read", third),
  ]);
  const descriptor = await store.publishArtifact(framed, {
    lineCount: null,
    mediaType: TOOL_OUTPUT_MEDIA_TYPE,
    artifactType: "tool_output",
    streamBytes: Object.freeze({
      read: third.byteLength,
      stdout: first.byteLength,
      stderr: second.byteLength,
    }),
    hardLimitReached: false,
    descendantsReaped: null,
    toolCallId: TOOL_CALL_ID,
    terminal: Object.freeze({
      status: "succeeded",
      code: "ok",
      exitCode: null,
      signal: null,
      descendantsReaped: null,
    }),
  });
  const access = observedArtifactStore(store);
  const binding = Object.freeze({
    artifactId: `art_${"2".repeat(32)}`,
    descriptor,
    store: access.store,
  });
  const boundary = createFileToolBoundary({
    cwd: fixture.cwd,
    storageRoot: fixture.storageRoot,
    canonicalEnvPath: fixture.envPath,
    umask: 0o027,
    artifacts: new Map([[descriptor.artifactRef, binding]]),
  });
  const subject = resolveFileSubject(boundary, "read", descriptor.artifactRef);
  assert.equal(subject.kind, "artifact");
  const capture = captureWriter();
  assert.equal(
    await executeReadFile(
      boundary,
      subject,
      readArguments(descriptor.artifactRef, 1, 2),
      capture.writer,
    ),
    undefined,
  );
  const output = await capture.finish();
  assert.equal(decoder.decode(output.payload), "keep-1\nkeep-2\n");
  assert.deepEqual(output.streams, ["read", "read", "read"]);
  assert.deepEqual(access.counts, { scans: 1, ranges: 0 });

  const malformed = concatBytes([
    encodeToolOutputData("read", utf8Bytes("selected\n")),
    Uint8Array.of(1, 0, 0),
  ]).copy();
  const malformedRef = `artifacts/sha256/${"c".repeat(64)}` as ArtifactRef;
  const malformedDescriptor = fakeToolOutputDescriptor(
    malformedRef,
    malformed.byteLength,
  );
  const malformedBoundary = createFileToolBoundary({
    cwd: fixture.cwd,
    storageRoot: fixture.storageRoot,
    canonicalEnvPath: fixture.envPath,
    umask: 0o027,
    artifacts: new Map([
      [
        malformedRef,
        Object.freeze({
          artifactId: `art_${"3".repeat(32)}`,
          descriptor: malformedDescriptor,
          store: memoryArtifactStore(malformed),
        }),
      ],
    ]),
  });
  const malformedCapture = captureWriter();
  await assert.rejects(
    executeReadFile(
      malformedBoundary,
      resolveFileSubject(malformedBoundary, "read", malformedRef),
      readArguments(malformedRef, 0, 1),
      malformedCapture.writer,
    ),
    FileToolIntegrityError,
  );
});

test("write and edit publish atomically with frozen modes and exact content", async (t) => {
  const fixture = await fileFixture(t);
  const created = join(fixture.cwd, "created.txt");
  const createPlan = await prepareWrite(fixture.boundary, created, "new\ncontent\n");
  assert.equal(createPlan.newFileMode, 0o640);
  assert.deepEqual(await executePreparedFileMutation(createPlan), {
    kind: "settled",
    status: "succeeded",
    code: "ok",
  });
  assert.equal(await readFile(created, "utf8"), "new\ncontent\n");
  assert.equal((await lstat(created)).mode & 0o777, 0o640);

  const existing = join(fixture.cwd, "existing.bin");
  await writeFile(existing, Uint8Array.of(0, 0xff, 1, 2));
  await chmod(existing, 0o604);
  const before = await lstat(existing);
  const overwrite = await prepareWrite(fixture.boundary, existing, "text replacement");
  assert.deepEqual(await executePreparedFileMutation(overwrite), {
    kind: "settled",
    status: "succeeded",
    code: "ok",
  });
  const after = await lstat(existing);
  assert.equal(await readFile(existing, "utf8"), "text replacement");
  assert.equal(after.mode & 0o777, 0o604);
  assert.notEqual(after.ino, before.ino);

  const unique = join(fixture.cwd, "unique.txt");
  await writeFile(unique, "left old right");
  const uniquePlan = await prepareEdit(
    fixture.boundary,
    unique,
    "old",
    "NEW",
  );
  assert.deepEqual(await executePreparedFileMutation(uniquePlan), {
    kind: "settled",
    status: "succeeded",
    code: "ok",
  });
  assert.equal(await readFile(unique, "utf8"), "left NEW right");

  const all = join(fixture.cwd, "all.txt");
  await writeFile(all, "aaaa");
  const allPlan = await prepareEdit(fixture.boundary, all, "aa", "X", true);
  assert.deepEqual(await executePreparedFileMutation(allPlan), {
    kind: "settled",
    status: "succeeded",
    code: "ok",
  });
  assert.equal(await readFile(all, "utf8"), "XX");
  assert.deepEqual(await tempEntries(fixture.cwd), []);
});

test("edit preflight reports no-match, non-unique, and invalid target text", async (t) => {
  const fixture = await fileFixture(t);
  const path = join(fixture.cwd, "edit.txt");
  await writeFile(path, "one two one");

  assert.deepEqual(
    await preflightFileMutation(
      fixture.boundary,
      resolveFileSubject(fixture.boundary, "edit", path),
      editArguments(path, "absent", "replacement"),
    ),
    {
      kind: "settled",
      status: "failed",
      code: "edit_no_match",
      matchCount: 0,
    },
  );
  assert.deepEqual(
    await preflightFileMutation(
      fixture.boundary,
      resolveFileSubject(fixture.boundary, "edit", path),
      editArguments(path, "one", "replacement"),
    ),
    {
      kind: "settled",
      status: "failed",
      code: "edit_not_unique",
      matchCount: 2,
    },
  );

  await writeFile(path, Uint8Array.of(0x61, 0, 0x62));
  assert.deepEqual(
    await preflightFileMutation(
      fixture.boundary,
      resolveFileSubject(fixture.boundary, "edit", path),
      editArguments(path, "a", "replacement", true),
    ),
    { kind: "settled", status: "invalid", code: "invalid_arguments" },
  );
  await writeFile(path, Uint8Array.of(0xff, 0xfe));
  assert.deepEqual(
    await preflightFileMutation(
      fixture.boundary,
      resolveFileSubject(fixture.boundary, "edit", path),
      editArguments(path, "a", "replacement", true),
    ),
    { kind: "settled", status: "invalid", code: "invalid_arguments" },
  );
});

test("mutations settle target_changed only when the changed state is provable", async (t) => {
  const fixture = await fileFixture(t);

  const missing = join(fixture.cwd, "new-race.txt");
  const missingPlan = await prepareWrite(fixture.boundary, missing, "ours");
  await writeFile(missing, "competitor");
  assert.deepEqual(await executePreparedFileMutation(missingPlan), {
    kind: "settled",
    status: "failed",
    code: "target_changed",
  });
  assert.equal(await readFile(missing, "utf8"), "competitor");

  const existing = join(fixture.cwd, "existing-race.txt");
  await writeFile(existing, "before");
  const existingPlan = await prepareWrite(fixture.boundary, existing, "ours");
  await writeFile(existing, "raced!");
  assert.deepEqual(await executePreparedFileMutation(existingPlan), {
    kind: "settled",
    status: "failed",
    code: "target_changed",
  });
  assert.equal(await readFile(existing, "utf8"), "raced!");
  assert.deepEqual(await tempEntries(fixture.cwd), []);
});

test("every mutation fault point maps to settled or indeterminate by publication", async (t) => {
  const cases: readonly Readonly<{
    point: FileMutationFaultPoint;
    published: boolean;
  }>[] = [
    { point: "after_temp_create", published: false },
    { point: "after_temp_write", published: false },
    { point: "after_temp_sync", published: false },
    { point: "before_target_recheck", published: false },
    { point: "before_publish", published: false },
    { point: "after_publish", published: true },
    { point: "after_parent_sync", published: true },
  ];
  for (const scenario of cases) {
    await t.test(scenario.point, async (child) => {
      const fixture = await fileFixture(child);
      const target = join(fixture.cwd, "target.txt");
      const plan = await prepareWrite(fixture.boundary, target, "published bytes");
      const outcome = await executePreparedFileMutation(plan, {
        reach(point) {
          if (point === scenario.point) throw new Error(`fault at ${point}`);
        },
      });
      assert.deepEqual(
        outcome,
        scenario.published
          ? { kind: "indeterminate", reason: "filesystem_state_unknown" }
          : { kind: "settled", status: "failed", code: "io_error" },
      );
      assert.equal(await pathExists(target), scenario.published);
      if (scenario.published) {
        assert.equal(await readFile(target, "utf8"), "published bytes");
      }
      assert.deepEqual(await tempEntries(fixture.cwd), []);
    });
  }
});

test("fault cleanup refuses false settlement and verifies temp bytes before publish", async (t) => {
  await t.test("changed target plus generic fault is indeterminate", async (child) => {
    const fixture = await fileFixture(child);
    const target = join(fixture.cwd, "ambiguous.txt");
    const plan = await prepareWrite(fixture.boundary, target, "ours");
    const outcome = await executePreparedFileMutation(plan, {
      async reach(point) {
        if (point === "before_target_recheck") {
          await writeFile(target, "competitor");
          throw new Error("fault after unclassified external change");
        }
      },
    });
    assert.deepEqual(outcome, {
      kind: "indeterminate",
      reason: "filesystem_state_unknown",
    });
    assert.equal(await readFile(target, "utf8"), "competitor");
    assert.equal((await tempEntries(fixture.cwd)).length, 1);
  });

  await t.test("same-size temp tampering fails before publication", async (child) => {
    const fixture = await fileFixture(child);
    const target = join(fixture.cwd, "verified-temp.txt");
    const plan = await prepareWrite(fixture.boundary, target, "good");
    const tempHex = "1".repeat(32);
    const outcome = await executePreparedFileMutation(plan, {
      tempNameHex: () => tempHex,
      async reach(point) {
        if (point === "after_temp_write") {
          await writeFile(join(fixture.cwd, `.dsh-tmp-${tempHex}`), "EVIL");
        }
      },
    });
    assert.deepEqual(outcome, {
      kind: "settled",
      status: "failed",
      code: "io_error",
    });
    assert.equal(await pathExists(target), false);
    assert.deepEqual(await tempEntries(fixture.cwd), []);
  });

  await t.test("a competing target at recheck settles target_changed", async (child) => {
    const fixture = await fileFixture(child);
    const target = join(fixture.cwd, "hook-race.txt");
    const plan = await prepareWrite(fixture.boundary, target, "ours");
    const outcome = await executePreparedFileMutation(plan, {
      async reach(point) {
        if (point === "before_target_recheck") {
          await writeFile(target, "competitor");
        }
      },
    });
    assert.deepEqual(outcome, {
      kind: "settled",
      status: "failed",
      code: "target_changed",
    });
    assert.equal(await readFile(target, "utf8"), "competitor");
    assert.deepEqual(await tempEntries(fixture.cwd), []);
  });
});
