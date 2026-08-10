import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import {
  bytesEqual,
  fromBase64,
  sha256Hex,
  toBase64,
  utf8Bytes,
} from "../bytes/ops.js";
import { freezeBytes, type FrozenBytes } from "../bytes/types.js";
import {
  createRecoveryCas,
  type FixedCas,
} from "../artifact/internal-cas.js";
import type {
  RecoveryRef as ArtifactRecoveryRef,
  Sha256 as ArtifactSha256,
} from "../artifact/types.js";
import type { JournalReferenceVerifier } from "./bindings.js";
import { journalError, JournalError } from "./errors.js";
import {
  reachFaultPoint,
  writeChunkLimit,
  type PersistenceTestControls,
} from "./faults.js";
import { openExistingSessionLog, syncDirectory, type SessionPaths } from "./paths.js";
import { replayJournal, type JournalReplayResult } from "./replay.js";
import {
  asSessionId,
  asSha256,
  createVerifiedJournalEvent,
  encodeVerifiedJournalEvent,
} from "./schema.js";
import type {
  AnyVerifiedJournalEvent,
  EventIdentitySource,
  JournalClock,
  JournalPayloadByType,
  RecoveryRef,
  SessionId,
  Sha256,
} from "./types.js";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const RECOVERY_VERSION = 1;
const IO_CHUNK_BYTES = 64 * 1024;

export interface RecoveryObjectV1 {
  readonly v: 1;
  readonly sessionId: SessionId;
  readonly validPrefixByteCount: number;
  readonly validPrefixSeq: number;
  readonly validPrefixHash: Sha256;
  readonly tailByteCount: number;
  readonly tailHash: Sha256;
  readonly tailEnc: "b64";
  readonly tailBytes: string;
}

export interface TornRepairResult {
  readonly log: FileHandle;
  readonly replay: JournalReplayResult;
  readonly recoveryEvent: AnyVerifiedJournalEvent;
}

function safeNonNegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw journalError("JOURNAL_CORRUPTION");
  }
  return value as number;
}

function safePositive(value: unknown): number {
  const parsed = safeNonNegative(value);
  if (parsed === 0) throw journalError("JOURNAL_CORRUPTION");
  return parsed;
}

function recoveryObject(
  sessionId: SessionId,
  replay: JournalReplayResult,
): RecoveryObjectV1 {
  const tail = replay.tornTail;
  if (tail === null || replay.head.hash === null || replay.head.seq < 1) {
    throw journalError("JOURNAL_TORN_WITHOUT_PREFIX");
  }
  return Object.freeze({
    v: RECOVERY_VERSION,
    sessionId,
    validPrefixByteCount: replay.validPrefixByteCount,
    validPrefixSeq: replay.head.seq,
    validPrefixHash: replay.head.hash,
    tailByteCount: tail.byteLength,
    tailHash: `sha256:${sha256Hex(tail)}` as Sha256,
    tailEnc: "b64",
    tailBytes: toBase64(tail),
  });
}

export function encodeRecoveryObject(value: RecoveryObjectV1): FrozenBytes {
  return utf8Bytes(
    JSON.stringify({
      v: RECOVERY_VERSION,
      sessionId: value.sessionId,
      validPrefixByteCount: value.validPrefixByteCount,
      validPrefixSeq: value.validPrefixSeq,
      validPrefixHash: value.validPrefixHash,
      tailByteCount: value.tailByteCount,
      tailHash: value.tailHash,
      tailEnc: "b64",
      tailBytes: value.tailBytes,
    }),
  );
}

export function decodeRecoveryObject(bytes: FrozenBytes): RecoveryObjectV1 {
  let text: string;
  let parsed: unknown;
  try {
    text = utf8Decoder.decode(bytes.copy());
    parsed = JSON.parse(text);
  } catch {
    throw journalError("JOURNAL_CORRUPTION");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw journalError("JOURNAL_CORRUPTION");
  }
  const value = parsed as Record<string, unknown>;
  const expectedKeys = [
    "v",
    "sessionId",
    "validPrefixByteCount",
    "validPrefixSeq",
    "validPrefixHash",
    "tailByteCount",
    "tailHash",
    "tailEnc",
    "tailBytes",
  ];
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    value["v"] !== RECOVERY_VERSION ||
    value["tailEnc"] !== "b64" ||
    typeof value["tailBytes"] !== "string"
  ) {
    throw journalError("JOURNAL_CORRUPTION");
  }
  let tail: FrozenBytes;
  try {
    tail = fromBase64(value["tailBytes"]);
  } catch {
    throw journalError("JOURNAL_CORRUPTION");
  }
  const result = Object.freeze({
    v: RECOVERY_VERSION,
    sessionId: asSessionId(value["sessionId"]),
    validPrefixByteCount: safePositive(value["validPrefixByteCount"]),
    validPrefixSeq: safePositive(value["validPrefixSeq"]),
    validPrefixHash: asSha256(value["validPrefixHash"]),
    tailByteCount: safePositive(value["tailByteCount"]),
    tailHash: asSha256(value["tailHash"]),
    tailEnc: "b64" as const,
    tailBytes: value["tailBytes"],
  });
  if (
    result.tailByteCount !== tail.byteLength ||
    result.tailHash !== `sha256:${sha256Hex(tail)}` ||
    !bytesEqual(encodeRecoveryObject(result), bytes)
  ) {
    throw journalError("JOURNAL_CORRUPTION");
  }
  return result;
}

async function writeAll(
  handle: FileHandle,
  bytes: Uint8Array,
  startPosition: number,
  controls: PersistenceTestControls | undefined,
): Promise<number> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const length = writeChunkLimit(controls, bytes.byteLength - offset);
    const result = await handle.write(
      bytes,
      offset,
      length,
      startPosition + offset,
    );
    if (result.bytesWritten < 1 || result.bytesWritten > length) {
      throw journalError("JOURNAL_IO");
    }
    offset += result.bytesWritten;
  }
  return startPosition + bytes.byteLength;
}

async function copyPrefix(
  source: FileHandle,
  destination: FileHandle,
  byteCount: number,
  controls: PersistenceTestControls | undefined,
): Promise<number> {
  let position = 0;
  while (position < byteCount) {
    const length = Math.min(IO_CHUNK_BYTES, byteCount - position);
    const buffer = new Uint8Array(length);
    const result = await source.read(buffer, 0, length, position);
    if (result.bytesRead !== length) throw journalError("JOURNAL_IO");
    position = await writeAll(destination, buffer, position, controls);
  }
  return position;
}

async function loadCompleteRecoveryObject(
  cas: FixedCas<ArtifactRecoveryRef>,
  ref: ArtifactRecoveryRef,
  byteCount: number,
): Promise<FrozenBytes> {
  const output = new Uint8Array(byteCount);
  let offset = 0;
  while (offset < byteCount) {
    const range = await cas.readVerifiedRange(ref, {
      offset,
      maxBytes: Math.min(32_768, byteCount - offset),
    });
    if (range.byteCount === 0) throw journalError("JOURNAL_CORRUPTION");
    output.set(range.bytes.copy(), offset);
    offset += range.byteCount;
  }
  return freezeBytes(output);
}

export async function verifyRecoveryObjectReference(
  cas: FixedCas<ArtifactRecoveryRef>,
  payload: JournalPayloadByType["journal_tail_recovered"],
  sessionId?: string,
  validPrefixByteCount?: number,
): Promise<void> {
  await cas.verifyObject(payload.recoveryRef as ArtifactRecoveryRef, {
    hash: payload.recoveryHash as ArtifactSha256,
    byteCount: payload.recoveryByteCount,
  });
  const bytes = await loadCompleteRecoveryObject(
    cas,
    payload.recoveryRef as ArtifactRecoveryRef,
    payload.recoveryByteCount,
  );
  const object = decodeRecoveryObject(bytes);
  if (
    (sessionId !== undefined && object.sessionId !== sessionId) ||
    (validPrefixByteCount !== undefined &&
      object.validPrefixByteCount !== validPrefixByteCount) ||
    object.validPrefixSeq !== payload.validPrefixSeq ||
    object.validPrefixHash !== payload.validPrefixHash ||
    object.tailByteCount !== payload.tailByteCount ||
    object.tailHash !== payload.tailHash ||
    `sha256:${sha256Hex(bytes)}` !== payload.recoveryHash
  ) {
    throw journalError("JOURNAL_CORRUPTION");
  }
}

export async function repairTornJournal(
  paths: SessionPaths,
  log: FileHandle,
  replay: JournalReplayResult,
  verifier: JournalReferenceVerifier,
  clock: JournalClock,
  eventIds: EventIdentitySource,
  controls?: PersistenceTestControls,
): Promise<TornRepairResult> {
  const object = recoveryObject(asSessionId(replay.projectionSnapshot.sessionId), replay);
  const objectBytes = encodeRecoveryObject(object);
  const recoveryCas = await createRecoveryCas(paths.sessionDir, controls);
  const publication = await recoveryCas.publishBytes(objectBytes);
  await reachFaultPoint(controls, "repair.after_recovery_publish");

  const recoveryEvent = createVerifiedJournalEvent(
    {
      type: "journal_tail_recovered",
      sessionId: object.sessionId,
      payload: {
        recoveryRef: publication.ref as RecoveryRef,
        recoveryHash: publication.hash as Sha256,
        recoveryByteCount: publication.byteCount,
        validPrefixSeq: object.validPrefixSeq,
        validPrefixHash: object.validPrefixHash,
        tailByteCount: object.tailByteCount,
        tailHash: object.tailHash,
      },
    },
    {
      seq: replay.head.seq + 1,
      id: eventIds.nextEventId(),
      at: clock.now(),
      prevHash: replay.head.hash,
    },
  );
  await replay.projection.prepare(recoveryEvent, {
    validPrefixByteCount: replay.validPrefixByteCount,
  });

  const tempPath = join(
    paths.sessionDir,
    `.log-repair-${randomBytes(16).toString("hex")}`,
  );
  let temp: FileHandle | undefined;
  let renamed = false;
  try {
    temp = await open(
      tempPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        constants.O_NOFOLLOW,
      0o600,
    );
    let position = await copyPrefix(
      log,
      temp,
      replay.validPrefixByteCount,
      controls,
    );
    await reachFaultPoint(controls, "repair.after_temp_prefix");
    const eventLine = new Uint8Array(
      encodeVerifiedJournalEvent(recoveryEvent).byteLength + 1,
    );
    eventLine.set(encodeVerifiedJournalEvent(recoveryEvent).copy());
    eventLine[eventLine.byteLength - 1] = 0x0a;
    position = await writeAll(temp, eventLine, position, controls);
    if (position <= replay.validPrefixByteCount) throw journalError("JOURNAL_IO");
    await reachFaultPoint(controls, "repair.after_temp_event");
    await temp.sync();
    await reachFaultPoint(controls, "repair.after_temp_sync");
    await temp.close();
    temp = undefined;
    await log.close();
    await rename(tempPath, paths.logPath);
    renamed = true;
    await reachFaultPoint(controls, "repair.after_rename_before_dir_sync");
    await syncDirectory(paths.sessionDir);
    await reachFaultPoint(controls, "repair.after_dir_sync");
  } catch (error) {
    await temp?.close().catch(() => undefined);
    if (!renamed) await unlink(tempPath).catch(() => undefined);
    if (error instanceof JournalError) throw error;
    throw error;
  }

  const reopened = await openExistingSessionLog(paths);
  try {
    const repairedReplay = await replayJournal(reopened, verifier);
    if (
      repairedReplay.tornTail !== null ||
      repairedReplay.events.length !== replay.events.length + 1 ||
      repairedReplay.events.at(-1)?.id !== recoveryEvent.id
    ) {
      throw journalError("JOURNAL_CORRUPTION");
    }
    return Object.freeze({
      log: reopened,
      replay: repairedReplay,
      recoveryEvent,
    });
  } catch (error) {
    await reopened.close().catch(() => undefined);
    throw error;
  }
}
