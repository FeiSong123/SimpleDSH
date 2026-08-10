export type JournalErrorCode =
  | "JOURNAL_SCHEMA"
  | "JOURNAL_CANONICAL"
  | "JOURNAL_SEQUENCE"
  | "JOURNAL_HASH"
  | "JOURNAL_REFERENCE"
  | "JOURNAL_CORRUPTION"
  | "JOURNAL_TORN_WITHOUT_PREFIX"
  | "JOURNAL_POISONED"
  | "JOURNAL_CLOSED"
  | "JOURNAL_IO"
  | "JOURNAL_LEASE_HELD"
  | "JOURNAL_LEASE_AMBIGUOUS"
  | "JOURNAL_LEASE_CHANGED"
  | "JOURNAL_LEASE_LIVE"
  | "JOURNAL_UNSAFE_PATH";

const MESSAGES: Readonly<Record<JournalErrorCode, string>> = Object.freeze({
  JOURNAL_SCHEMA: "journal value does not match the closed v1 schema",
  JOURNAL_CANONICAL: "journal record is not canonical v1 bytes",
  JOURNAL_SEQUENCE: "journal sequence or predecessor hash is invalid",
  JOURNAL_HASH: "journal record hash is invalid",
  JOURNAL_REFERENCE: "journal identity or reference binding is invalid",
  JOURNAL_CORRUPTION: "journal contains committed corruption",
  JOURNAL_TORN_WITHOUT_PREFIX: "torn journal has no valid session prefix",
  JOURNAL_POISONED: "journal writer is poisoned",
  JOURNAL_CLOSED: "journal writer is closed",
  JOURNAL_IO: "journal durability operation failed",
  JOURNAL_LEASE_HELD: "journal writer lease is held",
  JOURNAL_LEASE_AMBIGUOUS: "journal writer lease is ambiguous",
  JOURNAL_LEASE_CHANGED: "journal writer lease changed after inspection",
  JOURNAL_LEASE_LIVE: "journal writer lease may still be live",
  JOURNAL_UNSAFE_PATH: "journal storage path is unsafe",
});

export class JournalError extends Error {
  readonly code: JournalErrorCode;

  constructor(code: JournalErrorCode) {
    super(MESSAGES[code]);
    this.name = "JournalError";
    this.code = code;
  }
}

export function journalError(code: JournalErrorCode): JournalError {
  return new JournalError(code);
}
