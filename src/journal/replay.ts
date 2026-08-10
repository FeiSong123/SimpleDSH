import type { FileHandle } from "node:fs/promises";

import { freezeBytes, type FrozenBytes } from "../bytes/types.js";
import {
  JournalBindingProjection,
  type BindingProjectionSnapshot,
  type JournalPhysicalContext,
  type JournalReferenceVerifier,
} from "./bindings.js";
import { journalError } from "./errors.js";
import { decodeJournalRecord } from "./schema.js";
import type {
  AnyVerifiedJournalEvent,
  JournalHead,
} from "./types.js";

const READ_CHUNK_BYTES = 64 * 1024;

export interface JournalReplayResult {
  readonly events: readonly AnyVerifiedJournalEvent[];
  readonly head: JournalHead;
  readonly projection: JournalBindingProjection;
  readonly projectionSnapshot: BindingProjectionSnapshot;
  readonly validPrefixByteCount: number;
  readonly totalByteCount: number;
  readonly tornTail: FrozenBytes | null;
}

function appendPending(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  if (left.byteLength === 0) return Uint8Array.from(right);
  if (right.byteLength === 0) return left;
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left, 0);
  joined.set(right, left.byteLength);
  return joined;
}

async function acceptLine(
  rawLine: Uint8Array,
  events: AnyVerifiedJournalEvent[],
  projection: JournalBindingProjection,
  physical: JournalPhysicalContext,
): Promise<void> {
  const event = decodeJournalRecord(rawLine);
  const previous = events.at(-1);
  const expectedSeq = (previous?.seq ?? 0) + 1;
  const expectedHash = previous?.hash ?? null;
  if (event.seq !== expectedSeq || event.prevHash !== expectedHash) {
    throw journalError("JOURNAL_SEQUENCE");
  }
  await projection.accept(event, physical);
  events.push(event);
}

export async function replayJournal(
  log: FileHandle,
  verifier: JournalReferenceVerifier,
  byteLimit?: number,
): Promise<JournalReplayResult> {
  if (
    byteLimit !== undefined &&
    (!Number.isSafeInteger(byteLimit) || byteLimit < 0)
  ) {
    throw journalError("JOURNAL_IO");
  }
  const projection = new JournalBindingProjection(verifier);
  const events: AnyVerifiedJournalEvent[] = [];
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let position = 0;
  let validPrefixByteCount = 0;

  for (;;) {
    if (byteLimit !== undefined && position >= byteLimit) break;
    const buffer = new Uint8Array(
      byteLimit === undefined
        ? READ_CHUNK_BYTES
        : Math.min(READ_CHUNK_BYTES, byteLimit - position),
    );
    let bytesRead: number;
    try {
      ({ bytesRead } = await log.read(
        buffer,
        0,
        buffer.byteLength,
        position,
      ));
    } catch {
      throw journalError("JOURNAL_IO");
    }
    if (bytesRead === 0) break;
    position += bytesRead;
    const chunk = buffer.subarray(0, bytesRead);
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      const linePart = chunk.subarray(start, index);
      const line = appendPending(pending, linePart);
      pending = new Uint8Array();
      await acceptLine(line, events, projection, { validPrefixByteCount });
      validPrefixByteCount += line.byteLength + 1;
      start = index + 1;
    }
    pending = appendPending(pending, chunk.subarray(start));
  }

  if (pending.byteLength > 0 && events.length === 0) {
    throw journalError("JOURNAL_TORN_WITHOUT_PREFIX");
  }
  const previous = events.at(-1);
  return Object.freeze({
    events: Object.freeze([...events]),
    head: Object.freeze({
      seq: previous?.seq ?? 0,
      hash: previous?.hash ?? null,
    }),
    projection,
    projectionSnapshot: projection.snapshot(),
    validPrefixByteCount,
    totalByteCount: position,
    tornTail: pending.byteLength === 0 ? null : freezeBytes(pending),
  });
}
