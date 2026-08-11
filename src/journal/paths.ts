import { constants, existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { journalError, JournalError } from "./errors.js";
import {
  reachFaultPoint,
  type PersistenceTestControls,
} from "./faults.js";

const SESSION_ID = /^ses_[0-9a-f]{32}$/u;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface SessionPaths {
  readonly workspaceRoot: string;
  readonly storageDir: string;
  readonly sessionsDir: string;
  readonly sessionDir: string;
  readonly logPath: string;
  readonly writerLockDir: string;
  readonly blobsDir: string;
  readonly snapshotsDir: string;
  readonly artifactsDir: string;
  readonly recoveryDir: string;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function throwIo(): never {
  throw journalError("JOURNAL_IO");
}

/** The directory this workspace keeps its Sessions in. */
export const STORAGE_DIRECTORY = ".flashcoder";
/** What it was called while this was SimpleDSH. */
export const LEGACY_STORAGE_DIRECTORY = ".dsh";

/**
 * Which of the two a workspace uses.
 *
 * A workspace that already has Sessions under the old name keeps using it:
 * moving a Journal is a rewrite, and this is a system that does not rewrite
 * durable state. A workspace with nothing under the old name gets the new one.
 */
export function storageDirectoryName(workspaceRoot: string): string {
  if (existsSync(join(workspaceRoot, STORAGE_DIRECTORY))) {
    return STORAGE_DIRECTORY;
  }
  return existsSync(join(workspaceRoot, LEGACY_STORAGE_DIRECTORY))
    ? LEGACY_STORAGE_DIRECTORY
    : STORAGE_DIRECTORY;
}

export function createSessionPaths(
  workspaceRoot: string,
  sessionId: string,
): SessionPaths {
  if (workspaceRoot.length === 0 || !SESSION_ID.test(sessionId)) {
    throw journalError("JOURNAL_UNSAFE_PATH");
  }

  const canonicalWorkspaceRoot = resolve(workspaceRoot);
  const storageDir = join(canonicalWorkspaceRoot, storageDirectoryName(canonicalWorkspaceRoot));
  const sessionsDir = join(storageDir, "sessions");
  const sessionDir = join(sessionsDir, sessionId);

  return Object.freeze({
    workspaceRoot: canonicalWorkspaceRoot,
    storageDir,
    sessionsDir,
    sessionDir,
    logPath: join(sessionDir, "log.jsonl"),
    writerLockDir: join(sessionDir, "writer.lock"),
    blobsDir: join(sessionDir, "blobs", "sha256"),
    snapshotsDir: join(sessionDir, "snapshots", "sha256"),
    artifactsDir: join(sessionDir, "artifacts", "sha256"),
    recoveryDir: join(sessionDir, "recovery", "sha256"),
  });
}

export async function assertSecureDirectory(path: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    throw journalError("JOURNAL_UNSAFE_PATH");
  }
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    (stats.mode & 0o777) !== DIRECTORY_MODE
  ) {
    throw journalError("JOURNAL_UNSAFE_PATH");
  }
}

async function assertDirectoryWithoutMode(path: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    throw journalError("JOURNAL_UNSAFE_PATH");
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw journalError("JOURNAL_UNSAFE_PATH");
  }
}

export async function syncDirectory(
  path: string,
  requireStorageMode = true,
): Promise<void> {
  if (requireStorageMode) {
    await assertSecureDirectory(path);
  } else {
    await assertDirectoryWithoutMode(path);
  }

  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const stats = await handle.stat();
    if (
      !stats.isDirectory() ||
      (requireStorageMode && (stats.mode & 0o777) !== DIRECTORY_MODE)
    ) {
      throw journalError("JOURNAL_UNSAFE_PATH");
    }
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof JournalError) throw error;
    throwIo();
  }
  try {
    await handle.close();
  } catch {
    throwIo();
  }
}

async function ensureDirectory(
  path: string,
  parent: string,
  parentRequiresStorageMode: boolean,
  controls: PersistenceTestControls | undefined,
): Promise<void> {
  let created = false;
  try {
    await mkdir(path, { mode: DIRECTORY_MODE });
    created = true;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throwIo();
  }

  await assertSecureDirectory(path);
  await syncDirectory(path);
  if (created) {
    await reachFaultPoint(
      controls,
      "bootstrap.after_directory_sync_before_parent_sync",
    );
  }
  await syncDirectory(parent, parentRequiresStorageMode);
}

async function openSecureLog(path: string): Promise<{
  readonly handle: Awaited<ReturnType<typeof open>>;
  readonly created: boolean;
}> {
  const createFlags =
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_RDWR |
    constants.O_APPEND |
    constants.O_NOFOLLOW;
  try {
    const handle = await open(path, createFlags, FILE_MODE);
    return { handle, created: true };
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throwIo();
  }

  let before;
  try {
    before = await lstat(path);
  } catch {
    throw journalError("JOURNAL_UNSAFE_PATH");
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    (before.mode & 0o777) !== FILE_MODE
  ) {
    throw journalError("JOURNAL_UNSAFE_PATH");
  }

  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
    );
    const after = await handle.stat();
    if (
      !after.isFile() ||
      (after.mode & 0o777) !== FILE_MODE ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      await handle.close();
      throw journalError("JOURNAL_UNSAFE_PATH");
    }
    return { handle, created: false };
  } catch (error) {
    if (error instanceof JournalError) throw error;
    await handle?.close().catch(() => undefined);
    throw journalError("JOURNAL_UNSAFE_PATH");
  }
}

export async function openExistingSessionLog(
  paths: SessionPaths,
): Promise<Awaited<ReturnType<typeof open>>> {
  let before;
  try {
    before = await lstat(paths.logPath);
  } catch {
    throw journalError("JOURNAL_UNSAFE_PATH");
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    (before.mode & 0o777) !== FILE_MODE
  ) {
    throw journalError("JOURNAL_UNSAFE_PATH");
  }

  let handle;
  try {
    handle = await open(
      paths.logPath,
      constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
    );
    const after = await handle.stat();
    if (
      !after.isFile() ||
      (after.mode & 0o777) !== FILE_MODE ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw journalError("JOURNAL_UNSAFE_PATH");
    }
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof JournalError) throw error;
    throw journalError("JOURNAL_UNSAFE_PATH");
  }
}

export async function openExistingSessionLogReadOnly(
  paths: SessionPaths,
): Promise<Awaited<ReturnType<typeof open>>> {
  let before;
  try {
    before = await lstat(paths.logPath);
  } catch {
    throw journalError("JOURNAL_UNSAFE_PATH");
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    (before.mode & 0o777) !== FILE_MODE
  ) {
    throw journalError("JOURNAL_UNSAFE_PATH");
  }

  let handle;
  try {
    handle = await open(
      paths.logPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const after = await handle.stat();
    if (
      !after.isFile() ||
      (after.mode & 0o777) !== FILE_MODE ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw journalError("JOURNAL_UNSAFE_PATH");
    }
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof JournalError) throw error;
    throw journalError("JOURNAL_UNSAFE_PATH");
  }
}

export async function bootstrapSession(
  paths: SessionPaths,
  controls?: PersistenceTestControls,
): Promise<void> {
  await assertDirectoryWithoutMode(paths.workspaceRoot);

  await ensureDirectory(
    paths.storageDir,
    paths.workspaceRoot,
    false,
    controls,
  );
  await ensureDirectory(paths.sessionsDir, paths.storageDir, true, controls);
  await ensureDirectory(paths.sessionDir, paths.sessionsDir, true, controls);

  for (const [parent, leaf] of [
    [paths.sessionDir, join(paths.sessionDir, "blobs")],
    [join(paths.sessionDir, "blobs"), paths.blobsDir],
    [paths.sessionDir, join(paths.sessionDir, "snapshots")],
    [join(paths.sessionDir, "snapshots"), paths.snapshotsDir],
    [paths.sessionDir, join(paths.sessionDir, "artifacts")],
    [join(paths.sessionDir, "artifacts"), paths.artifactsDir],
    [paths.sessionDir, join(paths.sessionDir, "recovery")],
    [join(paths.sessionDir, "recovery"), paths.recoveryDir],
  ] as const) {
    await ensureDirectory(leaf, parent, true, controls);
  }

  const { handle, created } = await openSecureLog(paths.logPath);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || (stats.mode & 0o777) !== FILE_MODE) {
      throw journalError("JOURNAL_UNSAFE_PATH");
    }
    await handle.sync();
    if (created) {
      await reachFaultPoint(
        controls,
        "bootstrap.after_log_sync_before_session_sync",
      );
    }
    await syncDirectory(paths.sessionDir);
    if (created) {
      await reachFaultPoint(controls, "bootstrap.after_session_sync");
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof JournalError) throw error;
    throwIo();
  }
  try {
    await handle.close();
  } catch {
    throwIo();
  }
}

export const JOURNAL_DIRECTORY_MODE = DIRECTORY_MODE;
export const JOURNAL_FILE_MODE = FILE_MODE;
