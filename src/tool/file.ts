import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  link,
  lstat,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import {
  createToolOutputFrameParser,
  type ToolOutputFrameWriter,
} from "../artifact/tool-output.js";
import type {
  ArtifactDescriptor,
  ArtifactRef,
  ArtifactStore,
} from "../artifact/types.js";
import { utf8Bytes } from "../bytes/ops.js";
import type { FrozenBytes } from "../bytes/types.js";
import type {
  EditArguments,
  ReadArguments,
  WriteArguments,
} from "../bytes/tool-arguments.js";

const READ_CHUNK_BYTES = 32_768;
const WRITE_CHUNK_BYTES = 64 * 1024;
const ARTIFACT_REF = /^artifacts\/sha256\/[0-9a-f]{64}$/u;

export type FileObservationCode =
  | "invalid_arguments"
  | "io_error"
  | "edit_no_match"
  | "edit_not_unique";

export type FileObservationFailure =
  | Readonly<{
      readonly kind: "settled";
      readonly status: "invalid" | "failed";
      readonly code: Exclude<
        FileObservationCode,
        "edit_no_match" | "edit_not_unique"
      >;
    }>
  | Readonly<{
      readonly kind: "settled";
      readonly status: "failed";
      readonly code: "edit_no_match";
      readonly matchCount: 0;
    }>
  | Readonly<{
      readonly kind: "settled";
      readonly status: "failed";
      readonly code: "edit_not_unique";
      readonly matchCount: number;
    }>;

export interface FileMutationTerminal {
  readonly kind: "settled";
  readonly status: "succeeded" | "failed";
  readonly code: "ok" | "io_error" | "target_changed";
}

export interface FileMutationIndeterminate {
  readonly kind: "indeterminate";
  readonly reason: "filesystem_state_unknown";
}

export type FileMutationOutcome =
  | FileMutationTerminal
  | FileMutationIndeterminate;

export interface BoundReadArtifact {
  readonly artifactId: string;
  readonly descriptor: ArtifactDescriptor;
  readonly store: ArtifactStore;
}

export interface ActiveArtifactBindings {
  get(ref: ArtifactRef): BoundReadArtifact | undefined;
}

export interface FileToolBoundary {
  readonly cwd: string;
  readonly storageRoot: string;
  readonly canonicalEnvPath: string;
  readonly umask: number;
  readonly artifacts?: ActiveArtifactBindings;
}

export type ResolvedFileSubject =
  | Readonly<{
      readonly kind: "artifact";
      readonly input: string;
      readonly binding: BoundReadArtifact;
      readonly directDecision: "allow";
    }>
  | Readonly<{
      readonly kind: "path";
      readonly input: string;
      readonly lexicalPath: string;
      readonly directDecision: "allow" | "deny";
    }>;

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly nlink: 1;
  readonly size: number;
  readonly mode: number;
  readonly hash: string;
}

interface PathGuard {
  readonly kind: "path";
  readonly lexicalPath: string;
  readonly canonicalParent: string;
  readonly canonicalTarget: string;
  readonly existing: FileIdentity | null;
}

export type PreparedFileMutation = Readonly<{
  readonly tool: "write" | "edit";
  readonly guard: PathGuard;
  readonly newFileMode: number;
  readonly replacement:
    | Readonly<{ readonly kind: "write"; readonly bytes: FrozenBytes }>
    | Readonly<{
        readonly kind: "edit";
        readonly oldBytes: FrozenBytes;
        readonly newBytes: FrozenBytes;
      }>;
}>;

export type FileMutationFaultPoint =
  | "after_temp_create"
  | "after_temp_write"
  | "after_temp_sync"
  | "before_target_recheck"
  | "before_publish"
  | "after_publish"
  | "after_parent_sync";

export interface FileMutationControls {
  readonly reach?: (point: FileMutationFaultPoint) => void | Promise<void>;
  readonly tempNameHex?: () => string;
}

export class FileToolIntegrityError extends Error {
  constructor() {
    super("file Artifact integrity could not be proven");
    this.name = "FileToolIntegrityError";
  }
}

export class FileToolOutputError extends Error {
  constructor() {
    super("file output Artifact sink failed");
    this.name = "FileToolOutputError";
  }
}

function settled(
  status: FileObservationFailure["status"],
  code: Exclude<FileObservationCode, "edit_no_match" | "edit_not_unique">,
): FileObservationFailure {
  return Object.freeze({ kind: "settled", status, code });
}

function editMatchFailure(
  code: "edit_no_match" | "edit_not_unique",
  matchCount: number,
): FileObservationFailure {
  if (
    !Number.isSafeInteger(matchCount) ||
    (code === "edit_no_match" ? matchCount !== 0 : matchCount < 2)
  ) {
    throw new TypeError("edit match count is not canonical");
  }
  return code === "edit_no_match"
    ? Object.freeze({ kind: "settled", status: "failed", code, matchCount: 0 })
    : Object.freeze({ kind: "settled", status: "failed", code, matchCount });
}

function mutationSettled(
  status: FileMutationTerminal["status"],
  code: FileMutationTerminal["code"],
): FileMutationTerminal {
  return Object.freeze({ kind: "settled", status, code });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const value = error.code;
  return typeof value === "string" ? value : undefined;
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(child))
  );
}

function isProtected(boundary: FileToolBoundary, candidate: string): boolean {
  return (
    candidate === boundary.canonicalEnvPath ||
    isWithin(boundary.storageRoot, candidate)
  );
}

function asArtifactRef(value: string): ArtifactRef | undefined {
  return ARTIFACT_REF.test(value) ? (value as ArtifactRef) : undefined;
}

export function createFileToolBoundary(input: {
  readonly cwd: string;
  readonly storageRoot: string;
  readonly canonicalEnvPath: string;
  readonly umask?: number;
  readonly artifacts?: ActiveArtifactBindings;
}): FileToolBoundary {
  const umask = input.umask ?? process.umask();
  if (!Number.isSafeInteger(umask) || umask < 0 || umask > 0o777) {
    throw new TypeError("file boundary umask is invalid");
  }
  return Object.freeze({
    cwd: resolve(input.cwd),
    storageRoot: resolve(input.storageRoot),
    canonicalEnvPath: resolve(input.canonicalEnvPath),
    umask,
    ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
  });
}

export function resolveFileSubject(
  boundary: FileToolBoundary,
  tool: "read" | "write" | "edit",
  input: string,
): ResolvedFileSubject {
  const ref = tool === "read" ? asArtifactRef(input) : undefined;
  if (ref !== undefined) {
    const binding = boundary.artifacts?.get(ref);
    if (binding !== undefined && binding.descriptor.artifactRef === ref) {
      return Object.freeze({
        kind: "artifact",
        input,
        binding,
        directDecision: "allow",
      });
    }
  }
  const lexicalPath = resolve(boundary.cwd, input);
  return Object.freeze({
    kind: "path",
    input,
    lexicalPath,
    directDecision: isProtected(boundary, lexicalPath) ? "deny" : "allow",
  });
}

function identityFrom(stats: Stats, hash: string): FileIdentity {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    nlink: 1,
    size: stats.size,
    mode: stats.mode & 0o777,
    hash,
  });
}

function sameIdentity(stats: Stats, identity: FileIdentity): boolean {
  return (
    stats.isFile() &&
    !stats.isSymbolicLink() &&
    stats.dev === identity.dev &&
    stats.ino === identity.ino &&
    stats.nlink === 1 &&
    stats.size === identity.size &&
    (stats.mode & 0o777) === identity.mode
  );
}

async function hashHandle(
  handle: FileHandle,
  options?: Readonly<{
    readonly validateText?: boolean;
    readonly match?: FrozenBytes;
  }>,
): Promise<Readonly<{ readonly hash: string; readonly matches: number }>> {
  const digest = createHash("sha256");
  const decoder = options?.validateText === true
    ? new TextDecoder("utf-8", { fatal: true })
    : undefined;
  const needle = options?.match?.copy();
  const matcher = needle === undefined ? undefined : new NonOverlappingMatcher(needle);
  const buffer = new Uint8Array(READ_CHUNK_BYTES);
  let position = 0;
  while (true) {
    const read = await handle.read(buffer, 0, buffer.byteLength, position);
    if (read.bytesRead === 0) break;
    const chunk = buffer.subarray(0, read.bytesRead);
    digest.update(chunk);
    if (options?.validateText === true && chunk.includes(0)) {
      throw new InvalidTargetTextError();
    }
    if (decoder !== undefined) {
      try {
        decoder.decode(chunk, { stream: true });
      } catch {
        throw new InvalidTargetTextError();
      }
    }
    matcher?.push(chunk);
    position += read.bytesRead;
  }
  if (decoder !== undefined) {
    try {
      decoder.decode();
    } catch {
      throw new InvalidTargetTextError();
    }
  }
  return Object.freeze({
    hash: `sha256:${digest.digest("hex")}`,
    matches: matcher?.finish() ?? 0,
  });
}

class InvalidTargetTextError extends Error {}

class NonOverlappingMatcher {
  readonly #needle: Uint8Array;
  readonly #prefix: Uint32Array;
  #matched = 0;
  #count = 0;

  constructor(needle: Uint8Array) {
    if (needle.byteLength === 0) throw new TypeError("empty match is invalid");
    this.#needle = needle;
    this.#prefix = new Uint32Array(needle.byteLength);
    for (let index = 1, matched = 0; index < needle.byteLength; index += 1) {
      while (matched > 0 && needle[index] !== needle[matched]) {
        matched = this.#prefix[matched - 1] ?? 0;
      }
      if (needle[index] === needle[matched]) matched += 1;
      this.#prefix[index] = matched;
    }
  }

  push(chunk: Uint8Array): void {
    for (const byte of chunk) {
      while (this.#matched > 0 && byte !== this.#needle[this.#matched]) {
        this.#matched = this.#prefix[this.#matched - 1] ?? 0;
      }
      if (byte === this.#needle[this.#matched]) this.#matched += 1;
      if (this.#matched === this.#needle.byteLength) {
        if (this.#count === Number.MAX_SAFE_INTEGER) {
          throw new RangeError("edit match count exceeds the safe integer range");
        }
        this.#count += 1;
        // Reset rather than following the prefix link: matches are explicitly
        // left-to-right and non-overlapping.
        this.#matched = 0;
      }
    }
  }

  finish(): number {
    return this.#count;
  }
}

async function canonicalPathGuard(
  boundary: FileToolBoundary,
  lexicalPath: string,
): Promise<PathGuard | FileObservationFailure> {
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(dirname(lexicalPath));
  } catch (error) {
    return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR"
      ? settled("invalid", "invalid_arguments")
      : settled("failed", "io_error");
  }
  try {
    const parent = await lstat(canonicalParent);
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      return settled("invalid", "invalid_arguments");
    }
  } catch {
    return settled("failed", "io_error");
  }
  const canonicalTarget = join(canonicalParent, basename(lexicalPath));
  if (isProtected(boundary, canonicalTarget)) {
    return settled("invalid", "invalid_arguments");
  }
  return Object.freeze({
    kind: "path",
    lexicalPath,
    canonicalParent,
    canonicalTarget,
    existing: null,
  });
}

async function inspectExisting(
  guard: PathGuard,
  allowMissing: boolean,
  edit: EditArguments | undefined,
  hashContents = true,
): Promise<PathGuard | FileObservationFailure> {
  let before: Stats;
  try {
    before = await lstat(guard.canonicalTarget);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return allowMissing
        ? Object.freeze({ ...guard, existing: null })
        : settled("failed", "io_error");
    }
    return settled("failed", "io_error");
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    return settled("invalid", "invalid_arguments");
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      guard.canonicalTarget,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink !== 1 ||
      opened.size !== before.size ||
      (opened.mode & 0o777) !== (before.mode & 0o777)
    ) {
      return settled("failed", "io_error");
    }
    const hashed = hashContents
      ? await hashHandle(
          handle,
          edit === undefined
            ? undefined
            : { validateText: true, match: utf8Bytes(edit.oldString) },
        )
      : Object.freeze({ hash: "", matches: 0 });
    const after = await handle.stat();
    if (!sameIdentity(after, identityFrom(before, hashed.hash))) {
      return settled("failed", "io_error");
    }
    if (edit !== undefined) {
      if (hashed.matches === 0) {
        return editMatchFailure("edit_no_match", hashed.matches);
      }
      if (!edit.replaceAll && hashed.matches !== 1) {
        return editMatchFailure("edit_not_unique", hashed.matches);
      }
    }
    return Object.freeze({
      ...guard,
      existing: identityFrom(after, hashed.hash),
    });
  } catch (error) {
    return error instanceof InvalidTargetTextError
      ? settled("invalid", "invalid_arguments")
      : settled("failed", "io_error");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function preflightFileMutation(
  boundary: FileToolBoundary,
  subject: ResolvedFileSubject,
  argumentsValue: WriteArguments | EditArguments,
): Promise<PreparedFileMutation | FileObservationFailure> {
  if (subject.kind !== "path" || subject.directDecision !== "allow") {
    throw new TypeError("mutation preflight requires an allowed path subject");
  }
  const base = await canonicalPathGuard(boundary, subject.lexicalPath);
  if ("status" in base) return base;
  const isWrite = "content" in argumentsValue;
  const inspected = await inspectExisting(
    base,
    isWrite,
    isWrite ? undefined : argumentsValue,
  );
  if ("status" in inspected) return inspected;
  if (!isWrite && inspected.existing === null) {
    return settled("failed", "io_error");
  }
  return Object.freeze({
    tool: isWrite ? "write" : "edit",
    guard: inspected,
    newFileMode: 0o666 & ~boundary.umask,
    replacement: isWrite
      ? Object.freeze({ kind: "write", bytes: utf8Bytes(argumentsValue.content) })
      : Object.freeze({
          kind: "edit",
          oldBytes: utf8Bytes(argumentsValue.oldString),
          newBytes: utf8Bytes(argumentsValue.newString),
        }),
  });
}

class RecordSliceWriter {
  readonly #writer: ToolOutputFrameWriter;
  readonly #offset: number;
  readonly #end: number;
  #record = 0;
  #stopped = false;

  constructor(writer: ToolOutputFrameWriter, offset: number, limit: number) {
    this.#writer = writer;
    this.#offset = offset;
    this.#end = offset + limit;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  async push(chunk: Uint8Array): Promise<void> {
    if (this.#stopped || chunk.byteLength === 0) return;
    let cursor = 0;
    while (cursor < chunk.byteLength && !this.#stopped) {
      const lf = chunk.indexOf(0x0a, cursor);
      const end = lf === -1 ? chunk.byteLength : lf + 1;
      if (this.#record >= this.#offset && this.#record < this.#end) {
        let outcome;
        try {
          outcome = await this.#writer.write(
            "read",
            chunk.subarray(cursor, end),
          );
        } catch {
          throw new FileToolOutputError();
        }
        if (outcome.hardLimitReached) {
          this.#stopped = true;
          return;
        }
      }
      cursor = end;
      if (lf !== -1) {
        this.#record += 1;
        if (this.#record >= this.#end) this.#stopped = true;
      }
    }
  }
}

async function streamOrdinaryRead(
  boundary: FileToolBoundary,
  subject: Extract<ResolvedFileSubject, { readonly kind: "path" }>,
  argumentsValue: ReadArguments,
  writer: ToolOutputFrameWriter,
): Promise<FileObservationFailure | undefined> {
  const base = await canonicalPathGuard(boundary, subject.lexicalPath);
  if ("status" in base) return base;
  const inspected = await inspectExisting(base, false, undefined, false);
  if ("status" in inspected) return inspected;
  const expected = inspected.existing;
  if (expected === null) return settled("failed", "io_error");
  let handle: FileHandle | undefined;
  const slicer = new RecordSliceWriter(writer, argumentsValue.offset, argumentsValue.limit);
  try {
    handle = await open(
      inspected.canonicalTarget,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const opened = await handle.stat();
    if (!sameIdentity(opened, expected)) {
      return settled("failed", "io_error");
    }
    const buffer = new Uint8Array(READ_CHUNK_BYTES);
    let position = 0;
    while (!slicer.stopped) {
      const read = await handle.read(buffer, 0, buffer.byteLength, position);
      if (read.bytesRead === 0) break;
      await slicer.push(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    return undefined;
  } catch (error) {
    if (error instanceof FileToolOutputError) throw error;
    return settled("failed", "io_error");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function streamArtifactRead(
  binding: BoundReadArtifact,
  argumentsValue: ReadArguments,
  writer: ToolOutputFrameWriter,
): Promise<void> {
  try {
    const slicer = new RecordSliceWriter(writer, argumentsValue.offset, argumentsValue.limit);
    const framed = binding.descriptor.artifactType === "tool_output";
    const logicalChunks: Uint8Array[] = [];
    const parser = framed
      ? createToolOutputFrameParser({
          data(_stream, bytes) {
            logicalChunks.push(Uint8Array.from(bytes));
          },
        })
      : undefined;
    await binding.store.scanArtifact(binding.descriptor, async (bytes) => {
      if (parser === undefined) {
        if (!slicer.stopped) await slicer.push(bytes.copy());
      } else {
        logicalChunks.length = 0;
        parser.push(bytes);
        for (const chunk of logicalChunks) {
          if (slicer.stopped) break;
          await slicer.push(chunk);
        }
      }
    });
    if (parser !== undefined) {
      parser.finish();
    }
  } catch (error) {
    if (
      error instanceof FileToolIntegrityError ||
      error instanceof FileToolOutputError
    ) {
      throw error;
    }
    throw new FileToolIntegrityError();
  }
}

export async function executeReadFile(
  boundary: FileToolBoundary,
  subject: ResolvedFileSubject,
  argumentsValue: ReadArguments,
  writer: ToolOutputFrameWriter,
): Promise<FileObservationFailure | undefined> {
  if (subject.directDecision !== "allow") {
    throw new TypeError("read execution requires an allowed subject");
  }
  if (subject.kind === "artifact") {
    await streamArtifactRead(subject.binding, argumentsValue, writer);
    return undefined;
  }
  return streamOrdinaryRead(boundary, subject, argumentsValue, writer);
}

async function syncParent(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const stats = await handle.stat();
    if (!stats.isDirectory()) throw new TypeError("parent is not a directory");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validTempHex(value: string): boolean {
  return /^[0-9a-f]{32}$/u.test(value);
}

async function createTemp(
  parent: string,
  controls: FileMutationControls | undefined,
): Promise<Readonly<{ readonly path: string; readonly handle: FileHandle }>> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const hex = controls?.tempNameHex?.() ?? randomBytes(16).toString("hex");
    if (!validTempHex(hex)) throw new TypeError("temp name source is invalid");
    const path = join(parent, `.flashcoder-tmp-${hex}`);
    try {
      const handle = await open(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      return Object.freeze({ path, handle });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  throw new Error("cannot allocate a unique replacement file");
}

interface TempWriter {
  readonly write: (bytes: Uint8Array) => Promise<void>;
  readonly finish: () => Readonly<{ readonly size: number; readonly hash: string }>;
}

function tempWriter(handle: FileHandle): TempWriter {
  const digest = createHash("sha256");
  let size = 0;
  return Object.freeze({
    write: async (bytes: Uint8Array) => {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const length = Math.min(WRITE_CHUNK_BYTES, bytes.byteLength - offset);
        const result = await handle.write(bytes, offset, length);
        if (result.bytesWritten <= 0 || result.bytesWritten > length) {
          throw new Error("replacement write made no progress");
        }
        const written = bytes.subarray(offset, offset + result.bytesWritten);
        digest.update(written);
        size += result.bytesWritten;
        offset += result.bytesWritten;
      }
    },
    finish: () => Object.freeze({ size, hash: `sha256:${digest.digest("hex")}` }),
  });
}

async function streamReplacement(
  source: FileHandle,
  oldBytes: FrozenBytes,
  newBytes: FrozenBytes,
  output: TempWriter,
): Promise<Readonly<{
  readonly sourceHash: string;
  readonly sourceSize: number;
  readonly replacementHash: string;
  readonly replacementSize: number;
  readonly matches: number;
}>> {
  const needle = oldBytes.copy();
  const replacement = newBytes.copy();
  const digest = createHash("sha256");
  const buffer = new Uint8Array(READ_CHUNK_BYTES);
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let sourceSize = 0;
  let position = 0;
  let matches = 0;

  const process = async (
    data: Uint8Array<ArrayBufferLike>,
    final: boolean,
  ): Promise<Uint8Array<ArrayBufferLike>> => {
    let cursor = 0;
    const retain = final ? 0 : Math.min(needle.byteLength - 1, data.byteLength);
    const safeEnd = data.byteLength - retain;
    while (cursor < data.byteLength) {
      const index = Buffer.from(data).indexOf(Buffer.from(needle), cursor);
      if (index === -1 || (!final && index >= safeEnd)) break;
      await output.write(data.subarray(cursor, index));
      await output.write(replacement);
      matches += 1;
      cursor = index + needle.byteLength;
    }
    const emitEnd = final ? data.byteLength : Math.max(cursor, safeEnd);
    await output.write(data.subarray(cursor, emitEnd));
    return Uint8Array.from(data.subarray(emitEnd));
  };

  while (true) {
    const read = await source.read(buffer, 0, buffer.byteLength, position);
    if (read.bytesRead === 0) break;
    const chunk = buffer.subarray(0, read.bytesRead);
    digest.update(chunk);
    sourceSize += read.bytesRead;
    position += read.bytesRead;
    const combined = new Uint8Array(pending.byteLength + chunk.byteLength);
    combined.set(pending);
    combined.set(chunk, pending.byteLength);
    pending = await process(combined, false);
  }
  pending = await process(pending, true);
  if (pending.byteLength !== 0) throw new Error("edit replacement retained bytes");
  const replacementSummary = output.finish();
  return Object.freeze({
    sourceHash: `sha256:${digest.digest("hex")}`,
    sourceSize,
    replacementHash: replacementSummary.hash,
    replacementSize: replacementSummary.size,
    matches,
  });
}

async function recheckTarget(guard: PathGuard): Promise<"same" | "changed" | "unknown"> {
  if (guard.existing === null) {
    try {
      await lstat(guard.canonicalTarget);
      return "changed";
    } catch (error) {
      return errorCode(error) === "ENOENT" ? "same" : "unknown";
    }
  }
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(guard.canonicalTarget);
    if (!sameIdentity(before, guard.existing)) return "changed";
    handle = await open(
      guard.canonicalTarget,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const opened = await handle.stat();
    if (!sameIdentity(opened, guard.existing)) return "changed";
    const hashed = await hashHandle(handle);
    const after = await handle.stat();
    return sameIdentity(after, guard.existing) && hashed.hash === guard.existing.hash
      ? "same"
      : "changed";
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "changed" : "unknown";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function verifyTemp(
  path: string,
  expected: Readonly<{ readonly size: number; readonly hash: string }>,
  mode: number,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(path);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size !== expected.size ||
      (before.mode & 0o777) !== mode
    ) {
      throw new Error("replacement file identity is invalid");
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink !== 1 ||
      opened.size !== expected.size ||
      (opened.mode & 0o777) !== mode
    ) {
      throw new Error("replacement file identity changed");
    }
    const hashed = await hashHandle(handle);
    if (hashed.hash !== expected.hash) {
      throw new Error("replacement file hash changed");
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function cleanBeforePublication(
  guard: PathGuard,
  tempPath: string | undefined,
  expected: "same" | "changed",
): Promise<boolean> {
  const state = await recheckTarget(guard);
  if (state !== expected) return false;
  try {
    if (tempPath !== undefined) await unlink(tempPath);
    await syncParent(guard.canonicalParent);
    return true;
  } catch {
    return false;
  }
}

class TargetChangedError extends Error {}

export async function executePreparedFileMutation(
  plan: PreparedFileMutation,
  controls?: FileMutationControls,
): Promise<FileMutationOutcome> {
  let tempPath: string | undefined;
  let tempHandle: FileHandle | undefined;
  let published = false;
  let failure: unknown;
  try {
    const created = await createTemp(plan.guard.canonicalParent, controls);
    tempPath = created.path;
    tempHandle = created.handle;
    await controls?.reach?.("after_temp_create");
    const output = tempWriter(tempHandle);
    let replacementSummary: Readonly<{ readonly size: number; readonly hash: string }>;
    if (plan.replacement.kind === "write") {
      await output.write(plan.replacement.bytes.copy());
      replacementSummary = output.finish();
    } else {
      const expected = plan.guard.existing;
      if (expected === null) throw new TargetChangedError();
      let source: FileHandle | undefined;
      try {
        source = await open(
          plan.guard.canonicalTarget,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        const opened = await source.stat();
        if (!sameIdentity(opened, expected)) throw new TargetChangedError();
        const streamed = await streamReplacement(
          source,
          plan.replacement.oldBytes,
          plan.replacement.newBytes,
          output,
        );
        if (
          streamed.sourceHash !== expected.hash ||
          streamed.sourceSize !== expected.size
        ) {
          throw new TargetChangedError();
        }
        replacementSummary = Object.freeze({
          size: streamed.replacementSize,
          hash: streamed.replacementHash,
        });
      } finally {
        await source?.close().catch(() => undefined);
      }
    }
    await controls?.reach?.("after_temp_write");
    const desiredMode = plan.guard.existing?.mode ?? plan.newFileMode;
    await tempHandle.chmod(desiredMode);
    await tempHandle.sync();
    const tempStats = await tempHandle.stat();
    if (
      !tempStats.isFile() ||
      tempStats.nlink !== 1 ||
      tempStats.size !== replacementSummary.size
    ) {
      throw new Error("replacement file identity is invalid");
    }
    await controls?.reach?.("after_temp_sync");
    await tempHandle.close();
    tempHandle = undefined;
    await verifyTemp(tempPath, replacementSummary, desiredMode);
    await controls?.reach?.("before_target_recheck");
    const targetState = await recheckTarget(plan.guard);
    if (targetState === "changed") throw new TargetChangedError();
    if (targetState === "unknown") throw new Error("target identity is unknown");
    await controls?.reach?.("before_publish");
    if (plan.guard.existing === null) {
      await link(tempPath, plan.guard.canonicalTarget);
      published = true;
      await unlink(tempPath);
      tempPath = undefined;
    } else {
      await rename(tempPath, plan.guard.canonicalTarget);
      published = true;
      tempPath = undefined;
    }
    await controls?.reach?.("after_publish");
    await syncParent(plan.guard.canonicalParent);
    await controls?.reach?.("after_parent_sync");
    return mutationSettled("succeeded", "ok");
  } catch (error) {
    failure = error;
  } finally {
    await tempHandle?.close().catch(() => undefined);
  }

  if (published) {
    return Object.freeze({ kind: "indeterminate", reason: "filesystem_state_unknown" });
  }
  const targetChanged = failure instanceof TargetChangedError;
  const cleaned = await cleanBeforePublication(
    plan.guard,
    tempPath,
    targetChanged ? "changed" : "same",
  );
  if (!cleaned) {
    return Object.freeze({ kind: "indeterminate", reason: "filesystem_state_unknown" });
  }
  return targetChanged
    ? mutationSettled("failed", "target_changed")
    : mutationSettled("failed", "io_error");
}
