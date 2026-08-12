import { spawnSync } from "node:child_process";
import { readdirSync, type Dirent } from "node:fs";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { delimiter, dirname, resolve } from "node:path";

import type { GateResult } from "../verify/gate.js";

import { createBlobStore, type BlobPosition, type BlobStore } from "../blob/index.js";
import { restoreDeepSeekRequestSnapshot, type DeepSeekRequestSnapshot } from "../bytes/request.js";
import { assertUnicodeScalarString, utf8Bytes } from "../bytes/ops.js";
import { toolSchemaProfileForBytes } from "../bytes/schemas.js";
import { viewAssistant } from "../bytes/view.js";
import { freezeBytes, type FrozenBytes } from "../bytes/types.js";
import type { DeepSeekRetryClass } from "../ds/errors.js";
import type { ArtifactDescriptor } from "../artifact/index.js";
import {
  materializeUserV1,
  storeProjectedSnapshotV1,
  storeRecoveryAliasV1,
} from "../ctx/index.js";
import { CredentialError, type DeepSeekCredential } from "../ds/credential.js";
import {
  DeepSeekHttpError,
  DeepSeekProtocolError,
  type DeepSeekRetryDecision,
  type DeepSeekSemanticState,
} from "../ds/errors.js";
import {
  DeepSeekDurabilityError,
  DeepSeekTransportError,
  runDeepSeekOfficialWithRetry,
  type DeepSeekRetryLifecycle,
} from "../ds/transport.js";
import { storageDirectoryName } from "../journal/paths.js";
import { loadProjectInstructions } from "./project-instructions.js";
import {
  runDeepSeekWebSearch,
  type DeepSeekWebSearchExecutor,
} from "../ds/web-search.js";
import type {
  CompletedDeepSeekResponse,
  DeepSeekSemanticFragment,
  DeepSeekUsage,
} from "../ds/types.js";
import {
  loadPackagedFlashPriceBookV1,
  projectSessionCostV1,
  type CostReportV1,
} from "../cost/index.js";
import {
  newArtifactId,
  newAttemptId,
  newCacheCheckpointId,
  newCommitBoundaryId,
  newLineageId,
  newRequestSnapshotId,
  newRunId,
  createSessionPaths,
  openJournal,
  openJournalReadOnly,
  randomEventIdentitySource,
  systemJournalClock,
  type AnyVerifiedJournalEvent,
  type BlobPayload,
  type BlobRef,
  type CacheCheckpointId,
  type CommitBoundaryId,
  type EffectId,
  type EventId,
  type EventIdentitySource,
  type JournalClock,
  type LineageId,
  type RecoveryViewV1,
  type RunId,
  type SessionId,
  type VerifiedJournalEvent,
} from "../journal/index.js";
import type { PersistenceTestControls } from "../journal/faults.js";
import type { ReasoningEffort } from "../bytes/request.js";
import {
  buildCacheAbiV2,
  reasoningEffortFromTuple,
  loadCacheAbi,
  toolResultProfileForCacheAbi,
  type FrozenCacheAbiManifest,
} from "../lineage/index.js";
import { createSnapshotStore, type SnapshotStore } from "../snapshot/index.js";
import {
  JournalToolDurability,
  ToolDurabilityError,
  type PublishedToolArtifact,
} from "../tool/durability.js";
import { ToolRuntime } from "../tool/runtime.js";
import {
  planRecoveryStepV1,
  recoveryEventById,
} from "./recovery.js";
import { resumeRecoveryToolV1 } from "./recovery-runtime.js";
import {
  applyReconciliationV1,
  parseReconciliationEvidenceV1,
} from "./reconcile.js";

type RoleEvent = Extract<
  AnyVerifiedJournalEvent,
  {
    readonly type:
      | "user_committed"
      | "assistant_committed"
      | "tool_result_committed";
  }
>;

type KernelPhase =
  | "created"
  | "ready"
  | "requesting"
  | "committing_assistant"
  | "executing_tools"
  | "completed"
  | "interrupted";

type SendSnapshot = (
  snapshot: DeepSeekRequestSnapshot,
  lifecycle: DeepSeekRetryLifecycle,
  preview: ((fragment: DeepSeekSemanticFragment) => void | Promise<void>) | undefined,
  signal: AbortSignal,
) => Promise<CompletedDeepSeekResponse>;

export interface ToolActivity {
  readonly phase: "started" | "settled";
  readonly name: string;
  /** Exact arguments string from the assistant bytes; never re-serialized. */
  readonly arguments: string;
  readonly status?: string;
  readonly code?: string;
}

export interface SessionEnvironmentFacts {
  readonly date?: string;
  readonly cwd?: string;
  readonly git?: string;
  readonly tree?: string;
}

/**
 * What every turn carries, and what only the first turn of a Lineage does.
 *
 * `date` and `git` change while the model works, so they are worth resending.
 * `cwd` and the top-level listing do not: repeating them would put the same
 * bytes in front of the model on every turn for no new information, and the
 * model can list a directory itself the moment it needs a fresher answer.
 */
const EVERY_TURN_FACTS = ["date", "git"] as const;
const FIRST_TURN_FACTS = ["date", "cwd", "git", "tree"] as const;

interface KernelCommonInput {
  readonly workspaceRoot: string;
  readonly sessionId: SessionId;
  readonly signal?: AbortSignal;
  readonly onPreview?: (
    fragment: DeepSeekSemanticFragment,
  ) => void | Promise<void>;
  readonly onStatus?: (report: CostReportV1) => void;
  /**
   * Reports each tool the model ran and how it ended. Purely observational, in
   * the same sense as onPreview: it cannot change execution, and a throwing or
   * slow observer must not affect the turn. Without it a caller can see the
   * model's words but not its actions.
   */
  readonly onToolActivity?: (activity: ToolActivity) => void;
  readonly clock?: JournalClock;
  readonly eventIds?: EventIdentitySource;
}

interface SessionBaseInput extends KernelCommonInput {
  readonly userInput: string;
  /**
   * Effort for a *new* Session only. It becomes part of the Cache ABI, so a
   * continued or recovered Session keeps whatever its Lineage already froze.
   */
  readonly reasoningEffort?: ReasoningEffort;
  /** The declared check. The kernel records its verdict and never sees the command. */
  readonly verification?: SessionVerification;
  readonly environmentFacts?: SessionEnvironmentFacts;
  readonly acceptanceBudget?: SessionAcceptanceBudget;
}

interface RecoverySessionBaseInput extends KernelCommonInput {}

export interface OfficialSessionInput extends SessionBaseInput {
  readonly credential: DeepSeekCredential;
}

export interface OfficialRecoveryInput extends RecoverySessionBaseInput {
  readonly loadCredential: () => DeepSeekCredential;
}

export interface OfficialReconciliationInput extends OfficialRecoveryInput {
  readonly evidenceBytes: FrozenBytes;
}

export type SessionFixtureTurn =
  | Readonly<{
      readonly kind: "success";
      readonly response: CompletedDeepSeekResponse;
      readonly fragments?: readonly DeepSeekSemanticFragment[];
    }>
  | Readonly<{
      readonly kind: "interrupted";
      readonly failure: Error;
      readonly semanticState: DeepSeekSemanticState;
      readonly decision: DeepSeekRetryDecision;
      readonly fragments?: readonly DeepSeekSemanticFragment[];
    }>;

export interface SessionFixtureInput extends SessionBaseInput {
  readonly turns: readonly SessionFixtureTurn[];
  readonly persistenceControls?: PersistenceTestControls;
  readonly onBeforeSend?: (observation: Readonly<{
    readonly snapshot: DeepSeekRequestSnapshot;
    readonly acknowledgedEvents: readonly AnyVerifiedJournalEvent[];
  }>) => void | Promise<void>;
}

export interface RecoverySessionFixtureInput extends RecoverySessionBaseInput {
  readonly turns: readonly SessionFixtureTurn[];
  readonly persistenceControls?: PersistenceTestControls;
  readonly onBeforeSend?: SessionFixtureInput["onBeforeSend"];
}

export interface ReconciliationSessionFixtureInput
  extends RecoverySessionFixtureInput {
  readonly evidenceBytes: FrozenBytes;
}

export type VerificationOutcome =
  | "passed"
  | "failed"
  | "tampered"
  | "errored"
  | "unavailable";

export interface SessionVerification {
  /** Run the declared check. Throwing is reported as `errored`, never as a pass. */
  run(signal: AbortSignal): Promise<GateResult>;
}

/** Read a Run's verdict back out of the durable record during replay. */
function verificationFromEvents(
  events: readonly AnyVerifiedJournalEvent[],
  sourceAssistantEventId: EventId,
): VerificationOutcome {
  const recorded = events.findLast(
    (event): event is VerifiedJournalEvent<"verification_recorded"> =>
      event.type === "verification_recorded" &&
      event.payload.sourceAssistantEventId === sourceAssistantEventId,
  );
  return recorded?.payload.verdict ?? "unavailable";
}

/**
 * Run the declared check and put its verdict in the Journal.
 *
 * The verdict is durable for the same reason tool results are: a judgement the
 * process only held in memory would be a second source of truth about whether
 * the work was done. A check that throws is `errored` — never a pass.
 */
async function recordVerification(input: {
  readonly verify: SessionVerification | undefined;
  readonly opened: Awaited<ReturnType<typeof openJournal>>;
  readonly sessionId: SessionId;
  readonly parentId: EventId;
  readonly sourceAssistantEventId: EventId;
  readonly signal: AbortSignal | undefined;
}): Promise<VerificationOutcome> {
  if (input.verify === undefined) return "unavailable";

  const controller = new AbortController();
  const result = await input.verify.run(input.signal ?? controller.signal);

  const sink = await input.opened.artifacts.beginArtifact();
  await sink.write(utf8Bytes(result.output));
  const descriptor = await sink.publish({
    lineCount: null,
    mediaType: "text/plain; charset=utf-8",
    artifactType: "fact",
    streamBytes: null,
    hardLimitReached: null,
    descendantsReaped: null,
    toolCallId: null,
    terminal: null,
  });
  const artifactId = newArtifactId();
  await input.opened.writer.append({
    type: "artifact_published",
    sessionId: input.sessionId,
    parentId: input.parentId,
    payload: {
      artifactId,
      artifactRef: descriptor.artifactRef,
      artifactHash: descriptor.artifactHash,
      byteCount: descriptor.byteCount,
      lineCount: descriptor.lineCount,
      mediaType: descriptor.mediaType,
      artifactType: descriptor.artifactType,
      streamBytes: descriptor.streamBytes,
      hardLimitReached: descriptor.hardLimitReached,
      descendantsReaped: descriptor.descendantsReaped,
      toolCallId: descriptor.toolCallId,
      terminal: descriptor.terminal,
    },
  });
  await input.opened.writer.append({
    type: "verification_recorded",
    sessionId: input.sessionId,
    parentId: input.parentId,
    payload: {
      sourceAssistantEventId: input.sourceAssistantEventId,
      verdict: result.verdict,
      exitCode: result.exitCode,
      outputArtifactId: artifactId,
      baselineDigest: result.baselineDigest,
      changedProtectedPaths: result.changedProtectedPaths,
    },
  });
  return result.verdict;
}

export interface CompletedSessionResult {
  readonly status: "completed";
  readonly sessionId: SessionId;
  readonly lineageId: LineageId;
  readonly runId: RunId;
  readonly content: string;
  readonly commitBoundaryId: CommitBoundaryId;
  readonly requestCount: number;
  /**
   * The Run ended because the model ran out of output tokens, not because it
   * chose to stop.
   *
   * A Run with no tool calls normally means the model is done. It does not mean
   * that when the provider reported `length`: the message was cut mid-sentence
   * and whatever the model was about to do never got emitted. The bytes are
   * still durable and the Commit Boundary still stands, so the Session is
   * intact — but `content` is a fragment, and presenting it as the answer is
   * how a cut-off thought became a final reply.
   */
  readonly truncated: boolean;
  /**
   * What the declared verification decided, or `unavailable` when none was
   * declared. A Run closes either way — the model loop did reach a boundary —
   * but only this says whether the work stands up.
   */
  readonly verification: VerificationOutcome;
}

export interface SessionAcceptanceBudget {
  readonly signal: AbortSignal;
  beforeSemanticRequest(): number;
  beforePhysicalAttempt(semanticRequestOrdinal: number): void;
  recordPreSemanticFailure(semanticRequestOrdinal: number): void;
  recordSemanticResponse(
    semanticRequestOrdinal: number,
    usage: DeepSeekUsage,
  ): void;
  beforeEffect(): void;
}

export class SessionAcceptanceBudgetError extends Error {
  constructor(readonly budgetCause: unknown) {
    super("Session acceptance budget stopped execution");
    this.name = "SessionAcceptanceBudgetError";
  }
}

export type SessionInterruptionReason =
  | "request_failed"
  | "semantic_interrupted"
  | "effect_indeterminate"
  | "integrity_violation"
  | "cancelled"
  | "durability_failure";

export class SessionInterruptedError extends Error {
  constructor(
    readonly reason: SessionInterruptionReason,
    /**
     * The provider's retry classification, when the interruption came from a
     * request. A caller deciding whether to resume needs it: a 400 is a
     * permanently invalid request that no new Run can fix, while a transport
     * drop is worth continuing from the last safe boundary.
     */
    readonly retryClass?: DeepSeekRetryClass,
  ) {
    super(`Session interrupted: ${reason}`);
    this.name = "SessionInterruptedError";
  }
}

export class SessionKernelError extends Error {
  constructor(
    readonly code:
      | "invalid_state"
      | "fixture_exhausted"
      | "durability_failure"
      | "incomplete_bootstrap",
  ) {
    super(`Session Kernel failed: ${code}`);
    this.name = "SessionKernelError";
  }
}

function asEvent<Type extends AnyVerifiedJournalEvent["type"]>(
  event: AnyVerifiedJournalEvent,
  type: Type,
): Extract<AnyVerifiedJournalEvent, { readonly type: Type }> {
  if (event.type !== type) throw new SessionKernelError("durability_failure");
  return event as Extract<AnyVerifiedJournalEvent, { readonly type: Type }>;
}

function isRoleEvent(event: AnyVerifiedJournalEvent): event is RoleEvent {
  return (
    event.type === "user_committed" ||
    event.type === "assistant_committed" ||
    event.type === "tool_result_committed"
  );
}

function transition(current: KernelPhase, next: KernelPhase): KernelPhase {
  const legal: Readonly<Record<KernelPhase, readonly KernelPhase[]>> = {
    created: ["ready", "interrupted"],
    ready: ["requesting", "interrupted"],
    requesting: ["committing_assistant", "interrupted"],
    committing_assistant: ["executing_tools", "completed", "interrupted"],
    executing_tools: ["ready", "interrupted"],
    completed: [],
    interrupted: [],
  };
  if (!legal[current].includes(next)) {
    throw new SessionKernelError("invalid_state");
  }
  return next;
}

function acceptanceCall<Result>(operation: () => Result): Result {
  try {
    return operation();
  } catch (error) {
    throw new SessionAcceptanceBudgetError(error);
  }
}

function executionSignal(
  userSignal: AbortSignal | undefined,
  acceptanceBudget: SessionAcceptanceBudget | undefined,
): AbortSignal {
  const signals = [userSignal, acceptanceBudget?.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (signals.length === 0) return new AbortController().signal;
  if (signals.length === 1) return signals[0]!;
  return AbortSignal.any(signals);
}

function bestEffortPreviewObserver(
  observer: SessionBaseInput["onPreview"],
): ((fragment: DeepSeekSemanticFragment) => void) | undefined {
  if (observer === undefined) return undefined;
  let enabled = true;
  let pending = false;
  return (fragment): void => {
    if (!enabled || pending) return;
    try {
      const completion = observer(fragment);
      if (completion === undefined) return;
      pending = true;
      void Promise.resolve(completion).then(
        () => {
          pending = false;
        },
        () => {
          pending = false;
          enabled = false;
        },
      );
    } catch {
      enabled = false;
    }
  };
}

function filesystemErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function recoveryExistingOnlyPreflight(
  workspaceRoot: string,
  sessionId: SessionId,
): Promise<void> {
  const paths = createSessionPaths(workspaceRoot, sessionId);
  let log;
  try {
    log = await open(
      paths.logPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stats = await log.stat();
    if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size < 0) {
      throw new SessionKernelError("incomplete_bootstrap");
    }
    if (stats.size === 0) {
      throw new SessionKernelError("incomplete_bootstrap");
    }
  } catch (error) {
    if (
      error instanceof SessionKernelError ||
      filesystemErrorCode(error) === "ENOENT"
    ) {
      throw new SessionKernelError("incomplete_bootstrap");
    }
    throw error;
  } finally {
    await log?.close().catch(() => undefined);
  }

  const observed = await openJournalReadOnly(workspaceRoot, sessionId);
  const hasRun = observed.recoveryView.runs.length > 0;
  if (!hasRun) throw new SessionKernelError("incomplete_bootstrap");
  const hasUser = observed.replay.events.some(
    (event) => event.type === "user_committed",
  );
  if (!hasUser && observed.recoveryView.activeRunId === undefined) {
    throw new SessionKernelError("incomplete_bootstrap");
  }
}

async function bestEffortStatusObserver(
  observer: KernelCommonInput["onStatus"],
  sessionId: SessionId,
): Promise<
  ((events: readonly AnyVerifiedJournalEvent[]) => void) | undefined
> {
  if (observer === undefined) return undefined;
  const priceBook = await loadPackagedFlashPriceBookV1().catch(() => undefined);
  if (priceBook === undefined) return undefined;
  let enabled = true;
  return (events): void => {
    if (!enabled) return;
    try {
      observer(projectSessionCostV1(sessionId, events, priceBook));
    } catch {
      enabled = false;
    }
  };
}

function rolePosition(
  events: readonly AnyVerifiedJournalEvent[],
  lineageId: LineageId,
): BlobPosition {
  let position: BlobPosition = Object.freeze({
    blobIndex: 0,
    previousChainHash: null,
  });
  for (const event of events) {
    if (!isRoleEvent(event) || event.lineageId !== lineageId) continue;
    if (
      event.payload.blobIndex !== position.blobIndex ||
      event.payload.chainHash === null
    ) {
      throw new SessionKernelError("invalid_state");
    }
    position = Object.freeze({
      blobIndex: event.payload.blobIndex + 1,
      previousChainHash: event.payload.chainHash,
    });
  }
  return position;
}

async function externalBlobMap(
  events: readonly AnyVerifiedJournalEvent[],
  lineageId: LineageId,
  blobs: BlobStore,
): Promise<ReadonlyMap<BlobRef, FrozenBytes>> {
  const external = new Map<BlobRef, FrozenBytes>();
  let position: BlobPosition = Object.freeze({
    blobIndex: 0,
    previousChainHash: null,
  });
  for (const event of events) {
    if (!isRoleEvent(event) || event.lineageId !== lineageId) continue;
    const bytes = await blobs.load(
      event.payload as BlobPayload<RoleEvent["payload"]["role"]>,
      position,
    );
    if (event.payload.enc === "ref") {
      external.set(event.payload.blobRef, bytes);
    }
    position = Object.freeze({
      blobIndex: event.payload.blobIndex + 1,
      previousChainHash: event.payload.chainHash,
    });
  }
  return external;
}

function eventsThrough(
  events: readonly AnyVerifiedJournalEvent[],
  eventId: string,
): readonly AnyVerifiedJournalEvent[] {
  const index = events.findIndex((event) => event.id === eventId);
  if (index < 0) throw new SessionKernelError("invalid_state");
  return Object.freeze(events.slice(0, index + 1));
}

function descriptorForSnapshot(
  event: VerifiedJournalEvent<"request_snapshot_stored">,
): Readonly<{
  readonly bodyRef: VerifiedJournalEvent<"request_snapshot_stored">["payload"]["bodyRef"];
  readonly bodyHash: VerifiedJournalEvent<"request_snapshot_stored">["payload"]["bodyHash"];
  readonly byteCount: number;
}> {
  return Object.freeze({
    bodyRef: event.payload.bodyRef,
    bodyHash: event.payload.bodyHash,
    byteCount: event.payload.byteCount,
  });
}

async function restoredSnapshot(
  store: SnapshotStore,
  event: VerifiedJournalEvent<"request_snapshot_stored">,
): Promise<DeepSeekRequestSnapshot> {
  const body = await store.load(descriptorForSnapshot(event));
  const tagged = event.payload.bodyHash;
  if (!tagged.startsWith("sha256:") || tagged.length !== 71) {
    throw new SessionKernelError("invalid_state");
  }
  return restoreDeepSeekRequestSnapshot(body, {
    bodySha256: tagged.slice("sha256:".length),
    byteCount: event.payload.byteCount,
  });
}

function artifactDescriptorFromEvent(
  payload: VerifiedJournalEvent<"artifact_published">["payload"],
): ArtifactDescriptor {
  return Object.freeze({
    artifactRef: payload.artifactRef,
    artifactHash: payload.artifactHash,
    byteCount: payload.byteCount,
    lineCount: payload.lineCount,
    mediaType: payload.mediaType,
    artifactType: payload.artifactType,
    streamBytes: payload.streamBytes,
    hardLimitReached: payload.hardLimitReached,
    descendantsReaped: payload.descendantsReaped,
    toolCallId: payload.toolCallId,
    terminal: payload.terminal,
  });
}

function existingToolArtifacts(
  opened: Awaited<ReturnType<typeof openJournal>>,
  sessionId: SessionId,
): readonly PublishedToolArtifact[] {
  return Object.freeze(
    opened.writer.events
      .filter(
        (event): event is VerifiedJournalEvent<"artifact_published"> =>
          event.type === "artifact_published" &&
          event.sessionId === sessionId &&
          event.payload.artifactType === "tool_output",
      )
      .map((event) => Object.freeze({
        artifactId: event.payload.artifactId,
        descriptor: artifactDescriptorFromEvent(event.payload),
        store: opened.artifacts,
        event,
      })),
  );
}

async function loadArtifactBytes(
  opened: Awaited<ReturnType<typeof openJournal>>,
  event: VerifiedJournalEvent<"artifact_published">,
): Promise<FrozenBytes> {
  const bytes = new Uint8Array(event.payload.byteCount);
  let offset = 0;
  await opened.artifacts.scanArtifact(
    artifactDescriptorFromEvent(event.payload),
    (chunk) => {
      const copy = chunk.copy();
      bytes.set(copy, offset);
      offset += copy.byteLength;
    },
  );
  if (offset !== bytes.byteLength) {
    throw new SessionKernelError("invalid_state");
  }
  return freezeBytes(bytes);
}

async function loadRoleEventBytes(
  events: readonly AnyVerifiedJournalEvent[],
  lineageId: LineageId,
  eventId: EventId,
  blobs: BlobStore,
): Promise<FrozenBytes> {
  let position: BlobPosition = Object.freeze({
    blobIndex: 0,
    previousChainHash: null,
  });
  for (const event of events) {
    if (!isRoleEvent(event) || event.lineageId !== lineageId) continue;
    const bytes = await blobs.load(event.payload, position);
    if (event.id === eventId) return bytes;
    position = Object.freeze({
      blobIndex: event.payload.blobIndex + 1,
      previousChainHash: event.payload.chainHash,
    });
  }
  throw new SessionKernelError("invalid_state");
}

export async function loadActiveCacheAbi(
  opened: Awaited<ReturnType<typeof openJournal>>,
  lineageId: LineageId,
): Promise<FrozenCacheAbiManifest> {
  const lineage = opened.writer.events.find(
    (event): event is VerifiedJournalEvent<"lineage_started"> =>
      event.type === "lineage_started" && event.lineageId === lineageId,
  );
  if (lineage === undefined) throw new SessionKernelError("invalid_state");
  const declaration = opened.writer.events.find(
    (event): event is VerifiedJournalEvent<"cache_abi_declared"> =>
      event.type === "cache_abi_declared" &&
      event.payload.cacheAbiId === lineage.payload.cacheAbiId,
  );
  if (declaration === undefined) throw new SessionKernelError("invalid_state");
  const artifact = opened.writer.events.find(
    (event): event is VerifiedJournalEvent<"artifact_published"> =>
      event.type === "artifact_published" &&
      event.payload.artifactId === declaration.payload.manifestArtifactId,
  );
  if (
    artifact === undefined ||
    artifact.payload.byteCount !== declaration.payload.manifestByteCount
  ) {
    throw new SessionKernelError("invalid_state");
  }
  return loadCacheAbi(
    await loadArtifactBytes(opened, artifact),
    lineage.payload.cacheAbiId,
  );
}

function sameToolCalls(
  left: CompletedDeepSeekResponse["toolCalls"],
  right: CompletedDeepSeekResponse["toolCalls"],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (call, index) =>
        call.id === right[index]?.id &&
        call.type === right[index]?.type &&
        call.function.name === right[index]?.function.name &&
        call.function.arguments === right[index]?.function.arguments,
    )
  );
}

function validateResponse(response: CompletedDeepSeekResponse): void {
  const view = viewAssistant(response.assistantBytes);
  if (
    view.content !== response.content ||
    view.reasoningContent !== response.reasoningContent ||
    !sameToolCalls(view.toolCalls, response.toolCalls)
  ) {
    throw new SessionKernelError("invalid_state");
  }
}

function failureOutcome(failure: Error):
  | "http_error"
  | "transport_error"
  | "timeout"
  | "cancelled"
  | "protocol_error"
  | "durability_error" {
  if (failure instanceof DeepSeekHttpError) return "http_error";
  if (failure instanceof DeepSeekProtocolError) return "protocol_error";
  if (failure instanceof DeepSeekDurabilityError) return "durability_error";
  if (failure instanceof DeepSeekTransportError) {
    if (failure.kind === "timeout") return "timeout";
    if (failure.kind === "cancelled") return "cancelled";
    return "transport_error";
  }
  return "transport_error";
}

function interruptionReason(
  failure: Error,
  semanticState: DeepSeekSemanticState,
): SessionInterruptionReason {
  if (failure instanceof DeepSeekDurabilityError) return "durability_failure";
  if (failure instanceof DeepSeekTransportError && failure.kind === "cancelled") {
    return "cancelled";
  }
  if (semanticState !== "pre_semantic") return "semantic_interrupted";
  return "request_failed";
}

function semanticWire(
  value: DeepSeekSemanticState,
): "pre_semantic" | "post_semantic" | "semantic_state_unknown" {
  return value === "unknown" ? "semantic_state_unknown" : value;
}

async function closeDurabilityFailure(input: Readonly<{
  writer: Awaited<ReturnType<typeof openJournal>>["writer"];
  sessionId: SessionId;
  lineageId: LineageId;
  runId: RunId;
  sourceEventId: EventId;
  attempt?: VerifiedJournalEvent<"request_attempt_started">;
  requestSnapshotId?: VerifiedJournalEvent<"request_snapshot_stored">["payload"]["requestSnapshotId"];
  semanticState?: DeepSeekSemanticState;
}>): Promise<boolean> {
  if (input.writer.state !== "open") return false;
  try {
    let sourceEventId = input.sourceEventId;
    if (
      input.attempt !== undefined &&
      input.requestSnapshotId !== undefined &&
      input.semanticState !== undefined
    ) {
      const interrupted = asEvent(
        await input.writer.append({
          type: "request_interrupted",
          sessionId: input.sessionId,
          lineageId: input.lineageId,
          runId: input.runId,
          payload: {
            attemptId: input.attempt.payload.attemptId,
            requestSnapshotId: input.requestSnapshotId,
            outcome: "durability_error",
            status: null,
            retryClass: "unknown",
            semanticState: semanticWire(input.semanticState),
          },
        }),
        "request_interrupted",
      );
      sourceEventId = interrupted.id;
    }
    await input.writer.append({
      type: "run_interrupted",
      sessionId: input.sessionId,
      lineageId: input.lineageId,
      runId: input.runId,
      payload: { reason: "durability_failure", sourceEventId },
    });
    return true;
  } catch {
    return false;
  }
}

async function appendBoundary(
  writer: Awaited<ReturnType<typeof openJournal>>["writer"],
  sessionId: SessionId,
  lineageId: LineageId,
  runId: RunId,
  sourceEventIds: readonly EventId[],
  cacheCheckpointId: CacheCheckpointId | null,
): Promise<VerifiedJournalEvent<"commit_boundary_created">> {
  const source = writer.events.findLast(
    (event) => event.id === sourceEventIds.at(-1),
  );
  if (source === undefined || !isRoleEvent(source)) {
    throw new SessionKernelError("invalid_state");
  }
  return asEvent(
    await writer.append({
      type: "commit_boundary_created",
      sessionId,
      lineageId,
      runId,
      ...(sourceEventIds.length === 1 ? { parentId: source.id } : {}),
      payload: {
        commitBoundaryId: newCommitBoundaryId(),
        cacheCheckpointId,
        blobCount: source.payload.blobIndex + 1,
        chainHash: source.payload.chainHash,
        protocolClosed: true,
        effectsSettled: true,
        sourceEventIds,
      },
    }),
    "commit_boundary_created",
  );
}

async function appendCheckpoint(
  writer: Awaited<ReturnType<typeof openJournal>>["writer"],
  sessionId: SessionId,
  lineageId: LineageId,
  runId: RunId,
  assistant: VerifiedJournalEvent<"assistant_committed">,
): Promise<VerifiedJournalEvent<"cache_checkpoint_created">> {
  return asEvent(
    await writer.append({
      type: "cache_checkpoint_created",
      sessionId,
      lineageId,
      runId,
      parentId: assistant.id,
      payload: {
        cacheCheckpointId: newCacheCheckpointId(),
        requestSnapshotId: assistant.payload.requestSnapshotId,
        blobCount: assistant.payload.blobIndex + 1,
        chainHash: assistant.payload.chainHash,
        promptTokens: assistant.payload.usage.promptTokens,
        providerRequestId: assistant.payload.providerRequestId,
        sourceAssistantEventId: assistant.id,
      },
    }),
    "cache_checkpoint_created",
  );
}

async function publishFact(
  opened: Awaited<ReturnType<typeof openJournal>>,
  sessionId: SessionId,
  lineageId: LineageId,
  runId: RunId,
  kind: "user_input" | "date" | "cwd" | "git" | "tree",
  value: string,
): Promise<Readonly<{
  readonly published: VerifiedJournalEvent<"artifact_published">;
  readonly fact: VerifiedJournalEvent<"fact_recorded">;
  readonly bytes: FrozenBytes;
}>> {
  assertUnicodeScalarString(value, `${kind} fact`);
  const bytes = utf8Bytes(value);
  const descriptor = await opened.artifacts.publishArtifact(bytes, {
    lineCount: null,
    mediaType: "text/plain; charset=utf-8",
    artifactType: "fact",
    streamBytes: null,
    hardLimitReached: null,
    descendantsReaped: null,
    toolCallId: null,
    terminal: null,
  });
  const artifactId = newArtifactId();
  const published = asEvent(
    await opened.writer.append({
      type: "artifact_published",
      sessionId,
      lineageId,
      runId,
      payload: { artifactId, ...descriptor },
    }),
    "artifact_published",
  );
  const fact = asEvent(
    await opened.writer.append({
      type: "fact_recorded",
      sessionId,
      lineageId,
      runId,
      parentId: published.id,
      payload: { kind, artifactId, byteCount: bytes.byteLength },
    }),
    "fact_recorded",
  );
  return Object.freeze({ published, fact, bytes });
}

async function initialize(
  opened: Awaited<ReturnType<typeof openJournal>>,
  input: SessionBaseInput,
  blobs: BlobStore,
): Promise<Readonly<{
  readonly cacheAbi: FrozenCacheAbiManifest;
  readonly lineageId: LineageId;
  readonly runId: RunId;
  readonly boundary: VerifiedJournalEvent<"commit_boundary_created">;
}>> {
  if (opened.writer.events.length !== 0 || input.userInput.length === 0) {
    throw new SessionKernelError("invalid_state");
  }
  const session = asEvent(
    await opened.writer.append({
      type: "session_started",
      sessionId: input.sessionId,
      payload: {},
    }),
    "session_started",
  );
  // The workspace's own rules join the frozen zone here, so they are part of
  // this Session's Cache ABI and every later turn reads them as a cache hit.
  const cacheAbi = buildCacheAbiV2(
    loadProjectInstructions(input.workspaceRoot),
    input.reasoningEffort,
  );
  const manifest = await opened.artifacts.publishArtifact(cacheAbi.manifestBytes, {
    lineCount: null,
    mediaType: "application/octet-stream",
    artifactType: "cache_abi_manifest",
    streamBytes: null,
    hardLimitReached: null,
    descendantsReaped: null,
    toolCallId: null,
    terminal: null,
  });
  const manifestArtifactId = newArtifactId();
  const manifestEvent = asEvent(
    await opened.writer.append({
      type: "artifact_published",
      sessionId: input.sessionId,
      parentId: session.id,
      payload: { artifactId: manifestArtifactId, ...manifest },
    }),
    "artifact_published",
  );
  await opened.writer.append({
    type: "cache_abi_declared",
    sessionId: input.sessionId,
    parentId: manifestEvent.id,
    payload: {
      cacheAbiId: cacheAbi.cacheAbiId,
      manifestArtifactId,
      manifestByteCount: cacheAbi.manifestBytes.byteLength,
    },
  });
  const lineageId = newLineageId();
  await opened.writer.append({
    type: "lineage_started",
    sessionId: input.sessionId,
    lineageId,
    payload: { cacheAbiId: cacheAbi.cacheAbiId },
  });
  await opened.writer.append({
    type: "lineage_activated",
    sessionId: input.sessionId,
    lineageId,
    payload: {
      previousLineageId: null,
      nextLineageId: lineageId,
      reason: "initial",
    },
  });
  const runId = newRunId();
  await opened.writer.append({
    type: "run_started",
    sessionId: input.sessionId,
    lineageId,
    runId,
    payload: { cause: "user", previousRunId: null },
  });

  const factInputs = [
    await publishFact(
      opened,
      input.sessionId,
      lineageId,
      runId,
      "user_input",
      input.userInput,
    ),
  ];
  for (const kind of FIRST_TURN_FACTS) {
    const value = input.environmentFacts?.[kind];
    if (value !== undefined) {
      factInputs.push(
        await publishFact(
          opened,
          input.sessionId,
          lineageId,
          runId,
          kind,
          value,
        ),
      );
    }
  }
  const user = materializeUserV1({ facts: factInputs });
  const payload = await blobs.publish("user", user.blob, {
    blobIndex: 0,
    previousChainHash: null,
  });
  const userEvent = asEvent(
    await opened.writer.append({
      type: "user_committed",
      sessionId: input.sessionId,
      lineageId,
      runId,
      parentId: user.sourceFactEventIds.at(-1)!,
      payload: { ...payload, sourceFactEventIds: user.sourceFactEventIds },
    }),
    "user_committed",
  );
  const boundary = await appendBoundary(
    opened.writer,
    input.sessionId,
    lineageId,
    runId,
    [userEvent.id],
    null,
  );
  return Object.freeze({ cacheAbi, lineageId, runId, boundary });
}

function nextBlobPosition(
  events: readonly AnyVerifiedJournalEvent[],
  lineageId: LineageId,
): BlobPosition {
  let position: BlobPosition = Object.freeze({
    blobIndex: 0,
    previousChainHash: null,
  });
  for (const event of events) {
    if (!isRoleEvent(event) || event.lineageId !== lineageId) continue;
    position = Object.freeze({
      blobIndex: event.payload.blobIndex + 1,
      previousChainHash: event.payload.chainHash,
    });
  }
  return position;
}

/**
 * Append one more user turn to a Lineage whose last Run already completed.
 *
 * This is a tail append, not a new Session: the Cache ABI, system and tools
 * blobs and every earlier blob stay byte-identical, so the whole prefix is
 * still eligible for a cache hit and no `cache_break` is produced.
 */
async function initializeContinuation(
  opened: Awaited<ReturnType<typeof openJournal>>,
  input: SessionBaseInput,
  blobs: BlobStore,
): Promise<KernelReadyState> {
  if (opened.writer.events.length === 0 || input.userInput.length === 0) {
    throw new SessionKernelError("invalid_state");
  }
  const activation = opened.writer.events.reduce<
    VerifiedJournalEvent<"lineage_activated"> | undefined
  >(
    (latest, event) =>
      event.type === "lineage_activated" ? event : latest,
    undefined,
  );
  if (activation === undefined) throw new SessionKernelError("invalid_state");
  const lineageId = activation.payload.nextLineageId as LineageId;

  const previousRun = opened.writer.events.reduce<
    VerifiedJournalEvent<"run_started"> | undefined
  >(
    (latest, event) =>
      event.type === "run_started" && event.lineageId === lineageId
        ? event
        : latest,
    undefined,
  );
  // A Lineage the Session switched to has no Run yet — whether it was created
  // to compact the conversation or to change the reasoning effort. Its first
  // turn is a user turn, exactly like the first turn of a Session: there is no
  // earlier Run on this prefix to continue from, because the prefix is new.
  const previousRunId = previousRun?.runId;
  if (previousRunId !== undefined) {
    // The previous Run must be closed, but it may have closed either way: a Run
    // the user interrupted at a safe boundary is continuable. Whether the
    // durable tail is actually closed is enforced by the Journal bindings when
    // the run_started is appended, which is the authority for that check.
    const closed = opened.writer.events.some(
      (event) =>
        (event.type === "run_completed" || event.type === "run_interrupted") &&
        event.runId === previousRunId,
    );
    if (!closed) throw new SessionKernelError("invalid_state");
  } else if (activation.payload.reason === "initial") {
    throw new SessionKernelError("invalid_state");
  }

  const cacheAbi = await loadActiveCacheAbi(opened, lineageId);
  // The effort is frozen into this Lineage's ABI. Continuing with a different
  // one would change request bytes mid-prefix, so refuse instead of drifting.
  if (input.reasoningEffort !== undefined) {
    const durable = reasoningEffortFromTuple(cacheAbi.modelTupleBytes);
    if (durable !== input.reasoningEffort) {
      throw new SessionKernelError("invalid_state");
    }
  }
  const runId = newRunId();
  await opened.writer.append({
    type: "run_started",
    sessionId: input.sessionId,
    lineageId,
    runId,
    payload:
      previousRunId === undefined
        ? { cause: "user", previousRunId: null }
        : { cause: "continue", previousRunId },
  });

  const factInputs = [
    await publishFact(
      opened,
      input.sessionId,
      lineageId,
      runId,
      "user_input",
      input.userInput,
    ),
  ];
  // A continued turn repeats only what can have changed since the last one.
  for (const kind of EVERY_TURN_FACTS) {
    const value = input.environmentFacts?.[kind];
    if (value !== undefined) {
      factInputs.push(
        await publishFact(opened, input.sessionId, lineageId, runId, kind, value),
      );
    }
  }
  const user = materializeUserV1({ facts: factInputs });
  const payload = await blobs.publish(
    "user",
    user.blob,
    nextBlobPosition(opened.writer.events, lineageId),
  );
  const userEvent = asEvent(
    await opened.writer.append({
      type: "user_committed",
      sessionId: input.sessionId,
      lineageId,
      runId,
      parentId: user.sourceFactEventIds.at(-1)!,
      payload: { ...payload, sourceFactEventIds: user.sourceFactEventIds },
    }),
    "user_committed",
  );
  const boundary = await appendBoundary(
    opened.writer,
    input.sessionId,
    lineageId,
    runId,
    [userEvent.id],
    null,
  );
  return Object.freeze({ cacheAbi, lineageId, runId, boundary });
}

interface KernelReadyState {
  readonly cacheAbi: FrozenCacheAbiManifest;
  readonly lineageId: LineageId;
  readonly runId: RunId;
  readonly boundary: VerifiedJournalEvent<"commit_boundary_created">;
  readonly snapshotEvent?: VerifiedJournalEvent<"request_snapshot_stored">;
}

type RecoveryPreparation =
  | Readonly<{ readonly kind: "ready"; readonly state: KernelReadyState }>
  | Readonly<{
      readonly kind: "completed";
      readonly result: CompletedSessionResult;
    }>
  | Readonly<{
      readonly kind: "indeterminate";
      readonly effectId: EffectId;
    }>;

function activeLineage(view: RecoveryViewV1): LineageId {
  if (view.activeLineageId === undefined) {
    throw new SessionKernelError("invalid_state");
  }
  return view.activeLineageId as LineageId;
}

function boundaryById(
  events: readonly AnyVerifiedJournalEvent[],
  commitBoundaryId: CommitBoundaryId,
): VerifiedJournalEvent<"commit_boundary_created"> {
  const boundary = events.find(
    (event): event is VerifiedJournalEvent<"commit_boundary_created"> =>
      event.type === "commit_boundary_created" &&
      event.payload.commitBoundaryId === commitBoundaryId,
  );
  if (boundary === undefined) throw new SessionKernelError("invalid_state");
  return boundary;
}

async function prepareRecovery(
  opened: Awaited<ReturnType<typeof openJournal>>,
  input: RecoverySessionBaseInput,
  blobs: BlobStore,
  snapshots: SnapshotStore,
  returnAtIndeterminate: boolean,
  webSearch: DeepSeekWebSearchExecutor,
): Promise<RecoveryPreparation> {
  const signal = input.signal ?? new AbortController().signal;
  const acknowledgedSnapshotIds = new Set<string>();
  for (;;) {
    const view = opened.recoveryView();
    const step = planRecoveryStepV1(view, opened.writer.events);
    const lineageId =
      step.kind === "incomplete_bootstrap"
        ? undefined
        : activeLineage(view);
    switch (step.kind) {
      case "incomplete_bootstrap":
        throw new SessionKernelError("incomplete_bootstrap");
      case "close_open_attempt":
        await opened.writer.append({
          type: "request_interrupted",
          sessionId: input.sessionId,
          lineageId: lineageId!,
          runId: step.runId,
          payload: {
            attemptId: step.attemptId,
            requestSnapshotId: step.requestSnapshotId,
            outcome: "durability_error",
            status: null,
            retryClass: "unknown",
            semanticState: step.semanticState,
          },
        });
        break;
      case "append_checkpoint": {
        const assistant = recoveryEventById(
          opened.writer.events,
          step.assistantEventId,
          "assistant_committed",
        );
        await appendCheckpoint(
          opened.writer,
          input.sessionId,
          lineageId!,
          step.runId,
          assistant,
        );
        break;
      }
      case "append_boundary":
        await appendBoundary(
          opened.writer,
          input.sessionId,
          lineageId!,
          step.runId,
          step.sourceEventIds,
          step.cacheCheckpointId,
        );
        break;
      case "mark_effect_indeterminate":
        await opened.writer.append({
          type: "effect_indeterminate",
          sessionId: input.sessionId,
          lineageId: lineageId!,
          runId: step.runId,
          payload: { effectId: step.effectId, reason: "crash_gap" },
        });
        break;
      case "complete_run":
        await opened.writer.append({
          type: "run_completed",
          sessionId: input.sessionId,
          lineageId: lineageId!,
          runId: step.runId,
          payload: {
            commitBoundaryId: step.commitBoundaryId,
            sourceAssistantEventId: step.sourceAssistantEventId,
          },
        });
        break;
      case "interrupt_run":
        await opened.writer.append({
          type: "run_interrupted",
          sessionId: input.sessionId,
          lineageId: lineageId!,
          runId: step.runId,
          payload: {
            reason: step.reason,
            sourceEventId: step.sourceEventId,
          },
        });
        break;
      case "start_recovery_run":
        await opened.writer.append({
          type: "run_started",
          sessionId: input.sessionId,
          lineageId: lineageId!,
          runId: newRunId(),
          payload: { cause: "recovery", previousRunId: step.previousRunId },
        });
        break;
      case "stop_indeterminate":
        if (returnAtIndeterminate) {
          return Object.freeze({
            kind: "indeterminate",
            effectId: step.effectId,
          });
        }
        throw new SessionInterruptedError("effect_indeterminate");
      case "resume_tool": {
        const beforeCount = opened.writer.events.length;
        try {
          await resumeRecoveryToolV1({
            opened,
            blobs,
            view,
            step,
            workspaceRoot: input.workspaceRoot,
            sessionId: input.sessionId,
            lineageId: lineageId!,
            signal,
            webSearch,
          });
        } catch (error) {
          if (signal.aborted) throw new SessionInterruptedError("cancelled");
          if (
            opened.writer.state !== "open" ||
            opened.writer.events.length === beforeCount
          ) {
            throw error;
          }
        }
        break;
      }
      case "store_snapshot": {
        const cacheAbi = await loadActiveCacheAbi(opened, lineageId!);
        const boundary = boundaryById(
          opened.writer.events,
          step.commitBoundaryId,
        );
        if (step.mode === "fresh") {
          const journalFacts = eventsThrough(opened.writer.events, boundary.id);
          const stored = await storeProjectedSnapshotV1({
            snapshotStore: snapshots,
            journal: opened.writer,
            requestSnapshotId: newRequestSnapshotId(),
            sessionId: input.sessionId,
            runId: step.runId,
            projectionInput: {
              cacheAbi,
              journalFacts,
              externalBlobs: await externalBlobMap(
                journalFacts,
                lineageId!,
                blobs,
              ),
              lineageId: lineageId!,
              commitBoundaryId: step.commitBoundaryId,
            },
          });
          acknowledgedSnapshotIds.add(stored.payload.requestSnapshotId);
        } else {
          if (step.sourceSnapshotId === null) {
            throw new SessionKernelError("invalid_state");
          }
          const source = view.snapshots.find(
            ({ requestSnapshotId }) =>
              requestSnapshotId === step.sourceSnapshotId,
          );
          if (source === undefined) {
            throw new SessionKernelError("invalid_state");
          }
          const stored = await storeRecoveryAliasV1({
            snapshotStore: snapshots,
            journal: opened.writer,
            cacheAbi,
            sourceSnapshotEvent: recoveryEventById(
              opened.writer.events,
              source.eventId,
              "request_snapshot_stored",
            ),
            requestSnapshotId: newRequestSnapshotId(),
            sessionId: input.sessionId,
            lineageId: lineageId!,
            runId: step.runId,
          });
          acknowledgedSnapshotIds.add(stored.payload.requestSnapshotId);
        }
        break;
      }
      case "send_snapshot": {
        const snapshot = view.snapshots.find(
          ({ requestSnapshotId }) =>
            requestSnapshotId === step.requestSnapshotId,
        );
        if (snapshot === undefined) {
          throw new SessionKernelError("invalid_state");
        }
        const snapshotEvent = recoveryEventById(
          opened.writer.events,
          snapshot.eventId,
          "request_snapshot_stored",
        );
        if (
          !acknowledgedSnapshotIds.has(
            snapshotEvent.payload.requestSnapshotId,
          )
        ) {
          await opened.writer.append({
            type: "run_interrupted",
            sessionId: input.sessionId,
            lineageId: lineageId!,
            runId: step.runId,
            payload: {
              reason: "durability_failure",
              sourceEventId: snapshotEvent.id,
            },
          });
          break;
        }
        return Object.freeze({
          kind: "ready",
          state: Object.freeze({
            cacheAbi: await loadActiveCacheAbi(opened, lineageId!),
            lineageId: lineageId!,
            runId: step.runId,
            boundary: boundaryById(
              opened.writer.events,
              snapshotEvent.payload.commitBoundaryId,
            ),
            snapshotEvent,
          }),
        });
      }
      case "completed": {
        const assistant = recoveryEventById(
          opened.writer.events,
          step.sourceAssistantEventId,
          "assistant_committed",
        );
        const content = viewAssistant(
          await loadRoleEventBytes(
            opened.writer.events,
            lineageId!,
            assistant.id,
            blobs,
          ),
        ).content;
        return Object.freeze({
          kind: "completed",
          result: Object.freeze({
            status: "completed",
            sessionId: input.sessionId,
            lineageId: lineageId!,
            runId: step.runId,
            content,
            commitBoundaryId: step.commitBoundaryId,
            requestCount: 0,
            // Read back from the durable record rather than recomputed: the
            // replay path never saw the response.
            truncated: assistant.payload.usage.rawFinishReason === "length",
            verification: verificationFromEvents(
              opened.writer.events,
              assistant.id,
            ),
          }),
        });
      }
    }
  }
}

/**
 * Binds the official web search endpoint to whatever credential the caller
 * holds. Fixture and test inputs have neither field; they get a stub that only
 * ever throws, so a fixture Session that never calls web_search is unaffected
 * and one that does must supply its own executor through the fixture.
 */
function webSearchExecutorForInput(
  input:
    | SessionBaseInput
    | RecoverySessionBaseInput
    | ReconciliationSessionFixtureInput
    | OfficialReconciliationInput,
): DeepSeekWebSearchExecutor {
  if ("credential" in input) {
    const credential = (input as OfficialSessionInput).credential;
    return (query, signal) =>
      runDeepSeekWebSearch({ credential, ...query, signal });
  }
  if ("loadCredential" in input) {
    const loadCredential = (input as OfficialRecoveryInput).loadCredential;
    return (query, signal) =>
      runDeepSeekWebSearch({ credential: loadCredential(), ...query, signal });
  }
  return Object.freeze(async () => {
    throw new Error("web search executor is not bound");
  });
}

async function runKernel(
  input:
    | SessionBaseInput
    | RecoverySessionBaseInput
    | ReconciliationSessionFixtureInput
    | OfficialReconciliationInput,
  send: SendSnapshot,
  beforeSend?: SessionFixtureInput["onBeforeSend"],
  persistenceControls?: PersistenceTestControls,
  mode: "new" | "continue" | "recover" | "reconcile" = "new",
): Promise<CompletedSessionResult> {
  if (mode === "new" || mode === "continue") {
    if (!("userInput" in input)) throw new SessionKernelError("invalid_state");
    assertUnicodeScalarString(input.userInput, "user input");
  }
  const reconciliation =
    mode === "reconcile"
      ? parseReconciliationEvidenceV1(
          (input as ReconciliationSessionFixtureInput).evidenceBytes,
        )
      : undefined;
  if (mode !== "new") {
    await recoveryExistingOnlyPreflight(input.workspaceRoot, input.sessionId);
  }
  const acceptanceBudget =
    mode === "new" || mode === "continue"
      ? (input as SessionBaseInput).acceptanceBudget
      : undefined;
  const signal = executionSignal(input.signal, acceptanceBudget);
  const observePreview = bestEffortPreviewObserver(input.onPreview);
  const observeStatus = await bestEffortStatusObserver(
    input.onStatus,
    input.sessionId,
  );
  const opened = await openJournal(
    input.workspaceRoot,
    input.sessionId,
    input.clock ?? systemJournalClock,
    input.eventIds ?? randomEventIdentitySource,
    persistenceControls,
  );
  const webSearch = webSearchExecutorForInput(input);
  let phase: KernelPhase = "created";
  try {
    const [blobs, snapshots] = await Promise.all([
      createBlobStore(opened.paths.sessionDir, persistenceControls),
      createSnapshotStore(opened.paths.sessionDir, persistenceControls),
    ]);
    let initialized: KernelReadyState;
    if (mode === "new") {
      initialized = await initialize(
        opened,
        input as SessionBaseInput,
        blobs,
      );
    } else if (mode === "continue") {
      initialized = await initializeContinuation(
        opened,
        input as SessionBaseInput,
        blobs,
      );
    } else {
      if (mode === "reconcile") {
        if (reconciliation === undefined) {
          throw new SessionKernelError("invalid_state");
        }
        const alreadyReconciled = opened.writer.events.some(
          (event) =>
            event.type === "effect_reconciled" &&
            event.payload.effectId === reconciliation.effectId,
        );
        if (!alreadyReconciled) {
          const stopped = await prepareRecovery(
            opened,
            input as RecoverySessionBaseInput,
            blobs,
            snapshots,
            true,
            webSearch,
          );
          if (
            stopped.kind !== "indeterminate" ||
            stopped.effectId !== reconciliation.effectId
          ) {
            throw new SessionKernelError("invalid_state");
          }
        }
        await applyReconciliationV1({
          opened,
          sessionId: input.sessionId,
          evidenceBytes: (input as ReconciliationSessionFixtureInput)
            .evidenceBytes,
          document: reconciliation,
        });
      }
      const prepared = await prepareRecovery(
        opened,
        input as RecoverySessionBaseInput,
        blobs,
        snapshots,
        false,
        webSearch,
      );
      if (prepared.kind === "completed") {
        observeStatus?.(opened.writer.events);
        return prepared.result;
      }
      if (prepared.kind === "indeterminate") {
        throw new SessionKernelError("invalid_state");
      }
      initialized = prepared.state;
    }
    observeStatus?.(opened.writer.events);
    const { cacheAbi, lineageId, runId } = initialized;
    const toolsProfile = toolSchemaProfileForBytes(cacheAbi.toolsBlob);
    const resultProfile = toolResultProfileForCacheAbi(cacheAbi);
    let boundary = initialized.boundary;
    let pendingSnapshotEvent = initialized.snapshotEvent;
    let pendingSemanticRequestOrdinal: number | undefined;
    let requestCount = 0;
    phase = transition(phase, "ready");

    for (;;) {
      if (signal.aborted) {
        const source = opened.writer.events.findLast(
          (event) => event.lineageId === lineageId && event.runId === runId,
        ) ?? boundary;
        await opened.writer.append({
          type: "run_interrupted",
          sessionId: input.sessionId,
          lineageId,
          runId,
          payload: { reason: "cancelled", sourceEventId: source.id },
        });
        phase = transition(phase, "interrupted");
        throw new SessionInterruptedError("cancelled");
      }
      let snapshotEvent: VerifiedJournalEvent<"request_snapshot_stored">;
      let requestSnapshot: DeepSeekRequestSnapshot;
      try {
        if (pendingSnapshotEvent !== undefined) {
          snapshotEvent = pendingSnapshotEvent;
          pendingSnapshotEvent = undefined;
        } else {
          pendingSemanticRequestOrdinal =
            acceptanceBudget === undefined
              ? undefined
              : acceptanceCall(() =>
                  acceptanceBudget.beforeSemanticRequest()
                );
          const journalFacts = eventsThrough(opened.writer.events, boundary.id);
          snapshotEvent = await storeProjectedSnapshotV1({
            snapshotStore: snapshots,
            journal: opened.writer,
            requestSnapshotId: newRequestSnapshotId(),
            sessionId: input.sessionId,
            runId,
            projectionInput: {
              cacheAbi,
              journalFacts,
              externalBlobs: await externalBlobMap(
                journalFacts,
                lineageId,
                blobs,
              ),
              lineageId,
              commitBoundaryId: boundary.payload.commitBoundaryId,
            },
          });
        }
        requestSnapshot = await restoredSnapshot(snapshots, snapshotEvent);
      } catch (error) {
        if (error instanceof SessionAcceptanceBudgetError) {
          await opened.writer.append({
            type: "run_interrupted",
            sessionId: input.sessionId,
            lineageId,
            runId,
            payload: { reason: "cancelled", sourceEventId: boundary.id },
          });
          phase = transition(phase, "interrupted");
          throw error;
        }
        const source = opened.writer.events.findLast(
          (event) => event.lineageId === lineageId && event.runId === runId,
        ) ?? boundary;
        const closed = await closeDurabilityFailure({
          writer: opened.writer,
          sessionId: input.sessionId,
          lineageId,
          runId,
          sourceEventId: source.id,
        });
        phase = transition(phase, "interrupted");
        if (!closed) throw new SessionKernelError("durability_failure");
        throw new SessionInterruptedError("durability_failure");
      }
      if (signal.aborted) {
        await opened.writer.append({
          type: "run_interrupted",
          sessionId: input.sessionId,
          lineageId,
          runId,
          payload: { reason: "cancelled", sourceEventId: snapshotEvent.id },
        });
        phase = transition(phase, "interrupted");
        throw new SessionInterruptedError("cancelled");
      }
      await beforeSend?.(
        Object.freeze({
          snapshot: requestSnapshot,
          acknowledgedEvents: opened.writer.events,
        }),
      );

      phase = transition(phase, "requesting");
      const attempts = new Map<number, VerifiedJournalEvent<"request_attempt_started">>();
      const semanticAttempts = new Set<string>();
      let activeAttempt: VerifiedJournalEvent<"request_attempt_started"> | undefined;
      const lifecycle: DeepSeekRetryLifecycle = {
        beforeAttempt: async (ordinal, candidate) => {
          if (candidate !== requestSnapshot || attempts.has(ordinal)) {
            throw new SessionKernelError("invalid_state");
          }
          if (acceptanceBudget !== undefined) {
            if (pendingSemanticRequestOrdinal === undefined) {
              throw new SessionKernelError("invalid_state");
            }
            acceptanceCall(() =>
              acceptanceBudget.beforePhysicalAttempt(
                pendingSemanticRequestOrdinal!,
              )
            );
          }
          const attempt = asEvent(
            await opened.writer.append({
              type: "request_attempt_started",
              sessionId: input.sessionId,
              lineageId,
              runId,
              payload: {
                attemptId: newAttemptId(),
                requestSnapshotId: snapshotEvent.payload.requestSnapshotId,
                ordinal,
              },
            }),
            "request_attempt_started",
          );
          attempts.set(ordinal, attempt);
          activeAttempt = attempt;
        },
        onSemanticStarted: async (ordinal) => {
          const attempt = attempts.get(ordinal);
          if (attempt === undefined || activeAttempt?.id !== attempt.id) {
            throw new SessionKernelError("invalid_state");
          }
          await opened.writer.append({
            type: "request_semantic_started",
            sessionId: input.sessionId,
            lineageId,
            runId,
            payload: { attemptId: attempt.payload.attemptId },
          });
          semanticAttempts.add(attempt.id);
        },
        afterInterrupted: async (
          ordinal,
          failure,
          semanticState,
          decision,
        ) => {
          const attempt = attempts.get(ordinal);
          if (attempt === undefined || activeAttempt?.id !== attempt.id) {
            throw new SessionKernelError("invalid_state");
          }
          const interrupted = asEvent(
            await opened.writer.append({
              type: "request_interrupted",
              sessionId: input.sessionId,
              lineageId,
              runId,
              payload: {
                attemptId: attempt.payload.attemptId,
                requestSnapshotId: snapshotEvent.payload.requestSnapshotId,
                outcome: failureOutcome(failure),
                status:
                  failure instanceof DeepSeekHttpError ? failure.status : null,
                retryClass:
                  decision.retryClass === "unknown"
                    ? "unknown"
                    : decision.retryClass,
                semanticState: semanticWire(semanticState),
              },
            }),
            "request_interrupted",
          );
          activeAttempt = undefined;
          if (
            acceptanceBudget !== undefined &&
            semanticState === "pre_semantic" &&
            decision.retry
          ) {
            if (pendingSemanticRequestOrdinal === undefined) {
              throw new SessionKernelError("invalid_state");
            }
            acceptanceCall(() =>
              acceptanceBudget.recordPreSemanticFailure(
                pendingSemanticRequestOrdinal!,
              )
            );
          }
          if (!decision.retry) {
            await opened.writer.append({
              type: "run_interrupted",
              sessionId: input.sessionId,
              lineageId,
              runId,
              payload: {
                reason: interruptionReason(failure, semanticState),
                sourceEventId: interrupted.id,
              },
            });
          }
        },
      };

      let response: CompletedDeepSeekResponse;
      try {
        response = await send(
          requestSnapshot,
          lifecycle,
          observePreview,
          signal,
        );
      } catch (error) {
        if (error instanceof SessionAcceptanceBudgetError) {
          const source = opened.writer.events.findLast(
            (event) => event.lineageId === lineageId && event.runId === runId,
          ) ?? snapshotEvent;
          await opened.writer.append({
            type: "run_interrupted",
            sessionId: input.sessionId,
            lineageId,
            runId,
            payload: { reason: "cancelled", sourceEventId: source.id },
          });
          phase = transition(phase, "interrupted");
          throw error;
        }
        if (error instanceof CredentialError && activeAttempt === undefined) {
          throw error;
        }
        let terminal = opened.writer.events.findLast(
          (event): event is VerifiedJournalEvent<"run_interrupted"> =>
            event.type === "run_interrupted" &&
            event.lineageId === lineageId &&
            event.runId === runId,
        );
        if (terminal === undefined) {
          if (opened.writer.state !== "open") {
            phase = transition(phase, "interrupted");
            throw new SessionKernelError("durability_failure");
          }
          let source = opened.writer.events.findLast(
            (event) => event.lineageId === lineageId && event.runId === runId,
          );
          try {
            if (activeAttempt !== undefined) {
              const semanticState: DeepSeekSemanticState = semanticAttempts.has(
                activeAttempt.id,
              )
                ? "post_semantic"
                : "pre_semantic";
              source = await opened.writer.append({
                type: "request_interrupted",
                sessionId: input.sessionId,
                lineageId,
                runId,
                payload: {
                  attemptId: activeAttempt.payload.attemptId,
                  requestSnapshotId: snapshotEvent.payload.requestSnapshotId,
                  outcome:
                    error instanceof SessionKernelError
                      ? "durability_error"
                      : error instanceof Error
                        ? failureOutcome(error)
                        : "durability_error",
                  status:
                    error instanceof DeepSeekHttpError ? error.status : null,
                  retryClass:
                    error instanceof DeepSeekProtocolError
                      ? "protocol"
                      : error instanceof DeepSeekTransportError
                        ? error.kind === "timeout"
                          ? "timeout"
                          : error.kind === "cancelled"
                            ? "cancelled"
                            : "transport_unknown"
                        : "unknown",
                  semanticState: semanticWire(semanticState),
                },
              });
              activeAttempt = undefined;
            }
            if (source === undefined) {
              throw new SessionKernelError("durability_failure");
            }
            const reason =
              error instanceof DeepSeekTransportError && error.kind === "cancelled"
                ? "cancelled"
                : "durability_failure";
            await opened.writer.append({
              type: "run_interrupted",
              sessionId: input.sessionId,
              lineageId,
              runId,
              payload: { reason, sourceEventId: source.id },
            });
          } catch {
            phase = transition(phase, "interrupted");
            throw new SessionKernelError("durability_failure");
          }
          terminal = opened.writer.events.findLast(
            (event): event is VerifiedJournalEvent<"run_interrupted"> =>
              event.type === "run_interrupted" &&
              event.lineageId === lineageId &&
              event.runId === runId,
          );
        }
        phase = transition(phase, "interrupted");
        if (terminal === undefined) {
          throw new SessionKernelError("durability_failure");
        }
        throw new SessionInterruptedError(terminal.payload.reason);
      }
      requestCount += 1;
      const successfulAttempt = activeAttempt;
      if (successfulAttempt === undefined) {
        throw new SessionKernelError("invalid_state");
      }
      try {
        validateResponse(response);
        if (
          (response.semanticDeltaCount > 0) !==
          semanticAttempts.has(successfulAttempt.id)
        ) {
          throw new SessionKernelError("invalid_state");
        }
        if (acceptanceBudget !== undefined) {
          if (pendingSemanticRequestOrdinal === undefined) {
            throw new SessionKernelError("invalid_state");
          }
          acceptanceCall(() =>
            acceptanceBudget.recordSemanticResponse(
              pendingSemanticRequestOrdinal!,
              response.usage,
            )
          );
          if (acceptanceBudget.signal.aborted) {
            throw new SessionAcceptanceBudgetError(
              acceptanceBudget.signal.reason,
            );
          }
        }
      } catch (error) {
        const semanticState: DeepSeekSemanticState = semanticAttempts.has(
          successfulAttempt.id,
        )
          ? "post_semantic"
          : "pre_semantic";
        if (error instanceof SessionAcceptanceBudgetError) {
          const interrupted = asEvent(
            await opened.writer.append({
              type: "request_interrupted",
              sessionId: input.sessionId,
              lineageId,
              runId,
              payload: {
                attemptId: successfulAttempt.payload.attemptId,
                requestSnapshotId: snapshotEvent.payload.requestSnapshotId,
                outcome: "cancelled",
                status: null,
                retryClass: "cancelled",
                semanticState: semanticWire(semanticState),
              },
            }),
            "request_interrupted",
          );
          activeAttempt = undefined;
          await opened.writer.append({
            type: "run_interrupted",
            sessionId: input.sessionId,
            lineageId,
            runId,
            payload: {
              reason: "cancelled",
              sourceEventId: interrupted.id,
            },
          });
          phase = transition(phase, "interrupted");
          throw error;
        }
        const interrupted = asEvent(
          await opened.writer.append({
            type: "request_interrupted",
            sessionId: input.sessionId,
            lineageId,
            runId,
            payload: {
              attemptId: successfulAttempt.payload.attemptId,
              requestSnapshotId: snapshotEvent.payload.requestSnapshotId,
              outcome: "protocol_error",
              status: null,
              retryClass: "protocol",
              semanticState: semanticWire(semanticState),
            },
          }),
          "request_interrupted",
        );
        activeAttempt = undefined;
        await opened.writer.append({
          type: "run_interrupted",
          sessionId: input.sessionId,
          lineageId,
          runId,
          payload: {
            reason:
              semanticState === "post_semantic"
                ? "semantic_interrupted"
                : "request_failed",
            sourceEventId: interrupted.id,
          },
        });
        phase = transition(phase, "interrupted");
        throw new SessionInterruptedError(
          semanticState === "post_semantic"
            ? "semantic_interrupted"
            : "request_failed",
          interrupted.payload.retryClass,
        );
      }
      phase = transition(phase, "committing_assistant");
      let assistant: VerifiedJournalEvent<"assistant_committed"> | undefined;
      try {
        const assistantPayload = await blobs.publish(
          "assistant",
          response.assistantBytes,
          rolePosition(opened.writer.events, lineageId),
        );
        assistant = asEvent(
          await opened.writer.append({
            type: "assistant_committed",
            sessionId: input.sessionId,
            lineageId,
            runId,
            payload: {
              ...assistantPayload,
              attemptId: successfulAttempt.payload.attemptId,
              requestSnapshotId: snapshotEvent.payload.requestSnapshotId,
              providerRequestId: response.providerRequestId,
              responseModel: response.responseModel,
              systemFingerprint: response.systemFingerprint,
              semanticDeltaCount: response.semanticDeltaCount,
              usage: response.usage,
            },
          }),
          "assistant_committed",
        );
      } catch {
        const semanticState: DeepSeekSemanticState = semanticAttempts.has(
          successfulAttempt.id,
        )
          ? "post_semantic"
          : "pre_semantic";
        const closed = await closeDurabilityFailure({
          writer: opened.writer,
          sessionId: input.sessionId,
          lineageId,
          runId,
          sourceEventId: successfulAttempt.id,
          attempt: successfulAttempt,
          requestSnapshotId: snapshotEvent.payload.requestSnapshotId,
          semanticState,
        });
        activeAttempt = undefined;
        phase = transition(phase, "interrupted");
        if (!closed) throw new SessionKernelError("durability_failure");
        throw new SessionInterruptedError("durability_failure");
      }
      activeAttempt = undefined;
      observeStatus?.(opened.writer.events);
      let checkpoint: VerifiedJournalEvent<"cache_checkpoint_created">;
      try {
        checkpoint = await appendCheckpoint(
          opened.writer,
          input.sessionId,
          lineageId,
          runId,
          assistant,
        );
      } catch {
        phase = transition(phase, "interrupted");
        throw new SessionKernelError("durability_failure");
      }

      if (response.toolCalls.length === 0) {
        let verification: VerificationOutcome = "unavailable";
        let completed: AnyVerifiedJournalEvent | undefined;
        try {
          boundary = await appendBoundary(
            opened.writer,
            input.sessionId,
            lineageId,
            runId,
            [assistant.id],
            checkpoint.payload.cacheCheckpointId,
          );
          completed = await opened.writer.append({
            type: "run_completed",
            sessionId: input.sessionId,
            lineageId,
            runId,
            parentId: boundary.id,
            payload: {
              commitBoundaryId: boundary.payload.commitBoundaryId,
              sourceAssistantEventId: assistant.id,
            },
          });
        } catch {
          phase = transition(phase, "interrupted");
          throw new SessionKernelError("durability_failure");
        }
        // After the Run is closed, and outside its scope. Between the Commit
        // Boundary and `run_completed` the Journal admits nothing else, and a
        // run-scoped event has to belong to an *active* Run. The verdict is
        // about work that Run already finished, so it hangs off the Session and
        // names the assistant event it judged.
        try {
          verification = await recordVerification({
            verify: "verification" in input ? input.verification : undefined,
            opened,
            sessionId: input.sessionId,
            parentId: completed?.id ?? boundary.id,
            sourceAssistantEventId: assistant.id,
            signal,
          });
        } catch {
          phase = transition(phase, "interrupted");
          throw new SessionKernelError("durability_failure");
        }
        phase = transition(phase, "completed");
        return Object.freeze({
          status: "completed",
          sessionId: input.sessionId,
          lineageId,
          runId,
          content: response.content,
          commitBoundaryId: boundary.payload.commitBoundaryId,
          requestCount,
          truncated: response.usage.rawFinishReason === "length",
          verification,
        });
      }

      phase = transition(phase, "executing_tools");
      const durability = new JournalToolDurability({
        scope: {
          sessionId: input.sessionId,
          lineageId,
          runId,
          sourceAssistantEventId: assistant.id,
        },
        writer: opened.writer,
        artifacts: opened.artifacts,
        blobs,
        blobPosition: rolePosition(opened.writer.events, lineageId),
        existingArtifacts: existingToolArtifacts(opened, input.sessionId),
      });
      let results;
      try {
        results = await new ToolRuntime({
          durability,
          cwd: resolve(input.workspaceRoot),
          storageRoot: opened.paths.storageDir,
          canonicalEnvPath: resolve(input.workspaceRoot, ".env"),
          umask: 0o022,
          toolsProfile,
          resultProfile,
          ...(acceptanceBudget === undefined
            ? {}
            : {
                effectGate: {
                  beforeEffect: () =>
                    acceptanceCall(() => acceptanceBudget.beforeEffect()),
                },
              }),
          webSearch,
        }).execute(response.toolCalls, signal);
        // Observation only, after the durable results exist. Failures here are
        // swallowed so a renderer bug cannot end a turn.
        if (input.onToolActivity !== undefined) {
          for (const [index, call] of response.toolCalls.entries()) {
            const settled = results[index];
            // The authoritative outcome is the durable Artifact/Effect
            // terminal, not anything the runtime returned in memory.
            const terminal = opened.writer.events.findLast(
              (event): event is VerifiedJournalEvent<"artifact_published"> =>
                event.type === "artifact_published" &&
                event.payload.toolCallId === settled?.toolCallId &&
                event.payload.terminal !== null,
            )?.payload.terminal;
            try {
              input.onToolActivity({
                phase: "settled",
                name: call.function.name,
                arguments: call.function.arguments,
                ...(terminal == null
                  ? {}
                  : { status: terminal.status, code: terminal.code }),
              });
            } catch {
              // a broken observer must not end the turn
            }
          }
        }
      } catch (error) {
        const terminal = opened.writer.events.findLast(
          (event): event is VerifiedJournalEvent<"run_interrupted"> =>
            event.type === "run_interrupted" &&
            event.lineageId === lineageId &&
            event.runId === runId,
        );
        if (terminal === undefined) {
          if (opened.writer.state !== "open") {
            throw new SessionKernelError("durability_failure");
          }
          if (error instanceof SessionAcceptanceBudgetError) {
            const source = opened.writer.events.findLast(
              (event) => event.lineageId === lineageId && event.runId === runId,
            ) ?? assistant;
            await opened.writer.append({
              type: "run_interrupted",
              sessionId: input.sessionId,
              lineageId,
              runId,
              payload: { reason: "cancelled", sourceEventId: source.id },
            });
            phase = transition(phase, "interrupted");
            throw error;
          }
          throw error instanceof ToolDurabilityError
            ? new SessionKernelError("durability_failure")
            : error;
        }
        phase = transition(phase, "interrupted");
        throw new SessionInterruptedError(terminal.payload.reason);
      }
      try {
        boundary = await appendBoundary(
          opened.writer,
          input.sessionId,
          lineageId,
          runId,
          results.map((result) => result.eventId),
          null,
        );
      } catch {
        phase = transition(phase, "interrupted");
        throw new SessionKernelError("durability_failure");
      }
      if (signal.aborted) {
        try {
          await durability.interruptRun("cancelled", boundary.id);
        } catch (error) {
          if (!(error instanceof ToolDurabilityError)) throw error;
        }
        phase = transition(phase, "interrupted");
        const terminal = opened.writer.events.findLast(
          (event): event is VerifiedJournalEvent<"run_interrupted"> =>
            event.type === "run_interrupted" &&
            event.lineageId === lineageId &&
            event.runId === runId &&
            event.payload.reason === "cancelled" &&
            event.payload.sourceEventId === boundary.id,
        );
        if (terminal === undefined) {
          throw new SessionKernelError("durability_failure");
        }
        throw new SessionInterruptedError("cancelled");
      }
      phase = transition(phase, "ready");
    }
  } finally {
    await opened.writer.close().catch(() => undefined);
  }
}

function sessionGitEnvironment(workspaceRoot: string): NodeJS.ProcessEnv {
  const systemPath = [...new Set([
    dirname(process.execPath),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ])].join(delimiter);
  const environment = Object.assign(Object.create(null) as NodeJS.ProcessEnv, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: workspaceRoot,
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    PATH: systemPath,
  });
  return Object.freeze(environment);
}

/**
 * How many changed files the status fact names before it stops counting them.
 *
 * The list grows as the model works, and it is resent every turn. Unbounded, a
 * task that touches fifty files would put fifty lines nobody asked for in front
 * of every later turn.
 */
export const GIT_STATUS_ENTRY_LIMIT = 20;

/** How many top-level entries the tree fact names. */
export const TREE_ENTRY_LIMIT = 50;

/** `…and 7 more files`, or nothing at all. Truncation is never silent. */
function boundedList(
  lines: readonly string[],
  limit: number,
  noun: string,
): string {
  if (lines.length <= limit) return lines.join("\n");
  const shown = lines.slice(0, limit).join("\n");
  return `${shown}\n…and ${String(lines.length - limit)} more ${noun}`;
}

/**
 * Which of these names the repository itself says do not count.
 *
 * One `git check-ignore` for the whole list rather than a set of invented
 * rules: `node_modules`, `dist` and `.DS_Store` are noise here because this
 * repository says so, not because the harness guessed. A workspace that is not
 * a repository, or a git that fails, hides nothing.
 */
function gitIgnoredNames(
  cwd: string,
  names: readonly string[],
): ReadonlySet<string> {
  if (names.length === 0) return new Set();
  const result = spawnSync("git", ["-C", cwd, "check-ignore", "--stdin"], {
    encoding: "utf8",
    env: sessionGitEnvironment(cwd),
    input: `${names.join("\n")}\n`,
  });
  // 0 means some were ignored, 1 means none were, anything else is a failure.
  if (result.status !== 0) return new Set();
  return new Set(result.stdout.split("\n").filter((line) => line.length > 0));
}

/**
 * The workspace's top level, once.
 *
 * First level only: it says what kind of project this is and where to look,
 * which is what the model would otherwise spend a turn asking. Going deeper
 * would be guessing at what matters and would cost bytes on every Session.
 */
function captureTree(cwd: string): string {
  let entries: Dirent[];
  try {
    entries = readdirSync(cwd, { withFileTypes: true });
  } catch {
    return "unreadable";
  }
  // `.git` is enormous and never useful; the storage directory is ours.
  const visible = entries.filter(
    ({ name }) => name !== ".git" && name !== storageDirectoryName(cwd),
  );
  const ignored = gitIgnoredNames(
    cwd,
    visible.map(({ name }) => name),
  );
  const named = visible
    .filter(({ name }) => !ignored.has(name))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort((left, right) => {
      const leftDirectory = left.endsWith("/");
      if (leftDirectory !== right.endsWith("/")) return leftDirectory ? -1 : 1;
      return left.localeCompare(right);
    });
  return named.length === 0
    ? "empty"
    : boundedList(named, TREE_ENTRY_LIMIT, "entries");
}

export async function captureSessionEnvironment(
  workspaceRoot: string,
): Promise<SessionEnvironmentFacts> {
  const cwd = resolve(workspaceRoot);
  const environment = sessionGitEnvironment(cwd);
  const branch = spawnSync("git", ["-C", cwd, "branch", "--show-current"], {
    encoding: "utf8",
    env: environment,
  });
  const status = spawnSync("git", ["-C", cwd, "status", "--short"], {
    encoding: "utf8",
    env: environment,
  });
  let git = "not a git repository";
  if (branch.status === 0 && status.status === 0) {
    const changed = status.stdout.split("\n").filter((line) => line.length > 0);
    const head = `branch: ${branch.stdout.trim() || "detached"}`;
    git =
      changed.length === 0
        ? `${head}\nstatus: clean`
        : `${head}\nstatus:\n${boundedList(changed, GIT_STATUS_ENTRY_LIMIT, "files")}`;
  }
  return Object.freeze({
    date: new Date().toISOString().slice(0, 10),
    cwd,
    git,
    tree: captureTree(cwd),
  });
}

export async function runOfficialSession(
  input: OfficialSessionInput,
): Promise<CompletedSessionResult> {
  const environmentFacts =
    input.environmentFacts ?? (await captureSessionEnvironment(input.workspaceRoot));
  return runKernel({ ...input, environmentFacts }, (snapshot, lifecycle, preview, signal) =>
    runDeepSeekOfficialWithRetry(snapshot, input.credential, {
      lifecycle,
      signal,
      ...(preview === undefined ? {} : { onSemanticDelta: preview }),
    }),
  );
}

/**
 * Continue an existing Session with one more user turn. The Lineage, Cache ABI
 * and every durable byte before this turn stay exactly as they were.
 */
export async function continueOfficialSession(
  input: OfficialSessionInput,
): Promise<CompletedSessionResult> {
  const environmentFacts =
    input.environmentFacts ?? (await captureSessionEnvironment(input.workspaceRoot));
  return runKernel(
    { ...input, environmentFacts },
    (snapshot, lifecycle, preview, signal) =>
      runDeepSeekOfficialWithRetry(snapshot, input.credential, {
        lifecycle,
        signal,
        ...(preview === undefined ? {} : { onSemanticDelta: preview }),
      }),
    undefined,
    undefined,
    "continue",
  );
}

export function recoverOfficialSession(
  input: OfficialRecoveryInput,
): Promise<CompletedSessionResult> {
  return runKernel(
    input,
    (snapshot, lifecycle, preview, signal) =>
      runDeepSeekOfficialWithRetry(snapshot, input.loadCredential(), {
        lifecycle,
        signal,
        ...(preview === undefined ? {} : { onSemanticDelta: preview }),
      }),
    undefined,
    undefined,
    "recover",
  );
}

export function reconcileOfficialSession(
  input: OfficialReconciliationInput,
): Promise<CompletedSessionResult> {
  return runKernel(
    input,
    (snapshot, lifecycle, preview, signal) =>
      runDeepSeekOfficialWithRetry(snapshot, input.loadCredential(), {
        lifecycle,
        signal,
        ...(preview === undefined ? {} : { onSemanticDelta: preview }),
      }),
    undefined,
    undefined,
    "reconcile",
  );
}

function fixtureSender(
  input: Pick<SessionFixtureInput, "turns">,
): SendSnapshot {
  let turnIndex = 0;
  return async (snapshot, lifecycle, preview, signal) => {
    let ordinal = 1;
    for (;;) {
      await lifecycle.beforeAttempt(ordinal, snapshot);
      const turn = input.turns[turnIndex];
      turnIndex += 1;
      if (turn === undefined) throw new SessionKernelError("fixture_exhausted");
      if (signal.aborted) {
        const failure = new DeepSeekTransportError("cancelled", "ABORTED");
        const decision: DeepSeekRetryDecision = {
          retry: false,
          delayMs: null,
          retryClass: "cancelled",
          integritySelfCheck: false,
        };
        await lifecycle.afterInterrupted(
          ordinal,
          failure,
          "pre_semantic",
          decision,
        );
        throw failure;
      }
      const fragments = turn.fragments ?? [];
      if (
        fragments.length > 0 ||
        (turn.kind === "success" && turn.response.semanticDeltaCount > 0) ||
        (turn.kind === "interrupted" && turn.semanticState === "post_semantic")
      ) {
        await lifecycle.onSemanticStarted(ordinal);
      }
      for (const fragment of fragments) await preview?.(Object.freeze(fragment));
      if (turn.kind === "success") return turn.response;
      await lifecycle.afterInterrupted(
        ordinal,
        turn.failure,
        turn.semanticState,
        turn.decision,
      );
      if (turn.decision.retry) {
        ordinal += 1;
        continue;
      }
      throw turn.failure;
    }
  };
}

export function runSessionFixture(
  input: SessionFixtureInput,
): Promise<CompletedSessionResult> {
  return runKernel(
    input,
    fixtureSender(input),
    input.onBeforeSend,
    input.persistenceControls,
    "new",
  );
}

export function continueSessionFixture(
  input: SessionFixtureInput,
): Promise<CompletedSessionResult> {
  return runKernel(
    input,
    fixtureSender(input),
    input.onBeforeSend,
    input.persistenceControls,
    "continue",
  );
}

export function recoverSessionFixture(
  input: RecoverySessionFixtureInput,
): Promise<CompletedSessionResult> {
  return runKernel(
    input,
    fixtureSender(input),
    input.onBeforeSend,
    input.persistenceControls,
    "recover",
  );
}

export function reconcileSessionFixture(
  input: ReconciliationSessionFixtureInput,
): Promise<CompletedSessionResult> {
  return runKernel(
    input,
    fixtureSender(input),
    input.onBeforeSend,
    input.persistenceControls,
    "reconcile",
  );
}
