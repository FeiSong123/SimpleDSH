import type {
  AnyVerifiedJournalEvent,
  ArtifactId,
  AttemptId,
  CacheCheckpointId,
  CommitBoundaryId,
  EffectId,
  EventId,
  RecoveryViewV1,
  RequestSnapshotId,
  RunId,
  ToolCallId,
} from "../journal/index.js";

type RecoveryRun = RecoveryViewV1["runs"][number];
type RecoverySnapshot = RecoveryViewV1["snapshots"][number];
type RecoveryBoundary = RecoveryViewV1["boundaries"][number];
type RecoveryEffect = RecoveryViewV1["effects"][number];

export type RecoveryStepV1 =
  | Readonly<{ readonly kind: "incomplete_bootstrap" }>
  | Readonly<{
      readonly kind: "close_open_attempt";
      readonly runId: RunId;
      readonly attemptId: AttemptId;
      readonly requestSnapshotId: RequestSnapshotId;
      readonly semanticState: "post_semantic" | "semantic_state_unknown";
    }>
  | Readonly<{
      readonly kind: "append_checkpoint";
      readonly runId: RunId;
      readonly assistantEventId: EventId;
    }>
  | Readonly<{
      readonly kind: "append_boundary";
      readonly runId: RunId;
      readonly sourceEventIds: readonly EventId[];
      readonly cacheCheckpointId: CacheCheckpointId | null;
    }>
  | Readonly<{
      readonly kind: "mark_effect_indeterminate";
      readonly runId: RunId;
      readonly effectId: EffectId;
    }>
  | Readonly<{
      readonly kind: "complete_run";
      readonly runId: RunId;
      readonly commitBoundaryId: CommitBoundaryId;
      readonly sourceAssistantEventId: EventId;
    }>
  | Readonly<{
      readonly kind: "interrupt_run";
      readonly runId: RunId;
      readonly reason: "effect_indeterminate" | "durability_failure";
      readonly sourceEventId: EventId;
    }>
  | Readonly<{
      readonly kind: "start_recovery_run";
      readonly previousRunId: RunId;
    }>
  | Readonly<{
      readonly kind: "stop_indeterminate";
      readonly effectId: EffectId;
    }>
  | Readonly<{
      readonly kind: "resume_tool";
      readonly runId: RunId;
      readonly assistantEventId: EventId;
      readonly toolCallId: ToolCallId;
      readonly mode: "execute" | "reconstruct" | "deny";
      readonly effectId: EffectId | null;
      readonly artifactId: ArtifactId | null;
      readonly sourceEventId: EventId | null;
    }>
  | Readonly<{
      readonly kind: "store_snapshot";
      readonly runId: RunId;
      readonly commitBoundaryId: CommitBoundaryId;
      readonly mode: "fresh" | "alias";
      readonly sourceSnapshotId: RequestSnapshotId | null;
    }>
  | Readonly<{
      readonly kind: "send_snapshot";
      readonly runId: RunId;
      readonly requestSnapshotId: RequestSnapshotId;
    }>
  | Readonly<{
      readonly kind: "completed";
      readonly runId: RunId;
      readonly commitBoundaryId: CommitBoundaryId;
      readonly sourceAssistantEventId: EventId;
    }>;

function invalidRecoveryState(): never {
  throw new TypeError("verified Journal has no lawful recovery transition");
}

function eventById(
  events: readonly AnyVerifiedJournalEvent[],
  eventId: string,
): AnyVerifiedJournalEvent {
  const event = events.find((candidate) => candidate.id === eventId);
  return event ?? invalidRecoveryState();
}

function activeRun(view: RecoveryViewV1): RecoveryRun | undefined {
  if (view.activeRunId === undefined) return undefined;
  const run = view.runs.find(({ runId }) => runId === view.activeRunId);
  if (run?.status !== "active") invalidRecoveryState();
  return run;
}

function latestRun(view: RecoveryViewV1): RecoveryRun | undefined {
  return view.runs.at(-1);
}

function latestRunEvent(
  events: readonly AnyVerifiedJournalEvent[],
  runId: string,
): AnyVerifiedJournalEvent {
  return events.findLast((event) => event.runId === runId) ?? invalidRecoveryState();
}

function currentBoundary(view: RecoveryViewV1): RecoveryBoundary {
  const matches = view.boundaries.filter(
    ({ lineageId, payload }) =>
      lineageId === view.activeLineageId &&
      payload.blobCount === view.currentPrefix.blobCount &&
      payload.chainHash === view.currentPrefix.chainHash,
  );
  if (matches.length !== 1) invalidRecoveryState();
  return matches[0]!;
}

function snapshotForCurrentBoundary(
  view: RecoveryViewV1,
  boundary: RecoveryBoundary,
): RecoverySnapshot | undefined {
  return view.snapshots.findLast(
    ({ payload }) =>
      payload.commitBoundaryId === boundary.payload.commitBoundaryId,
  );
}

function unresolvedIndeterminate(
  view: RecoveryViewV1,
): RecoveryEffect | undefined {
  return view.effects.find(({ status }) => status === "indeterminate");
}

function pendingEffect(
  view: RecoveryViewV1,
  toolCallId: string,
): RecoveryEffect | undefined {
  return view.effects.findLast((effect) => effect.toolCallId === toolCallId);
}

function directArtifact(
  view: RecoveryViewV1,
  toolCallId: string,
): RecoveryViewV1["artifacts"][number] | undefined {
  return view.artifacts.findLast(
    ({ payload }) =>
      payload.artifactType === "tool_output" &&
      payload.toolCallId === toolCallId &&
      payload.terminal !== null,
  );
}

function completionStep(
  run: RecoveryRun,
): Extract<RecoveryStepV1, { readonly kind: "completed" }> {
  if (
    run.finalAssistantEventId === null ||
    run.finalBoundaryId === null
  ) {
    return invalidRecoveryState();
  }
  return Object.freeze({
    kind: "completed",
    runId: run.runId as RunId,
    commitBoundaryId: run.finalBoundaryId as CommitBoundaryId,
    sourceAssistantEventId: run.finalAssistantEventId as EventId,
  });
}

/**
 * Select exactly one transition from the already-verified binding projection.
 * This is a planner, not a reducer: it never derives facts independently of
 * JournalBindingProjection and must be called again after every acknowledged
 * append.
 */
export function planRecoveryStepV1(
  view: RecoveryViewV1,
  events: readonly AnyVerifiedJournalEvent[],
): RecoveryStepV1 {
  const current = activeRun(view);
  const last = latestRun(view);
  const hasUser = events.some(
    (event) =>
      event.type === "user_committed" &&
      event.lineageId === view.activeLineageId,
  );

  if (!hasUser) {
    if (current === undefined) {
      return Object.freeze({ kind: "incomplete_bootstrap" });
    }
    const source = latestRunEvent(events, current.runId);
    return Object.freeze({
      kind: "interrupt_run",
      runId: current.runId as RunId,
      reason: "durability_failure",
      sourceEventId: source.id,
    });
  }

  if (current === undefined) {
    if (last === undefined) return invalidRecoveryState();
    if (last.status === "completed") return completionStep(last);
    if (last.status !== "interrupted") return invalidRecoveryState();
    return Object.freeze({
      kind: "start_recovery_run",
      previousRunId: last.runId as RunId,
    });
  }

  const openAttempt = view.attempts.find(
    ({ runId, terminalType }) =>
      runId === current.runId && terminalType === null,
  );
  if (openAttempt !== undefined) {
    return Object.freeze({
      kind: "close_open_attempt",
      runId: current.runId as RunId,
      attemptId: openAttempt.attemptId as AttemptId,
      requestSnapshotId: openAttempt.requestSnapshotId as RequestSnapshotId,
      semanticState: openAttempt.semanticStarted
        ? "post_semantic"
        : "semantic_state_unknown",
    });
  }

  if (current.phase === "must_interrupt") {
    const source = latestRunEvent(events, current.runId);
    return Object.freeze({
      kind: "interrupt_run",
      runId: current.runId as RunId,
      reason: "durability_failure",
      sourceEventId: source.id,
    });
  }

  if (current.pendingAssistantCheckpointEventId !== null) {
    return Object.freeze({
      kind: "append_checkpoint",
      runId: current.runId as RunId,
      assistantEventId:
        current.pendingAssistantCheckpointEventId as EventId,
    });
  }

  if (current.phase === "finalizing") {
    if (current.finalAssistantEventId === null) return invalidRecoveryState();
    if (current.finalCheckpointId === null) {
      return Object.freeze({
        kind: "append_checkpoint",
        runId: current.runId as RunId,
        assistantEventId: current.finalAssistantEventId as EventId,
      });
    }
    if (current.finalBoundaryId === null) {
      return Object.freeze({
        kind: "append_boundary",
        runId: current.runId as RunId,
        sourceEventIds: Object.freeze([
          current.finalAssistantEventId as EventId,
        ]),
        cacheCheckpointId: current.finalCheckpointId as CacheCheckpointId,
      });
    }
    return Object.freeze({
      kind: "complete_run",
      runId: current.runId as RunId,
      commitBoundaryId: current.finalBoundaryId as CommitBoundaryId,
      sourceAssistantEventId: current.finalAssistantEventId as EventId,
    });
  }

  if (current.pendingBoundarySourceEventIds !== null) {
    return Object.freeze({
      kind: "append_boundary",
      runId: current.runId as RunId,
      sourceEventIds: current.pendingBoundarySourceEventIds as readonly EventId[],
      cacheCheckpointId: null,
    });
  }

  const prepared = view.effects.find(({ status }) => status === "prepared");
  if (prepared !== undefined) {
    return Object.freeze({
      kind: "mark_effect_indeterminate",
      runId: current.runId as RunId,
      effectId: prepared.effectId as EffectId,
    });
  }

  const indeterminate = unresolvedIndeterminate(view);
  if (indeterminate !== undefined && indeterminate.runId === current.runId) {
    if (indeterminate.terminalEventId === null) return invalidRecoveryState();
    return Object.freeze({
      kind: "interrupt_run",
      runId: current.runId as RunId,
      reason: "effect_indeterminate",
      sourceEventId: indeterminate.terminalEventId as EventId,
    });
  }

  if (current.cause !== "recovery") {
    const source = latestRunEvent(events, current.runId);
    return Object.freeze({
      kind: "interrupt_run",
      runId: current.runId as RunId,
      reason: "durability_failure",
      sourceEventId: source.id,
    });
  }

  if (indeterminate !== undefined) {
    return Object.freeze({
      kind: "stop_indeterminate",
      effectId: indeterminate.effectId as EffectId,
    });
  }

  const pending = view.pendingToolGroup;
  if (pending !== null) {
    const toolCallId = pending.callIds[pending.nextResultOrdinal];
    if (toolCallId === undefined) return invalidRecoveryState();
    const effect = pendingEffect(view, toolCallId);
    if (
      effect?.status === "completed" ||
      effect?.status === "reconciled_completed"
    ) {
      if (
        effect.outputArtifactId === null ||
        effect.terminalEventId === null
      ) {
        return invalidRecoveryState();
      }
      return Object.freeze({
        kind: "resume_tool",
        runId: current.runId as RunId,
        assistantEventId: pending.assistantEventId as EventId,
        toolCallId: toolCallId as ToolCallId,
        mode: "reconstruct",
        effectId: effect.effectId as EffectId,
        artifactId: effect.outputArtifactId as ArtifactId,
        sourceEventId: effect.terminalEventId as EventId,
      });
    }
    if (effect?.status === "indeterminate") {
      return Object.freeze({
        kind: "stop_indeterminate",
        effectId: effect.effectId as EffectId,
      });
    }
    if (effect?.status === "prepared") return invalidRecoveryState();
    if (effect?.status === "reconciled_denied") {
      if (effect.terminalEventId === null) return invalidRecoveryState();
      return Object.freeze({
        kind: "resume_tool",
        runId: current.runId as RunId,
        assistantEventId: pending.assistantEventId as EventId,
        toolCallId: toolCallId as ToolCallId,
        mode: "deny",
        effectId: effect.effectId as EffectId,
        artifactId: null,
        sourceEventId: effect.terminalEventId as EventId,
      });
    }
    if (effect === undefined) {
      const artifact = directArtifact(view, toolCallId);
      if (artifact !== undefined) {
        return Object.freeze({
          kind: "resume_tool",
          runId: current.runId as RunId,
          assistantEventId: pending.assistantEventId as EventId,
          toolCallId: toolCallId as ToolCallId,
          mode: "reconstruct",
          effectId: null,
          artifactId: artifact.artifactId as ArtifactId,
          sourceEventId: artifact.eventId as EventId,
        });
      }
    }
    return Object.freeze({
      kind: "resume_tool",
      runId: current.runId as RunId,
      assistantEventId: pending.assistantEventId as EventId,
      toolCallId: toolCallId as ToolCallId,
      mode: "execute",
      effectId: null,
      artifactId: null,
      sourceEventId: null,
    });
  }

  const boundary = currentBoundary(view);
  const snapshot = snapshotForCurrentBoundary(view, boundary);
  const currentRunSnapshots = view.snapshots.filter(
    ({ runId, payload }) =>
      runId === current.runId &&
      payload.commitBoundaryId === boundary.payload.commitBoundaryId,
  );
  const currentSnapshot = currentRunSnapshots.at(-1);
  if (currentSnapshot !== undefined) {
    const attempts = view.attempts.filter(
      ({ requestSnapshotId }) =>
        requestSnapshotId === currentSnapshot.payload.requestSnapshotId,
    );
    if (attempts.length === 0) {
      return Object.freeze({
        kind: "send_snapshot",
        runId: current.runId as RunId,
        requestSnapshotId:
          currentSnapshot.payload.requestSnapshotId as RequestSnapshotId,
      });
    }
    const source = latestRunEvent(events, current.runId);
    return Object.freeze({
      kind: "interrupt_run",
      runId: current.runId as RunId,
      reason: "durability_failure",
      sourceEventId: source.id,
    });
  }

  return Object.freeze({
    kind: "store_snapshot",
    runId: current.runId as RunId,
    commitBoundaryId: boundary.payload.commitBoundaryId,
    mode: snapshot === undefined ? "fresh" : "alias",
    sourceSnapshotId:
      snapshot === undefined
        ? null
        : (snapshot.payload.requestSnapshotId as RequestSnapshotId),
  });
}

export function recoveryEventById<Type extends AnyVerifiedJournalEvent["type"]>(
  events: readonly AnyVerifiedJournalEvent[],
  eventId: string,
  type: Type,
): Extract<AnyVerifiedJournalEvent, { readonly type: Type }> {
  const event = eventById(events, eventId);
  if (event.type !== type) return invalidRecoveryState();
  return event as Extract<AnyVerifiedJournalEvent, { readonly type: Type }>;
}
