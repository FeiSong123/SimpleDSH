import { sha256Hex } from "../bytes/ops.js";
import { FrozenBytes } from "../bytes/types.js";
import { materializeUserMessage } from "../bytes/user.js";
import type {
  AnyVerifiedJournalEvent,
  EventId,
} from "../journal/types.js";

type ArtifactPublishedEvent = Extract<
  AnyVerifiedJournalEvent,
  { readonly type: "artifact_published" }
>;
type FactRecordedEvent = Extract<
  AnyVerifiedJournalEvent,
  { readonly type: "fact_recorded" }
>;

type UserFactKind = "user_input" | "date" | "cwd" | "git";

const FACT_ORDER: Readonly<Record<UserFactKind, number>> = Object.freeze({
  user_input: 0,
  date: 1,
  cwd: 2,
  git: 3,
});

const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

export interface UserFactInput {
  readonly published: ArtifactPublishedEvent;
  readonly fact: FactRecordedEvent;
  readonly bytes: FrozenBytes;
}

export interface UserMaterialization {
  readonly blob: FrozenBytes;
  readonly sourceFactEventIds: readonly EventId[];
}

function invalidFacts(): never {
  throw new TypeError("invalid v1 user fact materialization input");
}

function decodeFactBytes(bytes: FrozenBytes): string {
  try {
    return fatalDecoder.decode(bytes.copy());
  } catch {
    return invalidFacts();
  }
}

function factRank(kind: string): number {
  if (!Object.prototype.hasOwnProperty.call(FACT_ORDER, kind)) {
    return invalidFacts();
  }
  return FACT_ORDER[kind as UserFactKind];
}

export function materializeUserV1(input: {
  readonly facts: readonly UserFactInput[];
}): UserMaterialization {
  if (
    typeof input !== "object" ||
    input === null ||
    !Array.isArray(input.facts) ||
    input.facts.length === 0
  ) {
    return invalidFacts();
  }

  let sessionId: string | undefined;
  let lineageId: string | undefined;
  let runId: string | undefined;
  let previousRank = -1;
  let previousFactSeq = 0;
  let userContent: string | undefined;
  const environment: string[] = [];
  const sourceFactEventIds: EventId[] = [];
  const sourceIds = new Set<string>();

  for (const entry of input.facts) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      entry.published?.type !== "artifact_published" ||
      entry.fact?.type !== "fact_recorded" ||
      !(entry.bytes instanceof FrozenBytes)
    ) {
      return invalidFacts();
    }

    const { published, fact, bytes } = entry;
    if (
      published.lineageId === undefined ||
      published.runId === undefined ||
      fact.lineageId === undefined ||
      fact.runId === undefined ||
      published.sessionId !== fact.sessionId ||
      published.lineageId !== fact.lineageId ||
      published.runId !== fact.runId ||
      !Number.isSafeInteger(published.seq) ||
      !Number.isSafeInteger(fact.seq) ||
      published.seq <= 0 ||
      fact.seq <= published.seq ||
      fact.seq <= previousFactSeq
    ) {
      return invalidFacts();
    }

    if (sessionId === undefined) {
      sessionId = fact.sessionId;
      lineageId = fact.lineageId;
      runId = fact.runId;
    } else if (
      fact.sessionId !== sessionId ||
      fact.lineageId !== lineageId ||
      fact.runId !== runId
    ) {
      return invalidFacts();
    }

    const kind = fact.payload.kind;
    const rank = factRank(kind);
    if (rank <= previousRank || sourceIds.has(fact.id)) {
      return invalidFacts();
    }

    const digestHex = sha256Hex(bytes);
    const expectedHash = `sha256:${digestHex}`;
    if (
      published.payload.artifactType !== "fact" ||
      published.payload.artifactId !== fact.payload.artifactId ||
      published.payload.artifactHash !== expectedHash ||
      published.payload.artifactRef !== `artifacts/sha256/${digestHex}` ||
      published.payload.byteCount !== bytes.byteLength ||
      fact.payload.byteCount !== bytes.byteLength
    ) {
      return invalidFacts();
    }

    const value = decodeFactBytes(bytes);
    if (kind === "user_input") {
      if (value.length === 0 || userContent !== undefined) {
        return invalidFacts();
      }
      userContent = value;
    } else {
      environment.push(`${kind}:\n${value}`);
    }

    previousRank = rank;
    previousFactSeq = fact.seq;
    sourceIds.add(fact.id);
    sourceFactEventIds.push(fact.id);
  }

  if (userContent === undefined) return invalidFacts();
  const content =
    environment.length === 0
      ? userContent
      : `${userContent}\n\n<env>\n${environment.join("\n")}\n</env>`;

  return Object.freeze({
    blob: materializeUserMessage(content),
    sourceFactEventIds: Object.freeze([...sourceFactEventIds]),
  });
}
