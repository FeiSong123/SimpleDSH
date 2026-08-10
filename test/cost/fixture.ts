import { sha256Hex, toBase64, utf8Bytes } from "../../src/bytes/ops.js";
import { asToolCallId, type ToolCallId } from "../../src/bytes/tool-call-id.js";
import { createVerifiedJournalEvent } from "../../src/journal/schema.js";
import type {
  AnyJournalEventDraft,
  AnyVerifiedJournalEvent,
  AttemptId,
  CacheAbiId,
  CanonicalTimestamp,
  EffectId,
  EventId,
  JournalEventDraft,
  JournalEventType,
  LineageId,
  RequestSnapshotId,
  RunId,
  SessionId,
  Sha256,
  VerifiedJournalEvent,
} from "../../src/journal/types.js";

export function objectId<Id extends string>(prefix: string, value: number): Id {
  return `${prefix}_${value.toString(16).padStart(32, "0")}` as Id;
}

export const SESSION_ID = objectId<SessionId>("ses", 1);
export const LINEAGE_A = objectId<LineageId>("lin", 2);
export const LINEAGE_B = objectId<LineageId>("lin", 3);
export const RUN_A = objectId<RunId>("run", 4);
export const RUN_B = objectId<RunId>("run", 5);
export const SNAPSHOT_A = objectId<RequestSnapshotId>("rqs", 6);
export const SNAPSHOT_B = objectId<RequestSnapshotId>("rqs", 7);
export const ATTEMPT_A = objectId<AttemptId>("att", 8);
export const ATTEMPT_B = objectId<AttemptId>("att", 9);
export const HASH_A = `sha256:${"a".repeat(64)}` as Sha256;
export const HASH_B = `sha256:${"b".repeat(64)}` as Sha256;

export class CostEventBuilder {
  readonly #events: AnyVerifiedJournalEvent[] = [];
  #eventOrdinal = 1;

  append<Type extends JournalEventType>(
    draft: JournalEventDraft<Type>,
    at = "2026-08-05T00:00:00.000Z" as CanonicalTimestamp,
  ): VerifiedJournalEvent<Type> {
    const previous = this.#events.at(-1);
    const event = createVerifiedJournalEvent(
      draft as AnyJournalEventDraft,
      {
        seq: this.#events.length + 1,
        id: objectId<EventId>("evt", this.#eventOrdinal),
        at,
        prevHash: previous?.hash ?? null,
      },
    ) as VerifiedJournalEvent<Type>;
    this.#eventOrdinal += 1;
    this.#events.push(event as AnyVerifiedJournalEvent);
    return event;
  }

  events(): readonly AnyVerifiedJournalEvent[] {
    return Object.freeze([...this.#events]);
  }
}

export function startLineage(
  builder: CostEventBuilder,
  lineageId: LineageId,
  runId: RunId,
): void {
  builder.append({
    type: "lineage_started",
    sessionId: SESSION_ID,
    lineageId,
    payload: { cacheAbiId: HASH_A as unknown as CacheAbiId },
  });
  builder.append({
    type: "lineage_activated",
    sessionId: SESSION_ID,
    lineageId,
    payload: {
      previousLineageId: lineageId === LINEAGE_A ? null : LINEAGE_A,
      nextLineageId: lineageId,
      reason: lineageId === LINEAGE_A ? "initial" : "abi_change",
    },
  });
  builder.append({
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId,
    runId,
    payload: { cause: "user", previousRunId: null },
  });
}

export function startAttempt(
  builder: CostEventBuilder,
  input: Readonly<{
    readonly lineageId: LineageId;
    readonly runId: RunId;
    readonly attemptId: AttemptId;
    readonly requestSnapshotId: RequestSnapshotId;
    readonly ordinal?: number;
    readonly at?: CanonicalTimestamp;
  }>,
): void {
  builder.append(
    {
      type: "request_attempt_started",
      sessionId: SESSION_ID,
      lineageId: input.lineageId,
      runId: input.runId,
      payload: {
        attemptId: input.attemptId,
        requestSnapshotId: input.requestSnapshotId,
        ordinal: input.ordinal ?? 1,
      },
    },
    input.at,
  );
}

export function commitAssistant(
  builder: CostEventBuilder,
  input: Readonly<{
    readonly lineageId: LineageId;
    readonly runId: RunId;
    readonly attemptId: AttemptId;
    readonly requestSnapshotId: RequestSnapshotId;
    readonly responseModel: string;
    readonly promptTokens: number;
    readonly hitTokens: number;
    readonly missTokens: number;
    readonly completionTokens: number;
    readonly reasoningTokens: number;
    readonly finishReason?: string;
    readonly at?: CanonicalTimestamp;
  }>,
): VerifiedJournalEvent<"assistant_committed"> {
  const bytes = utf8Bytes("");
  return builder.append(
    {
      type: "assistant_committed",
      sessionId: SESSION_ID,
      lineageId: input.lineageId,
      runId: input.runId,
      payload: {
        role: "assistant",
        enc: "b64",
        bytes: toBase64(bytes),
        byteCount: bytes.byteLength,
        byteHash: `sha256:${sha256Hex(bytes)}` as Sha256,
        blobIndex: 0,
        chainHash: HASH_B,
        attemptId: input.attemptId,
        requestSnapshotId: input.requestSnapshotId,
        providerRequestId: `provider-${input.attemptId}`,
        responseModel: input.responseModel,
        systemFingerprint: null,
        semanticDeltaCount: 0,
        usage: {
          promptTokens: input.promptTokens,
          promptCacheHitTokens: input.hitTokens,
          promptCacheMissTokens: input.missTokens,
          completionTokens: input.completionTokens,
          reasoningTokens: input.reasoningTokens,
          rawFinishReason: input.finishReason ?? "stop",
        },
      },
    },
    input.at,
  );
}

export function toolCallId(value: string): ToolCallId {
  return asToolCallId(value);
}

export function effectId(value: number): EffectId {
  return objectId<EffectId>("eff", value);
}
