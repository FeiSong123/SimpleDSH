import {
  bytesEqual,
  concatBytes,
  fromBase64,
  lengthPrefix,
  sha256Hex,
  utf8Bytes,
} from "../bytes/ops.js";
import {
  materializeToolResultMessage,
  parseToolResultContentForProfile,
  TOOL_RESULT_PROJECTION_LIMIT_BYTES,
} from "../bytes/tool-result.js";
import type {
  StaticToolResultContent,
  ToolResultProfile,
} from "../bytes/tool-result.js";
import type { FrozenBytes } from "../bytes/types.js";
import {
  toolSchemaProfileForBytes,
  type ToolSchemaProfile,
} from "../bytes/schemas.js";
import { viewAssistant, viewTool, viewUser } from "../bytes/view.js";
import { createToolOutputFrameParser } from "../artifact/tool-output.js";
import type { ToolOutputFrameSummary } from "../artifact/tool-output.js";
import type { ToolTerminalSource } from "../artifact/tool-terminal-source.js";
import {
  loadCacheAbi,
  toolResultProfileForCacheAbi,
} from "../lineage/cache-abi.js";
import { createArtifactToolResultProjector } from "../artifact/tool-result.js";
import {
  validateToolArgumentsForProfile,
} from "../bytes/tool-arguments.js";
import type {
  StaticToolValidationCode,
  ToolName,
  ValidatedToolArguments,
} from "../bytes/tool-arguments.js";
import { isCommitClosureV1 } from "./closure.js";
import { journalError } from "./errors.js";
import type { JournalAppendPreflight, PreparedJournalAppend } from "./writer.js";
import type {
  AnyVerifiedJournalEvent,
  BlobPayload,
  BlobRef,
  JournalEventType,
  JournalPayloadByType,
  Sha256,
  SnapshotRef,
  ToolTerminal,
} from "./types.js";

interface EventBinding {
  readonly type: JournalEventType;
  readonly event: AnyVerifiedJournalEvent;
}

type ObjectKind =
  | "cache_abi"
  | "lineage"
  | "run"
  | "artifact"
  | "artifact_version"
  | "request_snapshot"
  | "attempt"
  | "cache_checkpoint"
  | "commit_boundary"
  | "effect";

interface ObjectBinding {
  readonly kind: ObjectKind;
  readonly eventId: string;
}

interface RunScopedBinding extends ObjectBinding {
  readonly lineageId: string;
  readonly runId: string;
}

interface RunBinding extends ObjectBinding {
  readonly kind: "run";
  readonly lineageId: string;
  readonly cause: "user" | "continue" | "recovery";
  readonly previousRunId: string | null;
  readonly status: "active" | "completed" | "interrupted";
  readonly phase: "normal" | "must_interrupt" | "finalizing";
  readonly finalAssistantEventId: string | undefined;
  readonly finalCheckpointId: string | undefined;
  readonly finalBoundaryId: string | undefined;
  readonly retrySnapshotId: string | undefined;
  readonly pendingAssistantCheckpointEventId: string | undefined;
  readonly pendingBoundarySourceEventIds: readonly string[] | undefined;
}

interface CacheAbiBinding extends ObjectBinding {
  readonly kind: "cache_abi";
  readonly headerHash: Sha256;
  readonly toolsProfile: ToolSchemaProfile;
  readonly resultProfile: ToolResultProfile;
}

interface LineageBinding extends ObjectBinding {
  readonly kind: "lineage";
  readonly cacheAbiId: string;
}

interface ArtifactBinding extends ObjectBinding {
  readonly kind: "artifact";
  readonly lineageId: string | undefined;
  readonly runId: string | undefined;
  readonly payload: JournalPayloadByType["artifact_published"];
}

interface SnapshotBinding extends RunScopedBinding {
  readonly kind: "request_snapshot";
  readonly payload: JournalPayloadByType["request_snapshot_stored"];
}

interface AttemptBinding extends RunScopedBinding {
  readonly kind: "attempt";
  readonly requestSnapshotId: string;
}

interface CheckpointBinding extends RunScopedBinding {
  readonly kind: "cache_checkpoint";
  readonly sourceAssistantEventId: string;
  readonly payload: JournalPayloadByType["cache_checkpoint_created"];
}

interface BoundaryBinding extends RunScopedBinding {
  readonly kind: "commit_boundary";
  readonly payload: JournalPayloadByType["commit_boundary_created"];
}

interface ToolCallBinding {
  readonly id: string;
  readonly assistantEventId: string;
  readonly lineageId: string;
  readonly runId: string;
  readonly ordinal: number;
  readonly groupSize: number;
  readonly name: string;
  readonly argumentsHash: Sha256;
  readonly toolsProfile: ToolSchemaProfile;
  readonly resultProfile: ToolResultProfile;
  readonly validatedArguments: ValidatedToolArguments | undefined;
  readonly validationCode: StaticToolValidationCode | undefined;
  readonly resultEventId: string | undefined;
}

interface ToolGroupBinding {
  readonly assistantEventId: string;
  readonly callIds: readonly string[];
  readonly nextResultOrdinal: number;
}

interface PermissionBinding {
  readonly eventId: string;
  readonly finalDecision: "allow" | "deny";
}

interface EffectBinding extends RunScopedBinding {
  readonly kind: "effect";
  readonly toolCallId: string;
  readonly toolName: Exclude<ToolName, "read">;
  readonly status:
    | "prepared"
    | "completed"
    | "indeterminate"
    | "reconciled_completed"
    | "reconciled_not_executed";
  readonly outputArtifactId: string | undefined;
  readonly terminalEventId: string | undefined;
}

interface LineagePrefix {
  readonly nextBlobIndex: number;
  readonly chainHash: Sha256 | null;
}

type ProjectInstructionsChange =
  | Readonly<{ readonly phase: "awaiting_abi" }>
  | Readonly<{
      readonly phase: "awaiting_activation";
      readonly cacheAbiId: string;
    }>;

interface BindingState {
  sessionId: string | undefined;
  activeLineageId: string | undefined;
  activeRunId: string | undefined;
  pendingAbiChange:
    | Readonly<{ fromLineageId: string; toLineageId: string }>
    | undefined;
  projectInstructionsChange: ProjectInstructionsChange | undefined;
  readonly events: Map<string, EventBinding>;
  readonly objects: Map<string, ObjectBinding>;
  readonly artifacts: Map<string, ArtifactBinding>;
  readonly artifactVersions: Map<
    string,
    JournalPayloadByType["artifact_version_created"]
  >;
  readonly attempts: Map<string, AttemptBinding>;
  readonly effects: Map<string, EffectBinding>;
  readonly activeEffectsByCall: Map<string, string>;
  readonly permissions: Map<string, PermissionBinding>;
  readonly semanticAttempts: Set<string>;
  readonly terminalAttempts: Set<string>;
  readonly checkpointSources: Set<string>;
  readonly recoveryHashes: Set<string>;
  readonly toolCalls: Map<string, ToolCallBinding>;
  readonly pendingToolGroups: Map<string, ToolGroupBinding>;
  readonly latestRunByLineage: Map<string, string>;
  readonly boundaryPrefixKeys: Set<string>;
  readonly snapshotOrdinals: Map<string, number>;
  readonly lineagePrefixes: Map<string, LineagePrefix>;
}

export interface JournalReferenceVerifier {
  loadBlob(ref: BlobRef): Promise<FrozenBytes>;
  loadArtifact(
    payload: JournalPayloadByType["artifact_published"],
  ): Promise<FrozenBytes>;
  scanArtifact(
    payload: JournalPayloadByType["artifact_published"],
    visit: (bytes: FrozenBytes) => void,
  ): Promise<void>;
  verifyArtifact(
    payload: JournalPayloadByType["artifact_published"],
  ): Promise<void>;
  verifySnapshot(
    ref: SnapshotRef,
    hash: Sha256,
    byteCount: number,
  ): Promise<void>;
  verifyRecovery(
    payload: JournalPayloadByType["journal_tail_recovered"],
    sessionId: string,
    validPrefixByteCount: number,
  ): Promise<void>;
}

export interface JournalPhysicalContext {
  readonly validPrefixByteCount: number;
}

export interface BindingProjectionSnapshot {
  readonly sessionId: string | undefined;
  readonly eventCount: number;
  readonly objectCount: number;
  readonly blobCount: number;
  readonly chainHash: Sha256 | null;
  readonly eventIds: readonly string[];
  readonly objectIds: readonly string[];
}

export interface RecoveryViewV1 {
  readonly version: 1;
  readonly sessionId: string | undefined;
  readonly activeLineageId: string | undefined;
  readonly activeRunId: string | undefined;
  readonly currentPrefix: Readonly<{
    readonly blobCount: number;
    readonly chainHash: Sha256 | null;
  }>;
  readonly runs: readonly Readonly<{
    readonly runId: string;
    readonly lineageId: string;
    readonly cause: "user" | "continue" | "recovery";
    readonly previousRunId: string | null;
    readonly status: "active" | "completed" | "interrupted";
    readonly phase: "normal" | "must_interrupt" | "finalizing";
    readonly finalAssistantEventId: string | null;
    readonly finalCheckpointId: string | null;
    readonly finalBoundaryId: string | null;
    readonly retrySnapshotId: string | null;
    readonly pendingAssistantCheckpointEventId: string | null;
    readonly pendingBoundarySourceEventIds: readonly string[] | null;
  }>[];
  readonly snapshots: readonly Readonly<{
    readonly requestSnapshotId: string;
    readonly eventId: string;
    readonly lineageId: string;
    readonly runId: string;
    readonly payload: JournalPayloadByType["request_snapshot_stored"];
  }>[];
  readonly attempts: readonly Readonly<{
    readonly attemptId: string;
    readonly eventId: string;
    readonly lineageId: string;
    readonly runId: string;
    readonly requestSnapshotId: string;
    readonly semanticStarted: boolean;
    readonly terminalEventId: string | null;
    readonly terminalType: "assistant_committed" | "request_interrupted" | null;
  }>[];
  readonly checkpoints: readonly Readonly<{
    readonly cacheCheckpointId: string;
    readonly eventId: string;
    readonly lineageId: string;
    readonly runId: string;
    readonly payload: JournalPayloadByType["cache_checkpoint_created"];
  }>[];
  readonly boundaries: readonly Readonly<{
    readonly commitBoundaryId: string;
    readonly eventId: string;
    readonly lineageId: string;
    readonly runId: string;
    readonly payload: JournalPayloadByType["commit_boundary_created"];
  }>[];
  readonly artifacts: readonly Readonly<{
    readonly artifactId: string;
    readonly eventId: string;
    readonly lineageId: string | null;
    readonly runId: string | null;
    readonly payload: JournalPayloadByType["artifact_published"];
  }>[];
  readonly effects: readonly Readonly<{
    readonly effectId: string;
    readonly eventId: string;
    readonly lineageId: string;
    readonly runId: string;
    readonly toolCallId: string;
    readonly toolName: Exclude<ToolName, "read">;
    readonly status: EffectBinding["status"];
    readonly outputArtifactId: string | null;
    readonly terminalEventId: string | null;
  }>[];
  readonly toolCalls: readonly Readonly<{
    readonly toolCallId: string;
    readonly assistantEventId: string;
    readonly lineageId: string;
    readonly runId: string;
    readonly ordinal: number;
    readonly groupSize: number;
    readonly name: string;
    readonly argumentsHash: Sha256;
    readonly toolsProfile: ToolSchemaProfile;
    readonly resultProfile: ToolResultProfile;
    readonly validatedArguments: ValidatedToolArguments | null;
    readonly validationCode: StaticToolValidationCode | null;
    readonly resultEventId: string | null;
  }>[];
  readonly pendingToolGroup: Readonly<{
    readonly lineageId: string;
    readonly assistantEventId: string;
    readonly callIds: readonly string[];
    readonly nextResultOrdinal: number;
  }> | null;
}

function referenceFailure(): never {
  throw journalError("JOURNAL_REFERENCE");
}

function cloneState(state: BindingState): BindingState {
  return {
    sessionId: state.sessionId,
    activeLineageId: state.activeLineageId,
    activeRunId: state.activeRunId,
    pendingAbiChange: state.pendingAbiChange,
    projectInstructionsChange: state.projectInstructionsChange,
    events: new Map(state.events),
    objects: new Map(state.objects),
    artifacts: new Map(state.artifacts),
    artifactVersions: new Map(state.artifactVersions),
    attempts: new Map(state.attempts),
    effects: new Map(state.effects),
    activeEffectsByCall: new Map(state.activeEffectsByCall),
    permissions: new Map(state.permissions),
    semanticAttempts: new Set(state.semanticAttempts),
    terminalAttempts: new Set(state.terminalAttempts),
    checkpointSources: new Set(state.checkpointSources),
    recoveryHashes: new Set(state.recoveryHashes),
    toolCalls: new Map(state.toolCalls),
    pendingToolGroups: new Map(state.pendingToolGroups),
    latestRunByLineage: new Map(state.latestRunByLineage),
    boundaryPrefixKeys: new Set(state.boundaryPrefixKeys),
    snapshotOrdinals: new Map(state.snapshotOrdinals),
    lineagePrefixes: new Map(
      [...state.lineagePrefixes].map(([lineageId, prefix]) => [
        lineageId,
        Object.freeze({ ...prefix }),
      ]),
    ),
  };
}

function emptyState(): BindingState {
  return {
    sessionId: undefined,
    activeLineageId: undefined,
    activeRunId: undefined,
    pendingAbiChange: undefined,
    projectInstructionsChange: undefined,
    events: new Map(),
    objects: new Map(),
    artifacts: new Map(),
    artifactVersions: new Map(),
    attempts: new Map(),
    effects: new Map(),
    activeEffectsByCall: new Map(),
    permissions: new Map(),
    semanticAttempts: new Set(),
    terminalAttempts: new Set(),
    checkpointSources: new Set(),
    recoveryHashes: new Set(),
    toolCalls: new Map(),
    pendingToolGroups: new Map(),
    latestRunByLineage: new Map(),
    boundaryPrefixKeys: new Set(),
    snapshotOrdinals: new Map(),
    lineagePrefixes: new Map(),
  };
}

function requireEvent(
  state: BindingState,
  id: string,
  allowedTypes?: readonly JournalEventType[],
): EventBinding {
  const binding = state.events.get(id);
  if (
    binding === undefined ||
    (allowedTypes !== undefined && !allowedTypes.includes(binding.type))
  ) {
    referenceFailure();
  }
  return binding;
}

function createObject(
  state: BindingState,
  id: string,
  binding: ObjectBinding,
): void {
  if (state.objects.has(id)) referenceFailure();
  state.objects.set(id, binding);
}

function requireObject(
  state: BindingState,
  id: string,
  kind: ObjectKind,
): ObjectBinding {
  const binding = state.objects.get(id);
  if (binding === undefined || binding.kind !== kind) referenceFailure();
  return binding;
}

function requireRunScope(event: AnyVerifiedJournalEvent): {
  readonly lineageId: string;
  readonly runId: string;
} {
  if (event.lineageId === undefined || event.runId === undefined) {
    referenceFailure();
  }
  return { lineageId: event.lineageId, runId: event.runId };
}

function requireSameLineage(
  lineageId: string,
  event: AnyVerifiedJournalEvent,
): void {
  if (event.lineageId !== lineageId) referenceFailure();
}

function requireSameRun(
  binding: RunScopedBinding,
  event: AnyVerifiedJournalEvent,
): void {
  if (
    event.lineageId !== binding.lineageId ||
    event.runId !== binding.runId
  ) {
    referenceFailure();
  }
}

function requireEventSameRun(
  source: AnyVerifiedJournalEvent,
  event: AnyVerifiedJournalEvent,
): void {
  if (
    source.lineageId === undefined ||
    source.runId === undefined ||
    source.lineageId !== event.lineageId ||
    source.runId !== event.runId
  ) {
    referenceFailure();
  }
}

function requireBindingLineage(
  binding: { readonly lineageId: string },
  event: AnyVerifiedJournalEvent,
): void {
  if (event.lineageId !== binding.lineageId) referenceFailure();
}

function activePrefix(
  state: BindingState,
  lineageId: string | undefined,
): { readonly lineageId: string; readonly prefix: LineagePrefix } {
  if (lineageId === undefined || state.activeLineageId !== lineageId) {
    referenceFailure();
  }
  if (
    state.projectInstructionsChange !== undefined ||
    state.pendingAbiChange !== undefined
  ) {
    referenceFailure();
  }
  const prefix = state.lineagePrefixes.get(lineageId);
  if (prefix === undefined) referenceFailure();
  return { lineageId, prefix };
}

function requireArtifact(
  state: BindingState,
  id: string,
): ArtifactBinding {
  const object = requireObject(state, id, "artifact") as ArtifactBinding;
  const artifact = state.artifacts.get(id);
  if (artifact === undefined || artifact !== object) referenceFailure();
  return artifact;
}

function requireArtifactScope(
  artifact: ArtifactBinding,
  event: AnyVerifiedJournalEvent,
): void {
  if (
    artifact.lineageId !== event.lineageId ||
    artifact.runId !== event.runId
  ) {
    referenceFailure();
  }
}

function rawDigest(hash: Sha256): Uint8Array {
  return Uint8Array.from(Buffer.from(hash.slice("sha256:".length), "hex"));
}

async function resolveBlob(
  payload:
    | BlobPayload<"user">
    | BlobPayload<"assistant">
    | BlobPayload<"tool">,
  verifier: JournalReferenceVerifier,
): Promise<FrozenBytes> {
  let bytes: FrozenBytes;
  if (payload.enc === "b64") {
    try {
      bytes = fromBase64(payload.bytes);
    } catch {
      referenceFailure();
    }
  } else {
    try {
      bytes = await verifier.loadBlob(payload.blobRef);
    } catch {
      referenceFailure();
    }
  }
  if (
    bytes.byteLength !== payload.byteCount ||
    `sha256:${sha256Hex(bytes)}` !== payload.byteHash
  ) {
    referenceFailure();
  }
  return bytes;
}

async function applyBlob(
  state: BindingState,
  lineageId: string | undefined,
  payload:
    | BlobPayload<"user">
    | BlobPayload<"assistant">
    | BlobPayload<"tool">,
  verifier: JournalReferenceVerifier,
): Promise<FrozenBytes> {
  const active = activePrefix(state, lineageId);
  const prefix = active.prefix;
  if (payload.blobIndex !== prefix.nextBlobIndex) referenceFailure();
  const bytes = await resolveBlob(payload, verifier);
  const expected =
    prefix.chainHash === null
      ? (`sha256:${sha256Hex(bytes)}` as Sha256)
      : (`sha256:${sha256Hex(
          concatBytes([
            lengthPrefix(rawDigest(prefix.chainHash)),
            lengthPrefix(bytes),
          ]),
        )}` as Sha256);
  if (payload.chainHash !== expected) referenceFailure();
  state.lineagePrefixes.set(
    active.lineageId,
    Object.freeze({
      nextBlobIndex: prefix.nextBlobIndex + 1,
      chainHash: expected,
    }),
  );
  return bytes;
}

function verifyScopes(
  state: BindingState,
  event: AnyVerifiedJournalEvent,
): void {
  if (event.parentId !== undefined) requireEvent(state, event.parentId);
  if (event.lineageId !== undefined && event.type !== "lineage_started") {
    requireObject(state, event.lineageId, "lineage");
  }
  if (event.runId !== undefined && event.type !== "run_started") {
    const run = requireObject(state, event.runId, "run") as RunBinding;
    if (
      run.lineageId !== event.lineageId ||
      run.status !== "active" ||
      state.activeRunId !== event.runId
    ) {
      referenceFailure();
    }
  }
}

function activeRun(state: BindingState): RunBinding | undefined {
  if (state.activeRunId === undefined) return undefined;
  const run = requireObject(state, state.activeRunId, "run") as RunBinding;
  if (run.status !== "active") referenceFailure();
  return run;
}

function replaceRun(
  state: BindingState,
  runId: string,
  binding: RunBinding,
): void {
  state.objects.set(runId, binding);
}

function hasRunAncestor(
  state: BindingState,
  descendant: RunBinding,
  ancestorRunId: string,
): boolean {
  let previousRunId = descendant.previousRunId;
  while (previousRunId !== null) {
    if (previousRunId === ancestorRunId) return true;
    const previous = requireObject(state, previousRunId, "run") as RunBinding;
    if (previous.lineageId !== descendant.lineageId) referenceFailure();
    previousRunId = previous.previousRunId;
  }
  return false;
}

function hasOpenAttempt(state: BindingState, runId: string): boolean {
  for (const [attemptId, attempt] of state.attempts) {
    if (attempt.runId === runId && !state.terminalAttempts.has(attemptId)) {
      return true;
    }
  }
  return false;
}

function hasSnapshotForBoundary(
  state: BindingState,
  commitBoundaryId: string,
): boolean {
  for (const binding of state.objects.values()) {
    if (
      binding.kind === "request_snapshot" &&
      (binding as SnapshotBinding).payload.commitBoundaryId === commitBoundaryId
    ) {
      return true;
    }
  }
  return false;
}

function gateActiveRunPhase(
  state: BindingState,
  event: AnyVerifiedJournalEvent,
): void {
  const run = activeRun(state);
  if (run === undefined) return;
  if (event.type === "journal_tail_recovered") return;
  if (run.pendingAssistantCheckpointEventId !== undefined) {
    if (
      event.type !== "cache_checkpoint_created" ||
      event.runId !== state.activeRunId
    ) {
      referenceFailure();
    }
    return;
  }
  if (run.pendingBoundarySourceEventIds !== undefined) {
    if (
      event.type !== "commit_boundary_created" ||
      event.runId !== state.activeRunId
    ) {
      referenceFailure();
    }
    return;
  }
  if (run.phase === "must_interrupt") {
    if (event.type !== "run_interrupted" || event.runId !== state.activeRunId) {
      referenceFailure();
    }
    return;
  }
  if (run.retrySnapshotId !== undefined) {
    if (
      (event.type !== "request_attempt_started" &&
        event.type !== "run_interrupted") ||
      event.runId !== state.activeRunId
    ) {
      referenceFailure();
    }
    return;
  }
  if (run.phase !== "finalizing") return;
  const expected =
    run.finalCheckpointId === undefined
      ? "cache_checkpoint_created"
      : run.finalBoundaryId === undefined
        ? "commit_boundary_created"
        : "run_completed";
  if (event.type !== expected || event.runId !== state.activeRunId) {
    referenceFailure();
  }
}

function boundaryPrefixKey(
  lineageId: string,
  blobCount: number,
  chainHash: Sha256,
): string {
  return `${lineageId}\u0000${blobCount}\u0000${chainHash}`;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function requireSourceEvents(
  state: BindingState,
  ids: readonly string[],
  allowedTypes?: readonly JournalEventType[],
): readonly EventBinding[] {
  return ids.map((id) => requireEvent(state, id, allowedTypes));
}

function hasCommitClosure(state: BindingState, lineageId: string): boolean {
  let openModelResponses = 0;
  for (const [attemptId, attempt] of state.attempts) {
    if (
      attempt.lineageId === lineageId &&
      !state.terminalAttempts.has(attemptId)
    ) {
      openModelResponses += 1;
    }
  }
  const group = state.pendingToolGroups.get(lineageId);
  const pendingToolCalls =
    group === undefined ? 0 : group.callIds.length - group.nextResultOrdinal;
  let unsettledEffects = 0;
  for (const effect of state.effects.values()) {
    if (
      effect.lineageId === lineageId &&
      (effect.status === "prepared" || effect.status === "indeterminate")
    ) {
      unsettledEffects += 1;
    }
  }
  return isCommitClosureV1({
    openModelResponses,
    pendingToolCalls,
    unsettledEffects,
  });
}

function lastAcceptedEvent(state: BindingState): AnyVerifiedJournalEvent | undefined {
  return [...state.events.values()].at(-1)?.event;
}

function isCanonicalPermission(
  payload: JournalPayloadByType["permission_decided"],
): boolean {
  if (payload.policyDecision === "allow") {
    return payload.finalDecision === "allow" && payload.resolution === "policy";
  }
  if (payload.policyDecision === "deny") {
    return payload.finalDecision === "deny" && payload.resolution === "policy";
  }
  if (payload.resolution === "policy") return false;
  if (payload.resolution === "yes_flag") return payload.finalDecision === "allow";
  if (payload.resolution === "non_interactive") {
    return payload.finalDecision === "deny";
  }
  return payload.resolution === "interactive";
}

function requireToolOutputArtifact(
  state: BindingState,
  artifactId: string,
): ArtifactBinding {
  const artifact = requireArtifact(state, artifactId);
  if (artifact.payload.artifactType !== "tool_output") referenceFailure();
  return artifact;
}

function requiredToolName(call: ToolCallBinding): ToolName {
  const name = call.validatedArguments?.name;
  if (name === undefined) referenceFailure();
  return name;
}

function readOffset(call: ToolCallBinding): number | undefined {
  return call.validatedArguments?.name === "read"
    ? call.validatedArguments.value.offset
    : undefined;
}

async function validateToolArtifactBytes(
  call: ToolCallBinding,
  artifact: ArtifactBinding,
  verifier: JournalReferenceVerifier,
  terminal: ToolTerminal | null,
  terminalSource: ToolTerminalSource,
): Promise<void> {
  const toolName = requiredToolName(call);
  const streamBytes = artifact.payload.streamBytes;
  const hardLimitReached = artifact.payload.hardLimitReached;
  const descendantsReaped = artifact.payload.descendantsReaped;
  if (
    streamBytes === null ||
    hardLimitReached === null ||
    artifact.payload.toolCallId !== callIdOf(call)
  ) {
    referenceFailure();
  }
  if (terminal === null) {
    if (
      (toolName === "bash" && typeof descendantsReaped !== "boolean") ||
      (toolName !== "bash" && descendantsReaped !== null)
    ) {
      referenceFailure();
    }
  } else if (artifact.payload.terminal === null && toolName === "bash") {
    if (
      typeof descendantsReaped !== "boolean" ||
      terminal.descendantsReaped !== descendantsReaped
    ) {
      referenceFailure();
    }
  } else if (
    descendantsReaped !== null ||
    terminal.descendantsReaped !== null
  ) {
    referenceFailure();
  }
  if (terminal !== null) {
    try {
      const offset = readOffset(call);
      const projector = createArtifactToolResultProjector({
        toolCallId: callIdOf(call),
        toolName,
        toolsProfile: call.toolsProfile,
        resultProfile: call.resultProfile,
        terminalSource,
        ...(offset === undefined ? {} : { readOffset: offset }),
        artifact: {
          artifactId: artifactIdOf(artifact),
          artifactRef: artifact.payload.artifactRef,
          artifactSha256: artifact.payload.artifactHash,
          byteCount: artifact.payload.byteCount,
          payloadBytes: streamBytes,
          hardLimitReached,
        },
        terminal,
      });
      await verifier.scanArtifact(
        artifact.payload,
        (bytes) => projector.push(bytes),
      );
      projector.finish();
    } catch {
      referenceFailure();
    }
    return;
  }
  let invalidStream = false;
  const parser = createToolOutputFrameParser({
    data(stream) {
      if (
        (toolName === "read" && stream !== "read") ||
        (toolName === "bash" && stream === "read") ||
        toolName === "write" ||
        toolName === "edit"
      ) {
        invalidStream = true;
      }
    },
    hardLimit(stream) {
      if (
        (toolName !== "read" && toolName !== "bash") ||
        (toolName === "read" && stream !== "read") ||
        (toolName === "bash" && stream === "read")
      ) {
        invalidStream = true;
      }
    },
  });
  let summary: ToolOutputFrameSummary;
  try {
    await verifier.scanArtifact(
      artifact.payload,
      (bytes) => parser.push(bytes),
    );
    summary = parser.finish();
  } catch {
    referenceFailure();
  }
  if (
    invalidStream ||
    summary.byteCount !== artifact.payload.byteCount ||
    summary.payloadBytes.read !== streamBytes.read ||
    summary.payloadBytes.stdout !== streamBytes.stdout ||
    summary.payloadBytes.stderr !== streamBytes.stderr ||
    summary.hardLimitReached !== artifact.payload.hardLimitReached
  ) {
    referenceFailure();
  }
}

function callIdOf(call: ToolCallBinding): string {
  return call.id;
}

function artifactIdOf(artifact: ArtifactBinding): string {
  return artifact.payload.artifactId;
}

function replaceEffect(
  state: BindingState,
  effectId: string,
  binding: EffectBinding,
): void {
  state.effects.set(effectId, binding);
  state.objects.set(effectId, binding);
}

async function applyEvent(
  state: BindingState,
  event: AnyVerifiedJournalEvent,
  verifier: JournalReferenceVerifier,
  physical: JournalPhysicalContext | undefined,
): Promise<void> {
  if (state.events.has(event.id)) referenceFailure();
  if (state.events.size === 0) {
    if (event.type !== "session_started") referenceFailure();
    state.sessionId = event.sessionId;
  } else if (
    event.type === "session_started" ||
    event.sessionId !== state.sessionId
  ) {
    referenceFailure();
  }
  gateActiveRunPhase(state, event);
  verifyScopes(state, event);

  switch (event.type) {
    case "session_started":
      break;
    case "artifact_published": {
      try {
        await verifier.verifyArtifact(event.payload);
      } catch {
        referenceFailure();
      }
      const binding: ArtifactBinding = {
        kind: "artifact",
        eventId: event.id,
        lineageId: event.lineageId,
        runId: event.runId,
        payload: event.payload,
      };
      if (event.payload.artifactType === "tool_output") {
        const scope = requireRunScope(event);
        const callId = event.payload.toolCallId;
        const call = callId === null ? undefined : state.toolCalls.get(callId);
        const permission = callId === null ? undefined : state.permissions.get(callId);
        if (
          callId === null ||
          call === undefined ||
          call.resultEventId !== undefined ||
          call.validatedArguments === undefined ||
          permission?.finalDecision !== "allow" ||
          call.lineageId !== scope.lineageId
        ) {
          referenceFailure();
        }
        const effectId = state.activeEffectsByCall.get(callId);
        const effect = effectId === undefined ? undefined : state.effects.get(effectId);
        if (event.payload.terminal === null) {
          if (
            effect === undefined ||
            (effect.status !== "prepared" && effect.status !== "indeterminate") ||
            (effect.status === "prepared" && effect.runId !== scope.runId)
          ) {
            referenceFailure();
          }
          if (effect.status === "indeterminate") {
            const run = requireObject(state, scope.runId, "run") as RunBinding;
            if (run.cause !== "recovery") referenceFailure();
          }
        } else if (
          effect !== undefined &&
          effect.status !== "reconciled_not_executed"
        ) {
          referenceFailure();
        }
        await validateToolArtifactBytes(
          call,
          binding,
          verifier,
          event.payload.terminal,
          "artifact",
        );
      }
      createObject(state, event.payload.artifactId, binding);
      state.artifacts.set(event.payload.artifactId, binding);
      break;
    }
    case "cache_abi_declared": {
      const manifest = requireArtifact(state, event.payload.manifestArtifactId);
      if (
        manifest.lineageId !== undefined ||
        manifest.runId !== undefined ||
        String(manifest.payload.artifactHash) !==
          String(event.payload.cacheAbiId) ||
        manifest.payload.byteCount !== event.payload.manifestByteCount ||
        manifest.payload.artifactType !== "cache_abi_manifest"
      ) {
        referenceFailure();
      }
      let headerHash: Sha256;
      let toolsProfile: ToolSchemaProfile;
      let resultProfile: ToolResultProfile;
      try {
        const manifestBytes = await verifier.loadArtifact(manifest.payload);
        const loaded = loadCacheAbi(
          manifestBytes,
          event.payload.cacheAbiId,
        );
        if (loaded.manifestBytes.byteLength !== event.payload.manifestByteCount) {
          referenceFailure();
        }
        headerHash = loaded.headerHash;
        toolsProfile = toolSchemaProfileForBytes(loaded.toolsBlob);
        resultProfile = toolResultProfileForCacheAbi(loaded);
      } catch {
        referenceFailure();
      }
      const binding: CacheAbiBinding = {
        kind: "cache_abi",
        eventId: event.id,
        headerHash,
        toolsProfile,
        resultProfile,
      };
      createObject(state, event.payload.cacheAbiId, binding);
      if (state.projectInstructionsChange?.phase === "awaiting_abi") {
        state.projectInstructionsChange = Object.freeze({
          phase: "awaiting_activation",
          cacheAbiId: event.payload.cacheAbiId,
        });
      }
      break;
    }
    case "lineage_started":
      requireObject(state, event.payload.cacheAbiId, "cache_abi");
      if (event.lineageId === undefined) referenceFailure();
      createObject(state, event.lineageId, {
        kind: "lineage",
        eventId: event.id,
        cacheAbiId: event.payload.cacheAbiId,
      } as LineageBinding);
      state.lineagePrefixes.set(
        event.lineageId,
        Object.freeze({ nextBlobIndex: 0, chainHash: null }),
      );
      break;
    case "lineage_activated": {
      if (state.activeRunId !== undefined) referenceFailure();
      const next = requireObject(
        state,
        event.payload.nextLineageId,
        "lineage",
      ) as LineageBinding;
      if (state.projectInstructionsChange?.phase === "awaiting_abi") {
        referenceFailure();
      }
      if (
        state.projectInstructionsChange?.phase === "awaiting_activation" &&
        state.projectInstructionsChange.cacheAbiId !== next.cacheAbiId
      ) {
        referenceFailure();
      }
      if (event.payload.reason === "initial") {
        if (
          state.activeLineageId !== undefined ||
          state.pendingAbiChange !== undefined
        ) {
          referenceFailure();
        }
      } else {
        if (
          state.activeLineageId === undefined ||
          event.payload.previousLineageId !== state.activeLineageId
        ) {
          referenceFailure();
        }
        const previous = requireObject(
          state,
          state.activeLineageId,
          "lineage",
        ) as LineageBinding;
        if (
          (event.payload.reason !== "compaction" &&
            previous.cacheAbiId === next.cacheAbiId) ||
          (event.payload.reason === "compaction" &&
            previous.cacheAbiId !== next.cacheAbiId) ||
          state.pendingAbiChange?.fromLineageId !==
            event.payload.previousLineageId ||
          state.pendingAbiChange.toLineageId !== event.payload.nextLineageId
        ) {
          referenceFailure();
        }
        state.pendingAbiChange = undefined;
      }
      state.activeLineageId = event.payload.nextLineageId;
      state.projectInstructionsChange = undefined;
      break;
    }
    case "run_started": {
      if (event.lineageId === undefined || event.runId === undefined) {
        referenceFailure();
      }
      requireObject(state, event.lineageId, "lineage");
      if (
        state.activeRunId !== undefined ||
        state.activeLineageId !== event.lineageId ||
        state.pendingAbiChange !== undefined ||
        state.projectInstructionsChange !== undefined
      ) {
        referenceFailure();
      }
      const latestRunId = state.latestRunByLineage.get(event.lineageId);
      if (event.payload.cause === "user") {
        // The first Run of a Lineage only. Replay can therefore still tell a
        // fresh Session from one the user continued.
        if (
          event.payload.previousRunId !== null ||
          latestRunId !== undefined ||
          !hasCommitClosure(state, event.lineageId)
        ) {
          referenceFailure();
        }
      } else {
        if (
          event.payload.previousRunId === null ||
          latestRunId !== event.payload.previousRunId
        ) {
          referenceFailure();
        }
        const previous = requireObject(
          state,
          event.payload.previousRunId,
          "run",
        ) as RunBinding;
        // continue and recovery are mutually exclusive branches of the same
        // append: a settled Run is continued, an interrupted one is recovered.
        // Only continue demands closure; recovery exists precisely to take over
        // a durable pending tail.
        // What decides whether a new user turn may be appended is whether the
        // durable tail is closed, not how the previous Run was labelled. A Run
        // the user interrupted at a safe boundary is fine to continue from; one
        // that left pending tool calls fails the closure check and must go
        // through recovery instead.
        const closed = hasCommitClosure(state, event.lineageId);
        const statusAllowed =
          event.payload.cause === "continue"
            ? previous.status === "completed" || previous.status === "interrupted"
            : previous.status === "interrupted";
        if (
          previous.lineageId !== event.lineageId ||
          !statusAllowed ||
          (event.payload.cause === "continue" && !closed)
        ) {
          referenceFailure();
        }
      }
      const binding: RunBinding = Object.freeze({
        kind: "run",
        eventId: event.id,
        lineageId: event.lineageId,
        cause: event.payload.cause,
        previousRunId: event.payload.previousRunId,
        status: "active",
        phase: "normal",
        finalAssistantEventId: undefined,
        finalCheckpointId: undefined,
        finalBoundaryId: undefined,
        retrySnapshotId: undefined,
        pendingAssistantCheckpointEventId: undefined,
        pendingBoundarySourceEventIds: undefined,
      });
      createObject(state, event.runId, binding);
      state.activeRunId = event.runId;
      state.latestRunByLineage.set(event.lineageId, event.runId);
      break;
    }
    case "fact_recorded": {
      const artifact = requireArtifact(state, event.payload.artifactId);
      requireArtifactScope(artifact, event);
      const expectedArtifactType =
        event.payload.kind === "project_instructions"
          ? "project_instructions"
          : "fact";
      if (
        artifact.payload.byteCount !== event.payload.byteCount ||
        artifact.payload.artifactType !== expectedArtifactType ||
        (event.payload.kind === "project_instructions" &&
          (event.lineageId !== undefined || event.runId !== undefined))
      ) {
        referenceFailure();
      }
      if (event.payload.kind === "project_instructions") {
        state.projectInstructionsChange = Object.freeze({
          phase: "awaiting_abi",
        });
      }
      break;
    }
    case "user_committed": {
      const scope = requireRunScope(event);
      if (!hasCommitClosure(state, scope.lineageId)) referenceFailure();
      const sources = requireSourceEvents(
        state,
        event.payload.sourceFactEventIds,
        ["fact_recorded"],
      );
      const expectedOrder = ["user_input", "date", "cwd", "git"] as const;
      const kinds = sources.map((source) => {
        requireEventSameRun(source.event, event);
        return (source.event.payload as JournalPayloadByType["fact_recorded"]).kind;
      });
      const positions = kinds.map((kind) =>
        expectedOrder.indexOf(kind as (typeof expectedOrder)[number]),
      );
      if (
        kinds[0] !== "user_input" ||
        positions.some(
          (position, index) =>
            position < 0 ||
            (index > 0 && position <= (positions[index - 1] ?? -1)),
        )
      ) {
        referenceFailure();
      }
      const bytes = await applyBlob(state, event.lineageId, event.payload, verifier);
      try {
        viewUser(bytes);
      } catch {
        referenceFailure();
      }
      const run = requireObject(state, scope.runId, "run") as RunBinding;
      if (run.pendingBoundarySourceEventIds !== undefined) referenceFailure();
      replaceRun(
        state,
        scope.runId,
        Object.freeze({
          ...run,
          pendingBoundarySourceEventIds: Object.freeze([event.id]),
        }),
      );
      break;
    }
    case "artifact_version_created":
      requireArtifact(state, event.payload.oldArtifactId);
      requireArtifact(state, event.payload.newArtifactId);
      if (event.payload.parentArtifactVersionId !== null) {
        requireObject(
          state,
          event.payload.parentArtifactVersionId,
          "artifact_version",
        );
        const parent = state.artifactVersions.get(
          event.payload.parentArtifactVersionId,
        );
        if (parent?.newArtifactId !== event.payload.oldArtifactId) {
          referenceFailure();
        }
      }
      createObject(state, event.payload.artifactVersionId, {
        kind: "artifact_version",
        eventId: event.id,
      });
      state.artifactVersions.set(
        event.payload.artifactVersionId,
        event.payload,
      );
      break;
    case "request_snapshot_stored": {
      if (
        state.projectInstructionsChange !== undefined ||
        state.pendingAbiChange !== undefined
      ) {
        referenceFailure();
      }
      const scope = requireRunScope(event);
      if (!hasCommitClosure(state, scope.lineageId)) referenceFailure();
      const lineage = requireObject(
        state,
        scope.lineageId,
        "lineage",
      ) as LineageBinding;
      if (lineage.cacheAbiId !== event.payload.cacheAbiId) referenceFailure();
      const cacheAbi = requireObject(
        state,
        event.payload.cacheAbiId,
        "cache_abi",
      ) as CacheAbiBinding;
      const boundary = requireObject(
        state,
        event.payload.commitBoundaryId,
        "commit_boundary",
      ) as BoundaryBinding;
      if (
        boundary.lineageId !== scope.lineageId ||
        event.parentId !== boundary.eventId ||
        event.payload.headEventId !== boundary.eventId ||
        event.payload.segmentHashes[0] !== cacheAbi.headerHash ||
        event.payload.segmentHashes[1] !== boundary.payload.chainHash
      ) {
        referenceFailure();
      }
      const targetRun = requireObject(
        state,
        scope.runId,
        "run",
      ) as RunBinding;
      const prefix = activePrefix(state, scope.lineageId).prefix;
      if (
        boundary.payload.blobCount !== prefix.nextBlobIndex ||
        boundary.payload.chainHash !== prefix.chainHash
      ) {
        referenceFailure();
      }
      if (event.payload.recoveryFromSnapshotId === null) {
        const sameRunImmediate =
          boundary.runId === scope.runId &&
          lastAcceptedEvent(state)?.id === boundary.eventId;
        const recoveryProjection =
          boundary.runId !== scope.runId &&
          targetRun.cause === "recovery" &&
          hasRunAncestor(state, targetRun, boundary.runId);
        if (
          (!sameRunImmediate && !recoveryProjection) ||
          hasSnapshotForBoundary(state, event.payload.commitBoundaryId)
        ) {
          referenceFailure();
        }
      } else {
        const source = requireObject(
          state,
          event.payload.recoveryFromSnapshotId,
          "request_snapshot",
        ) as SnapshotBinding;
        if (
          source.lineageId !== scope.lineageId ||
          source.runId === scope.runId ||
          targetRun.cause !== "recovery" ||
          !hasRunAncestor(state, targetRun, source.runId) ||
          source.payload.bodyRef !== event.payload.bodyRef ||
          source.payload.bodyHash !== event.payload.bodyHash ||
          source.payload.byteCount !== event.payload.byteCount ||
          source.payload.cacheAbiId !== event.payload.cacheAbiId ||
          source.payload.projectorVersion !== event.payload.projectorVersion ||
          source.payload.headEventId !== event.payload.headEventId ||
          source.payload.commitBoundaryId !== event.payload.commitBoundaryId ||
          source.payload.segmentHashes[0] !== event.payload.segmentHashes[0] ||
          source.payload.segmentHashes[1] !== event.payload.segmentHashes[1]
        ) {
          referenceFailure();
        }
      }
      try {
        await verifier.verifySnapshot(
          event.payload.bodyRef,
          event.payload.bodyHash,
          event.payload.byteCount,
        );
      } catch {
        referenceFailure();
      }
      const binding: SnapshotBinding = {
        kind: "request_snapshot",
        eventId: event.id,
        lineageId: scope.lineageId,
        runId: scope.runId,
        payload: event.payload,
      };
      createObject(state, event.payload.requestSnapshotId, binding);
      break;
    }
    case "request_attempt_started": {
      if (
        state.projectInstructionsChange !== undefined ||
        state.pendingAbiChange !== undefined
      ) {
        referenceFailure();
      }
      const scope = requireRunScope(event);
      const run = requireObject(state, scope.runId, "run") as RunBinding;
      if (
        hasOpenAttempt(state, scope.runId) ||
        (run.retrySnapshotId !== undefined &&
          run.retrySnapshotId !== event.payload.requestSnapshotId)
      ) {
        referenceFailure();
      }
      if (!hasCommitClosure(state, scope.lineageId)) referenceFailure();
      const snapshot = requireObject(
        state,
        event.payload.requestSnapshotId,
        "request_snapshot",
      ) as SnapshotBinding;
      requireSameRun(snapshot, event);
      const expected =
        (state.snapshotOrdinals.get(event.payload.requestSnapshotId) ?? 0) + 1;
      if (
        event.payload.ordinal !== expected ||
        ((expected === 1) !== (run.retrySnapshotId === undefined))
      ) {
        referenceFailure();
      }
      state.snapshotOrdinals.set(event.payload.requestSnapshotId, expected);
      const binding: AttemptBinding = {
        kind: "attempt",
        eventId: event.id,
        lineageId: scope.lineageId,
        runId: scope.runId,
        requestSnapshotId: event.payload.requestSnapshotId,
      };
      createObject(state, event.payload.attemptId, binding);
      state.attempts.set(event.payload.attemptId, binding);
      if (run.retrySnapshotId !== undefined) {
        replaceRun(
          state,
          scope.runId,
          Object.freeze({ ...run, retrySnapshotId: undefined }),
        );
      }
      break;
    }
    case "request_semantic_started": {
      const attempt = requireObject(
        state,
        event.payload.attemptId,
        "attempt",
      ) as AttemptBinding;
      requireSameRun(attempt, event);
      if (
        state.semanticAttempts.has(event.payload.attemptId) ||
        state.terminalAttempts.has(event.payload.attemptId)
      ) {
        referenceFailure();
      }
      state.semanticAttempts.add(event.payload.attemptId);
      break;
    }
    case "assistant_committed": {
      const attempt = requireObject(
        state,
        event.payload.attemptId,
        "attempt",
      ) as AttemptBinding;
      const snapshot = requireObject(
        state,
        event.payload.requestSnapshotId,
        "request_snapshot",
      ) as SnapshotBinding;
      if (
        attempt.requestSnapshotId !== event.payload.requestSnapshotId ||
        !(
          attempt.lineageId === snapshot.lineageId &&
          attempt.runId === snapshot.runId
        )
      ) {
        referenceFailure();
      }
      requireSameRun(attempt, event);
      if (
        state.terminalAttempts.has(event.payload.attemptId) ||
        (event.payload.semanticDeltaCount > 0) !==
          state.semanticAttempts.has(event.payload.attemptId)
      ) {
        referenceFailure();
      }
      const bytes = await applyBlob(
        state,
        event.lineageId,
        event.payload,
        verifier,
      );
      let toolCalls: ReturnType<typeof viewAssistant>["toolCalls"];
      try {
        toolCalls = viewAssistant(bytes).toolCalls;
      } catch {
        referenceFailure();
      }
      if (state.pendingToolGroups.has(attempt.lineageId)) referenceFailure();
      const lineage = requireObject(
        state,
        attempt.lineageId,
        "lineage",
      ) as LineageBinding;
      const cacheAbi = requireObject(
        state,
        lineage.cacheAbiId,
        "cache_abi",
      ) as CacheAbiBinding;
      const callIds = toolCalls.map((call) => call.id);
      for (const [ordinal, call] of toolCalls.entries()) {
        if (state.toolCalls.has(call.id)) referenceFailure();
        const validation = validateToolArgumentsForProfile(
          call.function.name,
          call.function.arguments,
          cacheAbi.toolsProfile,
        );
        state.toolCalls.set(
          call.id,
          Object.freeze({
            id: call.id,
            assistantEventId: event.id,
            lineageId: attempt.lineageId,
            runId: attempt.runId,
            ordinal,
            groupSize: toolCalls.length,
            name: call.function.name,
            argumentsHash: `sha256:${sha256Hex(
              utf8Bytes(call.function.arguments),
            )}` as Sha256,
            toolsProfile: cacheAbi.toolsProfile,
            resultProfile: cacheAbi.resultProfile,
            validatedArguments: validation.ok ? validation.arguments : undefined,
            validationCode: validation.ok ? undefined : validation.code,
            resultEventId: undefined,
          }),
        );
      }
      if (callIds.length > 0) {
        const run = requireObject(state, attempt.runId, "run") as RunBinding;
        if (
          run.status !== "active" ||
          run.phase !== "normal" ||
          run.pendingAssistantCheckpointEventId !== undefined
        ) {
          referenceFailure();
        }
        state.pendingToolGroups.set(
          attempt.lineageId,
          Object.freeze({
            assistantEventId: event.id,
            callIds: Object.freeze(callIds),
            nextResultOrdinal: 0,
          }),
        );
        replaceRun(
          state,
          attempt.runId,
          Object.freeze({
            ...run,
            pendingAssistantCheckpointEventId: event.id,
          }),
        );
      } else {
        const run = requireObject(state, attempt.runId, "run") as RunBinding;
        if (run.status !== "active" || run.phase !== "normal") {
          referenceFailure();
        }
        replaceRun(
          state,
          attempt.runId,
          Object.freeze({
            ...run,
            phase: "finalizing",
            finalAssistantEventId: event.id,
          }),
        );
      }
      state.terminalAttempts.add(event.payload.attemptId);
      break;
    }
    case "request_interrupted": {
      const attempt = requireObject(
        state,
        event.payload.attemptId,
        "attempt",
      ) as AttemptBinding;
      const snapshot = requireObject(
        state,
        event.payload.requestSnapshotId,
        "request_snapshot",
      ) as SnapshotBinding;
      if (
        attempt.requestSnapshotId !== event.payload.requestSnapshotId ||
        attempt.lineageId !== snapshot.lineageId ||
        attempt.runId !== snapshot.runId
      ) {
        referenceFailure();
      }
      requireSameRun(attempt, event);
      if (state.terminalAttempts.has(event.payload.attemptId)) referenceFailure();
      const semanticStarted = state.semanticAttempts.has(event.payload.attemptId);
      if (
        (event.payload.semanticState === "pre_semantic" && semanticStarted) ||
        (event.payload.semanticState === "post_semantic" && !semanticStarted)
      ) {
        referenceFailure();
      }
      state.terminalAttempts.add(event.payload.attemptId);
      if (event.payload.semanticState !== "pre_semantic") {
        const run = requireObject(state, attempt.runId, "run") as RunBinding;
        replaceRun(
          state,
          attempt.runId,
          Object.freeze({ ...run, phase: "must_interrupt" }),
        );
      } else {
        const run = requireObject(state, attempt.runId, "run") as RunBinding;
        replaceRun(
          state,
          attempt.runId,
          Object.freeze({
            ...run,
            retrySnapshotId: event.payload.requestSnapshotId,
          }),
        );
      }
      break;
    }
    case "cache_checkpoint_created": {
      const scope = requireRunScope(event);
      const snapshot = requireObject(
        state,
        event.payload.requestSnapshotId,
        "request_snapshot",
      ) as SnapshotBinding;
      requireSameRun(snapshot, event);
      const sourceBinding = requireEvent(
        state,
        event.payload.sourceAssistantEventId,
        ["assistant_committed"],
      );
      requireEventSameRun(sourceBinding.event, event);
      {
        const source = sourceBinding.event
          .payload as JournalPayloadByType["assistant_committed"];
        if (
          source.requestSnapshotId !== event.payload.requestSnapshotId ||
          source.providerRequestId !== event.payload.providerRequestId ||
          source.usage.promptTokens !== event.payload.promptTokens ||
          source.blobIndex + 1 !== event.payload.blobCount ||
          source.chainHash !== event.payload.chainHash ||
          state.checkpointSources.has(event.payload.sourceAssistantEventId)
        ) {
          referenceFailure();
        }
      }
      const prefix = activePrefix(state, scope.lineageId).prefix;
      if (
        event.payload.blobCount !== prefix.nextBlobIndex ||
        event.payload.chainHash !== prefix.chainHash
      ) {
        referenceFailure();
      }
      const binding: CheckpointBinding = {
        kind: "cache_checkpoint",
        eventId: event.id,
        lineageId: scope.lineageId,
        runId: scope.runId,
        sourceAssistantEventId: event.payload.sourceAssistantEventId,
        payload: event.payload,
      };
      createObject(state, event.payload.cacheCheckpointId, binding);
      state.checkpointSources.add(event.payload.sourceAssistantEventId);
      const run = requireObject(state, scope.runId, "run") as RunBinding;
      if (run.pendingAssistantCheckpointEventId !== undefined) {
        if (
          run.pendingAssistantCheckpointEventId !==
          event.payload.sourceAssistantEventId
        ) {
          referenceFailure();
        }
        replaceRun(
          state,
          scope.runId,
          Object.freeze({
            ...run,
            pendingAssistantCheckpointEventId: undefined,
          }),
        );
      }
      if (run.phase === "finalizing") {
        if (
          run.finalAssistantEventId !== event.payload.sourceAssistantEventId ||
          run.finalCheckpointId !== undefined
        ) {
          referenceFailure();
        }
        replaceRun(
          state,
          scope.runId,
          Object.freeze({
            ...run,
            finalCheckpointId: event.payload.cacheCheckpointId,
          }),
        );
      }
      break;
    }
    case "commit_boundary_created": {
      const scope = requireRunScope(event);
      let checkpoint: CheckpointBinding | undefined;
      if (event.payload.cacheCheckpointId !== null) {
        checkpoint = requireObject(
          state,
          event.payload.cacheCheckpointId,
          "cache_checkpoint",
        ) as CheckpointBinding;
        requireSameRun(checkpoint, event);
      }
      const sources = requireSourceEvents(state, event.payload.sourceEventIds);
      for (const source of sources) {
        requireSameLineage(scope.lineageId, source.event);
      }
      const boundaryRun = requireObject(
        state,
        scope.runId,
        "run",
      ) as RunBinding;
      const sourceType = sources[0]?.type;
      if (sourceType === "user_committed") {
        const sourcePayload = sources[0]!.event
          .payload as JournalPayloadByType["user_committed"];
        if (
          sources.length !== 1 ||
          sources[0]!.event.runId !== scope.runId ||
          event.payload.cacheCheckpointId !== null ||
          sourcePayload.blobIndex + 1 !== event.payload.blobCount ||
          sourcePayload.chainHash !== event.payload.chainHash
        ) {
          referenceFailure();
        }
      } else if (sourceType === "assistant_committed") {
        if (
          sources[0]!.event.runId !== scope.runId ||
          sources.length !== 1 ||
          boundaryRun.phase !== "finalizing" ||
          boundaryRun.finalAssistantEventId !== sources[0]!.event.id ||
          boundaryRun.finalCheckpointId === undefined ||
          event.payload.cacheCheckpointId !== boundaryRun.finalCheckpointId ||
          checkpoint === undefined ||
          checkpoint?.sourceAssistantEventId !==
            boundaryRun.finalAssistantEventId
        ) {
          referenceFailure();
        }
      } else if (sourceType === "tool_result_committed") {
        if (
          event.payload.cacheCheckpointId !== null
        ) {
          referenceFailure();
        }
        let assistantEventId: string | undefined;
        for (const [ordinal, source] of sources.entries()) {
          if (source.type !== "tool_result_committed") referenceFailure();
          const payload = source.event
            .payload as JournalPayloadByType["tool_result_committed"];
          const call = state.toolCalls.get(payload.toolCallId);
          if (
            call === undefined ||
            call.lineageId !== scope.lineageId ||
            call.resultEventId !== source.event.id ||
            call.ordinal !== ordinal ||
            call.groupSize !== sources.length ||
            (assistantEventId !== undefined &&
              call.assistantEventId !== assistantEventId)
          ) {
            referenceFailure();
          }
          assistantEventId = call.assistantEventId;
        }
        const lastPayload = sources.at(-1)!.event
          .payload as JournalPayloadByType["tool_result_committed"];
        if (
          lastPayload.blobIndex + 1 !== event.payload.blobCount ||
          lastPayload.chainHash !== event.payload.chainHash
        ) {
          referenceFailure();
        }
      } else {
        referenceFailure();
      }
      if (sourceType !== "assistant_committed") {
        if (
          boundaryRun.pendingBoundarySourceEventIds === undefined ||
          !sameIds(
            boundaryRun.pendingBoundarySourceEventIds,
            event.payload.sourceEventIds,
          )
        ) {
          referenceFailure();
        }
      }
      const prefix = activePrefix(state, scope.lineageId).prefix;
      const prefixKey = boundaryPrefixKey(
        scope.lineageId,
        event.payload.blobCount,
        event.payload.chainHash,
      );
      if (
        event.payload.blobCount !== prefix.nextBlobIndex ||
        event.payload.chainHash !== prefix.chainHash ||
        !hasCommitClosure(state, scope.lineageId) ||
        state.boundaryPrefixKeys.has(prefixKey)
      ) {
        referenceFailure();
      }
      const binding: BoundaryBinding = {
        kind: "commit_boundary",
        eventId: event.id,
        lineageId: scope.lineageId,
        runId: scope.runId,
        payload: event.payload,
      };
      createObject(state, event.payload.commitBoundaryId, binding);
      state.boundaryPrefixKeys.add(prefixKey);
      if (sourceType === "assistant_committed") {
        replaceRun(
          state,
          scope.runId,
          Object.freeze({
            ...boundaryRun,
            finalBoundaryId: event.payload.commitBoundaryId,
          }),
        );
      } else {
        replaceRun(
          state,
          scope.runId,
          Object.freeze({
            ...boundaryRun,
            pendingBoundarySourceEventIds: undefined,
          }),
        );
      }
      break;
    }
    case "cache_break":
      if (
        event.payload.classification === "planned" &&
        event.payload.reason === "compaction"
      ) {
        // Same Cache ABI on both sides: the frozen zone did not move, the
        // conversation did. What must hold is that the break leaves the
        // currently active Lineage and that the summary it names is durable.
        requireObject(state, event.payload.fromLineageId, "lineage");
        requireObject(state, event.payload.toLineageId, "lineage");
        requireArtifact(state, event.payload.summaryArtifactId);
        if (
          state.pendingAbiChange !== undefined ||
          state.activeLineageId !== event.payload.fromLineageId ||
          state.activeRunId !== undefined
        ) {
          referenceFailure();
        }
        state.pendingAbiChange = Object.freeze({
          fromLineageId: event.payload.fromLineageId,
          toLineageId: event.payload.toLineageId,
        });
        break;
      }
      if (event.payload.classification === "planned") {
        const from = requireObject(
          state,
          event.payload.fromLineageId,
          "lineage",
        ) as LineageBinding;
        const to = requireObject(
          state,
          event.payload.toLineageId,
          "lineage",
        ) as LineageBinding;
        if (
          state.pendingAbiChange !== undefined ||
          state.activeLineageId !== event.payload.fromLineageId ||
          from.cacheAbiId === to.cacheAbiId ||
          state.projectInstructionsChange?.phase === "awaiting_abi" ||
          (state.projectInstructionsChange?.phase === "awaiting_activation" &&
            state.projectInstructionsChange.cacheAbiId !== to.cacheAbiId)
        ) {
          referenceFailure();
        }
        state.pendingAbiChange = Object.freeze({
          fromLineageId: event.payload.fromLineageId,
          toLineageId: event.payload.toLineageId,
        });
      } else {
        requireArtifact(state, event.payload.diffArtifactId);
      }
      break;
    case "verification_recorded":
      requireEvent(state, event.payload.sourceAssistantEventId, ["assistant_committed"]);
      requireArtifact(state, event.payload.outputArtifactId);
      break;
    case "integrity_violation":
      if (event.payload.relatedEventId !== null) {
        requireEvent(state, event.payload.relatedEventId);
      }
      break;
    case "permission_decided": {
      const toolCall = state.toolCalls.get(event.payload.toolCallId);
      if (
        toolCall === undefined ||
        toolCall.resultEventId !== undefined ||
        toolCall.validatedArguments === undefined ||
        state.permissions.has(event.payload.toolCallId) ||
        !isCanonicalPermission(event.payload)
      ) {
        referenceFailure();
      }
      requireBindingLineage(toolCall, event);
      state.permissions.set(
        event.payload.toolCallId,
        Object.freeze({
          eventId: event.id,
          finalDecision: event.payload.finalDecision,
        }),
      );
      break;
    }
    case "effect_prepared": {
      const scope = requireRunScope(event);
      const toolCall = state.toolCalls.get(event.payload.toolCallId);
      const permission = state.permissions.get(event.payload.toolCallId);
      const previousEffectId = state.activeEffectsByCall.get(
        event.payload.toolCallId,
      );
      const previousEffect =
        previousEffectId === undefined
          ? undefined
          : state.effects.get(previousEffectId);
      if (
        toolCall === undefined ||
        toolCall.resultEventId !== undefined ||
        toolCall.validatedArguments === undefined ||
        toolCall.validatedArguments.name === "read" ||
        toolCall.validatedArguments.name !== event.payload.toolName ||
        toolCall.argumentsHash !== event.payload.argumentsHash ||
        permission?.finalDecision !== "allow" ||
        (previousEffect !== undefined &&
          !(
            previousEffect.status === "reconciled_not_executed" &&
            previousEffect.runId !== scope.runId
          ))
      ) {
        referenceFailure();
      }
      requireBindingLineage(toolCall, event);
      const binding: EffectBinding = {
        kind: "effect",
        eventId: event.id,
        lineageId: scope.lineageId,
        runId: scope.runId,
        toolCallId: event.payload.toolCallId,
        toolName: event.payload.toolName,
        status: "prepared",
        outputArtifactId: undefined,
        terminalEventId: undefined,
      };
      createObject(state, event.payload.effectId, binding);
      state.effects.set(event.payload.effectId, binding);
      state.activeEffectsByCall.set(
        event.payload.toolCallId,
        event.payload.effectId,
      );
      break;
    }
    case "effect_completed": {
      const effect = requireObject(
        state,
        event.payload.effectId,
        "effect",
      ) as EffectBinding;
      if (
        effect.toolCallId !== event.payload.toolCallId ||
        effect.status !== "prepared"
      ) {
        referenceFailure();
      }
      requireSameRun(effect, event);
      const artifact = requireToolOutputArtifact(
        state,
        event.payload.artifactId,
      );
      requireArtifactScope(artifact, event);
      const call = state.toolCalls.get(event.payload.toolCallId);
      if (
        call === undefined ||
        artifact.payload.toolCallId !== event.payload.toolCallId ||
        artifact.payload.terminal !== null ||
        effect.toolName !== requiredToolName(call)
      ) {
        referenceFailure();
      }
      await validateToolArtifactBytes(
        call,
        artifact,
        verifier,
        event.payload.terminal,
        "effect",
      );
      replaceEffect(
        state,
        event.payload.effectId,
        Object.freeze({
          ...effect,
          status: "completed",
          outputArtifactId: event.payload.artifactId,
          terminalEventId: event.id,
        }),
      );
      break;
    }
    case "effect_indeterminate": {
      const effect = requireObject(
        state,
        event.payload.effectId,
        "effect",
      ) as EffectBinding;
      if (effect.status !== "prepared") referenceFailure();
      requireBindingLineage(effect, event);
      replaceEffect(
        state,
        event.payload.effectId,
        Object.freeze({
          ...effect,
          status: "indeterminate",
          terminalEventId: event.id,
        }),
      );
      break;
    }
    case "effect_reconciled": {
      const effect = requireObject(
        state,
        event.payload.effectId,
        "effect",
      ) as EffectBinding;
      if (effect.status !== "indeterminate") referenceFailure();
      requireBindingLineage(effect, event);
      const recoveryScope = requireRunScope(event);
      const recoveryRun = requireObject(
        state,
        recoveryScope.runId,
        "run",
      ) as RunBinding;
      if (recoveryRun.cause !== "recovery") referenceFailure();
      const evidence = requireArtifact(state, event.payload.evidenceArtifactId);
      requireArtifactScope(evidence, event);
      if (evidence.payload.artifactType !== "operator_evidence") {
        referenceFailure();
      }
      if (event.payload.resolution === "completed") {
        const output = requireToolOutputArtifact(
          state,
          event.payload.outputArtifactId,
        );
        requireArtifactScope(output, event);
        const call = state.toolCalls.get(effect.toolCallId);
        if (
          call === undefined ||
          output.payload.toolCallId !== effect.toolCallId ||
          output.payload.terminal !== null ||
          effect.toolName !== requiredToolName(call)
        ) {
          referenceFailure();
        }
        await validateToolArtifactBytes(
          call,
          output,
          verifier,
          event.payload.terminal,
          "effect",
        );
      }
      replaceEffect(
        state,
        event.payload.effectId,
        Object.freeze({
          ...effect,
          status:
            event.payload.resolution === "completed"
              ? "reconciled_completed"
              : "reconciled_not_executed",
          outputArtifactId:
            event.payload.resolution === "completed"
              ? event.payload.outputArtifactId
              : undefined,
          terminalEventId: event.id,
        }),
      );
      break;
    }
    case "tool_result_committed": {
      const scope = requireRunScope(event);
      const toolCall = state.toolCalls.get(event.payload.toolCallId);
      const group =
        toolCall === undefined
          ? undefined
          : state.pendingToolGroups.get(toolCall.lineageId);
      if (
        toolCall === undefined ||
        group === undefined ||
        toolCall.resultEventId !== undefined ||
        group.assistantEventId !== toolCall.assistantEventId ||
        group.callIds[group.nextResultOrdinal] !== event.payload.toolCallId ||
        toolCall.ordinal !== group.nextResultOrdinal
      ) {
        referenceFailure();
      }
      requireBindingLineage(toolCall, event);
      const source = requireEvent(state, event.payload.sourceEventId);
      const activeEffectId = state.activeEffectsByCall.get(
        event.payload.toolCallId,
      );
      let resultArtifact: ArtifactBinding | undefined;
      let resultTerminal: ToolTerminal | undefined;
      let staticContent: StaticToolResultContent | undefined;
      if (event.payload.effectId !== null) {
        const effect = requireObject(
          state,
          event.payload.effectId,
          "effect",
        ) as EffectBinding;
        if (
          effect.toolCallId !== event.payload.toolCallId ||
          activeEffectId !== event.payload.effectId ||
          (effect.status !== "completed" &&
            effect.status !== "reconciled_completed") ||
          event.payload.artifactId === null ||
          effect.outputArtifactId !== event.payload.artifactId ||
          effect.terminalEventId !== event.payload.sourceEventId ||
          (effect.status === "completed" &&
            (source.type !== "effect_completed" ||
              (source.event.payload as JournalPayloadByType["effect_completed"])
                .effectId !== event.payload.effectId)) ||
          (effect.status === "reconciled_completed" &&
            (source.type !== "effect_reconciled" ||
              (source.event.payload as JournalPayloadByType["effect_reconciled"])
                .effectId !== event.payload.effectId))
        ) {
          referenceFailure();
        }
        requireBindingLineage(effect, event);
        resultArtifact = requireToolOutputArtifact(
          state,
          event.payload.artifactId,
        );
        if (
          resultArtifact.payload.toolCallId !== event.payload.toolCallId ||
          resultArtifact.payload.terminal !== null
        ) {
          referenceFailure();
        }
        if (source.type === "effect_completed") {
          resultTerminal = (
            source.event.payload as JournalPayloadByType["effect_completed"]
          ).terminal;
        } else if (
          source.type === "effect_reconciled" &&
          (source.event.payload as JournalPayloadByType["effect_reconciled"])
            .resolution === "completed"
        ) {
          resultTerminal = (
            source.event.payload as Extract<
              JournalPayloadByType["effect_reconciled"],
              { readonly resolution: "completed" }
            >
          ).terminal;
        } else {
          referenceFailure();
        }
      } else if (event.payload.artifactId !== null) {
        const activeEffect =
          activeEffectId === undefined ? undefined : state.effects.get(activeEffectId);
        if (
          activeEffect !== undefined &&
          activeEffect.status !== "reconciled_not_executed"
        ) {
          referenceFailure();
        }
        resultArtifact = requireToolOutputArtifact(
          state,
          event.payload.artifactId,
        );
        if (
          source.type !== "artifact_published" ||
          (source.event.payload as JournalPayloadByType["artifact_published"])
            .artifactId !== event.payload.artifactId ||
          resultArtifact.payload.toolCallId !== event.payload.toolCallId ||
          resultArtifact.payload.terminal === null
        ) {
          referenceFailure();
        }
        const resultRun = requireObject(
          state,
          scope.runId,
          "run",
        ) as RunBinding;
        if (
          resultArtifact.lineageId !== scope.lineageId ||
          resultArtifact.runId === undefined ||
          (resultArtifact.runId !== scope.runId &&
            (resultRun.cause !== "recovery" ||
              !hasRunAncestor(state, resultRun, resultArtifact.runId)))
        ) {
          referenceFailure();
        }
        resultTerminal = resultArtifact.payload.terminal;
      } else {
        const activeEffect =
          activeEffectId === undefined ? undefined : state.effects.get(activeEffectId);
        if (
          activeEffect !== undefined &&
          activeEffect.status !== "reconciled_not_executed"
        ) {
          referenceFailure();
        }
        if (
          source.type === "permission_decided" &&
          (source.event.payload as JournalPayloadByType["permission_decided"])
            .toolCallId === event.payload.toolCallId &&
          (source.event.payload as JournalPayloadByType["permission_decided"])
            .finalDecision === "deny" &&
          toolCall.validationCode === undefined
        ) {
          staticContent = Object.freeze({
            kind: "static",
            status: "denied",
            code: "permission_denied",
          });
        } else if (
          source.type === "assistant_committed" &&
          source.event.id === toolCall.assistantEventId &&
          toolCall.validationCode !== undefined
        ) {
          staticContent = Object.freeze({
            kind: "static",
            status: "invalid",
            code: toolCall.validationCode,
          });
        } else {
          referenceFailure();
        }
      }
      const bytes = await applyBlob(state, event.lineageId, event.payload, verifier);
      try {
        if (bytes.byteLength > TOOL_RESULT_PROJECTION_LIMIT_BYTES) {
          referenceFailure();
        }
        const view = viewTool(bytes);
        if (view.toolCallId !== event.payload.toolCallId) {
          referenceFailure();
        }
        parseToolResultContentForProfile(
          view.content,
          toolCall.resultProfile,
        );
        let expected: FrozenBytes;
        if (staticContent !== undefined) {
          expected = materializeToolResultMessage(
            event.payload.toolCallId,
            staticContent,
          );
        } else {
          if (resultArtifact === undefined || resultTerminal === undefined) {
            referenceFailure();
          }
          const streamBytes = resultArtifact.payload.streamBytes;
          const hardLimitReached = resultArtifact.payload.hardLimitReached;
          if (streamBytes === null || hardLimitReached === null) referenceFailure();
          const offset = readOffset(toolCall);
          const projector = createArtifactToolResultProjector({
            toolCallId: event.payload.toolCallId,
            toolName: requiredToolName(toolCall),
            toolsProfile: toolCall.toolsProfile,
            resultProfile: toolCall.resultProfile,
            terminalSource: event.payload.effectId === null
              ? "artifact"
              : "effect",
            ...(offset === undefined ? {} : { readOffset: offset }),
            artifact: {
              artifactId: resultArtifact.payload.artifactId,
              artifactRef: resultArtifact.payload.artifactRef,
              artifactSha256: resultArtifact.payload.artifactHash,
              byteCount: resultArtifact.payload.byteCount,
              payloadBytes: streamBytes,
              hardLimitReached,
            },
            terminal: resultTerminal,
          });
          await verifier.scanArtifact(
            resultArtifact.payload,
            (artifactBytes) => projector.push(artifactBytes),
          );
          expected = projector.finish().messageBytes;
        }
        if (!bytesEqual(bytes, expected)) referenceFailure();
      } catch {
        referenceFailure();
      }
      state.toolCalls.set(
        event.payload.toolCallId,
        Object.freeze({ ...toolCall, resultEventId: event.id }),
      );
      const nextResultOrdinal = group.nextResultOrdinal + 1;
      if (nextResultOrdinal === group.callIds.length) {
        state.pendingToolGroups.delete(toolCall.lineageId);
        const sourceEventIds = group.callIds.map((callId) => {
          const call = state.toolCalls.get(callId);
          if (call?.resultEventId === undefined) referenceFailure();
          return call.resultEventId;
        });
        const run = requireObject(state, scope.runId, "run") as RunBinding;
        if (run.pendingBoundarySourceEventIds !== undefined) referenceFailure();
        replaceRun(
          state,
          scope.runId,
          Object.freeze({
            ...run,
            pendingBoundarySourceEventIds: Object.freeze(sourceEventIds),
          }),
        );
      } else {
        state.pendingToolGroups.set(
          toolCall.lineageId,
          Object.freeze({ ...group, nextResultOrdinal }),
        );
      }
      break;
    }
    case "run_completed": {
      const scope = requireRunScope(event);
      const run = requireObject(state, scope.runId, "run") as RunBinding;
      const boundary = requireObject(
        state,
        event.payload.commitBoundaryId,
        "commit_boundary",
      ) as BoundaryBinding;
      requireSameRun(boundary, event);
      const source = requireEvent(state, event.payload.sourceAssistantEventId, [
        "assistant_committed",
      ]).event;
      requireEventSameRun(source, event);
      if (
        run.status !== "active" ||
        run.phase !== "finalizing" ||
        run.finalAssistantEventId !== source.id ||
        run.finalCheckpointId === undefined ||
        run.finalBoundaryId !== event.payload.commitBoundaryId ||
        boundary.payload.cacheCheckpointId !== run.finalCheckpointId ||
        boundary.payload.sourceEventIds.length !== 1 ||
        boundary.payload.sourceEventIds[0] !== source.id ||
        hasOpenAttempt(state, scope.runId) ||
        !hasCommitClosure(state, scope.lineageId)
      ) {
        referenceFailure();
      }
      replaceRun(
        state,
        scope.runId,
        Object.freeze({ ...run, status: "completed" }),
      );
      state.activeRunId = undefined;
      break;
    }
    case "run_interrupted": {
      const scope = requireRunScope(event);
      const run = requireObject(state, scope.runId, "run") as RunBinding;
      const source = requireEvent(state, event.payload.sourceEventId).event;
      requireEventSameRun(source, event);
      if (
        run.status !== "active" ||
        run.phase === "finalizing" ||
        hasOpenAttempt(state, scope.runId)
      ) {
        referenceFailure();
      }
      replaceRun(
        state,
        scope.runId,
        Object.freeze({ ...run, status: "interrupted" }),
      );
      state.activeRunId = undefined;
      break;
    }
    case "journal_tail_recovered":
      if (
        event.payload.validPrefixSeq !== event.seq - 1 ||
        event.payload.validPrefixHash !== event.prevHash
      ) {
        referenceFailure();
      }
      if (state.recoveryHashes.has(event.payload.recoveryHash)) {
        referenceFailure();
      }
      if (physical === undefined) referenceFailure();
      try {
        await verifier.verifyRecovery(
          event.payload,
          event.sessionId,
          physical.validPrefixByteCount,
        );
      } catch {
        referenceFailure();
      }
      state.recoveryHashes.add(event.payload.recoveryHash);
      break;
  }

  state.events.set(event.id, { type: event.type, event });
}

export class JournalBindingProjection implements JournalAppendPreflight {
  readonly #verifier: JournalReferenceVerifier;
  #state: BindingState;
  #generation = 0;

  constructor(verifier: JournalReferenceVerifier) {
    this.#verifier = verifier;
    this.#state = emptyState();
  }

  async prepare(
    event: AnyVerifiedJournalEvent,
    physical?: JournalPhysicalContext,
  ): Promise<PreparedJournalAppend> {
    const generation = this.#generation;
    const candidate = cloneState(this.#state);
    await applyEvent(candidate, event, this.#verifier, physical);
    let committed = false;
    return {
      commit: () => {
        if (committed || this.#generation !== generation) referenceFailure();
        committed = true;
        this.#state = candidate;
        this.#generation += 1;
      },
    };
  }

  async accept(
    event: AnyVerifiedJournalEvent,
    physical?: JournalPhysicalContext,
  ): Promise<void> {
    const prepared = await this.prepare(event, physical);
    prepared.commit();
  }

  snapshot(): BindingProjectionSnapshot {
    const prefix =
      this.#state.activeLineageId === undefined
        ? undefined
        : this.#state.lineagePrefixes.get(this.#state.activeLineageId);
    return Object.freeze({
      sessionId: this.#state.sessionId,
      eventCount: this.#state.events.size,
      objectCount: this.#state.objects.size,
      blobCount: prefix?.nextBlobIndex ?? 0,
      chainHash: prefix?.chainHash ?? null,
      eventIds: Object.freeze([...this.#state.events.keys()]),
      objectIds: Object.freeze([...this.#state.objects.keys()]),
    });
  }

  recoveryView(): RecoveryViewV1 {
    const prefix =
      this.#state.activeLineageId === undefined
        ? undefined
        : this.#state.lineagePrefixes.get(this.#state.activeLineageId);
    const runs: RecoveryViewV1["runs"][number][] = [];
    const snapshots: RecoveryViewV1["snapshots"][number][] = [];
    const checkpoints: RecoveryViewV1["checkpoints"][number][] = [];
    const boundaries: RecoveryViewV1["boundaries"][number][] = [];
    for (const [id, object] of this.#state.objects) {
      if (object.kind === "run") {
        const run = object as RunBinding;
        runs.push(Object.freeze({
          runId: id,
          lineageId: run.lineageId,
          cause: run.cause,
          previousRunId: run.previousRunId,
          status: run.status,
          phase: run.phase,
          finalAssistantEventId: run.finalAssistantEventId ?? null,
          finalCheckpointId: run.finalCheckpointId ?? null,
          finalBoundaryId: run.finalBoundaryId ?? null,
          retrySnapshotId: run.retrySnapshotId ?? null,
          pendingAssistantCheckpointEventId:
            run.pendingAssistantCheckpointEventId ?? null,
          pendingBoundarySourceEventIds:
            run.pendingBoundarySourceEventIds === undefined
              ? null
              : Object.freeze([...run.pendingBoundarySourceEventIds]),
        }));
      } else if (object.kind === "request_snapshot") {
        const snapshot = object as SnapshotBinding;
        snapshots.push(Object.freeze({
          requestSnapshotId: id,
          eventId: snapshot.eventId,
          lineageId: snapshot.lineageId,
          runId: snapshot.runId,
          payload: snapshot.payload,
        }));
      } else if (object.kind === "cache_checkpoint") {
        const checkpoint = object as CheckpointBinding;
        checkpoints.push(Object.freeze({
          cacheCheckpointId: id,
          eventId: checkpoint.eventId,
          lineageId: checkpoint.lineageId,
          runId: checkpoint.runId,
          payload: checkpoint.payload,
        }));
      } else if (object.kind === "commit_boundary") {
        const boundary = object as BoundaryBinding;
        boundaries.push(Object.freeze({
          commitBoundaryId: id,
          eventId: boundary.eventId,
          lineageId: boundary.lineageId,
          runId: boundary.runId,
          payload: boundary.payload,
        }));
      }
    }
    const attempts = [...this.#state.attempts.entries()].map(
      ([attemptId, attempt]): RecoveryViewV1["attempts"][number] => {
        let terminalEventId: string | null = null;
        let terminalType: RecoveryViewV1["attempts"][number]["terminalType"] = null;
        for (const binding of this.#state.events.values()) {
          const event = binding.event;
          if (
            (event.type === "assistant_committed" ||
              event.type === "request_interrupted") &&
            event.payload.attemptId === attemptId
          ) {
            terminalEventId = event.id;
            terminalType = event.type;
          }
        }
        return Object.freeze({
          attemptId,
          eventId: attempt.eventId,
          lineageId: attempt.lineageId,
          runId: attempt.runId,
          requestSnapshotId: attempt.requestSnapshotId,
          semanticStarted: this.#state.semanticAttempts.has(attemptId),
          terminalEventId,
          terminalType,
        });
      },
    );
    const artifacts = [...this.#state.artifacts.entries()].map(
      ([artifactId, artifact]): RecoveryViewV1["artifacts"][number] =>
        Object.freeze({
          artifactId,
          eventId: artifact.eventId,
          lineageId: artifact.lineageId ?? null,
          runId: artifact.runId ?? null,
          payload: artifact.payload,
        }),
    );
    const effects = [...this.#state.effects.entries()].map(
      ([effectId, effect]): RecoveryViewV1["effects"][number] =>
        Object.freeze({
          effectId,
          eventId: effect.eventId,
          lineageId: effect.lineageId,
          runId: effect.runId,
          toolCallId: effect.toolCallId,
          toolName: effect.toolName,
          status: effect.status,
          outputArtifactId: effect.outputArtifactId ?? null,
          terminalEventId: effect.terminalEventId ?? null,
        }),
    );
    const toolCalls = [...this.#state.toolCalls.values()].map(
      (call): RecoveryViewV1["toolCalls"][number] => Object.freeze({
        toolCallId: call.id,
        assistantEventId: call.assistantEventId,
        lineageId: call.lineageId,
        runId: call.runId,
        ordinal: call.ordinal,
        groupSize: call.groupSize,
        name: call.name,
        argumentsHash: call.argumentsHash,
        toolsProfile: call.toolsProfile,
        resultProfile: call.resultProfile,
        validatedArguments: call.validatedArguments ?? null,
        validationCode: call.validationCode ?? null,
        resultEventId: call.resultEventId ?? null,
      }),
    );
    const pending =
      this.#state.activeLineageId === undefined
        ? undefined
        : this.#state.pendingToolGroups.get(this.#state.activeLineageId);
    return Object.freeze({
      version: 1,
      sessionId: this.#state.sessionId,
      activeLineageId: this.#state.activeLineageId,
      activeRunId: this.#state.activeRunId,
      currentPrefix: Object.freeze({
        blobCount: prefix?.nextBlobIndex ?? 0,
        chainHash: prefix?.chainHash ?? null,
      }),
      runs: Object.freeze(runs),
      snapshots: Object.freeze(snapshots),
      attempts: Object.freeze(attempts),
      checkpoints: Object.freeze(checkpoints),
      boundaries: Object.freeze(boundaries),
      artifacts: Object.freeze(artifacts),
      effects: Object.freeze(effects),
      toolCalls: Object.freeze(toolCalls),
      pendingToolGroup:
        pending === undefined || this.#state.activeLineageId === undefined
          ? null
          : Object.freeze({
              lineageId: this.#state.activeLineageId,
              assistantEventId: pending.assistantEventId,
              callIds: Object.freeze([...pending.callIds]),
              nextResultOrdinal: pending.nextResultOrdinal,
            }),
    });
  }
}
