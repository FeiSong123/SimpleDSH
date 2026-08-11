import { advanceBlobPrefix, INLINE_BLOB_LIMIT } from "../blob/prefix.js";
import {
  bytesEqual,
  fromBase64,
  sha256Hex,
  utf8Bytes,
} from "../bytes/ops.js";
import {
  parseToolResultContentForProfile,
  TOOL_RESULT_PROJECTION_LIMIT_BYTES,
} from "../bytes/tool-result.js";
import type {
  ArtifactToolResultContent,
  CompactArtifactToolResultContent,
  StaticToolResultContent,
  ToolResultProfile,
} from "../bytes/tool-result.js";
import { FrozenBytes, freezeBytes } from "../bytes/types.js";
import {
  toolSchemaProfileForBytes,
  type ToolSchemaProfile,
} from "../bytes/schemas.js";
import { viewAssistant, viewTool, viewUser } from "../bytes/view.js";
import {
  validateToolTerminalForSource,
  type ToolTerminalSource,
} from "../artifact/tool-terminal-source.js";
import { isCommitClosureV1 } from "../journal/closure.js";
import { encodeJournalPreimage } from "../journal/schema.js";
import type {
  AnyVerifiedJournalEvent,
  ArtifactId,
  BlobPayload,
  BlobRef,
  CacheAbiId,
  CacheCheckpointId,
  CommitBoundaryId,
  EffectId,
  EventId,
  JournalPayloadByType,
  LineageId,
  RequestSnapshotId,
  RunId,
  Sha256,
  ToolCallId,
  ToolTerminal,
} from "../journal/types.js";
import {
  loadCacheAbi,
  toolResultProfileForCacheAbi,
  type FrozenCacheAbiManifest,
} from "./cache-abi.js";
import { validateToolArgumentsForProfile } from "../bytes/tool-arguments.js";
import type {
  StaticToolValidationCode,
  ToolName,
  ValidatedToolArguments,
} from "../bytes/tool-arguments.js";

export interface SelectLineagePrefixV1Input {
  readonly cacheAbi: FrozenCacheAbiManifest;
  readonly journalFacts: readonly AnyVerifiedJournalEvent[];
  readonly externalBlobs: ReadonlyMap<BlobRef, FrozenBytes>;
  readonly lineageId: LineageId;
  readonly commitBoundaryId: CommitBoundaryId;
}

export interface SelectedLineagePrefixV1 {
  readonly lineageId: LineageId;
  readonly cacheAbiId: CacheAbiId;
  readonly commitBoundaryId: CommitBoundaryId;
  readonly boundaryEventId: EventId;
  readonly blobCount: number;
  readonly chainHash: Sha256;
  readonly roleBlobs: readonly FrozenBytes[];
}

interface LineageState {
  readonly cacheAbiId: CacheAbiId;
  activated: boolean;
}

interface RunState {
  readonly lineageId: LineageId;
  readonly cause: "user" | "continue" | "recovery";
  readonly previousRunId: RunId | null;
  status: "active" | "completed" | "interrupted";
  phase: "normal" | "must_interrupt" | "finalizing";
  retrySnapshotId: RequestSnapshotId | undefined;
  finalAssistantEventId: EventId | undefined;
  finalCheckpointId: CacheCheckpointId | undefined;
  finalBoundaryId: CommitBoundaryId | undefined;
  pendingAssistantCheckpointEventId: EventId | undefined;
  pendingBoundarySourceEventIds: readonly EventId[] | undefined;
}

interface SnapshotState {
  readonly lineageId: LineageId;
  readonly runId: RunId;
  readonly payload: JournalPayloadByType["request_snapshot_stored"];
}

interface AttemptState {
  readonly lineageId: LineageId;
  readonly runId: RunId;
  readonly requestSnapshotId: RequestSnapshotId;
  semanticStarted: boolean;
  terminal: boolean;
}

interface ToolCallState {
  readonly id: ToolCallId;
  readonly assistantEventId: EventId;
  readonly lineageId: LineageId;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly groupSize: number;
  readonly name: string;
  readonly argumentsHash: Sha256;
  readonly toolsProfile: ToolSchemaProfile;
  readonly resultProfile: ToolResultProfile;
  readonly validatedArguments: ValidatedToolArguments | undefined;
  readonly validationCode: StaticToolValidationCode | undefined;
  resultEventId: EventId | undefined;
}

interface PendingToolGroup {
  readonly assistantEventId: EventId;
  readonly callIds: readonly ToolCallId[];
  nextResultOrdinal: number;
}

type EffectStatus =
  | "prepared"
  | "completed"
  | "indeterminate"
  | "reconciled_completed"
  | "reconciled_not_executed";

interface EffectState {
  readonly id: EffectId;
  readonly toolCallId: ToolCallId;
  readonly toolName: Exclude<ToolName, "read">;
  readonly runId: RunId;
  status: EffectStatus;
  outputArtifactId: ArtifactId | undefined;
  terminalEventId: EventId | undefined;
}

interface ArtifactState {
  readonly eventId: EventId;
  readonly lineageId: LineageId | undefined;
  readonly runId: RunId | undefined;
  readonly payload: JournalPayloadByType["artifact_published"];
}

interface BoundaryState {
  readonly eventId: EventId;
  readonly lineageId: LineageId;
  readonly runId: RunId;
  readonly blobCount: number;
  readonly chainHash: Sha256;
  readonly payload: JournalPayloadByType["commit_boundary_created"];
}

interface CheckpointState {
  readonly eventId: EventId;
  readonly lineageId: LineageId;
  readonly runId: RunId;
  readonly sourceAssistantEventId: EventId;
}

function fail(message: string): never {
  throw new TypeError(`invalid v1 Lineage prefix: ${message}`);
}

function copyFrozen(bytes: FrozenBytes): FrozenBytes {
  return freezeBytes(bytes.copy());
}

function requireRunScope(event: AnyVerifiedJournalEvent): {
  readonly lineageId: LineageId;
  readonly runId: RunId;
} {
  if (event.lineageId === undefined || event.runId === undefined) {
    fail("event is missing its Run scope");
  }
  return { lineageId: event.lineageId, runId: event.runId };
}

function rolePayload(
  event: AnyVerifiedJournalEvent,
): BlobPayload<"user" | "assistant" | "tool"> | undefined {
  if (
    event.type === "user_committed" ||
    event.type === "assistant_committed" ||
    event.type === "tool_result_committed"
  ) {
    return event.payload;
  }
  return undefined;
}

function validateVerifiedPrefix(
  journalFacts: readonly AnyVerifiedJournalEvent[],
  lineageId: LineageId,
  commitBoundaryId: CommitBoundaryId,
): void {
  if (journalFacts.length === 0) fail("Journal prefix is empty");
  const ids = new Set<EventId>();
  let previousHash: Sha256 | null = null;
  let sessionId: string | undefined;

  for (const [index, event] of journalFacts.entries()) {
    if (event.seq !== index + 1 || event.prevHash !== previousHash) {
      fail("Journal sequence or previous hash is not contiguous from genesis");
    }
    if (ids.has(event.id)) fail("Journal event id is duplicated");
    ids.add(event.id);
    if (index === 0) {
      if (event.type !== "session_started" || event.prevHash !== null) {
        fail("Journal prefix does not begin at Session genesis");
      }
      sessionId = event.sessionId;
    } else if (event.sessionId !== sessionId) {
      fail("Journal prefix crosses Session identity");
    }

    let preimageHash: string;
    try {
      preimageHash = `sha256:${sha256Hex(encodeJournalPreimage(event))}`;
    } catch {
      fail("Journal event is not canonical v1");
    }
    if (preimageHash !== event.hash) fail("Journal event hash is invalid");
    previousHash = event.hash;
  }

  const finalEvent = journalFacts.at(-1);
  if (
    finalEvent?.type !== "commit_boundary_created" ||
    finalEvent.lineageId !== lineageId ||
    finalEvent.payload.commitBoundaryId !== commitBoundaryId
  ) {
    fail("selected Commit Boundary creator is not the final Journal event");
  }
}

function validateCacheAbi(
  cacheAbi: FrozenCacheAbiManifest,
): FrozenCacheAbiManifest {
  let loaded: FrozenCacheAbiManifest;
  try {
    loaded = loadCacheAbi(cacheAbi.manifestBytes, cacheAbi.cacheAbiId);
  } catch {
    return fail("Cache ABI manifest is invalid");
  }
  if (
    cacheAbi.protocolVersion !== loaded.protocolVersion ||
    cacheAbi.projectorVersion !== loaded.projectorVersion ||
    cacheAbi.headerHash !== loaded.headerHash ||
    !bytesEqual(cacheAbi.modelTupleBytes, loaded.modelTupleBytes) ||
    !bytesEqual(cacheAbi.systemBlob, loaded.systemBlob) ||
    !bytesEqual(cacheAbi.toolsBlob, loaded.toolsBlob)
  ) {
    fail("Cache ABI object does not match its loaded manifest");
  }
  return loaded;
}

function validateExternalMap(
  journalFacts: readonly AnyVerifiedJournalEvent[],
  externalBlobs: ReadonlyMap<BlobRef, FrozenBytes>,
  lineageId: LineageId,
): ReadonlyMap<BlobRef, FrozenBytes> {
  const expected = new Set<BlobRef>();
  for (const event of journalFacts) {
    if (event.lineageId !== lineageId) continue;
    const payload = rolePayload(event);
    if (payload?.enc === "ref") expected.add(payload.blobRef);
  }

  const supplied = new Map<BlobRef, FrozenBytes>();
  try {
    for (const [ref, bytes] of externalBlobs) {
      if (supplied.has(ref) || !(bytes instanceof FrozenBytes)) {
        fail("external Blob map is not an exact immutable byte map");
      }
      supplied.set(ref, copyFrozen(bytes));
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("invalid v1")) {
      throw error;
    }
    fail("external Blob map cannot be enumerated");
  }

  if (supplied.size !== expected.size) {
    fail("external Blob map has missing or extra keys");
  }
  for (const ref of expected) {
    if (!supplied.has(ref)) fail("external Blob map is missing a selected ref");
  }
  return supplied;
}

function resolveRoleBytes(
  payload: BlobPayload<"user" | "assistant" | "tool">,
  externalBlobs: ReadonlyMap<BlobRef, FrozenBytes>,
): FrozenBytes {
  let bytes: FrozenBytes;
  if (payload.enc === "b64") {
    if (payload.byteCount > INLINE_BLOB_LIMIT) fail("large Blob is inline");
    try {
      bytes = fromBase64(payload.bytes);
    } catch {
      return fail("inline Blob is not canonical base64");
    }
  } else {
    if (payload.byteCount <= INLINE_BLOB_LIMIT) fail("small Blob is external");
    const expectedRef = `blobs/sha256/${payload.byteHash.slice("sha256:".length)}`;
    if (payload.blobRef !== expectedRef) fail("external Blob ref/hash mismatch");
    const supplied = externalBlobs.get(payload.blobRef);
    if (!(supplied instanceof FrozenBytes)) fail("external Blob bytes are missing");
    bytes = copyFrozen(supplied);
  }
  if (
    bytes.byteLength !== payload.byteCount ||
    `sha256:${sha256Hex(bytes)}` !== payload.byteHash
  ) {
    fail("Blob byte count or hash is invalid");
  }
  return bytes;
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

function requiredToolName(call: ToolCallState | undefined): ToolName {
  const name = call?.validatedArguments?.name;
  if (name === undefined) fail("tool call has no validated tool name");
  return name;
}

function requireSourceTerminal(
  toolName: ToolName,
  source: ToolTerminalSource,
  terminal: ToolTerminal,
  hardLimitReached: boolean | null,
): void {
  if (typeof hardLimitReached !== "boolean") {
    fail("tool output hard-limit marker is absent");
  }
  try {
    validateToolTerminalForSource(
      toolName,
      source,
      terminal,
      hardLimitReached,
    );
  } catch {
    fail("tool terminal is invalid for its durable source phase");
  }
}

function artifactResultMatches(
  result: ArtifactToolResultContent | CompactArtifactToolResultContent,
  artifact: ArtifactState,
  terminal: ToolTerminal | null,
  toolsProfile: ToolSchemaProfile,
  resultProfile: ToolResultProfile,
): boolean {
  const streams = artifact.payload.streamBytes;
  if (terminal === null || streams === null) return false;
  const framing = artifact.payload.byteCount - streams.read - streams.stdout - streams.stderr;
  const editMatch =
    terminal.code === "edit_no_match" || terminal.code === "edit_not_unique";
  const matchShape = editMatch
    ? toolsProfile === "edit-v5"
      ? result.matchCount !== undefined &&
        (terminal.code === "edit_no_match"
          ? result.matchCount === 0
          : result.matchCount >= 2) &&
        streams.read === 0 &&
        streams.stderr === 0 &&
        streams.stdout === String(result.matchCount).length &&
        framing === 6 &&
        artifact.payload.hardLimitReached === false
      : result.matchCount === undefined &&
        artifact.payload.byteCount === 0 &&
        streams.read === 0 &&
        streams.stdout === 0 &&
        streams.stderr === 0 &&
        framing === 0
    : result.matchCount === undefined;
  const commonMatches =
    matchShape &&
    result.status === terminal.status &&
    result.code === terminal.code &&
    result.exitCode === terminal.exitCode &&
    result.signal === terminal.signal &&
    result.hardLimitReached === artifact.payload.hardLimitReached;
  if (!commonMatches) return false;
  if (resultProfile === "compact-v2") {
    return (
      !("artifactId" in result) &&
      result.artifactRef ===
        (result.truncated ? artifact.payload.artifactRef : undefined)
    );
  }
  return (
    "artifactId" in result &&
    result.artifactId === artifact.payload.artifactId &&
    result.artifactRef === artifact.payload.artifactRef &&
    result.artifactSha256 === artifact.payload.artifactHash &&
    result.byteCount === artifact.payload.byteCount &&
    result.payloadBytes.read === streams.read &&
    result.payloadBytes.stdout === streams.stdout &&
    result.payloadBytes.stderr === streams.stderr &&
    result.framingByteCount === framing
  );
}

function staticResultMatches(
  result: StaticToolResultContent,
  expected: StaticToolResultContent,
): boolean {
  return result.status === expected.status && result.code === expected.code;
}

export function selectLineagePrefixV1(
  input: SelectLineagePrefixV1Input,
): SelectedLineagePrefixV1 {
  validateVerifiedPrefix(
    input.journalFacts,
    input.lineageId,
    input.commitBoundaryId,
  );
  const cacheAbi = validateCacheAbi(input.cacheAbi);
  const toolsProfile = toolSchemaProfileForBytes(cacheAbi.toolsBlob);
  const resultProfile = toolResultProfileForCacheAbi(cacheAbi);
  const externalBlobs = validateExternalMap(
    input.journalFacts,
    input.externalBlobs,
    input.lineageId,
  );

  const events = new Map<EventId, AnyVerifiedJournalEvent>();
  const artifacts = new Map<ArtifactId, ArtifactState>();
  const declaredCacheAbis = new Map<CacheAbiId, EventId>();
  const lineages = new Map<LineageId, LineageState>();
  const runs = new Map<RunId, RunState>();
  const latestRunByLineage = new Map<LineageId, RunId>();
  const snapshots = new Map<RequestSnapshotId, SnapshotState>();
  const snapshotOrdinals = new Map<RequestSnapshotId, number>();
  const attempts = new Map<string, AttemptState>();
  const calls = new Map<ToolCallId, ToolCallState>();
  const permissions = new Map<ToolCallId, "allow" | "deny">();
  const effects = new Map<EffectId, EffectState>();
  const activeEffectByCall = new Map<ToolCallId, EffectId>();
  const checkpoints = new Map<CacheCheckpointId, CheckpointState>();
  const checkpointSources = new Set<EventId>();
  const boundaries = new Map<CommitBoundaryId, BoundaryState>();
  const boundaryPrefixKeys = new Set<string>();
  const roleBlobs: FrozenBytes[] = [];

  let activeLineageId: LineageId | undefined;
  let activeRunId: RunId | undefined;
  let pendingBreak:
    | { readonly from: LineageId; readonly to: LineageId }
    | undefined;
  let targetDeclarationCount = 0;
  let targetStartCount = 0;
  let targetActivationCount = 0;
  let pendingToolGroup: PendingToolGroup | undefined;
  let chainHash: Sha256 | null = null;
  let selectedBoundary: BoundaryState | undefined;

  const closureState = (): {
    readonly openModelResponses: number;
    readonly pendingToolCalls: number;
    readonly unsettledEffects: number;
  } => ({
    openModelResponses: [...attempts.values()].filter(
      (attempt) => attempt.lineageId === input.lineageId && !attempt.terminal,
    ).length,
    pendingToolCalls:
      pendingToolGroup === undefined
        ? 0
        : pendingToolGroup.callIds.length - pendingToolGroup.nextResultOrdinal,
    unsettledEffects: [...effects.values()].filter(
      (effect) =>
        effect.status === "prepared" || effect.status === "indeterminate",
    ).length,
  });

  const requireTargetRun = (event: AnyVerifiedJournalEvent): RunState => {
    const scope = requireRunScope(event);
    if (scope.lineageId !== input.lineageId) fail("target event has wrong Lineage");
    const run = runs.get(scope.runId);
    if (
      run === undefined ||
      run.lineageId !== input.lineageId ||
      run.status !== "active" ||
      activeRunId !== scope.runId
    ) {
      fail("target event refers to an unknown Run");
    }
    return run;
  };

  const hasRunAncestor = (
    descendant: RunState,
    ancestorRunId: RunId,
  ): boolean => {
    let previousRunId = descendant.previousRunId;
    while (previousRunId !== null) {
      if (previousRunId === ancestorRunId) return true;
      const previous = runs.get(previousRunId);
      if (previous === undefined || previous.lineageId !== descendant.lineageId) {
        fail("recovery Run ancestor chain is invalid");
      }
      previousRunId = previous.previousRunId;
    }
    return false;
  };

  const hasOpenAttempt = (runId: RunId): boolean =>
    [...attempts.values()].some(
      (attempt) => attempt.runId === runId && !attempt.terminal,
    );

  const sameIds = (
    left: readonly EventId[],
    right: readonly EventId[],
  ): boolean =>
    left.length === right.length &&
    left.every((value, index) => value === right[index]);

  const boundaryPrefixKey = (
    lineageId: LineageId,
    blobCount: number,
    hash: Sha256,
  ): string => `${lineageId}\u0000${blobCount}\u0000${hash}`;

  const gateTargetRunPhase = (event: AnyVerifiedJournalEvent): void => {
    if (activeRunId === undefined || event.type === "journal_tail_recovered") {
      return;
    }
    const run = runs.get(activeRunId);
    if (run === undefined) fail("active Run is missing");
    if (run.lineageId !== input.lineageId) return;
    if (run.pendingAssistantCheckpointEventId !== undefined) {
      if (
        event.type !== "cache_checkpoint_created" ||
        event.runId !== activeRunId
      ) {
        fail("assistant response is not checkpointed immediately");
      }
      return;
    }
    if (run.pendingBoundarySourceEventIds !== undefined) {
      if (
        event.type !== "commit_boundary_created" ||
        event.runId !== activeRunId
      ) {
        fail("safe role tail is not immediately bounded or interrupted");
      }
      return;
    }
    if (run.phase === "must_interrupt") {
      if (event.type !== "run_interrupted" || event.runId !== activeRunId) {
        fail("post-semantic Run does not interrupt next");
      }
      return;
    }
    if (run.retrySnapshotId !== undefined) {
      if (
        (event.type !== "request_attempt_started" &&
          event.type !== "run_interrupted") ||
        event.runId !== activeRunId
      ) {
        fail("pre-semantic retry does not reuse its Snapshot next");
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
    if (event.type !== expected || event.runId !== activeRunId) {
      fail("final assistant closure is not contiguous");
    }
  };

  const appendRole = (
    event: AnyVerifiedJournalEvent,
    payload: BlobPayload<"user" | "assistant" | "tool">,
  ): FrozenBytes => {
    requireTargetRun(event);
    if (activeLineageId !== input.lineageId) fail("role Blob is not on active Lineage");
    if (payload.blobIndex !== roleBlobs.length) fail("Blob index is not contiguous");
    const bytes = resolveRoleBytes(payload, externalBlobs);
    const expectedChainHash = advanceBlobPrefix(bytes, {
      blobIndex: roleBlobs.length,
      previousChainHash: chainHash,
    });
    if (payload.chainHash !== expectedChainHash) fail("Blob chain hash is invalid");
    chainHash = expectedChainHash;
    roleBlobs.push(copyFrozen(bytes));
    return bytes;
  };

  for (const event of input.journalFacts) {
    gateTargetRunPhase(event);
    switch (event.type) {
      case "session_started":
        break;
      case "artifact_published": {
        if (event.lineageId === input.lineageId) {
          const run = requireTargetRun(event);
          if (event.payload.artifactType === "tool_output") {
            const callId = event.payload.toolCallId;
            const call = callId === null ? undefined : calls.get(callId);
            if (
              callId === null ||
              call === undefined ||
              call.resultEventId !== undefined ||
              call.validatedArguments === undefined ||
              permissions.get(callId) !== "allow"
            ) {
              fail("tool output Artifact does not bind an allowed pending call");
            }
            const activeId = activeEffectByCall.get(callId);
            const effect = activeId === undefined ? undefined : effects.get(activeId);
            if (event.payload.terminal === null) {
              if (
                effect === undefined ||
                (effect.status !== "prepared" && effect.status !== "indeterminate") ||
                (effect.status === "prepared" && effect.runId !== event.runId) ||
                (effect.status === "indeterminate" && run.cause !== "recovery")
              ) {
                fail("terminal-less tool output is not attached to an Effect");
              }
              if (
                (call.validatedArguments.name === "bash" &&
                  typeof event.payload.descendantsReaped !== "boolean") ||
                (call.validatedArguments.name !== "bash" &&
                  event.payload.descendantsReaped !== null)
              ) {
                fail("tool output cleanup observation is invalid");
              }
            } else if (
              effect !== undefined &&
              effect.status !== "reconciled_not_executed"
            ) {
              fail("pre-effect tool output conflicts with an active Effect");
            } else if (
              event.payload.descendantsReaped !== null ||
              event.payload.terminal.descendantsReaped !== null
            ) {
              fail("pre-effect tool output carries cleanup state");
            }
            if (event.payload.terminal !== null) {
              const toolName = call.validatedArguments.name;
              requireSourceTerminal(
                toolName,
                "artifact",
                event.payload.terminal,
                event.payload.hardLimitReached,
              );
              const activeEditMatch =
                call.toolsProfile === "edit-v5" &&
                toolName === "edit" &&
                (event.payload.terminal.code === "edit_no_match" ||
                  event.payload.terminal.code === "edit_not_unique");
              const streams = event.payload.streamBytes;
              if (activeEditMatch) {
                if (
                  streams === null ||
                  streams.read !== 0 ||
                  streams.stderr !== 0 ||
                  streams.stdout < 1 ||
                  streams.stdout > 16 ||
                  event.payload.byteCount !== streams.stdout + 6 ||
                  event.payload.hardLimitReached !== false
                ) {
                  fail("active edit match observation metadata is invalid");
                }
              } else if (
                ((toolName !== "read") ||
                  event.payload.terminal.code === "invalid_arguments") &&
                event.payload.byteCount !== 0
              ) {
                fail("pre-effect observation Artifact is not empty");
              }
            }
          }
        }
        if (artifacts.has(event.payload.artifactId)) fail("Artifact id is duplicated");
        artifacts.set(event.payload.artifactId, {
          eventId: event.id,
          lineageId: event.lineageId,
          runId: event.runId,
          payload: event.payload,
        });
        break;
      }
      case "cache_abi_declared": {
        if (declaredCacheAbis.has(event.payload.cacheAbiId)) {
          fail("Cache ABI is declared more than once");
        }
        const artifact = artifacts.get(event.payload.manifestArtifactId);
        if (
          artifact === undefined ||
          artifact.lineageId !== undefined ||
          artifact.runId !== undefined ||
          artifact.payload.artifactType !== "cache_abi_manifest" ||
          String(artifact.payload.artifactHash) !==
            String(event.payload.cacheAbiId) ||
          artifact.payload.byteCount !== event.payload.manifestByteCount
        ) {
          fail("Cache ABI declaration does not bind its manifest Artifact");
        }
        declaredCacheAbis.set(event.payload.cacheAbiId, event.id);
        if (event.payload.cacheAbiId === cacheAbi.cacheAbiId) {
          targetDeclarationCount += 1;
          if (event.payload.manifestByteCount !== cacheAbi.manifestBytes.byteLength) {
            fail("Cache ABI manifest count differs from the loaded bytes");
          }
        }
        break;
      }
      case "lineage_started": {
        if (
          event.lineageId === undefined ||
          lineages.has(event.lineageId) ||
          !declaredCacheAbis.has(event.payload.cacheAbiId)
        ) {
          fail("Lineage start does not bind one declared Cache ABI");
        }
        lineages.set(event.lineageId, {
          cacheAbiId: event.payload.cacheAbiId,
          activated: false,
        });
        if (event.lineageId === input.lineageId) {
          targetStartCount += 1;
          if (event.payload.cacheAbiId !== cacheAbi.cacheAbiId) {
            fail("selected Lineage uses a different Cache ABI");
          }
        }
        break;
      }
      case "cache_break": {
        if (event.payload.classification === "unplanned") {
          fail("unplanned cache break is not projectable");
        }
        const from = lineages.get(event.payload.fromLineageId);
        const to = lineages.get(event.payload.toLineageId);
        // A compaction break keeps the Cache ABI and replaces the
        // conversation; an ABI change is the other way round. Both leave the
        // active Lineage, and neither may nest.
        const sameAbi = from?.cacheAbiId === to?.cacheAbiId;
        if (
          pendingBreak !== undefined ||
          activeLineageId !== event.payload.fromLineageId ||
          from === undefined ||
          to === undefined ||
          sameAbi !== (event.payload.reason === "compaction")
        ) {
          fail("planned cache break does not bind a Lineage transition");
        }
        pendingBreak = {
          from: event.payload.fromLineageId,
          to: event.payload.toLineageId,
        };
        break;
      }
      case "lineage_activated": {
        if (activeRunId !== undefined) {
          fail("Lineage changes while a Run is active");
        }
        const lineage = lineages.get(event.payload.nextLineageId);
        if (lineage === undefined || lineage.activated) {
          fail("Lineage activation is missing or duplicated");
        }
        if (event.payload.reason === "initial") {
          if (
            activeLineageId !== undefined ||
            event.payload.previousLineageId !== null ||
            pendingBreak !== undefined
          ) {
            fail("initial Lineage activation is not initial");
          }
        } else if (
          activeLineageId === undefined ||
          event.payload.previousLineageId !== activeLineageId ||
          pendingBreak?.from !== activeLineageId ||
          pendingBreak.to !== event.payload.nextLineageId
        ) {
          fail("ABI-change Lineage activation lacks its exact cache break");
        } else {
          pendingBreak = undefined;
        }
        lineage.activated = true;
        activeLineageId = event.payload.nextLineageId;
        if (activeLineageId === input.lineageId) targetActivationCount += 1;
        break;
      }
      case "run_started": {
        const scope = requireRunScope(event);
        if (
          activeRunId !== undefined ||
          event.runId === undefined ||
          runs.has(event.runId) ||
          !lineages.has(scope.lineageId) ||
          activeLineageId !== scope.lineageId
        ) {
          fail("Run start does not bind the active Lineage");
        }
        const latestRunId = latestRunByLineage.get(scope.lineageId);
        if (event.payload.cause === "user") {
          if (
            event.payload.previousRunId !== null ||
            latestRunId !== undefined
          ) {
            fail("user Run is not the first Run on its Lineage");
          }
        } else {
          if (
            event.payload.previousRunId === null ||
            latestRunId !== event.payload.previousRunId
          ) {
            fail("continue or recovery Run does not name the latest predecessor");
          }
          const previous = runs.get(event.payload.previousRunId);
          // Closure, not the predecessor's label, decides whether a new user
          // turn may follow: an interrupted Run that stopped at a safe boundary
          // is continuable.
          const statusAllowed =
            event.payload.cause === "continue"
              ? previous?.status === "completed" || previous?.status === "interrupted"
              : previous?.status === "interrupted";
          if (previous?.lineageId !== scope.lineageId || !statusAllowed) {
            fail(`${event.payload.cause} Run predecessor is invalid`);
          }
        }
        runs.set(event.runId, {
          lineageId: scope.lineageId,
          cause: event.payload.cause,
          previousRunId: event.payload.previousRunId,
          status: "active",
          phase: "normal",
          retrySnapshotId: undefined,
          finalAssistantEventId: undefined,
          finalCheckpointId: undefined,
          finalBoundaryId: undefined,
          pendingAssistantCheckpointEventId: undefined,
          pendingBoundarySourceEventIds: undefined,
        });
        activeRunId = event.runId;
        latestRunByLineage.set(scope.lineageId, event.runId);
        break;
      }
      case "fact_recorded": {
        if (event.lineageId !== input.lineageId) break;
        const scope = requireRunScope(event);
        requireTargetRun(event);
        const artifact = artifacts.get(event.payload.artifactId);
        const expectedArtifactType =
          event.payload.kind === "project_instructions"
            ? "project_instructions"
            : "fact";
        if (
          artifact === undefined ||
          artifact.lineageId !== scope.lineageId ||
          artifact.runId !== scope.runId ||
          artifact.payload.artifactType !== expectedArtifactType ||
          artifact.payload.byteCount !== event.payload.byteCount
        ) {
          fail("fact does not bind its exact same-Run Artifact");
        }
        break;
      }
      case "request_snapshot_stored": {
        if (event.lineageId !== input.lineageId) break;
        const targetRun = requireTargetRun(event);
        if (!isCommitClosureV1(closureState())) {
          fail("Request Snapshot follows an unsafe protocol/effect state");
        }
        const boundary = boundaries.get(event.payload.commitBoundaryId);
        const scope = requireRunScope(event);
        if (
          boundary === undefined ||
          boundary.lineageId !== scope.lineageId ||
          event.parentId !== boundary.eventId ||
          event.payload.cacheAbiId !== cacheAbi.cacheAbiId ||
          event.payload.projectorVersion !== cacheAbi.projectorVersion ||
          event.payload.headEventId !== boundary.eventId ||
          event.payload.segmentHashes[0] !== cacheAbi.headerHash ||
          event.payload.segmentHashes[1] !== boundary.chainHash ||
          snapshots.has(event.payload.requestSnapshotId)
        ) {
          fail("Request Snapshot identity does not bind ABI and boundary");
        }
        if (
          boundary.blobCount !== roleBlobs.length ||
          boundary.chainHash !== chainHash
        ) {
          fail("Request Snapshot Boundary is not the current durable prefix");
        }
        if (event.payload.recoveryFromSnapshotId === null) {
          const sameRunImmediate =
            boundary.runId === scope.runId &&
            [...events.values()].at(-1)?.id === boundary.eventId;
          const recoveryProjection =
            boundary.runId !== scope.runId &&
            targetRun.cause === "recovery" &&
            hasRunAncestor(targetRun, boundary.runId);
          const boundaryAlreadyProjected = [...snapshots.values()].some(
            (snapshot) =>
              snapshot.payload.commitBoundaryId ===
              event.payload.commitBoundaryId,
          );
          if (
            (!sameRunImmediate && !recoveryProjection) ||
            boundaryAlreadyProjected
          ) {
            fail("ordinary Request Snapshot does not bind one unprojected safe Boundary");
          }
        } else {
          const source = snapshots.get(event.payload.recoveryFromSnapshotId);
          if (
            source === undefined ||
            source.lineageId !== scope.lineageId ||
            source.runId === scope.runId ||
            targetRun.cause !== "recovery" ||
            !hasRunAncestor(targetRun, source.runId) ||
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
            fail("recovery Request Snapshot is not an exact cross-Run alias");
          }
        }
        snapshots.set(event.payload.requestSnapshotId, {
          ...scope,
          payload: event.payload,
        });
        break;
      }
      case "request_attempt_started": {
        if (event.lineageId !== input.lineageId) break;
        const run = requireTargetRun(event);
        if (!isCommitClosureV1(closureState())) {
          fail("Provider attempt starts before protocol/effects close");
        }
        const snapshot = snapshots.get(event.payload.requestSnapshotId);
        const scope = requireRunScope(event);
        const expectedOrdinal =
          (snapshotOrdinals.get(event.payload.requestSnapshotId) ?? 0) + 1;
        if (
          snapshot === undefined ||
          snapshot.lineageId !== scope.lineageId ||
          snapshot.runId !== scope.runId ||
          attempts.has(event.payload.attemptId) ||
          hasOpenAttempt(scope.runId) ||
          event.payload.ordinal !== expectedOrdinal ||
          ((expectedOrdinal === 1) !== (run.retrySnapshotId === undefined)) ||
          (run.retrySnapshotId !== undefined &&
            run.retrySnapshotId !== event.payload.requestSnapshotId)
        ) {
          fail("Provider attempt does not bind its Snapshot and Run");
        }
        snapshotOrdinals.set(event.payload.requestSnapshotId, expectedOrdinal);
        run.retrySnapshotId = undefined;
        attempts.set(event.payload.attemptId, {
          ...scope,
          requestSnapshotId: event.payload.requestSnapshotId,
          semanticStarted: false,
          terminal: false,
        });
        break;
      }
      case "request_semantic_started": {
        if (event.lineageId !== input.lineageId) break;
        const attempt = attempts.get(event.payload.attemptId);
        const scope = requireRunScope(event);
        if (
          attempt === undefined ||
          attempt.terminal ||
          attempt.semanticStarted ||
          attempt.lineageId !== scope.lineageId ||
          attempt.runId !== scope.runId
        ) {
          fail("semantic start does not bind one open attempt");
        }
        attempt.semanticStarted = true;
        break;
      }
      case "request_interrupted": {
        if (event.lineageId !== input.lineageId) break;
        const attempt = attempts.get(event.payload.attemptId);
        const scope = requireRunScope(event);
        const semanticStarted = attempt?.semanticStarted ?? false;
        if (
          attempt === undefined ||
          attempt.terminal ||
          attempt.requestSnapshotId !== event.payload.requestSnapshotId ||
          attempt.lineageId !== scope.lineageId ||
          attempt.runId !== scope.runId ||
          (event.payload.semanticState === "pre_semantic" && semanticStarted) ||
          (event.payload.semanticState === "post_semantic" && !semanticStarted)
        ) {
          fail("request interruption does not close one open attempt");
        }
        attempt.terminal = true;
        const run = requireTargetRun(event);
        if (event.payload.semanticState === "pre_semantic") {
          run.retrySnapshotId = event.payload.requestSnapshotId;
        } else {
          run.phase = "must_interrupt";
        }
        break;
      }
      case "user_committed": {
        if (event.lineageId !== input.lineageId) break;
        if (!isCommitClosureV1(closureState())) {
          fail("user Blob is appended before prior protocol/effects close");
        }
        const scope = requireRunScope(event);
        const expectedOrder = ["user_input", "date", "cwd", "git"] as const;
        const positions: number[] = [];
        for (const sourceId of event.payload.sourceFactEventIds) {
          const source = events.get(sourceId);
          if (
            source?.type !== "fact_recorded" ||
            source.lineageId !== scope.lineageId ||
            source.runId !== scope.runId
          ) {
            fail("user source fact is absent or crosses Run/Lineage");
          }
          positions.push(
            expectedOrder.indexOf(
              source.payload.kind as (typeof expectedOrder)[number],
            ),
          );
        }
        if (
          positions.length === 0 ||
          positions[0] !== 0 ||
          positions.some(
            (position, index) =>
              position < 0 ||
              (index > 0 && position <= (positions[index - 1] ?? -1)),
          )
        ) {
          fail("user source facts are not in exact v1 order");
        }
        const bytes = appendRole(event, event.payload);
        try {
          viewUser(bytes);
        } catch {
          fail("user Blob is not canonical");
        }
        const run = requireTargetRun(event);
        if (run.pendingBoundarySourceEventIds !== undefined) {
          fail("user Blob overlaps an unbounded safe tail");
        }
        run.pendingBoundarySourceEventIds = Object.freeze([event.id]);
        break;
      }
      case "assistant_committed": {
        if (event.lineageId !== input.lineageId) break;
        const attempt = attempts.get(event.payload.attemptId);
        const scope = requireRunScope(event);
        if (
          attempt === undefined ||
          attempt.terminal ||
          attempt.lineageId !== scope.lineageId ||
          attempt.runId !== scope.runId ||
          attempt.requestSnapshotId !== event.payload.requestSnapshotId ||
          (event.payload.semanticDeltaCount > 0) !== attempt.semanticStarted ||
          pendingToolGroup !== undefined
        ) {
          fail("assistant Blob does not close one matching open attempt");
        }
        const bytes = appendRole(event, event.payload);
        let assistant: ReturnType<typeof viewAssistant>;
        try {
          assistant = viewAssistant(bytes);
        } catch {
          return fail("assistant Blob is not canonical");
        }
        attempt.terminal = true;
        const callIds: ToolCallId[] = [];
        for (const [ordinal, call] of assistant.toolCalls.entries()) {
          const id = call.id as ToolCallId;
          if (calls.has(id)) fail("assistant tool declaration is duplicated");
          const validation = validateToolArgumentsForProfile(
            call.function.name,
            call.function.arguments,
            toolsProfile,
          );
          calls.set(id, {
            id,
            assistantEventId: event.id,
            lineageId: scope.lineageId,
            runId: scope.runId,
            ordinal,
            groupSize: assistant.toolCalls.length,
            name: call.function.name,
            argumentsHash: `sha256:${sha256Hex(
              utf8Bytes(call.function.arguments),
            )}` as Sha256,
            toolsProfile,
            resultProfile,
            validatedArguments: validation.ok ? validation.arguments : undefined,
            validationCode: validation.ok ? undefined : validation.code,
            resultEventId: undefined,
          });
          callIds.push(id);
        }
        if (callIds.length > 0) {
          const run = requireTargetRun(event);
          if (
            run.phase !== "normal" ||
            run.pendingAssistantCheckpointEventId !== undefined
          ) {
            fail("tool-calling assistant overlaps pending Run closure");
          }
          pendingToolGroup = {
            assistantEventId: event.id,
            callIds: Object.freeze(callIds),
            nextResultOrdinal: 0,
          };
          run.pendingAssistantCheckpointEventId = event.id;
        } else {
          const run = requireTargetRun(event);
          run.phase = "finalizing";
          run.finalAssistantEventId = event.id;
        }
        break;
      }
      case "permission_decided": {
        if (event.lineageId !== input.lineageId) break;
        requireTargetRun(event);
        const call = calls.get(event.payload.toolCallId);
        if (
          call === undefined ||
          call.resultEventId !== undefined ||
          call.validatedArguments === undefined ||
          permissions.has(event.payload.toolCallId) ||
          !isCanonicalPermission(event.payload)
        ) {
          fail("permission decision does not bind one pending tool call");
        }
        permissions.set(event.payload.toolCallId, event.payload.finalDecision);
        break;
      }
      case "effect_prepared": {
        if (event.lineageId !== input.lineageId) break;
        const scope = requireRunScope(event);
        requireTargetRun(event);
        const call = calls.get(event.payload.toolCallId);
        const previousId = activeEffectByCall.get(event.payload.toolCallId);
        const previous = previousId === undefined ? undefined : effects.get(previousId);
        if (
          call === undefined ||
          call.resultEventId !== undefined ||
          call.validatedArguments === undefined ||
          call.validatedArguments.name === "read" ||
          call.validatedArguments.name !== event.payload.toolName ||
          call.argumentsHash !== event.payload.argumentsHash ||
          permissions.get(event.payload.toolCallId) !== "allow" ||
          effects.has(event.payload.effectId) ||
          (previous !== undefined &&
            !(
              previous.status === "reconciled_not_executed" &&
              previous.runId !== scope.runId
            ))
        ) {
          fail("prepared Effect does not bind one allowed mutating call");
        }
        effects.set(event.payload.effectId, {
          id: event.payload.effectId,
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName,
          runId: scope.runId,
          status: "prepared",
          outputArtifactId: undefined,
          terminalEventId: undefined,
        });
        activeEffectByCall.set(event.payload.toolCallId, event.payload.effectId);
        break;
      }
      case "effect_completed": {
        if (event.lineageId !== input.lineageId) break;
        requireTargetRun(event);
        const effect = effects.get(event.payload.effectId);
        const artifact = artifacts.get(event.payload.artifactId);
        const scope = requireRunScope(event);
        if (
          effect === undefined ||
          effect.status !== "prepared" ||
          effect.toolCallId !== event.payload.toolCallId ||
          effect.runId !== scope.runId ||
          artifact?.payload.artifactType !== "tool_output" ||
          artifact.payload.toolCallId !== event.payload.toolCallId ||
          artifact.payload.terminal !== null ||
          artifact.lineageId !== scope.lineageId ||
          artifact.runId !== scope.runId ||
          effect.toolName !== requiredToolName(calls.get(effect.toolCallId))
        ) {
          fail("Effect completion does not close one prepared Effect");
        }
        if (
          (effect.toolName === "bash" &&
            (typeof artifact.payload.descendantsReaped !== "boolean" ||
              event.payload.terminal.descendantsReaped !==
                artifact.payload.descendantsReaped)) ||
          (effect.toolName !== "bash" &&
            (artifact.payload.descendantsReaped !== null ||
              event.payload.terminal.descendantsReaped !== null))
        ) {
          fail("Effect completion cleanup observation is inconsistent");
        }
        requireSourceTerminal(
          effect.toolName,
          "effect",
          event.payload.terminal,
          artifact.payload.hardLimitReached,
        );
        if (effect.toolName !== "bash" && artifact.payload.byteCount !== 0) {
          fail("file Effect output Artifact is not empty");
        }
        effect.status = "completed";
        effect.outputArtifactId = event.payload.artifactId;
        effect.terminalEventId = event.id;
        break;
      }
      case "effect_indeterminate": {
        if (event.lineageId !== input.lineageId) break;
        requireTargetRun(event);
        const effect = effects.get(event.payload.effectId);
        if (effect === undefined || effect.status !== "prepared") {
          fail("indeterminate Effect is not prepared");
        }
        effect.status = "indeterminate";
        effect.terminalEventId = event.id;
        break;
      }
      case "effect_reconciled": {
        if (event.lineageId !== input.lineageId) break;
        const run = requireTargetRun(event);
        const effect = effects.get(event.payload.effectId);
        const evidence = artifacts.get(event.payload.evidenceArtifactId);
        const scope = requireRunScope(event);
        if (
          run.cause !== "recovery" ||
          effect === undefined ||
          effect.status !== "indeterminate" ||
          evidence?.payload.artifactType !== "operator_evidence" ||
          evidence.lineageId !== scope.lineageId ||
          evidence.runId !== scope.runId
        ) {
          fail("Effect reconciliation lacks recovery evidence");
        }
        if (event.payload.resolution === "completed") {
          const output = artifacts.get(event.payload.outputArtifactId);
          if (
            output?.payload.artifactType !== "tool_output" ||
            output.payload.toolCallId !== effect.toolCallId ||
            output.payload.terminal !== null ||
            output.lineageId !== scope.lineageId ||
            output.runId !== scope.runId ||
            effect.toolName !== requiredToolName(calls.get(effect.toolCallId))
          ) {
            fail("reconciled Effect output is not durable");
          }
          if (
            (effect.toolName === "bash" &&
              (typeof output.payload.descendantsReaped !== "boolean" ||
                event.payload.terminal.descendantsReaped !==
                  output.payload.descendantsReaped)) ||
            (effect.toolName !== "bash" &&
              (output.payload.descendantsReaped !== null ||
                event.payload.terminal.descendantsReaped !== null))
          ) {
            fail("reconciled Effect cleanup observation is inconsistent");
          }
          requireSourceTerminal(
            effect.toolName,
            "effect",
            event.payload.terminal,
            output.payload.hardLimitReached,
          );
          if (effect.toolName !== "bash" && output.payload.byteCount !== 0) {
            fail("reconciled file Effect output Artifact is not empty");
          }
          effect.status = "reconciled_completed";
          effect.outputArtifactId = event.payload.outputArtifactId;
          effect.terminalEventId = event.id;
        } else {
          effect.status = "reconciled_not_executed";
          effect.outputArtifactId = undefined;
          effect.terminalEventId = event.id;
        }
        break;
      }
      case "tool_result_committed": {
        if (event.lineageId !== input.lineageId) break;
        requireTargetRun(event);
        const group = pendingToolGroup;
        const call = calls.get(event.payload.toolCallId);
        const activeEffectId = activeEffectByCall.get(event.payload.toolCallId);
        if (
          group === undefined ||
          call === undefined ||
          call.resultEventId !== undefined ||
          call.assistantEventId !== group.assistantEventId ||
          group.callIds[group.nextResultOrdinal] !== event.payload.toolCallId ||
          call.ordinal !== group.nextResultOrdinal
        ) {
          fail("tool result is orphaned, duplicated, or out of order");
        }
        let resultArtifact: ArtifactState | undefined;
        let resultTerminal: ToolTerminal | undefined;
        let expectedStatic: StaticToolResultContent | undefined;
        if (event.payload.effectId !== null) {
          const effect = effects.get(event.payload.effectId);
          const source = events.get(event.payload.sourceEventId);
          const sourceMatchesTerminal =
            (effect?.status === "completed" &&
              source?.type === "effect_completed" &&
              source.payload.effectId === event.payload.effectId) ||
            (effect?.status === "reconciled_completed" &&
              source?.type === "effect_reconciled" &&
              source.payload.effectId === event.payload.effectId);
          if (
            effect === undefined ||
            effect.toolCallId !== event.payload.toolCallId ||
            activeEffectId !== event.payload.effectId ||
            (effect.status !== "completed" &&
              effect.status !== "reconciled_completed") ||
            event.payload.artifactId === null ||
            effect.outputArtifactId !== event.payload.artifactId ||
            effect.terminalEventId !== event.payload.sourceEventId ||
            !sourceMatchesTerminal
          ) {
            fail("tool result does not bind its terminal Effect output");
          }
          resultArtifact = artifacts.get(event.payload.artifactId);
          if (
            resultArtifact?.payload.toolCallId !== event.payload.toolCallId ||
            resultArtifact.payload.terminal !== null
          ) {
            fail("Effect result Artifact identity is invalid");
          }
          if (source?.type === "effect_completed") {
            resultTerminal = source.payload.terminal;
          } else if (
            source?.type === "effect_reconciled" &&
            source.payload.resolution === "completed"
          ) {
            resultTerminal = source.payload.terminal;
          } else {
            fail("Effect result terminal source is invalid");
          }
        } else if (event.payload.artifactId !== null) {
          const activeEffect =
            activeEffectId === undefined ? undefined : effects.get(activeEffectId);
          if (
            activeEffect !== undefined &&
            activeEffect.status !== "reconciled_not_executed"
          ) {
            fail("tool result bypasses its active Effect");
          }
          const artifact = artifacts.get(event.payload.artifactId);
          const source = events.get(event.payload.sourceEventId);
          const scope = requireRunScope(event);
          const targetRun = runs.get(scope.runId);
          if (
            artifact === undefined ||
            artifact.payload.artifactType !== "tool_output" ||
            artifact.payload.toolCallId !== event.payload.toolCallId ||
            artifact.payload.terminal === null ||
            artifact.lineageId !== scope.lineageId ||
            artifact.runId === undefined ||
            targetRun === undefined ||
            (artifact.runId !== scope.runId &&
              (targetRun.cause !== "recovery" ||
                !hasRunAncestor(targetRun, artifact.runId))) ||
            source?.type !== "artifact_published" ||
            source.id !== artifact.eventId
          ) {
            fail("pre-effect result does not bind its durable tool output");
          }
          resultArtifact = artifact;
          resultTerminal = artifact.payload.terminal;
        } else {
          const activeEffect =
            activeEffectId === undefined ? undefined : effects.get(activeEffectId);
          if (
            activeEffect !== undefined &&
            activeEffect.status !== "reconciled_not_executed"
          ) {
            fail("tool result bypasses its active Effect");
          }
          const source = events.get(event.payload.sourceEventId);
          if (
            source?.type === "permission_decided" &&
            source.payload.toolCallId === event.payload.toolCallId &&
            source.payload.finalDecision === "deny" &&
            call.validationCode === undefined
          ) {
            expectedStatic = Object.freeze({
              kind: "static",
              status: "denied",
              code: "permission_denied",
            });
          } else if (
            source?.type === "assistant_committed" &&
            source.id === call.assistantEventId &&
            call.validationCode !== undefined
          ) {
            expectedStatic = Object.freeze({
              kind: "static",
              status: "invalid",
              code: call.validationCode,
            });
          } else {
            fail("tool result without Artifact lacks a safe rejection source");
          }
        }
        const bytes = appendRole(event, event.payload);
        let toolCallId: string;
        try {
          if (bytes.byteLength > TOOL_RESULT_PROJECTION_LIMIT_BYTES) {
            fail("tool result exceeds the provider projection limit");
          }
          const tool = viewTool(bytes);
          toolCallId = tool.toolCallId;
          const content = parseToolResultContentForProfile(
            tool.content,
            call.resultProfile,
          );
          if (expectedStatic !== undefined) {
            if (
              content.kind !== "static" ||
              !staticResultMatches(content, expectedStatic)
            ) {
              fail("static tool result does not match its rejection source");
            }
          } else if (
            content.kind !== "artifact" ||
            resultArtifact === undefined ||
            resultTerminal === undefined ||
            !artifactResultMatches(
              content,
              resultArtifact,
              resultTerminal,
              call.toolsProfile,
              call.resultProfile,
            )
          ) {
            fail("Artifact tool result does not match its durable source");
          }
        } catch {
          return fail("tool Blob is not canonical");
        }
        if (toolCallId !== event.payload.toolCallId) {
          fail("tool Blob id differs from its Journal payload");
        }
        call.resultEventId = event.id;
        group.nextResultOrdinal += 1;
        if (group.nextResultOrdinal === group.callIds.length) {
          const sourceEventIds = group.callIds.map((callId) => {
            const completedCall = calls.get(callId);
            if (completedCall?.resultEventId === undefined) {
              return fail("completed tool group lacks one result event");
            }
            return completedCall.resultEventId;
          });
          const run = requireTargetRun(event);
          if (run.pendingBoundarySourceEventIds !== undefined) {
            fail("tool batch overlaps an unbounded safe tail");
          }
          run.pendingBoundarySourceEventIds = Object.freeze(sourceEventIds);
          pendingToolGroup = undefined;
        }
        break;
      }
      case "cache_checkpoint_created": {
        if (event.lineageId !== input.lineageId) break;
        const run = requireTargetRun(event);
        const scope = requireRunScope(event);
        const source = events.get(event.payload.sourceAssistantEventId);
        if (
          event.payload.blobCount !== roleBlobs.length ||
          event.payload.chainHash !== chainHash ||
          source?.type !== "assistant_committed" ||
          source.lineageId !== scope.lineageId ||
          source.runId !== scope.runId ||
          source.payload.requestSnapshotId !== event.payload.requestSnapshotId ||
          source.payload.providerRequestId !== event.payload.providerRequestId ||
          source.payload.usage.promptTokens !== event.payload.promptTokens ||
          checkpoints.has(event.payload.cacheCheckpointId) ||
          checkpointSources.has(event.payload.sourceAssistantEventId)
        ) {
          fail("Cache Checkpoint does not match selected prefix bytes");
        }
        checkpoints.set(event.payload.cacheCheckpointId, {
          eventId: event.id,
          lineageId: scope.lineageId,
          runId: scope.runId,
          sourceAssistantEventId: event.payload.sourceAssistantEventId,
        });
        checkpointSources.add(event.payload.sourceAssistantEventId);
        if (run.pendingAssistantCheckpointEventId !== undefined) {
          if (
            run.pendingAssistantCheckpointEventId !==
            event.payload.sourceAssistantEventId
          ) {
            fail("Cache Checkpoint does not close the pending assistant");
          }
          run.pendingAssistantCheckpointEventId = undefined;
        }
        if (run.phase === "finalizing") {
          if (
            run.finalAssistantEventId !== event.payload.sourceAssistantEventId ||
            run.finalCheckpointId !== undefined
          ) {
            fail("final checkpoint does not bind the final assistant");
          }
          run.finalCheckpointId = event.payload.cacheCheckpointId;
        }
        break;
      }
      case "commit_boundary_created": {
        if (event.lineageId !== input.lineageId) break;
        const scope = requireRunScope(event);
        const run = requireTargetRun(event);
        const checkpoint =
          event.payload.cacheCheckpointId === null
            ? undefined
            : checkpoints.get(event.payload.cacheCheckpointId);
        if (
          chainHash === null ||
          event.payload.blobCount !== roleBlobs.length ||
          event.payload.chainHash !== chainHash ||
          !isCommitClosureV1(closureState())
        ) {
          fail("Commit Boundary is not derived from a closed prefix");
        }
        if (
          event.payload.cacheCheckpointId !== null &&
          checkpoint === undefined
        ) {
          fail("Commit Boundary refers to an unknown Cache Checkpoint");
        }
        const sources = event.payload.sourceEventIds.map((sourceId) => {
          const source = events.get(sourceId);
          if (source === undefined || source.lineageId !== input.lineageId) {
            fail("Commit Boundary source does not belong to its Lineage");
          }
          return source;
        });
        const sourceType = sources[0]?.type;
        if (sourceType === "user_committed") {
          const source = sources[0];
          if (
            sources.length !== 1 ||
            source?.runId !== scope.runId ||
            event.payload.cacheCheckpointId !== null ||
            source?.type !== "user_committed" ||
            source.payload.blobIndex + 1 !== event.payload.blobCount ||
            source.payload.chainHash !== event.payload.chainHash
          ) {
            fail("user Boundary source is not exact");
          }
        } else if (sourceType === "assistant_committed") {
          if (
            sources[0]!.runId !== scope.runId ||
            sources.length !== 1 ||
            run.phase !== "finalizing" ||
            run.finalAssistantEventId !== sources[0]!.id ||
            run.finalCheckpointId === undefined ||
            event.payload.cacheCheckpointId !== run.finalCheckpointId ||
            checkpoint?.runId !== scope.runId ||
            checkpoint.sourceAssistantEventId !== run.finalAssistantEventId
          ) {
            fail("final Boundary does not bind assistant and checkpoint");
          }
        } else if (sourceType === "tool_result_committed") {
          if (event.payload.cacheCheckpointId !== null) {
            fail("tool Boundary carries a Cache Checkpoint");
          }
          let assistantEventId: EventId | undefined;
          for (const [ordinal, source] of sources.entries()) {
            if (source.type !== "tool_result_committed") {
              fail("tool Boundary mixes source kinds");
            }
            const call = calls.get(source.payload.toolCallId);
            if (
              call === undefined ||
              call.lineageId !== input.lineageId ||
              call.resultEventId !== source.id ||
              call.ordinal !== ordinal ||
              call.groupSize !== sources.length ||
              (assistantEventId !== undefined &&
                call.assistantEventId !== assistantEventId)
            ) {
              fail("tool Boundary is not one complete declared-order batch");
            }
            assistantEventId = call.assistantEventId;
          }
          const last = sources.at(-1);
          if (
            last?.type !== "tool_result_committed" ||
            last.payload.blobIndex + 1 !== event.payload.blobCount ||
            last.payload.chainHash !== event.payload.chainHash
          ) {
            fail("tool Boundary prefix does not end at its last result");
          }
        } else {
          fail("Commit Boundary source kind is invalid");
        }
        if (sourceType !== "assistant_committed") {
          if (
            run.pendingBoundarySourceEventIds === undefined ||
            !sameIds(
              run.pendingBoundarySourceEventIds,
              event.payload.sourceEventIds,
            )
          ) {
            fail("safe role tail does not match its exact Boundary sources");
          }
        }
        const prefixKey = boundaryPrefixKey(
          scope.lineageId,
          event.payload.blobCount,
          event.payload.chainHash,
        );
        if (
          boundaries.has(event.payload.commitBoundaryId) ||
          boundaryPrefixKeys.has(prefixKey)
        ) {
          fail("Commit Boundary id is duplicated");
        }
        const boundary: BoundaryState = {
          eventId: event.id,
          lineageId: scope.lineageId,
          runId: scope.runId,
          blobCount: event.payload.blobCount,
          chainHash,
          payload: event.payload,
        };
        boundaries.set(event.payload.commitBoundaryId, boundary);
        boundaryPrefixKeys.add(prefixKey);
        if (sourceType === "assistant_committed") {
          run.finalBoundaryId = event.payload.commitBoundaryId;
        } else {
          run.pendingBoundarySourceEventIds = undefined;
        }
        if (event.payload.commitBoundaryId === input.commitBoundaryId) {
          selectedBoundary = boundary;
        }
        break;
      }
      case "run_completed": {
        const scope = requireRunScope(event);
        const run = runs.get(scope.runId);
        const source = events.get(event.payload.sourceAssistantEventId);
        if (
          run === undefined ||
          run.status !== "active" ||
          activeRunId !== scope.runId ||
          source?.type !== "assistant_committed" ||
          source.lineageId !== scope.lineageId ||
          source.runId !== scope.runId
        ) {
          fail("Run completion does not close its active Run");
        }
        if (scope.lineageId === input.lineageId) {
          const boundary = boundaries.get(event.payload.commitBoundaryId);
          if (
            boundary?.lineageId !== scope.lineageId ||
            boundary.runId !== scope.runId ||
            hasOpenAttempt(scope.runId) ||
            run.phase !== "finalizing" ||
            run.finalAssistantEventId !== source.id ||
            run.finalCheckpointId === undefined ||
            run.finalBoundaryId !== event.payload.commitBoundaryId ||
            boundary.payload.cacheCheckpointId !== run.finalCheckpointId ||
            boundary.payload.sourceEventIds.length !== 1 ||
            boundary.payload.sourceEventIds[0] !== source.id ||
            !isCommitClosureV1(closureState())
          ) {
            fail("target Run completion lacks exact final closure");
          }
        }
        run.status = "completed";
        activeRunId = undefined;
        break;
      }
      case "run_interrupted": {
        const scope = requireRunScope(event);
        const run = runs.get(scope.runId);
        const source = events.get(event.payload.sourceEventId);
        if (
          run === undefined ||
          run.status !== "active" ||
          activeRunId !== scope.runId ||
          run.phase === "finalizing" ||
          source === undefined ||
          source.lineageId !== scope.lineageId ||
          source.runId !== scope.runId ||
          (scope.lineageId === input.lineageId && hasOpenAttempt(scope.runId))
        ) {
          fail("Run interruption does not close its active same-Run source");
        }
        run.status = "interrupted";
        activeRunId = undefined;
        break;
      }
      default:
        break;
    }
    events.set(event.id, event);
  }

  if (
    targetDeclarationCount !== 1 ||
    targetStartCount !== 1 ||
    targetActivationCount !== 1 ||
    activeLineageId !== input.lineageId ||
    pendingBreak !== undefined
  ) {
    fail("selected ABI/Lineage declaration and activation are not unique and active");
  }
  if (
    selectedBoundary === undefined ||
    selectedBoundary.eventId !== input.journalFacts.at(-1)?.id ||
    selectedBoundary.blobCount !== roleBlobs.length ||
    selectedBoundary.chainHash !== chainHash
  ) {
    fail("selected Commit Boundary does not match the exact prefix head");
  }

  return Object.freeze({
    lineageId: input.lineageId,
    cacheAbiId: cacheAbi.cacheAbiId,
    commitBoundaryId: input.commitBoundaryId,
    boundaryEventId: selectedBoundary.eventId,
    blobCount: selectedBoundary.blobCount,
    chainHash: selectedBoundary.chainHash,
    roleBlobs: Object.freeze(roleBlobs.map(copyFrozen)),
  });
}
