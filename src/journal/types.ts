import type { EffectTerminal, ToolTerminal } from "../artifact/terminal.js";
import type { ToolCallId } from "../bytes/tool-call-id.js";

export type { EffectTerminal, ToolTerminal } from "../artifact/terminal.js";
export type { ToolCallId } from "../bytes/tool-call-id.js";

export type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export type EventId = Brand<string, "EventId">;
export type SessionId = Brand<string, "SessionId">;
export type LineageId = Brand<string, "LineageId">;
export type RunId = Brand<string, "RunId">;
export type RequestSnapshotId = Brand<string, "RequestSnapshotId">;
export type AttemptId = Brand<string, "AttemptId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type ArtifactVersionId = Brand<string, "ArtifactVersionId">;
export type EffectId = Brand<string, "EffectId">;
export type CacheCheckpointId = Brand<string, "CacheCheckpointId">;
export type CommitBoundaryId = Brand<string, "CommitBoundaryId">;
export type Sha256 = Brand<string, "Sha256">;
export type CacheAbiId = Brand<string, "CacheAbiId">;
export type CanonicalTimestamp = Brand<string, "CanonicalTimestamp">;
export type ArtifactRef = Brand<
  `artifacts/sha256/${string}`,
  "ArtifactRef"
>;
export type BlobRef = Brand<`blobs/sha256/${string}`, "BlobRef">;
export type SnapshotRef = Brand<
  `snapshots/sha256/${string}`,
  "SnapshotRef"
>;
export type RecoveryRef = Brand<
  `recovery/sha256/${string}`,
  "RecoveryRef"
>;

export type BlobRole = "user" | "assistant" | "tool";

export interface InlineBlobPayload<Role extends BlobRole> {
  readonly role: Role;
  readonly enc: "b64";
  readonly bytes: string;
  readonly byteCount: number;
  readonly byteHash: Sha256;
  readonly blobIndex: number;
  readonly chainHash: Sha256;
}

export interface ExternalBlobPayload<Role extends BlobRole> {
  readonly role: Role;
  readonly enc: "ref";
  readonly blobRef: BlobRef;
  readonly byteCount: number;
  readonly byteHash: Sha256;
  readonly blobIndex: number;
  readonly chainHash: Sha256;
}

export type BlobPayload<Role extends BlobRole> =
  | InlineBlobPayload<Role>
  | ExternalBlobPayload<Role>;

export interface NativeUsagePayload {
  readonly promptTokens: number;
  readonly promptCacheHitTokens: number;
  readonly promptCacheMissTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  readonly rawFinishReason: string;
}

export interface ArtifactStreamBytes {
  readonly read: number;
  readonly stdout: number;
  readonly stderr: number;
}

/**
 * Provider usage of one successful web search round. Mirrors the dimensions
 * the chat transport prices so the cost projector can price it with the same
 * price book; it is never part of the chat prefix or cache metrics.
 */
export interface ToolResultSearchUsage {
  readonly inputTokens: number;
  readonly promptCacheHitTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

export type ArtifactType =
  | "cache_abi_manifest"
  | "project_instructions"
  | "fact"
  | "tool_output"
  | "operator_evidence"
  | "user_state";

export interface JournalPayloadByType {
  readonly session_started: Record<never, never>;
  readonly cache_abi_declared: {
    readonly cacheAbiId: CacheAbiId;
    readonly manifestArtifactId: ArtifactId;
    readonly manifestByteCount: number;
  };
  readonly lineage_started: {
    readonly cacheAbiId: CacheAbiId;
  };
  readonly lineage_activated: {
    readonly previousLineageId: LineageId | null;
    readonly nextLineageId: LineageId;
    readonly reason: "initial" | "abi_change" | "compaction";
  };
  readonly run_started: {
    readonly cause: "user" | "continue" | "recovery";
    readonly previousRunId: RunId | null;
  };
  readonly fact_recorded: {
    readonly kind:
      | "user_input"
      | "project_instructions"
      | "date"
      | "cwd"
      | "git"
      | "tree";
    readonly artifactId: ArtifactId;
    readonly byteCount: number;
  };
  readonly user_committed: BlobPayload<"user"> & {
    readonly sourceFactEventIds: readonly EventId[];
  };
  /**
   * The declared verification command ran, and what it decided.
   *
   * A leaf record: nothing references it and it joins no prefix chain. It
   * exists because a verdict the CLI only held in memory would be a second
   * source of truth about whether the work was done.
   */
  readonly verification_recorded: {
    readonly sourceAssistantEventId: EventId;
    readonly verdict: "passed" | "failed" | "tampered" | "errored";
    readonly exitCode: number | null;
    readonly outputArtifactId: ArtifactId;
    /** Digest of the inventory taken before the first request of the Session. */
    readonly baselineDigest: string;
    /** Protected paths whose type, mode or contents moved since that baseline. */
    readonly changedProtectedPaths: readonly string[];
  };
  readonly artifact_published: {
    readonly artifactId: ArtifactId;
    readonly artifactRef: ArtifactRef;
    readonly artifactHash: Sha256;
    readonly byteCount: number;
    readonly lineCount: number | null;
    readonly mediaType: string;
    readonly artifactType: ArtifactType;
    readonly streamBytes: ArtifactStreamBytes | null;
    readonly hardLimitReached: boolean | null;
    readonly descendantsReaped: boolean | null;
    readonly toolCallId: ToolCallId | null;
    readonly terminal: ToolTerminal | null;
  };
  readonly artifact_version_created: {
    readonly artifactVersionId: ArtifactVersionId;
    readonly parentArtifactVersionId: ArtifactVersionId | null;
    readonly oldArtifactId: ArtifactId;
    readonly newArtifactId: ArtifactId;
  };
  readonly request_snapshot_stored: {
    readonly requestSnapshotId: RequestSnapshotId;
    readonly bodyRef: SnapshotRef;
    readonly bodyHash: Sha256;
    readonly byteCount: number;
    readonly cacheAbiId: CacheAbiId;
    readonly projectorVersion: "dsh-projector-v1";
    readonly headEventId: EventId;
    readonly commitBoundaryId: CommitBoundaryId;
    readonly segmentHashes: readonly [Sha256, Sha256];
    readonly recoveryFromSnapshotId: RequestSnapshotId | null;
  };
  readonly request_attempt_started: {
    readonly attemptId: AttemptId;
    readonly requestSnapshotId: RequestSnapshotId;
    readonly ordinal: number;
  };
  readonly request_semantic_started: {
    readonly attemptId: AttemptId;
  };
  readonly assistant_committed: BlobPayload<"assistant"> & {
    readonly attemptId: AttemptId;
    readonly requestSnapshotId: RequestSnapshotId;
    readonly providerRequestId: string;
    readonly responseModel: string;
    readonly systemFingerprint: string | null;
    readonly semanticDeltaCount: number;
    readonly usage: NativeUsagePayload;
  };
  readonly request_interrupted: {
    readonly attemptId: AttemptId;
    readonly requestSnapshotId: RequestSnapshotId;
    readonly outcome:
      | "http_error"
      | "transport_error"
      | "timeout"
      | "cancelled"
      | "protocol_error"
      | "durability_error";
    readonly status: number | null;
    readonly retryClass:
      | "request_invalid"
      | "authentication"
      | "balance"
      | "rate_limited"
      | "server"
      | "unknown"
      | "timeout"
      | "cancelled"
      | "protocol"
      | "transport_unknown";
    readonly semanticState:
      | "pre_semantic"
      | "post_semantic"
      | "semantic_state_unknown";
  };
  readonly cache_checkpoint_created: {
    readonly cacheCheckpointId: CacheCheckpointId;
    readonly requestSnapshotId: RequestSnapshotId;
    readonly blobCount: number;
    readonly chainHash: Sha256;
    readonly promptTokens: number;
    readonly providerRequestId: string;
    readonly sourceAssistantEventId: EventId;
  };
  readonly commit_boundary_created: {
    readonly commitBoundaryId: CommitBoundaryId;
    readonly cacheCheckpointId: CacheCheckpointId | null;
    readonly blobCount: number;
    readonly chainHash: Sha256;
    readonly protocolClosed: true;
    readonly effectsSettled: true;
    readonly sourceEventIds: readonly EventId[];
  };
  readonly cache_break:
    | {
        readonly classification: "planned";
        readonly fromLineageId: LineageId;
        readonly toLineageId: LineageId;
        readonly reason: "abi_change";
        readonly authorizedRevision: string;
      }
    | {
        /**
         * The prefix was replaced by a summary of itself.
         *
         * Same Cache ABI on both sides — the system blob, the tools and the
         * model tuple are unchanged. What changed is the conversation: the new
         * Lineage starts from a summary the model wrote on the old one, so the
         * old prefix is deliberately abandoned rather than corrupted.
         */
        readonly classification: "planned";
        readonly fromLineageId: LineageId;
        readonly toLineageId: LineageId;
        readonly reason: "compaction";
        readonly summaryArtifactId: ArtifactId;
        readonly replacedPromptTokens: number;
      }
    | {
        readonly classification: "unplanned";
        readonly reason: string;
        readonly expectedHash: Sha256;
        readonly actualHash: Sha256;
        readonly diffArtifactId: ArtifactId;
      };
  readonly integrity_violation: {
    readonly code:
      | "journal_canonical"
      | "journal_schema"
      | "journal_sequence"
      | "journal_hash"
      | "reference_missing"
      | "reference_mismatch"
      | "cas_collision"
      | "prefix_chain"
      | "protocol_closure"
      | "derived_conflict";
    readonly relatedEventId: EventId | null;
    readonly expectedHash: Sha256 | null;
    readonly actualHash: Sha256 | null;
  };
  readonly permission_decided: {
    readonly toolCallId: ToolCallId;
    readonly policyDecision: "allow" | "ask" | "deny";
    readonly finalDecision: "allow" | "deny";
    readonly resolution:
      | "policy"
      | "interactive"
      | "yes_flag"
      | "non_interactive";
  };
  readonly effect_prepared: {
    readonly effectId: EffectId;
    readonly toolCallId: ToolCallId;
    readonly toolName: "write" | "edit" | "bash";
    readonly argumentsHash: Sha256;
  };
  readonly effect_completed: {
    readonly effectId: EffectId;
    readonly toolCallId: ToolCallId;
    readonly artifactId: ArtifactId;
    readonly terminal: EffectTerminal;
  };
  readonly effect_indeterminate: {
    readonly effectId: EffectId;
    readonly reason:
      | "crash_gap"
      | "process_state_unknown"
      | "filesystem_state_unknown"
      | "artifact_durability_failed";
  };
  readonly effect_reconciled:
    | {
        readonly effectId: EffectId;
        readonly resolution: "completed";
        readonly evidenceArtifactId: ArtifactId;
        readonly outputArtifactId: ArtifactId;
        readonly terminal: EffectTerminal;
      }
    | {
        readonly effectId: EffectId;
        readonly resolution: "proven_not_executed";
        readonly evidenceArtifactId: ArtifactId;
      }
    | {
        readonly effectId: EffectId;
        readonly resolution: "not_executed_denied";
        readonly evidenceArtifactId: ArtifactId;
      };
  readonly tool_result_committed: BlobPayload<"tool"> & {
    readonly toolCallId: ToolCallId;
    readonly effectId: EffectId | null;
    readonly artifactId: ArtifactId | null;
    readonly sourceEventId: EventId;
    /**
     * Provider usage for a successful web_search tool result, used by the cost
     * projector. Absent for every other tool and for failed searches.
     */
    readonly searchUsage?: ToolResultSearchUsage | null;
  };
  readonly run_completed: {
    readonly commitBoundaryId: CommitBoundaryId;
    readonly sourceAssistantEventId: EventId;
  };
  readonly run_interrupted: {
    readonly reason:
      | "request_failed"
      | "semantic_interrupted"
      | "effect_indeterminate"
      | "integrity_violation"
      | "cancelled"
      | "durability_failure";
    readonly sourceEventId: EventId;
  };
  readonly journal_tail_recovered: {
    readonly recoveryRef: RecoveryRef;
    readonly recoveryHash: Sha256;
    readonly recoveryByteCount: number;
    readonly validPrefixSeq: number;
    readonly validPrefixHash: Sha256;
    readonly tailByteCount: number;
    readonly tailHash: Sha256;
  };
}

export type JournalEventType = keyof JournalPayloadByType;

export interface JournalEventScope {
  readonly lineageId?: LineageId;
  readonly runId?: RunId;
  readonly parentId?: EventId;
}

export type JournalEventDraft<Type extends JournalEventType = JournalEventType> =
  JournalEventScope & {
    readonly type: Type;
    readonly sessionId: SessionId;
    readonly payload: JournalPayloadByType[Type];
  };

export type AnyJournalEventDraft = {
  readonly [Type in JournalEventType]: JournalEventDraft<Type>;
}[JournalEventType];

export interface JournalEventPreimage<Type extends JournalEventType = JournalEventType>
  extends JournalEventScope {
  readonly v: 1;
  readonly seq: number;
  readonly id: EventId;
  readonly type: Type;
  readonly sessionId: SessionId;
  readonly at: CanonicalTimestamp;
  readonly payload: JournalPayloadByType[Type];
  readonly prevHash: Sha256 | null;
}

export interface VerifiedJournalEvent<
  Type extends JournalEventType = JournalEventType,
> extends JournalEventPreimage<Type> {
  readonly hash: Sha256;
}

export type AnyVerifiedJournalEvent = {
  readonly [Type in JournalEventType]: VerifiedJournalEvent<Type>;
}[JournalEventType];

export interface JournalHead {
  readonly seq: number;
  readonly hash: Sha256 | null;
}

export interface EventIdentitySource {
  nextEventId(): EventId;
}

export interface JournalClock {
  now(): CanonicalTimestamp;
}
