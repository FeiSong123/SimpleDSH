import type { FileHandle } from "node:fs/promises";

import { concatBytes, utf8Bytes } from "../bytes/ops.js";
import type { FrozenBytes } from "../bytes/types.js";
import { journalError } from "./errors.js";
import {
  reachFaultPoint,
  writeChunkLimit,
  type PersistenceTestControls,
} from "./faults.js";
import {
  createVerifiedJournalEvent,
  encodeVerifiedJournalEvent,
} from "./schema.js";
import type {
  AnyJournalEventDraft,
  AnyVerifiedJournalEvent,
  EventIdentitySource,
  JournalClock,
  JournalHead,
} from "./types.js";

const LINE_FEED = utf8Bytes("\n");

export interface PreparedJournalAppend {
  commit(): void;
}

export interface JournalAppendPreflight {
  prepare(event: AnyVerifiedJournalEvent): Promise<PreparedJournalAppend>;
}

export interface JournalWriterLease {
  release(log: FileHandle): Promise<void>;
}

export interface JournalWriterOptions {
  readonly log: FileHandle;
  readonly head: JournalHead;
  readonly initialEvents?: readonly AnyVerifiedJournalEvent[];
  readonly clock: JournalClock;
  readonly eventIds: EventIdentitySource;
  readonly preflight: JournalAppendPreflight;
  readonly lease: JournalWriterLease;
  readonly controls?: PersistenceTestControls;
}

type WriterState = "open" | "poisoned" | "closed";

export class JournalWriter {
  readonly #log: FileHandle;
  readonly #clock: JournalClock;
  readonly #eventIds: EventIdentitySource;
  readonly #preflight: JournalAppendPreflight;
  readonly #lease: JournalWriterLease;
  readonly #controls: PersistenceTestControls | undefined;
  #state: WriterState = "open";
  #accepting = true;
  #head: JournalHead;
  #events: readonly AnyVerifiedJournalEvent[];
  #serial: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;

  constructor(options: JournalWriterOptions) {
    this.#log = options.log;
    this.#head = Object.freeze({ ...options.head });
    this.#events = Object.freeze([...(options.initialEvents ?? [])]);
    this.#clock = options.clock;
    this.#eventIds = options.eventIds;
    this.#preflight = options.preflight;
    this.#lease = options.lease;
    this.#controls = options.controls;
  }

  get head(): JournalHead {
    return Object.freeze({ ...this.#head });
  }

  get events(): readonly AnyVerifiedJournalEvent[] {
    return this.#events;
  }

  get state(): WriterState {
    return this.#state;
  }

  append(draft: AnyJournalEventDraft): Promise<AnyVerifiedJournalEvent> {
    if (!this.#accepting || this.#state === "closed") {
      return Promise.reject(journalError("JOURNAL_CLOSED"));
    }
    if (this.#state === "poisoned") {
      return Promise.reject(journalError("JOURNAL_POISONED"));
    }
    const operation = this.#serial.then(() => this.#appendOne(draft));
    this.#serial = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#accepting = false;
    this.#closePromise = this.#serial.then(async () => {
      if (this.#state === "closed") return;
      try {
        await this.#lease.release(this.#log);
      } finally {
        this.#state = "closed";
      }
    });
    return this.#closePromise;
  }

  async #appendOne(
    draft: AnyJournalEventDraft,
  ): Promise<AnyVerifiedJournalEvent> {
    if (this.#state === "poisoned") throw journalError("JOURNAL_POISONED");
    if (this.#state === "closed") throw journalError("JOURNAL_CLOSED");

    const event = createVerifiedJournalEvent(draft, {
      seq: this.#head.seq + 1,
      id: this.#eventIds.nextEventId(),
      at: this.#clock.now(),
      prevHash: this.#head.hash,
    });
    const prepared = await this.#preflight.prepare(event);
    const record = concatBytes([encodeVerifiedJournalEvent(event), LINE_FEED]);

    try {
      await writeOneLogicalAppend(this.#log, record, this.#controls);
      await reachFaultPoint(this.#controls, "append.before_sync");
      await this.#log.sync();
      await reachFaultPoint(this.#controls, "append.after_sync_before_ack");
      prepared.commit();
      this.#head = Object.freeze({ seq: event.seq, hash: event.hash });
      this.#events = Object.freeze([...this.#events, event]);
    } catch {
      this.#state = "poisoned";
      throw journalError("JOURNAL_IO");
    }
    return event;
  }
}

export async function writeOneLogicalAppend(
  handle: FileHandle,
  bytes: FrozenBytes,
  controls?: PersistenceTestControls,
): Promise<void> {
  const source = bytes.copy();
  let offset = 0;
  while (offset < source.byteLength) {
    const remaining = source.byteLength - offset;
    const length = writeChunkLimit(controls, remaining);
    const result = await handle.write(source, offset, length);
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) {
      throw journalError("JOURNAL_IO");
    }
    if (result.bytesWritten > length) throw journalError("JOURNAL_IO");
    offset += result.bytesWritten;
    await reachFaultPoint(controls, "append.after_write_chunk");
  }
}
