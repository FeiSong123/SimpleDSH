/**
 * Stage 07 recovery/crash freeze fixture.
 *
 * This module is deliberately data-only. It records the v1 crash contract for
 * later process-kill tests without implementing recovery or changing Journal
 * schema.
 */

export const RECOVERY_CRASH_MATRIX_VERSION = 1 as const;

export type RecoveryCrashPointIdV1 =
  | "J00"
  | "J01"
  | "B02"
  | "B03"
  | "S04"
  | "R05"
  | "R06"
  | "R07"
  | "R08"
  | "R09"
  | "A10"
  | "C11"
  | "E12"
  | "E13"
  | "E14"
  | "E15"
  | "T16"
  | "B17"
  | "B18"
  | "F19"
  | "F20"
  | "F21"
  | "F22";

export interface RecoveryCrashMatrixEntryV1 {
  readonly id: RecoveryCrashPointIdV1;
  readonly crashPoint: string;
  readonly durableTail: string;
  readonly allowedOutcome: string;
  readonly testName: string;
}

export interface GlobalDurabilityEnvelopeEntryV1 {
  readonly id:
    | "append_absent"
    | "append_torn_or_unsynced"
    | "append_complete"
    | "append_synced_unacknowledged"
    | "repair_convergence";
  readonly durableTail: string;
  readonly allowedOutcome: string;
}

export const RECOVERY_GLOBAL_DURABILITY_ENVELOPE_V1 = Object.freeze({
  version: RECOVERY_CRASH_MATRIX_VERSION,
  scope: "Every semantic crash point in RECOVERY_CRASH_MATRIX_V1.",
  outcomes: Object.freeze<readonly GlobalDurabilityEnvelopeEntryV1[]>([
    Object.freeze({
      id: "append_absent",
      durableTail:
        "The target event has no bytes in the valid replay prefix.",
      allowedOutcome:
        "Classify and recover from the immediately preceding matrix state; never infer the missing event from process memory or caller intent.",
    }),
    Object.freeze({
      id: "append_torn_or_unsynced",
      durableTail:
        "Replay observes the old valid prefix, or that prefix followed by a non-newline-terminated suffix from the target append.",
      allowedOutcome:
        "Treat the target event as absent. If a torn suffix exists, preserve the exact valid prefix and repair it to that prefix plus exactly one journal_tail_recovered event.",
    }),
    Object.freeze({
      id: "append_complete",
      durableTail:
        "Replay observes one complete canonical newline-terminated target event with valid sequence and hash linkage.",
      allowedOutcome:
        "Treat the complete event as authoritative exactly once and classify the matching matrix state; no partial decode or duplicate derivation is allowed.",
    }),
    Object.freeze({
      id: "append_synced_unacknowledged",
      durableTail:
        "The complete target event was synced, but the append caller crashed or failed before observing acknowledgement.",
      allowedOutcome:
        "Replay authority wins: retain the complete event and continue from it exactly once. The failed acknowledgement must not synthesize an absent event or a false interruption.",
    }),
    Object.freeze({
      id: "repair_convergence",
      durableTail:
        "A repair crash leaves either the prior torn Journal or the canonical replacement, depending on whether rename and directory sync became durable.",
      allowedOutcome:
        "Repeated open and repair converges to the exact valid prefix plus exactly one journal_tail_recovered fact; no clean-but-unreported rollback is allowed.",
    }),
  ]),
  testName:
    "journal append crash admits only old prefix torn repair or exact event",
});

export interface RequestCrashClosureV1 {
  readonly durableTail: string;
  readonly requestInterrupted: Readonly<{
    readonly type: "request_interrupted";
    readonly attemptId: "open_attempt.attemptId";
    readonly requestSnapshotId: "open_attempt.requestSnapshotId";
    readonly outcome: "durability_error";
    readonly status: null;
    readonly retryClass: "unknown";
    readonly semanticState: "post_semantic" | "semantic_state_unknown";
  }>;
  readonly runInterrupted: Readonly<{
    readonly type: "run_interrupted";
    readonly reason: "durability_failure";
    readonly sourceEventId: "request_interrupted.id";
  }>;
}

export const REQUEST_CRASH_MAPPING_V1 = Object.freeze({
  version: RECOVERY_CRASH_MATRIX_VERSION,
  withDurableSemanticStart: Object.freeze<RequestCrashClosureV1>({
    durableTail:
      "request_attempt_started and its matching request_semantic_started are both in the valid replay prefix, with no terminal event for the attempt.",
    requestInterrupted: Object.freeze({
      type: "request_interrupted",
      attemptId: "open_attempt.attemptId",
      requestSnapshotId: "open_attempt.requestSnapshotId",
      outcome: "durability_error",
      status: null,
      retryClass: "unknown",
      semanticState: "post_semantic",
    }),
    runInterrupted: Object.freeze({
      type: "run_interrupted",
      reason: "durability_failure",
      sourceEventId: "request_interrupted.id",
    }),
  }),
  withoutDurableSemanticStart: Object.freeze<RequestCrashClosureV1>({
    durableTail:
      "request_attempt_started is in the valid replay prefix, with no matching request_semantic_started and no terminal event for the attempt.",
    requestInterrupted: Object.freeze({
      type: "request_interrupted",
      attemptId: "open_attempt.attemptId",
      requestSnapshotId: "open_attempt.requestSnapshotId",
      outcome: "durability_error",
      status: null,
      retryClass: "unknown",
      semanticState: "semantic_state_unknown",
    }),
    runInterrupted: Object.freeze({
      type: "run_interrupted",
      reason: "durability_failure",
      sourceEventId: "request_interrupted.id",
    }),
  }),
  prohibition:
    "Process recovery never claims pre_semantic merely because an injector observed a crash before send or before the semantic barrier. No request_sent event or second recovery WAL is introduced.",
});

export const RECOVERY_CRASH_MATRIX_V1 = Object.freeze<
  readonly RecoveryCrashMatrixEntryV1[]
>([
  Object.freeze({
    id: "J00",
    crashPoint: "Any Journal append boundary.",
    durableTail:
      "One of the five states in RECOVERY_GLOBAL_DURABILITY_ENVELOPE_V1; never a partially decoded event.",
    allowedOutcome:
      "Replay and repair decide whether the target event is absent or present. Recovery then reclassifies facts and applies exactly one matching matrix transition.",
    testName:
      "journal append crash admits only old prefix torn repair or exact event",
  }),
  Object.freeze({
    id: "J01",
    crashPoint: "Any of the six atomic torn-tail repair fault points.",
    durableTail:
      "Before durable replacement, either the original valid-prefix-plus-torn-tail Journal or the canonical replacement; after directory sync, the canonical replacement.",
    allowedOutcome:
      "Opening repeatedly converges to the exact original valid prefix followed by exactly one journal_tail_recovered event.",
    testName:
      "torn repair crash before and after rename leaves one recovery fact",
  }),
  Object.freeze({
    id: "B02",
    crashPoint: "Initial user blob committed before its Commit Boundary.",
    durableTail:
      "The active Run ends at user_committed, and no Commit Boundary cites that user event and prefix.",
    allowedOutcome:
      "Append the unique same-Run user Commit Boundary, interrupt the old Run for durability failure, start one successor recovery Run, then follow B03.",
    testName: "recovery derives the missing user Boundary exactly once",
  }),
  Object.freeze({
    id: "B03",
    crashPoint: "Initial user Commit Boundary committed before any Snapshot.",
    durableTail:
      "The exact current safe prefix ends at the user Commit Boundary, and no Request Snapshot exists for that Boundary.",
    allowedOutcome:
      "Interrupt the old Run, start one successor recovery Run, invoke the Projector exactly once, and store a fresh Snapshot with recoveryFromSnapshotId=null before send.",
    testName:
      "recovery fresh projects an unprojected user Boundary in a new Run",
  }),
  Object.freeze({
    id: "S04",
    crashPoint: "Request Snapshot committed before request attempt or send.",
    durableTail:
      "A validated Snapshot for the exact current Commit Boundary is durable, with no request_attempt_started using it.",
    allowedOutcome:
      "Interrupt the old Run, start one successor recovery Run, store an exact alias of the durable Snapshot body and hash, and send from the alias without invoking the Projector.",
    testName:
      "recovery aliases a durable Snapshot after crash before attempt",
  }),
  Object.freeze({
    id: "R05",
    crashPoint:
      "request_attempt_started committed and the process crashes before physical send.",
    durableTail:
      "An open request attempt exists with no durable request_semantic_started or request terminal event.",
    allowedOutcome:
      "Apply REQUEST_CRASH_MAPPING_V1.withoutDurableSemanticStart, start one successor recovery Run, and alias the exact Snapshot bytes. Durable recovery remains semantic_state_unknown despite the injector proving pre-send.",
    testName:
      "crash before send closes the open attempt as semantic unknown",
  }),
  Object.freeze({
    id: "R06",
    crashPoint:
      "Physical send occurred and the process crashes before any durable semantic marker.",
    durableTail:
      "The same Journal tail as R05: an open attempt with no durable request_semantic_started or terminal event.",
    allowedOutcome:
      "Apply REQUEST_CRASH_MAPPING_V1.withoutDurableSemanticStart and continue only in a successor recovery Run using an exact Snapshot alias. Possible duplicate provider cost is visible but does not relax byte identity.",
    testName:
      "crash after send before semantic closes unknown and reuses exact bytes",
  }),
  Object.freeze({
    id: "R07",
    crashPoint:
      "First semantic fragment arrives while request_semantic_started is being durably acknowledged.",
    durableTail:
      "Either the R06 tail with no semantic marker, or the R08 tail with one complete request_semantic_started; the fragment itself is not a Journal fact.",
    allowedOutcome:
      "If the marker is absent, expose or stage no fragment and follow R06. If replay contains the marker, follow R08. No third state is legal.",
    testName:
      "semantic barrier crash before acknowledgement exposes no fragment",
  }),
  Object.freeze({
    id: "R08",
    crashPoint:
      "request_semantic_started committed and the response stream remains incomplete.",
    durableTail:
      "An open request attempt has a matching durable request_semantic_started and no assistant_committed or request_interrupted terminal event.",
    allowedOutcome:
      "Apply REQUEST_CRASH_MAPPING_V1.withDurableSemanticStart, discard all staging, start one successor recovery Run, and alias the exact Snapshot. Never retry transparently in the old Run.",
    testName:
      "crash after semantic acknowledgement discards staging and starts a new Run",
  }),
  Object.freeze({
    id: "R09",
    crashPoint:
      "The complete response is staged in memory before atomic assistant commit.",
    durableTail:
      "The R08 Journal tail: semantic start is durable, but assistant_committed and its native usage are both absent.",
    allowedOutcome:
      "Follow R08. Discard staging and commit no assistant blob, usage, Cache Checkpoint, or partial response fact.",
    testName:
      "complete staging before assistant commits no assistant or usage",
  }),
  Object.freeze({
    id: "A10",
    crashPoint: "Atomic assistant plus native usage append.",
    durableTail:
      "Either the R09 tail with assistant_committed absent, or one complete assistant_committed containing the response blob binding, request identity, provider metadata, semantic count, and native usage.",
    allowedOutcome:
      "If absent, follow R09. If present, retain assistant, reasoning, content or tool calls, and usage atomically, then derive exactly one Cache Checkpoint. Tool-calling responses continue at C11; final responses continue at F19.",
    testName: "atomic assistant and usage derive one Cache Checkpoint",
  }),
  Object.freeze({
    id: "C11",
    crashPoint:
      "Tool-calling assistant Cache Checkpoint committed before pending tools continue.",
    durableTail:
      "The tool-calling assistant and its unique Cache Checkpoint are durable, but pending tool calls prevent a Commit Boundary.",
    allowedOutcome:
      "Treat the Checkpoint only as a cache fact. Interrupt the old Run, start one successor recovery Run, and continue the exact pending calls in declaration order from their durable effect states.",
    testName:
      "tool checkpoint is not a Commit Boundary and recovery continues pending tools",
  }),
  Object.freeze({
    id: "E12",
    crashPoint: "Pending T2 call before effect_prepared becomes durable.",
    durableTail:
      "The pending call has no effect_prepared; permission_decided may be absent or durable.",
    allowedOutcome:
      "The T2 effect is proven not executed by protocol ordering. Interrupt the old Run, start one recovery Run, reuse any durable permission decision, and execute the call once. A T1 observation may be rerun.",
    testName: "pending T2 without prepared executes once in a new Run",
  }),
  Object.freeze({
    id: "E13",
    crashPoint:
      "effect_prepared committed and the process crashes before external invocation.",
    durableTail:
      "One prepared Effect exists with no effect_completed, effect_indeterminate, or effect_reconciled terminal fact.",
    allowedOutcome:
      "Append exactly one effect_indeterminate with reason crash_gap, interrupt the old Run with reason effect_indeterminate, start one recovery Run, and stop for explicit reconciliation. Never auto-retry, even when the injector knows invocation did not begin.",
    testName:
      "prepared before execute becomes indeterminate and never auto retries",
  }),
  Object.freeze({
    id: "E14",
    crashPoint:
      "External effect is executing or published, or an output Artifact is durable, before effect_completed.",
    durableTail:
      "The Effect remains prepared with no terminal Effect fact; an Artifact fact may be absent or present.",
    allowedOutcome:
      "Follow E13. External target state or an Artifact alone cannot prove completion, so recovery stops after recording indeterminate until explicit evidence reconciles it.",
    testName:
      "executed without completed remains indeterminate even with an output Artifact",
  }),
  Object.freeze({
    id: "E15",
    crashPoint:
      "effect_completed committed before its canonical tool_result_committed.",
    durableTail:
      "A validated completed Effect cites its durable output Artifact and terminal state, while its ordered tool call has no result event.",
    allowedOutcome:
      "Never execute again and never mark indeterminate. Interrupt the old Run, start one recovery Run, reconstruct the canonical bounded tool-result bytes from the existing Artifact and terminal fact, and commit exactly one result citing them.",
    testName:
      "completed effect reconstructs one exact tool result without execution",
  }),
  Object.freeze({
    id: "T16",
    crashPoint:
      "One or more ordered tool results committed before the full declared batch is complete.",
    durableTail:
      "A pending tool group contains an exact committed prefix of results and a non-empty missing declaration-order suffix; no complete-batch Boundary exists.",
    allowedOutcome:
      "Preserve the committed result prefix, interrupt the old Run, start one recovery Run, and process only the missing suffix. Apply E13/E14 to any prepared call and E15 to any completed call. Create no Snapshot or Boundary until the batch is complete.",
    testName: "partial tool batch resumes only the ordered missing suffix",
  }),
  Object.freeze({
    id: "B17",
    crashPoint:
      "The last ordered tool result committed before the complete-batch Commit Boundary.",
    durableTail:
      "Every declared tool call has exactly one ordered result, the last result belongs to the active Run, and no Boundary cites the complete result batch.",
    allowedOutcome:
      "Append exactly one same-Run Commit Boundary citing the complete ordered result set before any Run interruption. Earlier results may belong to predecessor recovery Runs.",
    testName:
      "complete tool batch derives one ordered Boundary before interruption",
  }),
  Object.freeze({
    id: "B18",
    crashPoint:
      "Complete tool-result batch Commit Boundary committed before the next Snapshot.",
    durableTail:
      "The exact current safe prefix ends at the tool-batch Boundary and has no Snapshot keyed to that Boundary.",
    allowedOutcome:
      "Interrupt the old Run if active, start one successor recovery Run, and fresh-project the current Boundary exactly once. Reject aliasing a Snapshot from any older Boundary.",
    testName:
      "tool Boundary recovery fresh projects current prefix and rejects stale alias",
  }),
  Object.freeze({
    id: "F19",
    crashPoint:
      "Final assistant_committed before its Cache Checkpoint is durable.",
    durableTail:
      "A final assistant with no tool calls is durable and places its active Run in finalizing state, with no Checkpoint, final Boundary, or run_completed.",
    allowedOutcome:
      "Do not interrupt or start a recovery Run. Append the unique same-Run Cache Checkpoint, then continue through F20 and F21 without another model send.",
    testName:
      "final assistant derives checkpoint Boundary and closure contiguously",
  }),
  Object.freeze({
    id: "F20",
    crashPoint:
      "Final assistant Cache Checkpoint committed before its Commit Boundary.",
    durableTail:
      "The final assistant and its unique Cache Checkpoint are durable in the finalizing Run, with no final Commit Boundary.",
    allowedOutcome:
      "Append exactly one same-Run final Commit Boundary citing only the final assistant and binding the final Cache Checkpoint, then continue through F21.",
    testName: "final checkpoint derives Boundary exactly once",
  }),
  Object.freeze({
    id: "F21",
    crashPoint: "Final Commit Boundary committed before run_completed.",
    durableTail:
      "The finalizing Run has its final assistant, Checkpoint, and exact final Commit Boundary, but no Run terminal event.",
    allowedOutcome:
      "Append only run_completed, citing the final Commit Boundary and final assistant. Do not append run_interrupted or start a recovery Run.",
    testName: "final Boundary derives only run_completed",
  }),
  Object.freeze({
    id: "F22",
    crashPoint: "run_completed append or acknowledgement boundary.",
    durableTail:
      "Either F21 with run_completed absent, or one complete run_completed event, including the synced-but-unacknowledged case.",
    allowedOutcome:
      "If absent, follow F21. If present, the Session is durably complete and recovery is a read-only no-op that appends no Run or recovery facts.",
    testName: "completed Run recovery is a no op",
  }),
]);

/**
 * Stage 07 review-cut extension.
 *
 * V1 remains exported above so the original R05-R09 mapping can be compared
 * byte-for-byte. V2 adds only the finite crash seams requested by the fresh
 * design review. It is still data-only: none of these tables execute recovery,
 * publish an Artifact, or mutate a Journal.
 */
export const RECOVERY_CRASH_MATRIX_VERSION_V2 = 2 as const;

export type RecoveryCrashPointIdV2 =
  | RecoveryCrashPointIdV1
  | "I02"
  | "I03"
  | "R09a"
  | "A10a"
  | "E12r"
  | "Q23"
  | "Q24"
  | "Q25"
  | "Q26";

export interface RecoveryCrashMatrixEntryV2 {
  readonly id: RecoveryCrashPointIdV2;
  readonly crashPoint: string;
  readonly durableTail: string;
  readonly allowedOutcome: string;
  readonly testName: string;
}

export type PartialInitializationCaseIdV2 =
  | "physical_bootstrap_without_session"
  | "session_started"
  | "cache_manifest_artifact"
  | "cache_abi_declared"
  | "lineage_started"
  | "lineage_activated"
  | "run_started"
  | "orphan_user_fact_artifact"
  | "user_input_fact"
  | "partial_environment_artifact"
  | "partial_environment_facts"
  | "all_source_facts_without_user";

export interface PartialInitializationCaseV2 {
  readonly id: PartialInitializationCaseIdV2;
  readonly matrixId: "I02" | "I03";
  readonly durableTail: string;
  readonly recoverableUserTask: false;
  readonly oldRunClosureUpperBound: 0 | 1;
  readonly allowedOutcome:
    | "read_only_incomplete"
    | "interrupt_old_run_once_then_stop";
  readonly forbidden: readonly (
    | "guess_fact_set"
    | "materialize_user"
    | "start_successor_run"
    | "project"
    | "send"
    | "invoke_tool"
    | "fabricate_run_terminal"
  )[];
}

const PRE_RUN_FORBIDDEN_V2 = Object.freeze([
  "guess_fact_set",
  "materialize_user",
  "start_successor_run",
  "project",
  "send",
  "invoke_tool",
  "fabricate_run_terminal",
] as const);

const RUN_WITHOUT_USER_FORBIDDEN_V2 = Object.freeze([
  "guess_fact_set",
  "materialize_user",
  "start_successor_run",
  "project",
  "send",
  "invoke_tool",
] as const);

export const RECOVERY_PARTIAL_INITIALIZATION_V2 = Object.freeze({
  version: RECOVERY_CRASH_MATRIX_VERSION_V2,
  authority:
    "Only a complete durable user_committed proves which optional date/cwd/git facts belong to the initial user materialization. Earlier facts remain evidence, not a recoverable user task.",
  cases: Object.freeze<readonly PartialInitializationCaseV2[]>([
    Object.freeze({
      id: "physical_bootstrap_without_session",
      matrixId: "I02",
      durableTail:
        "Secure directories, CAS namespace directories, or an empty synced log may exist, but there is no complete session_started valid prefix.",
      recoverableUserTask: false,
      oldRunClosureUpperBound: 0,
      allowedOutcome: "read_only_incomplete",
      forbidden: PRE_RUN_FORBIDDEN_V2,
    }),
    Object.freeze({
      id: "session_started",
      matrixId: "I02",
      durableTail:
        "session_started is the valid tail; no Cache ABI identity exists.",
      recoverableUserTask: false,
      oldRunClosureUpperBound: 0,
      allowedOutcome: "read_only_incomplete",
      forbidden: PRE_RUN_FORBIDDEN_V2,
    }),
    Object.freeze({
      id: "cache_manifest_artifact",
      matrixId: "I02",
      durableTail:
        "The Session-scoped Cache ABI manifest Artifact is durable, but cache_abi_declared is absent.",
      recoverableUserTask: false,
      oldRunClosureUpperBound: 0,
      allowedOutcome: "read_only_incomplete",
      forbidden: PRE_RUN_FORBIDDEN_V2,
    }),
    Object.freeze({
      id: "cache_abi_declared",
      matrixId: "I02",
      durableTail:
        "cache_abi_declared is durable; no Lineage identity exists.",
      recoverableUserTask: false,
      oldRunClosureUpperBound: 0,
      allowedOutcome: "read_only_incomplete",
      forbidden: PRE_RUN_FORBIDDEN_V2,
    }),
    Object.freeze({
      id: "lineage_started",
      matrixId: "I02",
      durableTail:
        "lineage_started is durable, but the Lineage is not activated and no Run exists.",
      recoverableUserTask: false,
      oldRunClosureUpperBound: 0,
      allowedOutcome: "read_only_incomplete",
      forbidden: PRE_RUN_FORBIDDEN_V2,
    }),
    Object.freeze({
      id: "lineage_activated",
      matrixId: "I02",
      durableTail:
        "The initial Lineage activation is durable, but run_started is absent.",
      recoverableUserTask: false,
      oldRunClosureUpperBound: 0,
      allowedOutcome: "read_only_incomplete",
      forbidden: PRE_RUN_FORBIDDEN_V2,
    }),
    Object.freeze({
      id: "run_started",
      matrixId: "I03",
      durableTail:
        "The initial user Run exists, but no Run-scoped input Artifact or user_input fact is durable.",
      recoverableUserTask: false,
      oldRunClosureUpperBound: 1,
      allowedOutcome: "interrupt_old_run_once_then_stop",
      forbidden: RUN_WITHOUT_USER_FORBIDDEN_V2,
    }),
    Object.freeze({
      id: "orphan_user_fact_artifact",
      matrixId: "I03",
      durableTail:
        "A Run-scoped fact Artifact is durable, but no fact_recorded event classifies it as user_input.",
      recoverableUserTask: false,
      oldRunClosureUpperBound: 1,
      allowedOutcome: "interrupt_old_run_once_then_stop",
      forbidden: RUN_WITHOUT_USER_FORBIDDEN_V2,
    }),
    Object.freeze({
      id: "user_input_fact",
      matrixId: "I03",
      durableTail:
        "The user_input Artifact and fact_recorded event are durable, but user_committed is absent and the optional environment-fact set is not known complete.",
      recoverableUserTask: false,
      oldRunClosureUpperBound: 1,
      allowedOutcome: "interrupt_old_run_once_then_stop",
      forbidden: RUN_WITHOUT_USER_FORBIDDEN_V2,
    }),
    Object.freeze({
      id: "partial_environment_artifact",
      matrixId: "I03",
      durableTail:
        "user_input is recorded and a later Run-scoped fact Artifact is durable, but its date/cwd/git fact_recorded event is absent.",
      recoverableUserTask: false,
      oldRunClosureUpperBound: 1,
      allowedOutcome: "interrupt_old_run_once_then_stop",
      forbidden: RUN_WITHOUT_USER_FORBIDDEN_V2,
    }),
    Object.freeze({
      id: "partial_environment_facts",
      matrixId: "I03",
      durableTail:
        "user_input and a strict prefix of date/cwd/git facts are durable, but user_committed is absent.",
      recoverableUserTask: false,
      oldRunClosureUpperBound: 1,
      allowedOutcome: "interrupt_old_run_once_then_stop",
      forbidden: RUN_WITHOUT_USER_FORBIDDEN_V2,
    }),
    Object.freeze({
      id: "all_source_facts_without_user",
      matrixId: "I03",
      durableTail:
        "The process had published every intended source fact, but user_committed is absent; Journal facts cannot prove that no additional optional fact was intended.",
      recoverableUserTask: false,
      oldRunClosureUpperBound: 1,
      allowedOutcome: "interrupt_old_run_once_then_stop",
      forbidden: RUN_WITHOUT_USER_FORBIDDEN_V2,
    }),
  ]),
  runClosure:
    "For I03, append at most one run_interrupted(reason=durability_failure) sourced to the last authoritative old-Run event, then stop. If that terminal already exists, recovery is read-only. I02 has no Run to terminalize.",
});

export interface T1ArtifactAuthorityCaseV2 {
  readonly id: "unreferenced_cas_bytes" | "durable_artifact_event";
  readonly durableTail: string;
  readonly artifactIsJournalFact: boolean;
  readonly allowedAction: "rerun_read" | "reconstruct_result";
  readonly additionalReadInvocationsUpperBound: 0 | 1;
  readonly additionalArtifactEventsUpperBound: 0 | 1;
  readonly additionalToolResultsUpperBound: 1;
}

export const RECOVERY_T1_ARTIFACT_AUTHORITY_V2 = Object.freeze({
  version: RECOVERY_CRASH_MATRIX_VERSION_V2,
  cases: Object.freeze<readonly T1ArtifactAuthorityCaseV2[]>([
    Object.freeze({
      id: "unreferenced_cas_bytes",
      durableTail:
        "CAS bytes may exist, but artifact_published is absent from the valid Journal prefix.",
      artifactIsJournalFact: false,
      allowedAction: "rerun_read",
      additionalReadInvocationsUpperBound: 1,
      additionalArtifactEventsUpperBound: 1,
      additionalToolResultsUpperBound: 1,
    }),
    Object.freeze({
      id: "durable_artifact_event",
      durableTail:
        "The T1 read tool_output artifact_published event, exact Artifact bytes, and its read terminal are durable; tool_result_committed is absent.",
      artifactIsJournalFact: true,
      allowedAction: "reconstruct_result",
      additionalReadInvocationsUpperBound: 0,
      additionalArtifactEventsUpperBound: 0,
      additionalToolResultsUpperBound: 1,
    }),
  ]),
  convergence:
    "After the reconstructed result is durable, repeated recovery appends no second result or Artifact and never observes the filesystem again.",
});

export interface RequestDerivedTerminalSeamV2 {
  readonly id:
    | "request_interrupted_before_run_interrupted"
    | "assistant_before_checkpoint"
    | "tool_checkpoint_before_pending_continuation"
    | "final_checkpoint_before_final_boundary";
  readonly durableTail: string;
  readonly nextAction: string;
  readonly additionalRequestTerminalsUpperBound: 0;
  readonly additionalCheckpointsUpperBound: 0 | 1;
}

export const RECOVERY_REQUEST_DERIVED_TERMINALS_V2 = Object.freeze({
  version: RECOVERY_CRASH_MATRIX_VERSION_V2,
  cases: Object.freeze<readonly RequestDerivedTerminalSeamV2[]>([
    Object.freeze({
      id: "request_interrupted_before_run_interrupted",
      durableTail:
        "One request_interrupted terminal for the attempt is durable; the required old-Run interruption is absent.",
      nextAction:
        "Retain that sole request terminal and append only the sourced old-Run interruption before recovery continuation.",
      additionalRequestTerminalsUpperBound: 0,
      additionalCheckpointsUpperBound: 0,
    }),
    Object.freeze({
      id: "assistant_before_checkpoint",
      durableTail:
        "One assistant_committed atomically terminalizes its successful attempt; its derived Cache Checkpoint is absent.",
      nextAction:
        "Retain the assistant terminal and derive exactly one Cache Checkpoint keyed by its source assistant event.",
      additionalRequestTerminalsUpperBound: 0,
      additionalCheckpointsUpperBound: 1,
    }),
    Object.freeze({
      id: "tool_checkpoint_before_pending_continuation",
      durableTail:
        "The tool-calling assistant and its unique Cache Checkpoint are durable; pending tool continuation has not advanced.",
      nextAction:
        "Append neither assistant nor Checkpoint; continue only the declaration-order pending tool suffix under C11/E12-E15/E12r.",
      additionalRequestTerminalsUpperBound: 0,
      additionalCheckpointsUpperBound: 0,
    }),
    Object.freeze({
      id: "final_checkpoint_before_final_boundary",
      durableTail:
        "The final assistant and its unique Cache Checkpoint are durable; final Boundary and run_completed are absent.",
      nextAction:
        "Append neither assistant nor Checkpoint; derive only the missing F20/F21 deterministic tail.",
      additionalRequestTerminalsUpperBound: 0,
      additionalCheckpointsUpperBound: 0,
    }),
  ]),
  convergence:
    "Every derived event is keyed to its durable source. Replaying after any later kill observes the existing terminal or Checkpoint and advances to the next missing action without duplicating it.",
});

export type ReconciliationSeamIdV2 =
  | "q23_completed_evidence"
  | "q23_not_executed_evidence"
  | "q24_completed_output"
  | "q25_completed_resolution"
  | "q25_not_executed_resolution"
  | "q26_result"
  | "q26_boundary"
  | "q26_snapshot";

export interface ReconciliationSeamV2 {
  readonly id: ReconciliationSeamIdV2;
  readonly matrixId: "Q23" | "Q24" | "Q25" | "Q26";
  readonly durableTail: string;
  readonly nextAction: string;
  readonly additionalEvidenceArtifactsUpperBound: 0;
  readonly additionalOutputArtifactsUpperBound: 0 | 1;
  readonly additionalReconciliationEventsUpperBound: 0 | 1;
  readonly additionalToolResultsUpperBound: 0 | 1;
  readonly additionalExternalInvocationsUpperBound: 0 | 1;
}

export const RECOVERY_RECONCILIATION_SEAMS_V2 = Object.freeze({
  version: RECOVERY_CRASH_MATRIX_VERSION_V2,
  cases: Object.freeze<readonly ReconciliationSeamV2[]>([
    Object.freeze({
      id: "q23_completed_evidence",
      matrixId: "Q23",
      durableTail:
        "The exact operator_evidence Artifact and its artifact_published event are durable for a completed resolution; output Artifact and effect_reconciled are absent.",
      nextAction:
        "Reuse the evidence id and deterministically publish the declared framed output Artifact; do not invoke the external tool.",
      additionalEvidenceArtifactsUpperBound: 0,
      additionalOutputArtifactsUpperBound: 1,
      additionalReconciliationEventsUpperBound: 1,
      additionalToolResultsUpperBound: 1,
      additionalExternalInvocationsUpperBound: 0,
    }),
    Object.freeze({
      id: "q23_not_executed_evidence",
      matrixId: "Q23",
      durableTail:
        "The exact operator_evidence Artifact and its artifact_published event are durable for proven_not_executed; effect_reconciled is absent and no output Artifact is permitted.",
      nextAction:
        "Reuse the evidence id and append one proven_not_executed reconciliation, then follow Q25 without republishing evidence.",
      additionalEvidenceArtifactsUpperBound: 0,
      additionalOutputArtifactsUpperBound: 0,
      additionalReconciliationEventsUpperBound: 1,
      additionalToolResultsUpperBound: 1,
      additionalExternalInvocationsUpperBound: 1,
    }),
    Object.freeze({
      id: "q24_completed_output",
      matrixId: "Q24",
      durableTail:
        "The exact operator evidence and completed-resolution tool_output Artifact events are durable; effect_reconciled is absent.",
      nextAction:
        "Reuse both Artifact ids and append one completed reconciliation; publish neither Artifact again and invoke no external tool.",
      additionalEvidenceArtifactsUpperBound: 0,
      additionalOutputArtifactsUpperBound: 0,
      additionalReconciliationEventsUpperBound: 1,
      additionalToolResultsUpperBound: 1,
      additionalExternalInvocationsUpperBound: 0,
    }),
    Object.freeze({
      id: "q25_completed_resolution",
      matrixId: "Q25",
      durableTail:
        "effect_reconciled(completed) is durable with exact evidence/output ids; canonical tool_result_committed is absent.",
      nextAction:
        "Reconstruct one canonical result from the durable output and terminal; append no reconciliation or Artifact and invoke no external tool.",
      additionalEvidenceArtifactsUpperBound: 0,
      additionalOutputArtifactsUpperBound: 0,
      additionalReconciliationEventsUpperBound: 0,
      additionalToolResultsUpperBound: 1,
      additionalExternalInvocationsUpperBound: 0,
    }),
    Object.freeze({
      id: "q25_not_executed_resolution",
      matrixId: "Q25",
      durableTail:
        "effect_reconciled(proven_not_executed) is durable; no successor Effect or tool result exists.",
      nextAction:
        "Execute the pending T2 at most once under a new effect_prepared. A later crash gap follows E13 and never retries that external invocation.",
      additionalEvidenceArtifactsUpperBound: 0,
      additionalOutputArtifactsUpperBound: 1,
      additionalReconciliationEventsUpperBound: 0,
      additionalToolResultsUpperBound: 1,
      additionalExternalInvocationsUpperBound: 1,
    }),
    Object.freeze({
      id: "q26_result",
      matrixId: "Q26",
      durableTail:
        "The canonical reconciled tool result is durable; its complete-batch Commit Boundary is absent.",
      nextAction:
        "Retain result/evidence/output/reconciliation and derive only the unique declaration-order Boundary.",
      additionalEvidenceArtifactsUpperBound: 0,
      additionalOutputArtifactsUpperBound: 0,
      additionalReconciliationEventsUpperBound: 0,
      additionalToolResultsUpperBound: 0,
      additionalExternalInvocationsUpperBound: 0,
    }),
    Object.freeze({
      id: "q26_boundary",
      matrixId: "Q26",
      durableTail:
        "The reconciled result batch and its Commit Boundary are durable; the next Snapshot is absent.",
      nextAction:
        "Retain all reconciliation facts and fresh-project this never-projected Boundary once under B18.",
      additionalEvidenceArtifactsUpperBound: 0,
      additionalOutputArtifactsUpperBound: 0,
      additionalReconciliationEventsUpperBound: 0,
      additionalToolResultsUpperBound: 0,
      additionalExternalInvocationsUpperBound: 0,
    }),
    Object.freeze({
      id: "q26_snapshot",
      matrixId: "Q26",
      durableTail:
        "The continuation Snapshot is durable; a later crash occurs before or during its request continuation.",
      nextAction:
        "Retain every reconciliation/result fact and follow S04/R05-R09 using exact Snapshot bytes; never replay the reconciled effect.",
      additionalEvidenceArtifactsUpperBound: 0,
      additionalOutputArtifactsUpperBound: 0,
      additionalReconciliationEventsUpperBound: 0,
      additionalToolResultsUpperBound: 0,
      additionalExternalInvocationsUpperBound: 0,
    }),
  ]),
  convergence:
    "After every acknowledged append, recovery reclassifies from Journal facts and performs at most one next action. Arbitrarily many repeated recovery passes therefore converge without duplicate evidence Artifact, output Artifact, effect_reconciled, tool result, request terminal, or external effect.",
});

const RECOVERY_CRASH_MATRIX_REVIEW_CUTS_V2 = Object.freeze<
  readonly RecoveryCrashMatrixEntryV2[]
>([
  Object.freeze({
    id: "I02",
    crashPoint:
      "Any partial physical or identity bootstrap seam before run_started.",
    durableTail:
      "One exact RECOVERY_PARTIAL_INITIALIZATION_V2 I02 prefix; no user Run or complete durable user task exists.",
    allowedOutcome:
      "Report incomplete bootstrap read-only and fail closed. Do not create a Run terminal, infer identity, guess input, project, send, or invoke a tool.",
    testName:
      "partial bootstrap before Run stays read only and invents no task",
  }),
  Object.freeze({
    id: "I03",
    crashPoint:
      "run_started or any source-fact append before user_committed becomes durable.",
    durableTail:
      "One exact RECOVERY_PARTIAL_INITIALIZATION_V2 I03 prefix; optional date/cwd/git membership cannot be proven complete.",
    allowedOutcome:
      "Append at most one sourced run_interrupted(durability_failure) for the old Run and stop. Preserve facts as evidence, but create no user blob, successor Run, Snapshot, send, or tool invocation.",
    testName:
      "partial user bootstrap interrupts once and never guesses optional facts",
  }),
  Object.freeze({
    id: "R09a",
    crashPoint:
      "request_interrupted is durable and the process dies before the required old-Run closure.",
    durableTail:
      "The attempt already has exactly one request-derived terminal and no matching old-Run interruption.",
    allowedOutcome:
      "Preserve the sole request_interrupted event, append only the sourced run_interrupted required by its durable classification, and then recover. Never append a second request terminal.",
    testName:
      "durable request interruption is never terminalized twice",
  }),
  Object.freeze({
    id: "A10a",
    crashPoint:
      "Any kill after durable assistant_committed or after its derived Cache Checkpoint acknowledgement.",
    durableTail:
      "One assistant request terminal is durable; its unique Checkpoint is either absent or durable, and its tool/final continuation may be absent.",
    allowedOutcome:
      "If the Checkpoint is absent, derive it once. Otherwise append neither assistant nor Checkpoint and continue only at C11 or F20. Source-keyed replay makes later recovery a no-op for every existing fact.",
    testName:
      "assistant terminal and derived checkpoint each converge exactly once",
  }),
  Object.freeze({
    id: "E12r",
    crashPoint:
      "A T1 read output Artifact is committed before its canonical tool result.",
    durableTail:
      "artifact_published proves the exact read bytes, metadata, and terminal; tool_result_committed is absent.",
    allowedOutcome:
      "Reconstruct and append exactly one bounded canonical result from that Artifact. Never re-read external state and never publish a replacement Artifact.",
    testName:
      "durable T1 Artifact reconstructs one result without reread",
  }),
  Object.freeze({
    id: "Q23",
    crashPoint:
      "Reconciliation evidence Artifact is committed before any completed-resolution output Artifact or effect_reconciled.",
    durableTail:
      "The exact operator_evidence Artifact event is authoritative; later reconciliation facts are absent.",
    allowedOutcome:
      "Reuse evidence exactly. Build at most one declared output for completed, none for proven_not_executed, then append at most one reconciliation. Invoke no external tool before a proven_not_executed resolution is durable.",
    testName:
      "reconciliation reuses durable evidence across repeated recovery",
  }),
  Object.freeze({
    id: "Q24",
    crashPoint:
      "Completed-reconciliation output Artifact is committed before effect_reconciled.",
    durableTail:
      "Exact evidence and output Artifact events are durable; reconciliation is absent.",
    allowedOutcome:
      "Reuse both Artifacts and append exactly one completed effect_reconciled. Never republish output or invoke the external tool.",
    testName:
      "reconciliation reuses durable output before one resolution event",
  }),
  Object.freeze({
    id: "Q25",
    crashPoint:
      "effect_reconciled is committed before its canonical result or lawful continuation.",
    durableTail:
      "One explicit completed or proven_not_executed reconciliation is authoritative.",
    allowedOutcome:
      "Never duplicate evidence, output, or reconciliation. Completed reconstructs one result without execution; proven_not_executed may execute one newly prepared T2, whose later crash gap follows E13.",
    testName:
      "durable reconciliation selects one result or one new prepared effect",
  }),
  Object.freeze({
    id: "Q26",
    crashPoint:
      "Any acknowledgement seam after reconciled tool result through Boundary, Snapshot, and request continuation.",
    durableTail:
      "A strict prefix of the normal post-reconciliation continuation is durable.",
    allowedOutcome:
      "One-action reclassification derives only the next missing fact. Repeated recovery never duplicates result, Effect, Snapshot, request terminal, evidence/output Artifact, reconciliation, or external execution.",
    testName:
      "reconciled continuation converges after every acknowledgement seam",
  }),
]);

export const RECOVERY_CRASH_MATRIX_V2 = Object.freeze({
  version: RECOVERY_CRASH_MATRIX_VERSION_V2,
  entries: Object.freeze<readonly RecoveryCrashMatrixEntryV2[]>([
    ...RECOVERY_CRASH_MATRIX_V1,
    ...RECOVERY_CRASH_MATRIX_REVIEW_CUTS_V2,
  ]),
  preservedRequestClosureIds: Object.freeze([
    "R05",
    "R06",
    "R07",
    "R08",
    "R09",
  ] as const),
  partialInitialization: RECOVERY_PARTIAL_INITIALIZATION_V2,
  t1ArtifactAuthority: RECOVERY_T1_ARTIFACT_AUTHORITY_V2,
  requestDerivedTerminals: RECOVERY_REQUEST_DERIVED_TERMINALS_V2,
  reconciliation: RECOVERY_RECONCILIATION_SEAMS_V2,
});
