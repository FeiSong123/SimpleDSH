import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
} from "node:fs/promises";
import { join } from "node:path";

import { journalError, JournalError } from "./errors.js";
import {
  reachFaultPoint,
  writeChunkLimit,
  type PersistenceTestControls,
} from "./faults.js";
import {
  assertSecureDirectory,
  JOURNAL_DIRECTORY_MODE,
  JOURNAL_FILE_MODE,
  syncDirectory,
  type SessionPaths,
} from "./paths.js";
import type { CanonicalTimestamp } from "./types.js";

const OWNER_FILE = "owner.json";
const NONCE = /^[0-9a-f]{32}$/u;
const TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const OWNER_LINE =
  /^\{"v":1,"pid":([1-9][0-9]*),"nonce":"([0-9a-f]{32})","acquiredAt":"([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z)"\}\n$/u;
const MAX_OWNER_BYTES = 512;

export interface WriterLeaseOwner {
  readonly v: 1;
  readonly pid: number;
  readonly nonce: string;
  readonly acquiredAt: CanonicalTimestamp;
}

interface LeaseInspectionBase {
  readonly fingerprint: string;
  readonly verifiable: boolean;
}

export interface AbsentLeaseInspection extends LeaseInspectionBase {
  readonly state: "absent";
  readonly verifiable: true;
}

export interface LiveLeaseInspection extends LeaseInspectionBase {
  readonly state: "live";
  readonly verifiable: true;
  readonly owner: WriterLeaseOwner;
}

export interface StaleLeaseInspection extends LeaseInspectionBase {
  readonly state: "stale-proven-dead";
  readonly verifiable: true;
  readonly owner: WriterLeaseOwner;
}

export interface AmbiguousLeaseInspection extends LeaseInspectionBase {
  readonly state: "ambiguous";
}

export type WriterLeaseInspection =
  | AbsentLeaseInspection
  | LiveLeaseInspection
  | StaleLeaseInspection
  | AmbiguousLeaseInspection;

export type PassiveWriterLeaseObservation =
  | Readonly<{
      readonly state: "absent";
      readonly fingerprint: "sha256:absent";
      readonly verifiable: true;
    }>
  | Readonly<{
      readonly state: "owner-observed";
      readonly fingerprint: string;
      readonly verifiable: true;
      readonly owner: WriterLeaseOwner;
    }>
  | Readonly<{
      readonly state: "ambiguous";
      readonly fingerprint: string;
      readonly verifiable: boolean;
    }>;

export interface WriterLeaseQuarantineConfirmation {
  readonly confirmedNoConcurrentStart: true;
  readonly forceAmbiguous?: true;
}

export interface QuarantinedWriterLease {
  readonly previousState: "stale-proven-dead" | "ambiguous";
  readonly inspectionFingerprint: string;
  readonly quarantinePath: string;
}

interface LeaseSnapshot {
  readonly fingerprint: string;
  readonly verifiable: boolean;
  readonly exactOwnerLayout: boolean;
  readonly ownerBytes?: Uint8Array;
}

export class WriterLease {
  readonly paths: SessionPaths;
  readonly owner: WriterLeaseOwner;
  readonly fingerprint: string;
  readonly #ownerBytes: Uint8Array;

  constructor(
    paths: SessionPaths,
    owner: WriterLeaseOwner,
    fingerprint: string,
    ownerBytes: Uint8Array,
  ) {
    this.paths = paths;
    this.owner = owner;
    this.fingerprint = fingerprint;
    this.#ownerBytes = Uint8Array.from(ownerBytes);
  }

  matchesOwnerBytes(bytes: Uint8Array | undefined): boolean {
    if (bytes === undefined || bytes.byteLength !== this.#ownerBytes.byteLength) {
      return false;
    }
    return this.#ownerBytes.every((byte, index) => byte === bytes[index]);
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function validTimestamp(value: string): value is CanonicalTimestamp {
  if (!TIMESTAMP.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function encodeOwner(owner: WriterLeaseOwner): Uint8Array {
  return Buffer.from(
    `{"v":1,"pid":${owner.pid},"nonce":"${owner.nonce}","acquiredAt":"${owner.acquiredAt}"}\n`,
    "utf8",
  );
}

function parseOwner(bytes: Uint8Array): WriterLeaseOwner | undefined {
  const text = Buffer.from(bytes).toString("utf8");
  const match = OWNER_LINE.exec(text);
  if (match === null) return undefined;
  const pidText = match[1];
  const nonce = match[2];
  const acquiredAt = match[3];
  if (pidText === undefined || nonce === undefined || acquiredAt === undefined) {
    return undefined;
  }
  const pid = Number(pidText);
  if (
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    !NONCE.test(nonce) ||
    !validTimestamp(acquiredAt)
  ) {
    return undefined;
  }
  return Object.freeze({ v: 1, pid, nonce, acquiredAt });
}

function addStat(hash: ReturnType<typeof createHash>, stats: BigIntStats): void {
  hash.update(stats.dev.toString());
  hash.update(":");
  hash.update(stats.ino.toString());
  hash.update(":");
  hash.update(stats.mode.toString());
  hash.update(":");
  hash.update(stats.size.toString());
  hash.update(":");
  hash.update(stats.mtimeNs.toString());
  hash.update(":");
  hash.update(stats.ctimeNs.toString());
  hash.update("\n");
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readOwner(
  ownerPath: string,
  before: BigIntStats,
): Promise<{ readonly bytes?: Uint8Array; readonly verifiable: boolean }> {
  if (
    before.isSymbolicLink() ||
    !before.isFile()
  ) {
    return { verifiable: true };
  }
  if (before.size > BigInt(MAX_OWNER_BYTES)) return { verifiable: false };

  let handle;
  try {
    handle = await open(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!sameStat(before, opened)) {
      await handle.close().catch(() => undefined);
      return { verifiable: false };
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameStat(opened, after)) {
      await handle.close().catch(() => undefined);
      return { verifiable: false };
    }
    try {
      await handle.close();
    } catch {
      return { verifiable: false };
    }
    return { bytes, verifiable: true };
  } catch {
    await handle?.close().catch(() => undefined);
    return { verifiable: false };
  }
}

async function snapshotLease(paths: SessionPaths): Promise<LeaseSnapshot | undefined> {
  let lockBefore;
  try {
    lockBefore = await lstat(paths.writerLockDir, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    return {
      fingerprint: "sha256:unreadable",
      verifiable: false,
      exactOwnerLayout: false,
    };
  }

  const hash = createHash("sha256");
  hash.update("writer-lock-v1\n");
  addStat(hash, lockBefore);

  if (lockBefore.isSymbolicLink() || !lockBefore.isDirectory()) {
    return {
      fingerprint: `sha256:${hash.digest("hex")}`,
      verifiable: true,
      exactOwnerLayout: false,
    };
  }

  let names: string[];
  try {
    names = (await readdir(paths.writerLockDir)).sort();
  } catch {
    return {
      fingerprint: `sha256:${hash.digest("hex")}`,
      verifiable: false,
      exactOwnerLayout: false,
    };
  }
  hash.update(`entries:${names.length}\n`);

  let ownerBytes: Uint8Array | undefined;
  let ownerStats: BigIntStats | undefined;
  let verifiable = true;
  for (const name of names) {
    hash.update(Buffer.from(name, "utf8"));
    hash.update("\n");
    let entryStats;
    try {
      entryStats = await lstat(join(paths.writerLockDir, name), {
        bigint: true,
      });
    } catch {
      verifiable = false;
      continue;
    }
    addStat(hash, entryStats);
    if (name === OWNER_FILE) {
      ownerStats = entryStats;
      const ownerRead = await readOwner(
        join(paths.writerLockDir, OWNER_FILE),
        entryStats,
      );
      verifiable = verifiable && ownerRead.verifiable;
      ownerBytes = ownerRead.bytes;
      if (ownerBytes !== undefined) {
        hash.update(ownerBytes);
        hash.update("\n");
      }
    }
  }

  try {
    const lockAfter = await lstat(paths.writerLockDir, { bigint: true });
    const namesAfter = (await readdir(paths.writerLockDir)).sort();
    if (
      !sameStat(lockBefore, lockAfter) ||
      namesAfter.length !== names.length ||
      namesAfter.some((name, index) => name !== names[index])
    ) {
      verifiable = false;
    }
  } catch {
    verifiable = false;
  }

  return {
    fingerprint: `sha256:${hash.digest("hex")}`,
    verifiable,
    exactOwnerLayout:
      lockBefore.isDirectory() &&
      (lockBefore.mode & 0o777n) === BigInt(JOURNAL_DIRECTORY_MODE) &&
      names.length === 1 &&
      names[0] === OWNER_FILE &&
      ownerStats !== undefined &&
      !ownerStats.isSymbolicLink() &&
      ownerStats.isFile() &&
      (ownerStats.mode & 0o777n) === BigInt(JOURNAL_FILE_MODE) &&
      ownerBytes !== undefined,
    ...(ownerBytes === undefined ? {} : { ownerBytes }),
  };
}

function classifyLeaseSnapshot(
  snapshot: LeaseSnapshot | undefined,
): WriterLeaseInspection {
  if (snapshot === undefined) {
    return Object.freeze({
      state: "absent",
      fingerprint: "sha256:absent",
      verifiable: true,
    });
  }

  if (!snapshot.verifiable || !snapshot.exactOwnerLayout) {
    return Object.freeze({
      state: "ambiguous",
      fingerprint: snapshot.fingerprint,
      verifiable: snapshot.verifiable,
    });
  }
  const owner = parseOwner(snapshot.ownerBytes ?? new Uint8Array());
  if (owner === undefined) {
    return Object.freeze({
      state: "ambiguous",
      fingerprint: snapshot.fingerprint,
      verifiable: snapshot.verifiable,
    });
  }

  try {
    process.kill(owner.pid, 0);
    return Object.freeze({
      state: "live",
      fingerprint: snapshot.fingerprint,
      verifiable: true,
      owner,
    });
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") {
      return Object.freeze({
        state: "stale-proven-dead",
        fingerprint: snapshot.fingerprint,
        verifiable: true,
        owner,
      });
    }
    if (code === "EPERM") {
      return Object.freeze({
        state: "live",
        fingerprint: snapshot.fingerprint,
        verifiable: true,
        owner,
      });
    }
    return Object.freeze({
      state: "ambiguous",
      fingerprint: snapshot.fingerprint,
      verifiable: true,
    });
  }
}

export async function inspectWriterLease(
  paths: SessionPaths,
): Promise<WriterLeaseInspection> {
  return classifyLeaseSnapshot(await snapshotLease(paths));
}

export async function observeWriterLeasePassive(
  paths: SessionPaths,
): Promise<PassiveWriterLeaseObservation> {
  const snapshot = await snapshotLease(paths);
  if (snapshot === undefined) {
    return Object.freeze({
      state: "absent",
      fingerprint: "sha256:absent",
      verifiable: true,
    });
  }
  if (!snapshot.verifiable || !snapshot.exactOwnerLayout) {
    return Object.freeze({
      state: "ambiguous",
      fingerprint: snapshot.fingerprint,
      verifiable: snapshot.verifiable,
    });
  }
  const owner = parseOwner(snapshot.ownerBytes ?? new Uint8Array());
  if (owner === undefined) {
    return Object.freeze({
      state: "ambiguous",
      fingerprint: snapshot.fingerprint,
      verifiable: true,
    });
  }
  return Object.freeze({
    state: "owner-observed",
    fingerprint: snapshot.fingerprint,
    verifiable: true,
    owner,
  });
}

async function writeAll(
  handle: FileHandle,
  bytes: Uint8Array,
  controls: PersistenceTestControls | undefined,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const remaining = bytes.byteLength - offset;
    const length = writeChunkLimit(controls, remaining);
    const result = await handle.write(bytes, offset, length, offset);
    if (result.bytesWritten < 1 || result.bytesWritten > length) {
      throw journalError("JOURNAL_IO");
    }
    offset += result.bytesWritten;
  }
}

export async function acquireWriterLease(
  paths: SessionPaths,
  acquiredAt: CanonicalTimestamp,
  controls?: PersistenceTestControls,
): Promise<WriterLease> {
  if (!validTimestamp(acquiredAt)) throw journalError("JOURNAL_SCHEMA");
  await assertSecureDirectory(paths.sessionDir);

  try {
    await mkdir(paths.writerLockDir, { mode: JOURNAL_DIRECTORY_MODE });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw journalError("JOURNAL_IO");
    const existing = await inspectWriterLease(paths);
    if (existing.state === "live") throw journalError("JOURNAL_LEASE_LIVE");
    if (existing.state === "ambiguous") {
      throw journalError("JOURNAL_LEASE_AMBIGUOUS");
    }
    throw journalError("JOURNAL_LEASE_HELD");
  }

  await reachFaultPoint(controls, "lease.after_mkdir");
  await assertSecureDirectory(paths.writerLockDir);

  const owner: WriterLeaseOwner = Object.freeze({
    v: 1,
    pid: process.pid,
    nonce: randomBytes(16).toString("hex"),
    acquiredAt,
  });
  const ownerBytes = encodeOwner(owner);
  const ownerPath = join(paths.writerLockDir, OWNER_FILE);
  let ownerHandle;
  let ownerFailure: JournalError | undefined;
  try {
    ownerHandle = await open(
      ownerPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      JOURNAL_FILE_MODE,
    );
    await writeAll(ownerHandle, ownerBytes, controls);
    await ownerHandle.sync();
    await reachFaultPoint(controls, "lease.after_owner_sync");
  } catch (error) {
    ownerFailure =
      error instanceof JournalError ? error : journalError("JOURNAL_IO");
  }
  try {
    await ownerHandle?.close();
  } catch {
    ownerFailure ??= journalError("JOURNAL_IO");
  }
  if (ownerFailure !== undefined) throw ownerFailure;

  await syncDirectory(paths.writerLockDir);
  await syncDirectory(paths.sessionDir);

  const inspection = await inspectWriterLease(paths);
  const snapshot = await snapshotLease(paths);
  if (
    inspection.state !== "live" ||
    inspection.owner.pid !== owner.pid ||
    inspection.owner.nonce !== owner.nonce ||
    snapshot === undefined ||
    snapshot.fingerprint !== inspection.fingerprint ||
    !ownerBytes.every((byte, index) => byte === snapshot.ownerBytes?.[index]) ||
    ownerBytes.byteLength !== snapshot.ownerBytes?.byteLength
  ) {
    throw journalError("JOURNAL_LEASE_AMBIGUOUS");
  }

  return new WriterLease(
    paths,
    owner,
    inspection.fingerprint,
    ownerBytes,
  );
}

async function createQuarantineContainer(
  paths: SessionPaths,
  kind: "quarantine" | "release",
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const path = join(
      paths.sessionDir,
      `.writer-${kind}-${randomBytes(16).toString("hex")}`,
    );
    try {
      await mkdir(path, { mode: JOURNAL_DIRECTORY_MODE });
      await syncDirectory(path);
      await syncDirectory(paths.sessionDir);
      return path;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        if (error instanceof JournalError) throw error;
        throw journalError("JOURNAL_IO");
      }
    }
  }
  throw journalError("JOURNAL_IO");
}

async function moveLeaseToQuarantine(
  paths: SessionPaths,
  container: string,
): Promise<string> {
  const destination = join(container, "writer.lock");
  try {
    await rename(paths.writerLockDir, destination);
    await syncDirectory(container);
    await syncDirectory(paths.sessionDir);
    return destination;
  } catch (error) {
    if (error instanceof JournalError) throw error;
    throw journalError("JOURNAL_IO");
  }
}

export async function quarantineWriterLease(
  paths: SessionPaths,
  inspection: WriterLeaseInspection,
  confirmation: WriterLeaseQuarantineConfirmation,
): Promise<QuarantinedWriterLease> {
  if (confirmation.confirmedNoConcurrentStart !== true) {
    throw journalError("JOURNAL_LEASE_CHANGED");
  }
  if (inspection.state === "absent") {
    throw journalError("JOURNAL_LEASE_CHANGED");
  }
  if (inspection.state === "live") {
    throw journalError("JOURNAL_LEASE_LIVE");
  }
  if (!inspection.verifiable) {
    throw journalError("JOURNAL_LEASE_CHANGED");
  }
  if (
    inspection.state === "ambiguous" &&
    confirmation.forceAmbiguous !== true
  ) {
    throw journalError("JOURNAL_LEASE_AMBIGUOUS");
  }

  const container = await createQuarantineContainer(paths, "quarantine");
  const snapshot = await snapshotLease(paths);
  const current = classifyLeaseSnapshot(snapshot);
  if (current.state === "live") throw journalError("JOURNAL_LEASE_LIVE");
  if (
    current.state !== inspection.state ||
    current.fingerprint !== inspection.fingerprint ||
    !current.verifiable
  ) {
    throw journalError("JOURNAL_LEASE_CHANGED");
  }

  const quarantinePath = await moveLeaseToQuarantine(paths, container);
  return Object.freeze({
    previousState: inspection.state,
    inspectionFingerprint: inspection.fingerprint,
    quarantinePath,
  });
}

export async function releaseWriterLease(
  lease: WriterLease,
  logHandle: FileHandle,
): Promise<string> {
  try {
    await logHandle.close();
  } catch {
    throw journalError("JOURNAL_IO");
  }

  const container = await createQuarantineContainer(lease.paths, "release");
  const finalSnapshot = await snapshotLease(lease.paths);
  const finalCurrent = classifyLeaseSnapshot(finalSnapshot);
  if (
    finalCurrent.state !== "live" ||
    finalCurrent.fingerprint !== lease.fingerprint ||
    finalCurrent.owner.pid !== lease.owner.pid ||
    finalCurrent.owner.nonce !== lease.owner.nonce ||
    finalSnapshot === undefined ||
    !lease.matchesOwnerBytes(finalSnapshot.ownerBytes)
  ) {
    throw journalError("JOURNAL_LEASE_CHANGED");
  }

  return moveLeaseToQuarantine(lease.paths, container);
}
