import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";

import { freezeBytes, FrozenBytes } from "../bytes/types.js";
import type { PersistenceTestControls } from "../journal/faults.js";
import {
  reachFaultPoint,
  writeChunkLimit,
} from "../journal/faults.js";
import { ArtifactStoreError } from "./errors.js";
import type {
  ArtifactRef,
  BlobRef,
  CasRef,
  RecoveryRef,
  Sha256,
  SnapshotRef,
} from "./types.js";

const directoryMode = 0o700;
const fileMode = 0o600;
const digestPattern = /^[0-9a-f]{64}$/u;
const ioBufferByteCount = 64 * 1024;
const casRangeLimit = 32_768;

type CasNamespace = "artifacts" | "blobs" | "snapshots" | "recovery";

interface NamespaceShape<Ref extends CasRef> {
  readonly directory: CasNamespace;
  readonly refPrefix: `${CasNamespace}/sha256/`;
  readonly castRef: (value: string) => Ref;
}

export interface CasPublication<Ref extends CasRef> {
  readonly ref: Ref;
  readonly hash: Sha256;
  readonly byteCount: number;
}

export interface CasRange {
  readonly bytes: FrozenBytes;
  readonly offset: number;
  readonly byteCount: number;
  readonly totalByteCount: number;
  readonly eof: boolean;
}

export interface VerifiedCasObject<Ref extends CasRef>
  extends CasPublication<Ref> {
  readonly lineCount: number;
}

export type VerifiedCasChunkVisitor = (
  bytes: Uint8Array,
) => void | Promise<void>;

export interface CasCandidate<Ref extends CasRef> {
  write(bytes: Uint8Array | FrozenBytes): Promise<void>;
  publish(): Promise<CasPublication<Ref>>;
  abort(): Promise<void>;
}

export interface FixedCas<Ref extends CasRef> {
  begin(): Promise<CasCandidate<Ref>>;
  publishBytes(bytes: Uint8Array | FrozenBytes): Promise<CasPublication<Ref>>;
  verifyObject(
    ref: Ref,
    expected?: Readonly<{ hash: Sha256; byteCount: number }>,
  ): Promise<VerifiedCasObject<Ref>>;
  scanVerifiedObject(
    ref: Ref,
    expected: Readonly<{ hash: Sha256; byteCount: number }>,
    visit: VerifiedCasChunkVisitor,
  ): Promise<VerifiedCasObject<Ref>>;
  readVerifiedRange(
    ref: Ref,
    options: Readonly<{ offset: number; maxBytes: number }>,
  ): Promise<CasRange>;
}

function storageError(
  code: "artifact_integrity" | "artifact_io" | "artifact_state",
  message: string,
): ArtifactStoreError {
  return new ArtifactStoreError(code, message);
}

function collisionError(): ArtifactStoreError {
  return new ArtifactStoreError(
    "cas_collision",
    "existing CAS target is not the same secure object",
  );
}

function errnoCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const candidate = error as NodeJS.ErrnoException;
  return typeof candidate.code === "string" ? candidate.code : undefined;
}

function copyExplicitBytes(bytes: Uint8Array | FrozenBytes): Uint8Array {
  if (bytes instanceof FrozenBytes) return bytes.copy();
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("CAS accepts only explicit bytes");
  }
  return Uint8Array.from(bytes);
}

function assertSafeByteCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw storageError("artifact_integrity", "CAS byte count is invalid");
  }
}

function assertMode(actual: number, expected: number, kind: string): void {
  if ((actual & 0o777) !== expected) {
    throw storageError(
      "artifact_integrity",
      `${kind} permissions violate the storage contract`,
    );
  }
}

async function openSecureDirectory(path: string): Promise<FileHandle> {
  let before;
  try {
    before = await lstat(path);
  } catch {
    throw storageError("artifact_io", "storage directory cannot be inspected");
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw storageError("artifact_integrity", "storage path is not a directory");
  }
  assertMode(before.mode, directoryMode, "storage directory");

  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    throw storageError("artifact_io", "storage directory cannot be opened");
  }
  try {
    const after = await handle.stat();
    if (!after.isDirectory()) {
      throw storageError("artifact_integrity", "opened storage path is not a directory");
    }
    assertMode(after.mode, directoryMode, "storage directory");
    if (after.dev !== before.dev || after.ino !== before.ino) {
      throw storageError("artifact_integrity", "storage directory changed during inspection");
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function ensureSecureChildDirectory(
  parentPath: string,
  childName: string,
  controls: PersistenceTestControls | undefined,
): Promise<string> {
  const childPath = join(parentPath, childName);
  let created = false;
  try {
    await mkdir(childPath, { mode: directoryMode });
    created = true;
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") {
      throw storageError("artifact_io", "CAS directory cannot be created");
    }
  }

  const child = await openSecureDirectory(childPath);
  try {
    try {
      await child.sync();
    } catch {
      throw storageError("artifact_io", "CAS directory cannot be synchronized");
    }
    if (created) {
      await reachFaultPoint(
        controls,
        "bootstrap.after_directory_sync_before_parent_sync",
      );
    }
    const parent = await openSecureDirectory(parentPath);
    try {
      try {
        await parent.sync();
      } catch {
        throw storageError("artifact_io", "CAS parent directory cannot be synchronized");
      }
    } finally {
      await parent.close().catch(() => undefined);
    }
  } finally {
    await child.close().catch(() => undefined);
  }
  return childPath;
}

async function prepareNamespace(
  sessionDir: string,
  namespace: CasNamespace,
  controls: PersistenceTestControls | undefined,
): Promise<string> {
  const session = await openSecureDirectory(sessionDir);
  await session.close().catch(() => undefined);
  const namespaceDir = await ensureSecureChildDirectory(
    sessionDir,
    namespace,
    controls,
  );
  return ensureSecureChildDirectory(namespaceDir, "sha256", controls);
}

function hashWire(hex: string): Sha256 {
  if (!digestPattern.test(hex)) {
    throw storageError("artifact_integrity", "CAS digest is invalid");
  }
  return `sha256:${hex}` as Sha256;
}

function refDigest<Ref extends CasRef>(
  ref: Ref,
  shape: NamespaceShape<Ref>,
): string {
  const value: string = ref;
  if (!value.startsWith(shape.refPrefix)) {
    throw storageError("artifact_integrity", "CAS reference uses the wrong namespace");
  }
  const digest = value.slice(shape.refPrefix.length);
  if (!digestPattern.test(digest) || basename(value) !== digest) {
    throw storageError("artifact_integrity", "CAS reference is not canonical");
  }
  return digest;
}

function refForDigest<Ref extends CasRef>(
  digest: string,
  shape: NamespaceShape<Ref>,
): Ref {
  if (!digestPattern.test(digest)) {
    throw storageError("artifact_integrity", "CAS digest is invalid");
  }
  return shape.castRef(`${shape.refPrefix}${digest}`);
}

async function openSecureFile(path: string): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw storageError("artifact_integrity", "CAS object cannot be opened safely");
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw storageError("artifact_integrity", "CAS object is not a regular file");
    }
    assertMode(stats.mode, fileMode, "CAS object");
    assertSafeByteCount(stats.size);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function readAtMost(
  handle: FileHandle,
  target: Uint8Array,
  byteCount: number,
  position: number,
): Promise<number> {
  let read = 0;
  while (read < byteCount) {
    let result;
    try {
      result = await handle.read(
        target,
        read,
        byteCount - read,
        position + read,
      );
    } catch {
      throw storageError("artifact_io", "CAS object cannot be read");
    }
    if (result.bytesRead === 0) break;
    read += result.bytesRead;
  }
  return read;
}

interface ScannedFile {
  readonly digest: string;
  readonly byteCount: number;
  readonly lineCount: number;
  readonly rangeBytes: FrozenBytes | undefined;
}

async function scanFile(
  handle: FileHandle,
  range: Readonly<{ offset: number; maxBytes: number }> | undefined,
  visit?: VerifiedCasChunkVisitor,
): Promise<ScannedFile> {
  const before = await handle.stat();
  if (!before.isFile()) {
    throw storageError("artifact_integrity", "CAS object is not a regular file");
  }
  assertMode(before.mode, fileMode, "CAS object");
  assertSafeByteCount(before.size);

  const hasher = createHash("sha256");
  const buffer = new Uint8Array(ioBufferByteCount);
  const rangeLength =
    range === undefined
      ? 0
      : Math.min(range.maxBytes, Math.max(0, before.size - range.offset));
  const rangeBuffer =
    range === undefined ? undefined : new Uint8Array(rangeLength);
  let rangeCopied = 0;
  let position = 0;
  let lfCount = 0;
  let lastByte: number | undefined;

  while (position < before.size) {
    const requested = Math.min(buffer.byteLength, before.size - position);
    const bytesRead = await readAtMost(handle, buffer, requested, position);
    if (bytesRead !== requested) {
      throw storageError("artifact_integrity", "CAS object changed while being read");
    }
    const chunk = buffer.subarray(0, bytesRead);
    hasher.update(chunk);
    for (const byte of chunk) {
      if (byte === 0x0a) lfCount += 1;
      lastByte = byte;
    }
    await visit?.(chunk);

    if (range !== undefined && rangeBuffer !== undefined && rangeCopied < rangeLength) {
      const chunkStart = position;
      const chunkEnd = position + bytesRead;
      const copyStart = Math.max(chunkStart, range.offset);
      const copyEnd = Math.min(chunkEnd, range.offset + rangeLength);
      if (copyEnd > copyStart) {
        rangeBuffer.set(
          chunk.subarray(copyStart - chunkStart, copyEnd - chunkStart),
          rangeCopied,
        );
        rangeCopied += copyEnd - copyStart;
      }
    }
    position += bytesRead;
  }

  const after = await handle.stat();
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  ) {
    throw storageError("artifact_integrity", "CAS object changed while being verified");
  }

  return Object.freeze({
    digest: hasher.digest("hex"),
    byteCount: before.size,
    lineCount:
      before.size === 0 ? 0 : lfCount + (lastByte === 0x0a ? 0 : 1),
    rangeBytes:
      rangeBuffer === undefined ? undefined : freezeBytes(rangeBuffer),
  });
}

async function compareFiles(
  expectedPath: string,
  actual: FileHandle,
  expectedByteCount: number,
  expectedDigest: string,
): Promise<void> {
  const expected = await openSecureFile(expectedPath);
  try {
    const expectedStats = await expected.stat();
    const actualStats = await actual.stat();
    if (
      expectedStats.size !== expectedByteCount ||
      actualStats.size !== expectedByteCount
    ) {
      throw storageError("artifact_integrity", "CAS collision has a different byte count");
    }

    const expectedBuffer = new Uint8Array(ioBufferByteCount);
    const actualBuffer = new Uint8Array(ioBufferByteCount);
    const actualHasher = createHash("sha256");
    let position = 0;
    while (position < expectedByteCount) {
      const requested = Math.min(
        ioBufferByteCount,
        expectedByteCount - position,
      );
      const [expectedRead, actualRead] = await Promise.all([
        readAtMost(expected, expectedBuffer, requested, position),
        readAtMost(actual, actualBuffer, requested, position),
      ]);
      if (expectedRead !== requested || actualRead !== requested) {
        throw storageError("artifact_integrity", "CAS collision changed during verification");
      }
      actualHasher.update(actualBuffer.subarray(0, actualRead));
      for (let index = 0; index < requested; index += 1) {
        if (expectedBuffer[index] !== actualBuffer[index]) {
          throw storageError("artifact_integrity", "CAS collision is not byte-identical");
        }
      }
      position += requested;
    }
    if (actualHasher.digest("hex") !== expectedDigest) {
      throw storageError("artifact_integrity", "CAS collision hash does not match its name");
    }
    try {
      await actual.sync();
    } catch {
      throw storageError("artifact_io", "existing CAS object cannot be synchronized");
    }
  } finally {
    await expected.close().catch(() => undefined);
  }
}

async function bestEffortUnlink(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

type CandidateState = "open" | "finalizing" | "published" | "aborted" | "poisoned";

class NamespaceCandidate<Ref extends CasRef> implements CasCandidate<Ref> {
  readonly #targetDir: string;
  readonly #tempPath: string;
  readonly #shape: NamespaceShape<Ref>;
  readonly #controls: PersistenceTestControls | undefined;
  readonly #hasher = createHash("sha256");
  #handle: FileHandle | undefined;
  #state: CandidateState = "open";
  #queue: Promise<void> = Promise.resolve();
  #failure: unknown;
  #byteCount = 0;

  constructor(
    targetDir: string,
    tempPath: string,
    handle: FileHandle,
    shape: NamespaceShape<Ref>,
    controls: PersistenceTestControls | undefined,
  ) {
    this.#targetDir = targetDir;
    this.#tempPath = tempPath;
    this.#handle = handle;
    this.#shape = shape;
    this.#controls = controls;
  }

  write(bytes: Uint8Array | FrozenBytes): Promise<void> {
    if (this.#state !== "open") {
      return Promise.reject(
        storageError("artifact_state", "CAS candidate is not writable"),
      );
    }
    const copy = copyExplicitBytes(bytes);
    const task = this.#queue.then(async () => {
      if (this.#failure !== undefined) throw this.#failure;
      const handle = this.#handle;
      if (handle === undefined) {
        throw storageError("artifact_state", "CAS candidate handle is closed");
      }
      let offset = 0;
      while (offset < copy.byteLength) {
        const requested = writeChunkLimit(
          this.#controls,
          copy.byteLength - offset,
        );
        let bytesWritten: number;
        try {
          ({ bytesWritten } = await handle.write(
            copy,
            offset,
            requested,
            this.#byteCount + offset,
          ));
        } catch {
          throw storageError("artifact_io", "CAS candidate write failed");
        }
        if (bytesWritten < 1 || bytesWritten > requested) {
          throw storageError("artifact_io", "CAS candidate write made no progress");
        }
        offset += bytesWritten;
      }
      this.#hasher.update(copy);
      this.#byteCount += copy.byteLength;
      assertSafeByteCount(this.#byteCount);
    });
    this.#queue = task.then(
      () => undefined,
      (error: unknown) => {
        this.#failure = error;
        this.#state = "poisoned";
      },
    );
    return task;
  }

  async publish(): Promise<CasPublication<Ref>> {
    if (this.#state === "poisoned") {
      const failure = this.#failure;
      await this.#closeAndClean();
      throw failure ?? storageError("artifact_state", "CAS candidate is poisoned");
    }
    if (this.#state !== "open") {
      throw storageError("artifact_state", "CAS candidate cannot be published");
    }
    this.#state = "finalizing";
    await this.#queue;
    if (this.#failure !== undefined) {
      await this.#closeAndClean();
      throw this.#failure;
    }

    const handle = this.#handle;
    if (handle === undefined) {
      throw storageError("artifact_state", "CAS candidate handle is closed");
    }
    const expectedDigest = this.#hasher.digest("hex");
    try {
      try {
        await handle.sync();
      } catch {
        throw storageError("artifact_io", "CAS candidate cannot be synchronized");
      }
      await reachFaultPoint(this.#controls, "cas.after_temp_sync");

      const scan = await scanFile(handle, undefined);
      if (
        scan.byteCount !== this.#byteCount ||
        scan.digest !== expectedDigest
      ) {
        throw storageError("artifact_integrity", "CAS candidate verification failed");
      }

      await handle.close();
      this.#handle = undefined;

      const targetPath = join(this.#targetDir, expectedDigest);
      let linked = false;
      try {
        await link(this.#tempPath, targetPath);
        linked = true;
      } catch (error) {
        if (errnoCode(error) !== "EEXIST") {
          throw storageError("artifact_io", "CAS no-clobber publication failed");
        }
      }

      if (linked) {
        await reachFaultPoint(
          this.#controls,
          "cas.after_link_before_dir_sync",
        );
      } else {
        try {
          const existing = await openSecureFile(targetPath);
          try {
            await compareFiles(
              this.#tempPath,
              existing,
              this.#byteCount,
              expectedDigest,
            );
          } finally {
            await existing.close().catch(() => undefined);
          }
        } catch (error) {
          if (
            error instanceof ArtifactStoreError &&
            error.code === "artifact_integrity"
          ) {
            throw collisionError();
          }
          throw error;
        }
      }

      const parent = await openSecureDirectory(this.#targetDir);
      try {
        try {
          await parent.sync();
        } catch {
          throw storageError("artifact_io", "CAS directory cannot be synchronized");
        }
      } finally {
        await parent.close().catch(() => undefined);
      }
      await reachFaultPoint(
        this.#controls,
        "cas.after_dir_sync_before_cleanup",
      );

      this.#state = "published";
      return Object.freeze({
        ref: refForDigest(expectedDigest, this.#shape),
        hash: hashWire(expectedDigest),
        byteCount: this.#byteCount,
      });
    } catch (error) {
      this.#state = "poisoned";
      throw error;
    } finally {
      if (this.#handle !== undefined) {
        await this.#handle.close().catch(() => undefined);
        this.#handle = undefined;
      }
      await bestEffortUnlink(this.#tempPath);
    }
  }

  async abort(): Promise<void> {
    if (this.#state === "published" || this.#state === "finalizing") {
      throw storageError("artifact_state", "CAS candidate cannot be aborted");
    }
    if (this.#state === "aborted") return;
    this.#state = "aborted";
    await this.#queue;
    await this.#closeAndClean();
  }

  async #closeAndClean(): Promise<void> {
    if (this.#handle !== undefined) {
      await this.#handle.close().catch(() => undefined);
      this.#handle = undefined;
    }
    await bestEffortUnlink(this.#tempPath);
  }
}

class NamespaceCas<Ref extends CasRef> implements FixedCas<Ref> {
  readonly #targetDir: string;
  readonly #shape: NamespaceShape<Ref>;
  readonly #controls: PersistenceTestControls | undefined;
  readonly #writable: boolean;

  constructor(
    targetDir: string,
    shape: NamespaceShape<Ref>,
    controls: PersistenceTestControls | undefined,
    writable = true,
  ) {
    this.#targetDir = targetDir;
    this.#shape = shape;
    this.#controls = controls;
    this.#writable = writable;
  }

  async begin(): Promise<CasCandidate<Ref>> {
    if (!this.#writable) {
      throw storageError("artifact_state", "read-only CAS cannot publish");
    }
    const suffix = randomBytes(16).toString("hex");
    const tempPath = join(this.#targetDir, `.tmp-${suffix}`);
    let handle: FileHandle;
    try {
      handle = await open(
        tempPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_RDWR |
          constants.O_NOFOLLOW,
        fileMode,
      );
    } catch {
      throw storageError("artifact_io", "CAS candidate cannot be created");
    }
    return new NamespaceCandidate(
      this.#targetDir,
      tempPath,
      handle,
      this.#shape,
      this.#controls,
    );
  }

  async publishBytes(
    bytes: Uint8Array | FrozenBytes,
  ): Promise<CasPublication<Ref>> {
    const candidate = await this.begin();
    try {
      await candidate.write(bytes);
      return await candidate.publish();
    } catch (error) {
      await candidate.abort().catch(() => undefined);
      throw error;
    }
  }

  async verifyObject(
    ref: Ref,
    expected?: Readonly<{ hash: Sha256; byteCount: number }>,
  ): Promise<VerifiedCasObject<Ref>> {
    const digest = refDigest(ref, this.#shape);
    if (expected !== undefined) {
      assertSafeByteCount(expected.byteCount);
      if (expected.hash !== hashWire(digest)) {
        throw storageError("artifact_integrity", "CAS descriptor hash does not match its ref");
      }
    }
    const targetPath = join(this.#targetDir, digest);
    const handle = await openSecureFile(targetPath);
    try {
      const scan = await scanFile(handle, undefined);
      if (
        scan.digest !== digest ||
        (expected !== undefined && scan.byteCount !== expected.byteCount)
      ) {
        throw storageError("artifact_integrity", "CAS object does not match its descriptor");
      }
      return Object.freeze({
        ref,
        hash: hashWire(digest),
        byteCount: scan.byteCount,
        lineCount: scan.lineCount,
      });
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async scanVerifiedObject(
    ref: Ref,
    expected: Readonly<{ hash: Sha256; byteCount: number }>,
    visit: VerifiedCasChunkVisitor,
  ): Promise<VerifiedCasObject<Ref>> {
    if (typeof visit !== "function") {
      throw new TypeError("CAS verified scan requires a chunk visitor");
    }
    const digest = refDigest(ref, this.#shape);
    assertSafeByteCount(expected.byteCount);
    if (expected.hash !== hashWire(digest)) {
      throw storageError("artifact_integrity", "CAS descriptor hash does not match its ref");
    }
    const targetPath = join(this.#targetDir, digest);
    const handle = await openSecureFile(targetPath);
    try {
      const scan = await scanFile(handle, undefined, visit);
      if (scan.digest !== digest || scan.byteCount !== expected.byteCount) {
        throw storageError("artifact_integrity", "CAS object does not match its descriptor");
      }
      return Object.freeze({
        ref,
        hash: hashWire(digest),
        byteCount: scan.byteCount,
        lineCount: scan.lineCount,
      });
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async readVerifiedRange(
    ref: Ref,
    options: Readonly<{ offset: number; maxBytes: number }>,
  ): Promise<CasRange> {
    const digest = refDigest(ref, this.#shape);
    if (
      !Number.isSafeInteger(options.offset) ||
      options.offset < 0 ||
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1 ||
      options.maxBytes > casRangeLimit
    ) {
      throw new ArtifactStoreError(
        "artifact_range",
        "CAS range requires a non-negative offset and maxBytes in 1..32768",
      );
    }
    const targetPath = join(this.#targetDir, digest);
    const handle = await openSecureFile(targetPath);
    try {
      const scan = await scanFile(handle, options);
      if (scan.digest !== digest || scan.rangeBytes === undefined) {
        throw storageError("artifact_integrity", "CAS object hash does not match its ref");
      }
      const returnedOffset = options.offset;
      const byteCount = scan.rangeBytes.byteLength;
      return Object.freeze({
        bytes: scan.rangeBytes,
        offset: returnedOffset,
        byteCount,
        totalByteCount: scan.byteCount,
        eof: returnedOffset + byteCount >= scan.byteCount,
      });
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}

async function createFixedCas<Ref extends CasRef>(
  sessionDir: string,
  shape: NamespaceShape<Ref>,
  controls: PersistenceTestControls | undefined,
): Promise<FixedCas<Ref>> {
  if (typeof sessionDir !== "string" || sessionDir.length === 0) {
    throw storageError("artifact_integrity", "Session directory is invalid");
  }
  const targetDir = await prepareNamespace(
    sessionDir,
    shape.directory,
    controls,
  );
  return new NamespaceCas(targetDir, shape, controls);
}

async function openExistingFixedCas<Ref extends CasRef>(
  sessionDir: string,
  shape: NamespaceShape<Ref>,
): Promise<FixedCas<Ref>> {
  const session = await openSecureDirectory(sessionDir);
  await session.close().catch(() => undefined);
  const namespaceDir = join(sessionDir, shape.directory);
  const namespace = await openSecureDirectory(namespaceDir);
  await namespace.close().catch(() => undefined);
  const targetDir = join(namespaceDir, "sha256");
  const target = await openSecureDirectory(targetDir);
  await target.close().catch(() => undefined);
  return new NamespaceCas(targetDir, shape, undefined, false);
}

const artifactShape: NamespaceShape<ArtifactRef> = Object.freeze({
  directory: "artifacts",
  refPrefix: "artifacts/sha256/",
  castRef: (value: string) => value as ArtifactRef,
});
const blobShape: NamespaceShape<BlobRef> = Object.freeze({
  directory: "blobs",
  refPrefix: "blobs/sha256/",
  castRef: (value: string) => value as BlobRef,
});
const snapshotShape: NamespaceShape<SnapshotRef> = Object.freeze({
  directory: "snapshots",
  refPrefix: "snapshots/sha256/",
  castRef: (value: string) => value as SnapshotRef,
});
const recoveryShape: NamespaceShape<RecoveryRef> = Object.freeze({
  directory: "recovery",
  refPrefix: "recovery/sha256/",
  castRef: (value: string) => value as RecoveryRef,
});

export function createArtifactCas(
  sessionDir: string,
  controls?: PersistenceTestControls,
): Promise<FixedCas<ArtifactRef>> {
  return createFixedCas(sessionDir, artifactShape, controls);
}

export function createBlobCas(
  sessionDir: string,
  controls?: PersistenceTestControls,
): Promise<FixedCas<BlobRef>> {
  return createFixedCas(sessionDir, blobShape, controls);
}

export function createSnapshotCas(
  sessionDir: string,
  controls?: PersistenceTestControls,
): Promise<FixedCas<SnapshotRef>> {
  return createFixedCas(sessionDir, snapshotShape, controls);
}

export function createRecoveryCas(
  sessionDir: string,
  controls?: PersistenceTestControls,
): Promise<FixedCas<RecoveryRef>> {
  return createFixedCas(sessionDir, recoveryShape, controls);
}

export function openArtifactCasReadOnly(
  sessionDir: string,
): Promise<FixedCas<ArtifactRef>> {
  return openExistingFixedCas(sessionDir, artifactShape);
}

export function openBlobCasReadOnly(
  sessionDir: string,
): Promise<FixedCas<BlobRef>> {
  return openExistingFixedCas(sessionDir, blobShape);
}

export function openSnapshotCasReadOnly(
  sessionDir: string,
): Promise<FixedCas<SnapshotRef>> {
  return openExistingFixedCas(sessionDir, snapshotShape);
}

export function openRecoveryCasReadOnly(
  sessionDir: string,
): Promise<FixedCas<RecoveryRef>> {
  return openExistingFixedCas(sessionDir, recoveryShape);
}
