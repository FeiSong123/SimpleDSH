import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeToolOutputHardLimit,
  encodeToolOutputData,
  RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES,
  TOOL_OUTPUT_MEDIA_TYPE,
  type ToolOutputStream,
} from "../../src/artifact/tool-output.js";
import type {
  EffectTerminal,
  ToolTerminal,
} from "../../src/artifact/terminal.js";
import { advanceBlobPrefix, INLINE_BLOB_LIMIT } from "../../src/blob/store.js";
import { materializeAssistant } from "../../src/bytes/assistant.js";
import {
  bytesEqual,
  concatBytes,
  sha256Hex,
  toBase64,
  utf8Bytes,
} from "../../src/bytes/ops.js";
import { materializeToolResultMessage } from "../../src/bytes/tool-result.js";
import { freezeBytes, type FrozenBytes } from "../../src/bytes/types.js";
import { materializeUserMessage } from "../../src/bytes/user.js";
import { viewAssistant } from "../../src/bytes/view.js";
import { createVerifiedJournalEvent } from "../../src/journal/schema.js";
import type {
  AnyJournalEventDraft,
  AnyVerifiedJournalEvent,
  ArtifactId,
  ArtifactRef,
  AttemptId,
  BlobPayload,
  BlobRef,
  CacheCheckpointId,
  CanonicalTimestamp,
  CommitBoundaryId,
  EffectId,
  EventId,
  JournalEventDraft,
  JournalEventType,
  JournalPayloadByType,
  LineageId,
  RequestSnapshotId,
  RunId,
  SessionId,
  Sha256,
  SnapshotRef,
  ToolCallId,
  VerifiedJournalEvent,
} from "../../src/journal/types.js";
import {
  buildCacheAbiV1,
  buildCacheAbiV2,
  toolResultProfileForCacheAbi,
  type FrozenCacheAbiManifest,
} from "../../src/lineage/cache-abi.js";
import {
  selectLineagePrefixV1,
  type SelectedLineagePrefixV1,
} from "../../src/lineage/prefix.js";
import { projectArtifactToolResult } from "../../src/artifact/tool-result.js";

function wire<Value>(value: string): Value {
  return value as Value;
}

function opaque<Value>(prefix: string, digit: string): Value {
  return wire<Value>(`${prefix}_${digit.repeat(32)}`);
}

const SID = opaque<SessionId>("ses", "1");
const LID = opaque<LineageId>("lin", "2");
const RID = opaque<RunId>("run", "3");
const RECOVERY_RID = opaque<RunId>("run", "4");
const SECOND_RECOVERY_RID = opaque<RunId>("run", "6");
const MANIFEST_ARTIFACT = opaque<ArtifactId>("art", "4");
const FACT_ARTIFACT = opaque<ArtifactId>("art", "5");
const TIMESTAMP = wire<CanonicalTimestamp>("2026-08-04T01:02:03.004Z");
const SUCCEEDED_TERMINAL = Object.freeze({
  status: "succeeded",
  code: "ok",
  exitCode: null,
  signal: null,
  descendantsReaped: null,
}) satisfies ToolTerminal;

function artifactResultProjection(options: {
  readonly artifact: VerifiedJournalEvent<"artifact_published">;
  readonly framedBytes: FrozenBytes;
  readonly toolCallId: ToolCallId;
  readonly toolName: "bash" | "edit" | "read" | "write";
  readonly terminalSource: "artifact" | "effect";
  readonly terminal: ToolTerminal;
  readonly readOffset?: number;
  readonly resultProfile?: "verbose-v1" | "compact-v2";
}): ReturnType<typeof projectArtifactToolResult> {
  const streamBytes = options.artifact.payload.streamBytes;
  if (streamBytes === null) {
    throw new TypeError("tool result fixture requires stream metadata");
  }
  return projectArtifactToolResult({
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    toolsProfile: "edit-v5",
    resultProfile: options.resultProfile ?? "verbose-v1",
    terminalSource: options.terminalSource,
    ...(options.readOffset === undefined
      ? {}
      : { readOffset: options.readOffset }),
    artifact: {
      artifactId: options.artifact.payload.artifactId,
      artifactRef: options.artifact.payload.artifactRef,
      artifactSha256: options.artifact.payload.artifactHash,
      byteCount: options.artifact.payload.byteCount,
      payloadBytes: streamBytes,
      hardLimitReached: options.artifact.payload.hardLimitReached ?? false,
    },
    terminal: options.terminal,
    framedBytes: options.framedBytes,
  });
}

function hash(bytes: FrozenBytes): Sha256 {
  return wire<Sha256>(`sha256:${sha256Hex(bytes)}`);
}

function artifactRef(value: Sha256): ArtifactRef {
  return wire<ArtifactRef>(`artifacts/sha256/${value.slice("sha256:".length)}`);
}

function snapshotRef(value: Sha256): SnapshotRef {
  return wire<SnapshotRef>(`snapshots/sha256/${value.slice("sha256:".length)}`);
}

function blobRef(value: Sha256): BlobRef {
  return wire<BlobRef>(`blobs/sha256/${value.slice("sha256:".length)}`);
}

class JournalBuilder {
  readonly events: AnyVerifiedJournalEvent[] = [];
  #previousHash: Sha256 | null = null;

  append<Type extends JournalEventType>(
    draft: JournalEventDraft<Type>,
  ): VerifiedJournalEvent<Type> {
    const seq = this.events.length + 1;
    const event = createVerifiedJournalEvent(draft as AnyJournalEventDraft, {
      seq,
      id: wire<EventId>(`evt_${seq.toString(16).padStart(32, "0")}`),
      at: TIMESTAMP,
      prevHash: this.#previousHash,
    }) as VerifiedJournalEvent<Type>;
    this.events.push(event as AnyVerifiedJournalEvent);
    this.#previousHash = event.hash;
    return event;
  }
}

function inlinePayload<Role extends "user" | "assistant" | "tool">(
  role: Role,
  bytes: FrozenBytes,
  blobIndex: number,
  previousChainHash: Sha256 | null,
): BlobPayload<Role> {
  return {
    role,
    enc: "b64",
    bytes: toBase64(bytes),
    byteCount: bytes.byteLength,
    byteHash: hash(bytes),
    blobIndex,
    chainHash: advanceBlobPrefix(bytes, { blobIndex, previousChainHash }),
  };
}

function externalPayload<Role extends "user" | "assistant" | "tool">(
  role: Role,
  bytes: FrozenBytes,
  blobIndex: number,
  previousChainHash: Sha256 | null,
): BlobPayload<Role> {
  const byteHash = hash(bytes);
  return {
    role,
    enc: "ref",
    blobRef: blobRef(byteHash),
    byteCount: bytes.byteLength,
    byteHash,
    blobIndex,
    chainHash: advanceBlobPrefix(bytes, { blobIndex, previousChainHash }),
  };
}

interface UserBoundaryFixture {
  readonly builder: JournalBuilder;
  readonly cacheAbi: FrozenCacheAbiManifest;
  readonly userBytes: FrozenBytes;
  readonly userEvent: VerifiedJournalEvent<"user_committed">;
  readonly boundaryEvent: VerifiedJournalEvent<"commit_boundary_created">;
  readonly boundaryId: CommitBoundaryId;
  readonly chainHash: Sha256;
  readonly externalBlobs: Map<BlobRef, FrozenBytes>;
}

function publishArtifact(
  builder: JournalBuilder,
  options: {
    readonly artifactId: ArtifactId;
    readonly bytes: FrozenBytes;
    readonly artifactType:
      | "cache_abi_manifest"
      | "fact"
      | "tool_output"
      | "operator_evidence";
    readonly runScoped: boolean;
    readonly runId?: RunId;
    readonly toolCallId?: ToolCallId;
    readonly terminal?: ToolTerminal | null;
    readonly toolStream?: ToolOutputStream | null;
    readonly hardLimitReached?: boolean;
    readonly descendantsReaped?: boolean | null;
  },
): VerifiedJournalEvent<"artifact_published"> {
  const isToolOutput = options.artifactType === "tool_output";
  if (isToolOutput) {
    if (options.toolCallId === undefined || options.terminal === undefined) {
      throw new TypeError("tool output fixture needs toolCallId and terminal");
    }
    if (
      options.bytes.byteLength > 0 &&
      (options.toolStream === undefined || options.toolStream === null)
    ) {
      throw new TypeError("nonempty tool output fixture needs a stream");
    }
  }
  const stream = options.toolStream ?? null;
  const hardLimitReached = options.hardLimitReached ?? false;
  if (
    isToolOutput &&
    hardLimitReached &&
    options.bytes.byteLength !== RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES
  ) {
    throw new TypeError("hard-limit fixture needs exactly the raw byte limit");
  }
  const dataFrame =
    isToolOutput && options.bytes.byteLength > 0
      ? encodeToolOutputData(stream ?? "read", options.bytes)
      : options.bytes;
  const artifactBytes =
    isToolOutput && hardLimitReached
      ? concatBytes([dataFrame, encodeToolOutputHardLimit(stream ?? "read")])
      : dataFrame;
  const byteHash = hash(artifactBytes);
  return builder.append({
    type: "artifact_published",
    sessionId: SID,
    ...(options.runScoped
      ? { lineageId: LID, runId: options.runId ?? RID }
      : {}),
    payload: {
      artifactId: options.artifactId,
      artifactRef: artifactRef(byteHash),
      artifactHash: byteHash,
      byteCount: artifactBytes.byteLength,
      lineCount: null,
      mediaType: isToolOutput
        ? TOOL_OUTPUT_MEDIA_TYPE
        : "application/octet-stream",
      artifactType: options.artifactType,
      streamBytes: isToolOutput
        ? {
            read: stream === "read" ? options.bytes.byteLength : 0,
            stdout: stream === "stdout" ? options.bytes.byteLength : 0,
            stderr: stream === "stderr" ? options.bytes.byteLength : 0,
          }
        : null,
      hardLimitReached: isToolOutput ? hardLimitReached : null,
      descendantsReaped: isToolOutput
        ? (options.descendantsReaped ?? null)
        : null,
      toolCallId: isToolOutput ? (options.toolCallId ?? null) : null,
      terminal: isToolOutput ? (options.terminal ?? null) : null,
    },
  });
}

function appendBoundary(
  builder: JournalBuilder,
  options: {
    readonly idDigit: string;
    readonly blobCount: number;
    readonly chainHash: Sha256;
    readonly sourceEventIds: readonly EventId[];
    readonly runId?: RunId;
    readonly cacheCheckpointId?: CacheCheckpointId;
  },
): VerifiedJournalEvent<"commit_boundary_created"> {
  return builder.append({
    type: "commit_boundary_created",
    sessionId: SID,
    lineageId: LID,
    runId: options.runId ?? RID,
    payload: {
      commitBoundaryId: opaque<CommitBoundaryId>("cbd", options.idDigit),
      cacheCheckpointId: options.cacheCheckpointId ?? null,
      blobCount: options.blobCount,
      chainHash: options.chainHash,
      protocolClosed: true,
      effectsSettled: true,
      sourceEventIds: options.sourceEventIds,
    },
  });
}

function appendCheckpoint(
  fixture: UserBoundaryFixture,
  request: { readonly snapshotId: RequestSnapshotId },
  assistant: VerifiedJournalEvent<"assistant_committed">,
  idDigit: string,
): VerifiedJournalEvent<"cache_checkpoint_created"> {
  const cacheCheckpointId = opaque<CacheCheckpointId>("ccp", idDigit);
  return fixture.builder.append({
    type: "cache_checkpoint_created",
    sessionId: SID,
    lineageId: LID,
    runId: assistant.runId ?? RID,
    parentId: assistant.id,
    payload: {
      cacheCheckpointId,
      requestSnapshotId: request.snapshotId,
      blobCount: assistant.payload.blobIndex + 1,
      chainHash: assistant.payload.chainHash,
      promptTokens: assistant.payload.usage.promptTokens,
      providerRequestId: assistant.payload.providerRequestId,
      sourceAssistantEventId: assistant.id,
    },
  });
}

function userBoundary(options?: {
  readonly external?: boolean;
  readonly userBytes?: FrozenBytes;
  readonly sourceViolation?: "reversed" | "cross_run";
  readonly cacheAbi?: FrozenCacheAbiManifest;
}): UserBoundaryFixture {
  const builder = new JournalBuilder();
  const cacheAbi = options?.cacheAbi ?? buildCacheAbiV1();
  builder.append({ type: "session_started", sessionId: SID, payload: {} });
  const manifest = publishArtifact(builder, {
    artifactId: MANIFEST_ARTIFACT,
    bytes: cacheAbi.manifestBytes,
    artifactType: "cache_abi_manifest",
    runScoped: false,
  });
  builder.append({
    type: "cache_abi_declared",
    sessionId: SID,
    parentId: manifest.id,
    payload: {
      cacheAbiId: cacheAbi.cacheAbiId,
      manifestArtifactId: MANIFEST_ARTIFACT,
      manifestByteCount: cacheAbi.manifestBytes.byteLength,
    },
  });
  builder.append({
    type: "lineage_started",
    sessionId: SID,
    lineageId: LID,
    payload: { cacheAbiId: cacheAbi.cacheAbiId },
  });
  builder.append({
    type: "lineage_activated",
    sessionId: SID,
    lineageId: LID,
    payload: {
      previousLineageId: null,
      nextLineageId: LID,
      reason: "initial",
    },
  });
  builder.append({
    type: "run_started",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: { cause: "user", previousRunId: null },
  });
  const inputBytes = utf8Bytes("hello");
  const inputArtifact = publishArtifact(builder, {
    artifactId: FACT_ARTIFACT,
    bytes: inputBytes,
    artifactType: "fact",
    runScoped: true,
  });
  const fact = builder.append({
    type: "fact_recorded",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    parentId: inputArtifact.id,
    payload: {
      kind: "user_input",
      artifactId: FACT_ARTIFACT,
      byteCount: inputBytes.byteLength,
    },
  });
  const sourceFactEventIds: EventId[] = [fact.id];
  let userRunId = RID;
  if (options?.sourceViolation !== undefined) {
    const sourceRunId =
      options.sourceViolation === "cross_run" ? RECOVERY_RID : RID;
    if (sourceRunId === RECOVERY_RID) {
      const terminal = builder.append({
        type: "run_interrupted",
        sessionId: SID,
        lineageId: LID,
        runId: RID,
        payload: {
          reason: "durability_failure",
          sourceEventId: fact.id,
        },
      });
      builder.append({
        type: "run_started",
        sessionId: SID,
        lineageId: LID,
        runId: RECOVERY_RID,
        parentId: terminal.id,
        payload: { cause: "recovery", previousRunId: RID },
      });
      userRunId = RECOVERY_RID;
    }
    const dateBytes = utf8Bytes("2026-08-04");
    const dateArtifactId = opaque<ArtifactId>("art", "7");
    const dateArtifact = publishArtifact(builder, {
      artifactId: dateArtifactId,
      bytes: dateBytes,
      artifactType: "fact",
      runScoped: true,
      runId: sourceRunId,
    });
    const dateFact = builder.append({
      type: "fact_recorded",
      sessionId: SID,
      lineageId: LID,
      runId: sourceRunId,
      parentId: dateArtifact.id,
      payload: {
        kind: "date",
        artifactId: dateArtifactId,
        byteCount: dateBytes.byteLength,
      },
    });
    if (options.sourceViolation === "reversed") {
      sourceFactEventIds.unshift(dateFact.id);
    } else {
      sourceFactEventIds.push(dateFact.id);
    }
  }
  const userBytes = options?.userBytes ?? materializeUserMessage("hello");
  const payload = options?.external
    ? externalPayload("user", userBytes, 0, null)
    : inlinePayload("user", userBytes, 0, null);
  const userEvent = builder.append({
    type: "user_committed",
    sessionId: SID,
    lineageId: LID,
    runId: userRunId,
    parentId: fact.id,
    payload: { ...payload, sourceFactEventIds },
  });
  const boundaryEvent = appendBoundary(builder, {
    idDigit: "6",
    blobCount: 1,
    chainHash: payload.chainHash,
    sourceEventIds: [userEvent.id],
    runId: userRunId,
  });
  const externalBlobs = new Map<BlobRef, FrozenBytes>();
  if (payload.enc === "ref") externalBlobs.set(payload.blobRef, userBytes);
  return {
    builder,
    cacheAbi,
    userBytes,
    userEvent,
    boundaryEvent,
    boundaryId: boundaryEvent.payload.commitBoundaryId,
    chainHash: payload.chainHash,
    externalBlobs,
  };
}

function appendSnapshotAndAttempt(
  fixture: UserBoundaryFixture,
  attemptDigit = "8",
): {
  readonly snapshotId: RequestSnapshotId;
  readonly attemptId: AttemptId;
} {
  const body = utf8Bytes(`snapshot-${attemptDigit}`);
  const bodyHash = hash(body);
  const snapshotId = opaque<RequestSnapshotId>("rqs", "7");
  fixture.builder.append({
    type: "request_snapshot_stored",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    parentId: fixture.boundaryEvent.id,
    payload: {
      requestSnapshotId: snapshotId,
      bodyRef: snapshotRef(bodyHash),
      bodyHash,
      byteCount: body.byteLength,
      cacheAbiId: fixture.cacheAbi.cacheAbiId,
      projectorVersion: "dsh-projector-v1",
      headEventId: fixture.boundaryEvent.id,
      commitBoundaryId: fixture.boundaryId,
      segmentHashes: [fixture.cacheAbi.headerHash, fixture.chainHash],
      recoveryFromSnapshotId: null,
    },
  });
  const attemptId = opaque<AttemptId>("att", attemptDigit);
  fixture.builder.append({
    type: "request_attempt_started",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: { attemptId, requestSnapshotId: snapshotId, ordinal: 1 },
  });
  fixture.builder.append({
    type: "request_semantic_started",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: { attemptId },
  });
  return { snapshotId, attemptId };
}

function appendAssistant(
  fixture: UserBoundaryFixture,
  request: {
    readonly snapshotId: RequestSnapshotId;
    readonly attemptId: AttemptId;
  },
  bytes: FrozenBytes,
  runId: RunId = RID,
  checkpointToolAssistant = true,
): VerifiedJournalEvent<"assistant_committed"> {
  const payload = inlinePayload("assistant", bytes, 1, fixture.chainHash);
  const assistant = fixture.builder.append({
    type: "assistant_committed",
    sessionId: SID,
    lineageId: LID,
    runId,
    payload: {
      ...payload,
      attemptId: request.attemptId,
      requestSnapshotId: request.snapshotId,
      providerRequestId: "provider-1",
      responseModel: "DeepSeek-V4-Flash-0731",
      systemFingerprint: "fp-1",
      semanticDeltaCount: 1,
      usage: {
        promptTokens: 5,
        promptCacheHitTokens: 3,
        promptCacheMissTokens: 2,
        completionTokens: 2,
        reasoningTokens: 1,
        rawFinishReason: "stop",
      },
    },
  });
  if (checkpointToolAssistant && viewAssistant(bytes).toolCalls.length > 0) {
    appendCheckpoint(fixture, request, assistant, "8");
  }
  return assistant;
}

function select(
  fixture: UserBoundaryFixture,
  boundaryId = fixture.boundaryId,
  externalBlobs: ReadonlyMap<BlobRef, FrozenBytes> = fixture.externalBlobs,
): SelectedLineagePrefixV1 {
  return selectLineagePrefixV1({
    cacheAbi: fixture.cacheAbi,
    journalFacts: fixture.builder.events,
    externalBlobs,
    lineageId: LID,
    commitBoundaryId: boundaryId,
  });
}

type PrefixMatrixToolName = "bash" | "edit" | "read" | "write";
type PrefixTerminalSource = "artifact" | "effect";

interface PrefixTerminalCase {
  readonly label: string;
  readonly toolName: PrefixMatrixToolName;
  readonly source: PrefixTerminalSource;
  readonly terminal: ToolTerminal;
  readonly hardLimitReached?: boolean;
  readonly artifactDescendantsReaped?: boolean | null;
  readonly cacheAbi?: FrozenCacheAbiManifest;
  readonly resultProfileOverride?: "verbose-v1" | "compact-v2";
}

function prefixArguments(toolName: PrefixMatrixToolName): string {
  switch (toolName) {
    case "read":
      return '{"path":"input.txt"}';
    case "write":
      return '{"path":"output.txt","content":"ok"}';
    case "edit":
      return '{"path":"output.txt","old_string":"old","new_string":"new","replace_all":false}';
    case "bash":
      return '{"command":"printf ok","timeout":5}';
  }
}

function prefixTerminal(
  toolName: PrefixMatrixToolName,
  source: PrefixTerminalSource,
  code: ToolTerminal["code"],
): ToolTerminal {
  const status: ToolTerminal["status"] =
    code === "ok"
      ? "succeeded"
      : code === "invalid_arguments"
        ? "invalid"
        : code === "bash_supervisor_unavailable" ||
            code === "credential_shield_unavailable"
          ? "unavailable"
          : "failed";
  return Object.freeze({
    status,
    code,
    exitCode:
      code === "nonzero_exit"
        ? 7
        : code === "ok" && toolName === "bash" && source === "effect"
          ? 0
          : null,
    signal:
      code === "signaled" ||
      code === "timeout" ||
      code === "cancelled" ||
      code === "output_limit"
        ? "SIGTERM"
        : null,
    descendantsReaped:
      toolName === "bash" && source === "effect" ? false : null,
  });
}

function replacePrefixTerminal(
  terminal: ToolTerminal,
  changes: Partial<ToolTerminal>,
): ToolTerminal {
  return Object.freeze({ ...terminal, ...changes });
}

let prefixHardLimitPayload: FrozenBytes | undefined;

function prefixOutputBytes(hardLimitReached: boolean): FrozenBytes {
  if (!hardLimitReached) return utf8Bytes("");
  prefixHardLimitPayload ??= freezeBytes(
    new Uint8Array(RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES),
  );
  return prefixHardLimitPayload;
}

function sourcePhasePrefixFixture(
  item: PrefixTerminalCase,
  includeToolResult: boolean,
): {
  readonly fixture: UserBoundaryFixture;
  readonly finalBoundary: VerifiedJournalEvent<"commit_boundary_created">;
} {
  const fixture = userBoundary(
    item.cacheAbi === undefined ? undefined : { cacheAbi: item.cacheAbi },
  );
  const request = appendSnapshotAndAttempt(fixture);
  const callId = wire<ToolCallId>("call_terminal_matrix");
  const argumentsText = prefixArguments(item.toolName);
  const assistant = appendAssistant(
    fixture,
    request,
    materializeAssistant({
      content: "",
      reasoningContent: "terminal source matrix",
      toolCalls: [
        {
          id: callId,
          type: "function",
          function: { name: item.toolName, arguments: argumentsText },
        },
      ],
    }),
  );
  fixture.builder.append({
    type: "permission_decided",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: {
      toolCallId: callId,
      policyDecision: "allow",
      finalDecision: "allow",
      resolution: "policy",
    },
  });

  const effectId = opaque<EffectId>("eff", "a");
  if (item.source === "effect") {
    if (item.toolName === "read") {
      throw new TypeError("read has no Effect terminal source");
    }
    fixture.builder.append({
      type: "effect_prepared",
      sessionId: SID,
      lineageId: LID,
      runId: RID,
      payload: {
        effectId,
        toolCallId: callId,
        toolName: item.toolName,
        argumentsHash: hash(utf8Bytes(argumentsText)),
      },
    });
  }

  const hardLimitReached = item.hardLimitReached ?? false;
  const editMatchCount =
    item.source === "artifact" && item.toolName === "edit"
      ? item.terminal.code === "edit_no_match"
        ? "0"
        : item.terminal.code === "edit_not_unique"
          ? "2"
          : undefined
      : undefined;
  const outputBytes = editMatchCount === undefined
    ? prefixOutputBytes(hardLimitReached)
    : utf8Bytes(editMatchCount);
  const toolStream = editMatchCount !== undefined
    ? "stdout"
    : hardLimitReached
      ? item.toolName === "read"
        ? "read"
        : "stdout"
      : null;
  const outputArtifact = publishArtifact(fixture.builder, {
    artifactId: opaque<ArtifactId>("art", "a"),
    bytes: outputBytes,
    artifactType: "tool_output",
    runScoped: true,
    toolCallId: callId,
    terminal: item.source === "artifact" ? item.terminal : null,
    toolStream,
    hardLimitReached,
    descendantsReaped:
      item.artifactDescendantsReaped ??
      (item.source === "effect" && item.toolName === "bash" ? false : null),
  });
  const terminalEvent =
    item.source === "effect"
      ? fixture.builder.append({
          type: "effect_completed",
          sessionId: SID,
          lineageId: LID,
          runId: RID,
          payload: {
            effectId,
            toolCallId: callId,
            artifactId: outputArtifact.payload.artifactId,
            terminal: item.terminal as EffectTerminal,
          },
        })
      : outputArtifact;

  if (!includeToolResult) {
    const finalBoundary = appendBoundary(fixture.builder, {
      idDigit: "b",
      blobCount: 2,
      chainHash: assistant.payload.chainHash,
      sourceEventIds: [assistant.id],
    });
    return { fixture, finalBoundary };
  }

  const framedBytes = hardLimitReached
    ? concatBytes([
        encodeToolOutputData(toolStream ?? "stdout", outputBytes),
        encodeToolOutputHardLimit(toolStream ?? "stdout"),
      ])
    : editMatchCount === undefined
      ? outputBytes
      : encodeToolOutputData("stdout", outputBytes);
  const toolBytes = artifactResultProjection({
    artifact: outputArtifact,
    framedBytes,
    toolCallId: callId,
    toolName: item.toolName,
    terminalSource: item.source,
    terminal: item.terminal,
    resultProfile:
      item.resultProfileOverride ??
      toolResultProfileForCacheAbi(fixture.cacheAbi),
  }).messageBytes;
  const toolPayload = inlinePayload(
    "tool",
    toolBytes,
    2,
    assistant.payload.chainHash,
  );
  const toolResult = fixture.builder.append({
    type: "tool_result_committed",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: {
      ...toolPayload,
      toolCallId: callId,
      effectId: item.source === "effect" ? effectId : null,
      artifactId: outputArtifact.payload.artifactId,
      sourceEventId: terminalEvent.id,
    },
  });
  const finalBoundary = appendBoundary(fixture.builder, {
    idDigit: "b",
    blobCount: 3,
    chainHash: toolPayload.chainHash,
    sourceEventIds: [toolResult.id],
  });
  return { fixture, finalBoundary };
}

test("exact prefix selector accepts the complete source-phase terminal matrix", () => {
  const legalCases: readonly PrefixTerminalCase[] = [
    ...(["ok", "invalid_arguments", "io_error"] as const).map((code) => ({
      label: `read Artifact ${code}`,
      toolName: "read" as const,
      source: "artifact" as const,
      terminal: prefixTerminal("read", "artifact", code),
    })),
    ...(["invalid_arguments", "io_error"] as const).map((code) => ({
      label: `write pre-effect ${code}`,
      toolName: "write" as const,
      source: "artifact" as const,
      terminal: prefixTerminal("write", "artifact", code),
    })),
    ...([
      "invalid_arguments",
      "io_error",
      "edit_no_match",
      "edit_not_unique",
    ] as const).map((code) => ({
      label: `edit pre-effect ${code}`,
      toolName: "edit" as const,
      source: "artifact" as const,
      terminal: prefixTerminal("edit", "artifact", code),
    })),
    {
      label: "bash pre-effect frozen unavailable spelling",
      toolName: "bash",
      source: "artifact",
      terminal: prefixTerminal(
        "bash",
        "artifact",
        "bash_supervisor_unavailable",
      ),
    },
    ...(["write", "edit"] as const).flatMap((toolName) =>
      (["ok", "io_error", "target_changed"] as const).map((code) => ({
        label: `${toolName} Effect ${code}`,
        toolName,
        source: "effect" as const,
        terminal: prefixTerminal(toolName, "effect", code),
      })),
    ),
    ...([
      "ok",
      "io_error",
      "nonzero_exit",
      "signaled",
      "timeout",
      "cancelled",
      "output_limit",
    ] as const).map((code) => ({
      label: `bash Effect ${code}`,
      toolName: "bash" as const,
      source: "effect" as const,
      terminal: prefixTerminal("bash", "effect", code),
      ...(code === "output_limit" ? { hardLimitReached: true } : {}),
    })),
  ];

  for (const item of legalCases) {
    const built = sourcePhasePrefixFixture(item, true);
    const selected = select(
      built.fixture,
      built.finalBoundary.payload.commitBoundaryId,
    );
    assert.equal(selected.blobCount, 3, item.label);
  }
});

test("exact prefix selector binds the tool-result parser to protocol v2", () => {
  const compactCase: PrefixTerminalCase = {
    label: "v2 compact read result",
    toolName: "read",
    source: "artifact",
    terminal: prefixTerminal("read", "artifact", "ok"),
    cacheAbi: buildCacheAbiV2(),
  };
  const compact = sourcePhasePrefixFixture(compactCase, true);
  assert.equal(
    select(compact.fixture, compact.finalBoundary.payload.commitBoundaryId)
      .blobCount,
    3,
  );

  const verboseUnderV2 = sourcePhasePrefixFixture(
    { ...compactCase, resultProfileOverride: "verbose-v1" },
    true,
  );
  assert.throws(
    () =>
      select(
        verboseUnderV2.fixture,
        verboseUnderV2.finalBoundary.payload.commitBoundaryId,
      ),
    TypeError,
  );
});

test("exact prefix selector rejects wrong-phase and terminal metadata combinations", () => {
  const bashEffectOk = prefixTerminal("bash", "effect", "ok");
  const bashEffectIoError = prefixTerminal("bash", "effect", "io_error");
  const invalidCases: readonly PrefixTerminalCase[] = [
    {
      label: "legacy credential terminal",
      toolName: "bash",
      source: "artifact",
      terminal: prefixTerminal(
        "bash",
        "artifact",
        "credential_shield_unavailable",
      ),
    },
    {
      label: "read wrong-phase target_changed",
      toolName: "read",
      source: "artifact",
      terminal: prefixTerminal("read", "artifact", "target_changed"),
    },
    {
      label: "write pre-effect ok",
      toolName: "write",
      source: "artifact",
      terminal: prefixTerminal("write", "artifact", "ok"),
    },
    {
      label: "edit pre-effect target_changed",
      toolName: "edit",
      source: "artifact",
      terminal: prefixTerminal("edit", "artifact", "target_changed"),
    },
    {
      label: "bash pre-effect io_error",
      toolName: "bash",
      source: "artifact",
      terminal: prefixTerminal("bash", "artifact", "io_error"),
    },
    {
      label: "write Effect edit_no_match",
      toolName: "write",
      source: "effect",
      terminal: prefixTerminal("write", "effect", "edit_no_match"),
    },
    {
      label: "edit Effect nonzero_exit",
      toolName: "edit",
      source: "effect",
      terminal: prefixTerminal("edit", "effect", "nonzero_exit"),
    },
    {
      label: "bash Effect target_changed",
      toolName: "bash",
      source: "effect",
      terminal: prefixTerminal("bash", "effect", "target_changed"),
    },
    {
      label: "file terminal carries process exit",
      toolName: "read",
      source: "artifact",
      terminal: replacePrefixTerminal(
        prefixTerminal("read", "artifact", "ok"),
        { exitCode: 0 },
      ),
    },
    {
      label: "successful bash omits process exit",
      toolName: "bash",
      source: "effect",
      terminal: replacePrefixTerminal(bashEffectOk, { exitCode: null }),
    },
    {
      label: "output_limit omits hard-limit marker",
      toolName: "bash",
      source: "effect",
      terminal: prefixTerminal("bash", "effect", "output_limit"),
    },
    {
      label: "non-output_limit carries hard-limit marker",
      toolName: "bash",
      source: "effect",
      terminal: bashEffectOk,
      hardLimitReached: true,
    },
    {
      label: "pre-effect bash carries cleanup observation",
      toolName: "bash",
      source: "artifact",
      terminal: replacePrefixTerminal(
        prefixTerminal(
          "bash",
          "artifact",
          "bash_supervisor_unavailable",
        ),
        { descendantsReaped: false },
      ),
    },
    {
      label: "Effect bash omits cleanup observation",
      toolName: "bash",
      source: "effect",
      terminal: replacePrefixTerminal(bashEffectIoError, {
        descendantsReaped: null,
      }),
      artifactDescendantsReaped: false,
    },
    {
      label: "hash-valid Effect bash cleanup mismatch",
      toolName: "bash",
      source: "effect",
      terminal: replacePrefixTerminal(bashEffectIoError, {
        descendantsReaped: true,
      }),
      artifactDescendantsReaped: false,
    },
    {
      label: "file Effect carries cleanup observation",
      toolName: "write",
      source: "effect",
      terminal: replacePrefixTerminal(
        prefixTerminal("write", "effect", "io_error"),
        { descendantsReaped: false },
      ),
    },
  ];

  for (const item of invalidCases) {
    const built = sourcePhasePrefixFixture(item, false);
    assert.throws(
      () =>
        select(
          built.fixture,
          built.finalBoundary.payload.commitBoundaryId,
        ),
      /durable source phase|cleanup observation|cleanup state/u,
      item.label,
    );
  }
});

test("exact prefix selector accepts an initial canonical user boundary", () => {
  const fixture = userBoundary();
  const selected = select(fixture);
  assert.equal(selected.lineageId, LID);
  assert.equal(selected.cacheAbiId, fixture.cacheAbi.cacheAbiId);
  assert.equal(selected.commitBoundaryId, fixture.boundaryId);
  assert.equal(selected.boundaryEventId, fixture.boundaryEvent.id);
  assert.equal(selected.blobCount, 1);
  assert.equal(selected.chainHash, fixture.chainHash);
  assert.equal(bytesEqual(selected.roleBlobs[0]!, fixture.userBytes), true);
  assert.equal(Object.isFrozen(selected), true);
  assert.equal(Object.isFrozen(selected.roleBlobs), true);
});

test("exact prefix selector accepts a terminal assistant response", () => {
  const fixture = userBoundary();
  const request = appendSnapshotAndAttempt(fixture);
  const assistantBytes = materializeAssistant({
    content: "done🙂",
    reasoningContent: "verified",
    toolCalls: [],
  });
  const assistant = appendAssistant(fixture, request, assistantBytes);
  const checkpoint = appendCheckpoint(fixture, request, assistant, "9");
  const finalBoundary = appendBoundary(fixture.builder, {
    idDigit: "a",
    blobCount: 2,
    chainHash: assistant.payload.chainHash,
    sourceEventIds: [assistant.id],
    cacheCheckpointId: checkpoint.payload.cacheCheckpointId,
  });

  const selected = select(fixture, finalBoundary.payload.commitBoundaryId);
  assert.equal(selected.blobCount, 2);
  assert.equal(bytesEqual(selected.roleBlobs[1]!, assistantBytes), true);
});

test("prefix selector requires a tool-calling assistant checkpoint before any next Run event", () => {
  for (const next of ["permission", "interruption"] as const) {
    const fixture = userBoundary();
    const request = appendSnapshotAndAttempt(fixture);
    const callId = wire<ToolCallId>(`call_checkpoint_${next}`);
    const assistant = appendAssistant(
      fixture,
      request,
      materializeAssistant({
        content: "",
        reasoningContent: "checkpoint first",
        toolCalls: [
          {
            id: callId,
            type: "function",
            function: { name: "read", arguments: '{"path":"a"}' },
          },
        ],
      }),
      RID,
      false,
    );
    if (next === "permission") {
      fixture.builder.append({
        type: "permission_decided",
        sessionId: SID,
        lineageId: LID,
        runId: RID,
        payload: {
          toolCallId: callId,
          policyDecision: "allow",
          finalDecision: "allow",
          resolution: "policy",
        },
      });
    } else {
      fixture.builder.append({
        type: "run_interrupted",
        sessionId: SID,
        lineageId: LID,
        runId: RID,
        payload: { reason: "cancelled", sourceEventId: assistant.id },
      });
    }
    const claimed = appendBoundary(fixture.builder, {
      idDigit: next === "permission" ? "6" : "7",
      blobCount: 2,
      chainHash: assistant.payload.chainHash,
      sourceEventIds: [assistant.id],
    });
    assert.throws(
      () => select(fixture, claimed.payload.commitBoundaryId),
      /assistant response is not checkpointed immediately/u,
    );
  }
});

function completeToolBatch(options?: {
  readonly includeResults?: boolean;
  readonly reverseResults?: boolean;
  readonly recoverAfterFirstResult?: boolean;
  readonly interruptBeforeBoundary?: boolean;
}): {
  readonly fixture: UserBoundaryFixture;
  readonly assistant: VerifiedJournalEvent<"assistant_committed">;
  readonly finalBoundary: VerifiedJournalEvent<"commit_boundary_created">;
  readonly toolBytes: readonly FrozenBytes[];
} {
  const fixture = userBoundary();
  const request = appendSnapshotAndAttempt(fixture);
  const calls = [
    {
      id: "call_1",
      type: "function" as const,
      function: { name: "read", arguments: '{"path":"a"}' },
    },
    {
      id: "call_2",
      type: "function" as const,
      function: { name: "read", arguments: '{"path":"b"}' },
    },
  ];
  const assistant = appendAssistant(
    fixture,
    request,
    materializeAssistant({
      content: "",
      reasoningContent: "inspect both",
      toolCalls: calls,
    }),
  );
  for (const call of calls) {
    fixture.builder.append({
      type: "permission_decided",
      sessionId: SID,
      lineageId: LID,
      runId: RID,
      payload: {
        toolCallId: wire<ToolCallId>(call.id),
        policyDecision: "allow",
        finalDecision: "allow",
        resolution: "policy",
      },
    });
  }
  let previous = assistant.payload.chainHash;
  const toolBytes: FrozenBytes[] = [];
  const resultEventIds: EventId[] = [];
  const results = options?.reverseResults ? [...calls].reverse() : calls;
  let resultRunId = RID;
  if (options?.includeResults !== false) {
    for (const [index, call] of results.entries()) {
      const output = utf8Bytes(`raw-${call.id}`);
      const framedOutput = encodeToolOutputData("read", output);
      const artifactId = opaque<ArtifactId>("art", index === 0 ? "a" : "b");
      const artifact = publishArtifact(fixture.builder, {
        artifactId,
        bytes: output,
        artifactType: "tool_output",
        runScoped: true,
        runId: resultRunId,
        toolCallId: wire<ToolCallId>(call.id),
        terminal: SUCCEEDED_TERMINAL,
        toolStream: "read",
      });
      const bytes = artifactResultProjection({
        artifact,
        framedBytes: framedOutput,
        toolCallId: wire<ToolCallId>(call.id),
        toolName: "read",
        terminalSource: "artifact",
        terminal: SUCCEEDED_TERMINAL,
      }).messageBytes;
      const payload = inlinePayload("tool", bytes, 2 + index, previous);
      const result = fixture.builder.append({
        type: "tool_result_committed",
        sessionId: SID,
        lineageId: LID,
        runId: resultRunId,
        payload: {
          ...payload,
          toolCallId: wire<ToolCallId>(call.id),
          effectId: null,
          artifactId,
          sourceEventId: artifact.id,
        },
      });
      resultEventIds.push(result.id);
      toolBytes.push(bytes);
      previous = payload.chainHash;
      if (index === 0 && options?.recoverAfterFirstResult === true) {
        const terminal = fixture.builder.append({
          type: "run_interrupted",
          sessionId: SID,
          lineageId: LID,
          runId: RID,
          payload: { reason: "cancelled", sourceEventId: result.id },
        });
        fixture.builder.append({
          type: "run_started",
          sessionId: SID,
          lineageId: LID,
          runId: RECOVERY_RID,
          parentId: terminal.id,
          payload: { cause: "recovery", previousRunId: RID },
        });
        resultRunId = RECOVERY_RID;
      }
    }
  }
  if (options?.interruptBeforeBoundary === true) {
    const sourceEventId = resultEventIds.at(-1);
    if (sourceEventId === undefined) {
      throw new TypeError("interruption fixture requires a complete result batch");
    }
    fixture.builder.append({
      type: "run_interrupted",
      sessionId: SID,
      lineageId: LID,
      runId: resultRunId,
      payload: { reason: "cancelled", sourceEventId },
    });
  }
  const finalBoundary = appendBoundary(fixture.builder, {
    idDigit: "c",
    blobCount: options?.includeResults === false ? 2 : 4,
    chainHash: previous,
    sourceEventIds:
      options?.includeResults === false ? [assistant.id] : resultEventIds,
    runId: resultRunId,
  });
  return { fixture, assistant, finalBoundary, toolBytes };
}

test("exact prefix selector accepts one complete ordered tool-result batch", () => {
  const batch = completeToolBatch();
  const selected = select(
    batch.fixture,
    batch.finalBoundary.payload.commitBoundaryId,
  );
  assert.equal(selected.blobCount, 4);
  assert.equal(bytesEqual(selected.roleBlobs[2]!, batch.toolBytes[0]!), true);
  assert.equal(bytesEqual(selected.roleBlobs[3]!, batch.toolBytes[1]!), true);
});

test("prefix selection rejects an old Snapshot alias after a newer tool Boundary is durable", () => {
  const batch = completeToolBatch();
  const sourceSnapshot = batch.fixture.builder.events.find(
    (event) => event.type === "request_snapshot_stored",
  );
  if (sourceSnapshot?.type !== "request_snapshot_stored") {
    throw new TypeError("tool batch fixture lacks its source Snapshot");
  }

  const terminal = batch.fixture.builder.append({
    type: "run_interrupted",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: {
      reason: "durability_failure",
      sourceEventId: batch.finalBoundary.id,
    },
  });
  batch.fixture.builder.append({
    type: "run_started",
    sessionId: SID,
    lineageId: LID,
    runId: RECOVERY_RID,
    parentId: terminal.id,
    payload: { cause: "recovery", previousRunId: RID },
  });

  const aliasSnapshotId = opaque<RequestSnapshotId>("rqs", "e");
  batch.fixture.builder.append({
    type: "request_snapshot_stored",
    sessionId: SID,
    lineageId: LID,
    runId: RECOVERY_RID,
    parentId: sourceSnapshot.payload.headEventId,
    payload: {
      ...sourceSnapshot.payload,
      requestSnapshotId: aliasSnapshotId,
      recoveryFromSnapshotId: sourceSnapshot.payload.requestSnapshotId,
    },
  });
  const attemptId = opaque<AttemptId>("att", "e");
  batch.fixture.builder.append({
    type: "request_attempt_started",
    sessionId: SID,
    lineageId: LID,
    runId: RECOVERY_RID,
    payload: {
      attemptId,
      requestSnapshotId: aliasSnapshotId,
      ordinal: 1,
    },
  });
  batch.fixture.builder.append({
    type: "request_semantic_started",
    sessionId: SID,
    lineageId: LID,
    runId: RECOVERY_RID,
    payload: { attemptId },
  });
  const assistantBytes = materializeAssistant({
    content: "stale alias must not be selected",
    reasoningContent: "the durable prefix advanced through tool results",
    toolCalls: [],
  });
  const assistantPayload = inlinePayload(
    "assistant",
    assistantBytes,
    batch.finalBoundary.payload.blobCount,
    batch.finalBoundary.payload.chainHash,
  );
  const assistant = batch.fixture.builder.append({
    type: "assistant_committed",
    sessionId: SID,
    lineageId: LID,
    runId: RECOVERY_RID,
    payload: {
      ...assistantPayload,
      attemptId,
      requestSnapshotId: aliasSnapshotId,
      providerRequestId: "provider-stale-alias",
      responseModel: "DeepSeek-V4-Flash-0731",
      systemFingerprint: "fp-stale-alias",
      semanticDeltaCount: 1,
      usage: {
        promptTokens: 9,
        promptCacheHitTokens: 7,
        promptCacheMissTokens: 2,
        completionTokens: 2,
        reasoningTokens: 1,
        rawFinishReason: "stop",
      },
    },
  });
  const checkpoint = appendCheckpoint(
    batch.fixture,
    { snapshotId: aliasSnapshotId },
    assistant,
    "e",
  );
  const finalBoundary = appendBoundary(batch.fixture.builder, {
    idDigit: "f",
    blobCount: assistant.payload.blobIndex + 1,
    chainHash: assistant.payload.chainHash,
    sourceEventIds: [assistant.id],
    runId: RECOVERY_RID,
    cacheCheckpointId: checkpoint.payload.cacheCheckpointId,
  });

  assert.throws(
    () =>
      select(
        batch.fixture,
        finalBoundary.payload.commitBoundaryId,
      ),
    /Request Snapshot Boundary is not the current durable prefix/u,
  );
});

test("tool prefix may complete one ordered batch across recovery Runs", () => {
  const recovered = completeToolBatch({ recoverAfterFirstResult: true });
  assert.equal(
    select(
      recovered.fixture,
      recovered.finalBoundary.payload.commitBoundaryId,
    ).blobCount,
    4,
  );
});

test("complete tool prefix rejects interruption before its mandatory Boundary", () => {
  const interrupted = completeToolBatch({ interruptBeforeBoundary: true });
  assert.throws(
    () =>
      select(
        interrupted.fixture,
        interrupted.finalBoundary.payload.commitBoundaryId,
      ),
    /safe role tail is not immediately bounded/u,
  );
});

test("exact prefix selector requires the selected boundary to be the exact head", () => {
  const fixture = userBoundary();
  publishArtifact(fixture.builder, {
    artifactId: opaque<ArtifactId>("art", "d"),
    bytes: utf8Bytes("later"),
    artifactType: "fact",
    runScoped: true,
  });
  assert.throws(() => select(fixture), /final Journal event/u);

  const missingGenesis = fixture.builder.events.slice(1);
  assert.throws(
    () =>
      selectLineagePrefixV1({
        cacheAbi: fixture.cacheAbi,
        journalFacts: missingGenesis,
        externalBlobs: new Map(),
        lineageId: LID,
        commitBoundaryId: fixture.boundaryId,
      }),
    /contiguous from genesis/u,
  );
});

test("exact prefix selector rejects canonical-event and role-byte mutation", () => {
  const fixture = userBoundary({
    userBytes: utf8Bytes('{"role":"user", "content":"hello"}'),
  });
  assert.throws(() => select(fixture), /user Blob is not canonical/u);

  const canonical = userBoundary();
  const finalIndex = canonical.builder.events.length - 1;
  const finalEvent = canonical.builder.events[finalIndex]!;
  canonical.builder.events[finalIndex] = {
    ...finalEvent,
    hash: wire<Sha256>(`sha256:${"f".repeat(64)}`),
  } as AnyVerifiedJournalEvent;
  assert.throws(() => select(canonical), /event hash is invalid/u);
});

test("user source facts must be exact ordered facts from the same Run and Lineage", () => {
  const reversed = userBoundary({ sourceViolation: "reversed" });
  assert.throws(
    () => select(reversed),
    /source facts are not in exact v1 order/u,
  );

  const crossRun = userBoundary({ sourceViolation: "cross_run" });
  assert.throws(
    () => select(crossRun),
    /source fact is absent or crosses Run\/Lineage/u,
  );
});

test("external Blob map is exact: correct passes; missing, extra, and mutated fail", () => {
  const largeUser = materializeUserMessage("x".repeat(INLINE_BLOB_LIMIT + 32));
  assert.ok(largeUser.byteLength > INLINE_BLOB_LIMIT);
  const fixture = userBoundary({ external: true, userBytes: largeUser });
  assert.equal(select(fixture).blobCount, 1);

  assert.throws(
    () => select(fixture, fixture.boundaryId, new Map()),
    /missing or extra keys/u,
  );

  const extraHash = hash(utf8Bytes("extra"));
  const extra = new Map(fixture.externalBlobs);
  extra.set(blobRef(extraHash), utf8Bytes("extra"));
  assert.throws(
    () => select(fixture, fixture.boundaryId, extra),
    /missing or extra keys/u,
  );

  const mutated = new Map(fixture.externalBlobs);
  const onlyRef = [...mutated.keys()][0]!;
  const wrong = largeUser.copy();
  wrong[wrong.byteLength - 1] = (wrong.at(-1) ?? 0) ^ 1;
  mutated.set(onlyRef, freezeBytes(wrong));
  assert.throws(
    () => select(fixture, fixture.boundaryId, mutated),
    /byte count or hash/u,
  );
});

test("tool results fail closed when orphaned, reversed, or pending at boundary", () => {
  const orphan = userBoundary();
  const orphanBytes = materializeToolResultMessage("orphan", {
    kind: "static",
    status: "invalid",
    code: "unknown_tool",
  });
  const orphanPayload = inlinePayload("tool", orphanBytes, 1, orphan.chainHash);
  orphan.builder.append({
    type: "tool_result_committed",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: {
      ...orphanPayload,
      toolCallId: wire<ToolCallId>("orphan"),
      effectId: null,
      artifactId: null,
      sourceEventId: orphan.userEvent.id,
    },
  });
  const orphanBoundary = appendBoundary(orphan.builder, {
    idDigit: "d",
    blobCount: 2,
    chainHash: orphanPayload.chainHash,
    sourceEventIds: [orphan.userEvent.id],
  });
  assert.throws(
    () => select(orphan, orphanBoundary.payload.commitBoundaryId),
    /orphaned, duplicated, or out of order/u,
  );

  const reversed = completeToolBatch({ reverseResults: true });
  assert.throws(
    () =>
      select(reversed.fixture, reversed.finalBoundary.payload.commitBoundaryId),
    /orphaned, duplicated, or out of order/u,
  );

  const pending = completeToolBatch({ includeResults: false });
  assert.throws(
    () => select(pending.fixture, pending.finalBoundary.payload.commitBoundaryId),
    /not derived from a closed prefix/u,
  );
});

test("a Provider attempt cannot start while prior tool results are pending", () => {
  const fixture = userBoundary();
  const request = appendSnapshotAndAttempt(fixture);
  const assistant = appendAssistant(
    fixture,
    request,
    materializeAssistant({
      content: "",
      reasoningContent: "read first",
      toolCalls: [
        {
          id: "pending_read",
          type: "function",
          function: { name: "read", arguments: '{"path":"a"}' },
        },
      ],
    }),
  );
  fixture.builder.append({
    type: "request_attempt_started",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: {
      attemptId: opaque<AttemptId>("att", "f"),
      requestSnapshotId: request.snapshotId,
      ordinal: 2,
    },
  });
  const boundary = appendBoundary(fixture.builder, {
    idDigit: "f",
    blobCount: 2,
    chainHash: assistant.payload.chainHash,
    sourceEventIds: [assistant.id],
  });
  assert.throws(
    () => select(fixture, boundary.payload.commitBoundaryId),
    /Provider attempt starts before protocol\/effects close/u,
  );
});

test("open Provider attempts and unsettled Effects cannot be asserted closed", () => {
  const openAttempt = userBoundary();
  appendSnapshotAndAttempt(openAttempt);
  const openBoundary = appendBoundary(openAttempt.builder, {
    idDigit: "d",
    blobCount: 1,
    chainHash: openAttempt.chainHash,
    sourceEventIds: [openAttempt.userEvent.id],
  });
  assert.throws(
    () => select(openAttempt, openBoundary.payload.commitBoundaryId),
    /not derived from a closed prefix/u,
  );

  const unsettled = userBoundary();
  const request = appendSnapshotAndAttempt(unsettled);
  const argumentsText = '{"path":"a","content":"b"}';
  const assistant = appendAssistant(
    unsettled,
    request,
    materializeAssistant({
      content: "",
      reasoningContent: "write",
      toolCalls: [
        {
          id: "write_1",
          type: "function",
          function: { name: "write", arguments: argumentsText },
        },
      ],
    }),
  );
  unsettled.builder.append({
    type: "permission_decided",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: {
      toolCallId: wire<ToolCallId>("write_1"),
      policyDecision: "allow",
      finalDecision: "allow",
      resolution: "policy",
    },
  });
  unsettled.builder.append({
    type: "effect_prepared",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: {
      effectId: opaque<EffectId>("eff", "e"),
      toolCallId: wire<ToolCallId>("write_1"),
      toolName: "write",
      argumentsHash: hash(utf8Bytes(argumentsText)),
    },
  });
  const unsettledBoundary = appendBoundary(unsettled.builder, {
    idDigit: "f",
    blobCount: 2,
    chainHash: assistant.payload.chainHash,
    sourceEventIds: [assistant.id],
  });
  assert.throws(
    () => select(unsettled, unsettledBoundary.payload.commitBoundaryId),
    /not derived from a closed prefix/u,
  );
});

function appendRecoveryRun(
  builder: JournalBuilder,
  sourceEventId: EventId,
  reason: "durability_failure" | "effect_indeterminate" = "durability_failure",
): void {
  const terminal = builder.append({
    type: "run_interrupted",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: { reason, sourceEventId },
  });
  builder.append({
    type: "run_started",
    sessionId: SID,
    lineageId: LID,
    runId: RECOVERY_RID,
    parentId: terminal.id,
    payload: { cause: "recovery", previousRunId: RID },
  });
}

function completedWriteFixture(options?: {
  readonly outputType?: "tool_output" | "fact";
  readonly outputRunId?: RunId;
  readonly resultSource?: "completion" | "artifact";
  readonly bypassEffect?: boolean;
}): {
  readonly fixture: UserBoundaryFixture;
  readonly finalBoundary: VerifiedJournalEvent<"commit_boundary_created">;
} {
  const fixture = userBoundary();
  const request = appendSnapshotAndAttempt(fixture);
  const argumentsText = '{"path":"a","content":"b"}';
  const assistant = appendAssistant(
    fixture,
    request,
    materializeAssistant({
      content: "",
      reasoningContent: "write exact bytes",
      toolCalls: [
        {
          id: "write_terminal",
          type: "function",
          function: { name: "write", arguments: argumentsText },
        },
      ],
    }),
  );
  fixture.builder.append({
    type: "permission_decided",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: {
      toolCallId: wire<ToolCallId>("write_terminal"),
      policyDecision: "allow",
      finalDecision: "allow",
      resolution: "policy",
    },
  });
  const effectId = opaque<EffectId>("eff", "a");
  const prepared = fixture.builder.append({
    type: "effect_prepared",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: {
      effectId,
      toolCallId: wire<ToolCallId>("write_terminal"),
      toolName: "write",
      argumentsHash: hash(utf8Bytes(argumentsText)),
    },
  });
  const outputRunId = options?.outputRunId ?? RID;
  if (outputRunId === RECOVERY_RID) {
    appendRecoveryRun(fixture.builder, prepared.id);
  }
  const outputId = opaque<ArtifactId>("art", "c");
  const outputBytes = utf8Bytes("");
  const outputArtifact = publishArtifact(fixture.builder, {
    artifactId: outputId,
    bytes: outputBytes,
    artifactType: options?.outputType ?? "tool_output",
    runScoped: true,
    runId: outputRunId,
    toolCallId: wire<ToolCallId>("write_terminal"),
    terminal: null,
    toolStream: null,
  });
  const completed = fixture.builder.append({
    type: "effect_completed",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: {
      effectId,
      toolCallId: wire<ToolCallId>("write_terminal"),
      artifactId: outputId,
      terminal: SUCCEEDED_TERMINAL,
    },
  });
  const toolCallId = wire<ToolCallId>("write_terminal");
  const toolBytes =
    outputArtifact.payload.artifactType === "tool_output"
      ? artifactResultProjection({
          artifact: outputArtifact,
          framedBytes: outputBytes,
          toolCallId,
          toolName: "write",
          terminalSource: "effect",
          terminal: SUCCEEDED_TERMINAL,
        }).messageBytes
      : materializeToolResultMessage(toolCallId, {
          kind: "static",
          status: "invalid",
          code: "invalid_arguments",
        });
  const toolPayload = inlinePayload(
    "tool",
    toolBytes,
    2,
    assistant.payload.chainHash,
  );
  const tool = fixture.builder.append({
    type: "tool_result_committed",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: {
      ...toolPayload,
      toolCallId: wire<ToolCallId>("write_terminal"),
      effectId: options?.bypassEffect === true ? null : effectId,
      artifactId: options?.bypassEffect === true ? null : outputId,
      sourceEventId:
        options?.bypassEffect === true
          ? assistant.id
          : options?.resultSource === "artifact"
            ? outputArtifact.id
            : completed.id,
    },
  });
  const finalBoundary = appendBoundary(fixture.builder, {
    idDigit: "d",
    blobCount: 3,
    chainHash: toolPayload.chainHash,
    sourceEventIds: [tool.id],
  });
  return { fixture, finalBoundary };
}

test("Effect tool result binds the exact terminal creator event", () => {
  const valid = completedWriteFixture();
  assert.equal(
    select(valid.fixture, valid.finalBoundary.payload.commitBoundaryId).blobCount,
    3,
  );

  const wrongSource = completedWriteFixture({ resultSource: "artifact" });
  assert.throws(
    () =>
      select(
        wrongSource.fixture,
        wrongSource.finalBoundary.payload.commitBoundaryId,
      ),
    /terminal Effect output/u,
  );

  const bypass = completedWriteFixture({ bypassEffect: true });
  assert.throws(
    () => select(bypass.fixture, bypass.finalBoundary.payload.commitBoundaryId),
    /bypasses its active Effect/u,
  );
});

test("Effect completion output must be tool_output in the exact Effect Run", () => {
  const wrongType = completedWriteFixture({ outputType: "fact" });
  assert.throws(
    () =>
      select(wrongType.fixture, wrongType.finalBoundary.payload.commitBoundaryId),
    /completion does not close one prepared Effect/u,
  );

  const wrongRun = completedWriteFixture({ outputRunId: RECOVERY_RID });
  assert.throws(
    () =>
      select(wrongRun.fixture, wrongRun.finalBoundary.payload.commitBoundaryId),
    /terminal-less tool output is not attached to an Effect/u,
  );
});

function reconciledEffectFixture(options: {
  readonly evidenceType: "operator_evidence" | "fact";
  readonly evidenceRunId: RunId;
  readonly outputType: "tool_output" | "fact";
  readonly outputRunId: RunId;
  readonly bypassEffect?: boolean;
}): {
  readonly fixture: UserBoundaryFixture;
  readonly finalBoundary: VerifiedJournalEvent<"commit_boundary_created">;
} {
  const fixture = userBoundary();
  const request = appendSnapshotAndAttempt(fixture);
  const argumentsText = '{"path":"a","content":"b"}';
  const assistant = appendAssistant(
    fixture,
    request,
    materializeAssistant({
      content: "",
      reasoningContent: "recover write",
      toolCalls: [
        {
          id: "write_reconcile",
          type: "function",
          function: { name: "write", arguments: argumentsText },
        },
      ],
    }),
  );
  fixture.builder.append({
    type: "permission_decided",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: {
      toolCallId: wire<ToolCallId>("write_reconcile"),
      policyDecision: "allow",
      finalDecision: "allow",
      resolution: "policy",
    },
  });
  const effectId = opaque<EffectId>("eff", "b");
  fixture.builder.append({
    type: "effect_prepared",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: {
      effectId,
      toolCallId: wire<ToolCallId>("write_reconcile"),
      toolName: "write",
      argumentsHash: hash(utf8Bytes(argumentsText)),
    },
  });
  const indeterminate = fixture.builder.append({
    type: "effect_indeterminate",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: { effectId, reason: "crash_gap" },
  });
  appendRecoveryRun(
    fixture.builder,
    indeterminate.id,
    "effect_indeterminate",
  );
  const evidenceId = opaque<ArtifactId>("art", "d");
  publishArtifact(fixture.builder, {
    artifactId: evidenceId,
    bytes: utf8Bytes("operator checked"),
    artifactType: options.evidenceType,
    runScoped: true,
    runId: options.evidenceRunId,
  });
  const outputId = opaque<ArtifactId>("art", "e");
  const outputBytes = utf8Bytes("");
  const outputArtifact = publishArtifact(fixture.builder, {
    artifactId: outputId,
    bytes: outputBytes,
    artifactType: options.outputType,
    runScoped: true,
    runId: options.outputRunId,
    toolCallId: wire<ToolCallId>("write_reconcile"),
    terminal: null,
    toolStream: null,
  });
  const reconciled = fixture.builder.append({
    type: "effect_reconciled",
    sessionId: SID,
    lineageId: LID,
    runId: RECOVERY_RID,
    payload: {
      effectId,
      resolution: "completed",
      evidenceArtifactId: evidenceId,
      outputArtifactId: outputId,
      terminal: SUCCEEDED_TERMINAL,
    },
  });
  let blobCount = 2;
  let chainHash = assistant.payload.chainHash;
  let sourceEventId = reconciled.id;
  if (options.bypassEffect === true) {
    const toolCallId = wire<ToolCallId>("write_reconcile");
    const toolBytes =
      outputArtifact.payload.artifactType === "tool_output"
        ? artifactResultProjection({
            artifact: outputArtifact,
            framedBytes: outputBytes,
            toolCallId,
            toolName: "write",
            terminalSource: "effect",
            terminal: SUCCEEDED_TERMINAL,
          }).messageBytes
        : materializeToolResultMessage(toolCallId, {
            kind: "static",
            status: "invalid",
            code: "invalid_arguments",
          });
    const toolPayload = inlinePayload("tool", toolBytes, 2, chainHash);
    const tool = fixture.builder.append({
      type: "tool_result_committed",
      sessionId: SID,
      lineageId: LID,
      runId: RECOVERY_RID,
      payload: {
        ...toolPayload,
        toolCallId: wire<ToolCallId>("write_reconcile"),
        effectId: null,
        artifactId: null,
        sourceEventId: assistant.id,
      },
    });
    blobCount = 3;
    chainHash = toolPayload.chainHash;
    sourceEventId = tool.id;
  }
  const finalBoundary = appendBoundary(fixture.builder, {
    idDigit: "f",
    blobCount,
    chainHash,
    sourceEventIds: [sourceEventId],
    runId: RECOVERY_RID,
  });
  return { fixture, finalBoundary };
}

test("Effect reconciliation evidence and output are exact recovery-Run Artifacts", () => {
  const wrongEvidenceRun = reconciledEffectFixture({
    evidenceType: "operator_evidence",
    evidenceRunId: RID,
    outputType: "tool_output",
    outputRunId: RECOVERY_RID,
  });
  assert.throws(
    () =>
      select(
        wrongEvidenceRun.fixture,
        wrongEvidenceRun.finalBoundary.payload.commitBoundaryId,
      ),
    /reconciliation lacks recovery evidence|target event refers to an unknown Run/u,
  );

  const wrongOutputType = reconciledEffectFixture({
    evidenceType: "operator_evidence",
    evidenceRunId: RECOVERY_RID,
    outputType: "fact",
    outputRunId: RECOVERY_RID,
  });
  assert.throws(
    () =>
      select(
        wrongOutputType.fixture,
        wrongOutputType.finalBoundary.payload.commitBoundaryId,
      ),
    /reconciled Effect output is not durable/u,
  );

  const bypass = reconciledEffectFixture({
    evidenceType: "operator_evidence",
    evidenceRunId: RECOVERY_RID,
    outputType: "tool_output",
    outputRunId: RECOVERY_RID,
    bypassEffect: true,
  });
  assert.throws(
    () => select(bypass.fixture, bypass.finalBoundary.payload.commitBoundaryId),
    /bypasses its active Effect/u,
  );
});

function recoveryAliasFixture(
  violation?: "same_run" | "non_recovery" | "altered_body",
): {
  readonly fixture: UserBoundaryFixture;
  readonly finalBoundary: VerifiedJournalEvent<"commit_boundary_created">;
} {
  const fixture = userBoundary();
  const sourceBody = utf8Bytes("source request body");
  const sourceHash = hash(sourceBody);
  const sourceId = opaque<RequestSnapshotId>("rqs", "a");
  const sourcePayload: JournalPayloadByType["request_snapshot_stored"] = {
    requestSnapshotId: sourceId,
    bodyRef: snapshotRef(sourceHash),
    bodyHash: sourceHash,
    byteCount: sourceBody.byteLength,
    cacheAbiId: fixture.cacheAbi.cacheAbiId,
    projectorVersion: "dsh-projector-v1",
    headEventId: fixture.boundaryEvent.id,
    commitBoundaryId: fixture.boundaryId,
    segmentHashes: [fixture.cacheAbi.headerHash, fixture.chainHash],
    recoveryFromSnapshotId: null,
  };
  const sourceSnapshot = fixture.builder.append({
    type: "request_snapshot_stored",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    parentId: fixture.boundaryEvent.id,
    payload: sourcePayload,
  });

  const targetRunId = violation === "same_run" ? RID : RECOVERY_RID;
  if (targetRunId === RECOVERY_RID) {
    const terminal = fixture.builder.append({
      type: "run_interrupted",
      sessionId: SID,
      lineageId: LID,
      runId: RID,
      payload: {
        reason: "durability_failure",
        sourceEventId: sourceSnapshot.id,
      },
    });
    fixture.builder.append({
      type: "run_started",
      sessionId: SID,
      lineageId: LID,
      runId: RECOVERY_RID,
      parentId: terminal.id,
      payload:
        violation === "non_recovery"
          ? { cause: "user", previousRunId: null }
          : { cause: "recovery", previousRunId: RID },
    });
  }
  const alteredBody = utf8Bytes("altered request body");
  const alteredHash = hash(alteredBody);
  const aliasPayload: JournalPayloadByType["request_snapshot_stored"] = {
    ...sourcePayload,
    requestSnapshotId: opaque<RequestSnapshotId>("rqs", "b"),
    ...(violation === "altered_body"
      ? {
          bodyRef: snapshotRef(alteredHash),
          bodyHash: alteredHash,
          byteCount: alteredBody.byteLength,
        }
      : {}),
    recoveryFromSnapshotId: sourceId,
  };
  fixture.builder.append({
    type: "request_snapshot_stored",
    sessionId: SID,
    lineageId: LID,
    runId: targetRunId,
    parentId: fixture.boundaryEvent.id,
    payload: aliasPayload,
  });
  const attemptId = opaque<AttemptId>("att", "c");
  fixture.builder.append({
    type: "request_attempt_started",
    sessionId: SID,
    lineageId: LID,
    runId: targetRunId,
    payload: {
      attemptId,
      requestSnapshotId: aliasPayload.requestSnapshotId,
      ordinal: 1,
    },
  });
  fixture.builder.append({
    type: "request_semantic_started",
    sessionId: SID,
    lineageId: LID,
    runId: targetRunId,
    payload: { attemptId },
  });
  const assistant = appendAssistant(
    fixture,
    { snapshotId: aliasPayload.requestSnapshotId, attemptId },
    materializeAssistant({
      content: "recovered",
      reasoningContent: "resume exact snapshot",
      toolCalls: [],
    }),
    targetRunId,
  );
  const checkpoint = appendCheckpoint(
    fixture,
    { snapshotId: aliasPayload.requestSnapshotId },
    assistant,
    "d",
  );
  const finalBoundary = appendBoundary(fixture.builder, {
    idDigit: "e",
    blobCount: 2,
    chainHash: assistant.payload.chainHash,
    sourceEventIds: [assistant.id],
    runId: targetRunId,
    cacheCheckpointId: checkpoint.payload.cacheCheckpointId,
  });
  return { fixture, finalBoundary };
}

function freshRecoveryProjectionFixture(duplicate = false): {
  readonly fixture: UserBoundaryFixture;
  readonly finalBoundary: VerifiedJournalEvent<"commit_boundary_created">;
} {
  const fixture = userBoundary();
  const terminal = fixture.builder.append({
    type: "run_interrupted",
    sessionId: SID,
    lineageId: LID,
    runId: RID,
    payload: {
      reason: "durability_failure",
      sourceEventId: fixture.boundaryEvent.id,
    },
  });
  const firstRecovery = fixture.builder.append({
    type: "run_started",
    sessionId: SID,
    lineageId: LID,
    runId: RECOVERY_RID,
    parentId: terminal.id,
    payload: { cause: "recovery", previousRunId: RID },
  });
  const secondTerminal = fixture.builder.append({
    type: "run_interrupted",
    sessionId: SID,
    lineageId: LID,
    runId: RECOVERY_RID,
    payload: {
      reason: "durability_failure",
      sourceEventId: firstRecovery.id,
    },
  });
  fixture.builder.append({
    type: "run_started",
    sessionId: SID,
    lineageId: LID,
    runId: SECOND_RECOVERY_RID,
    parentId: secondTerminal.id,
    payload: { cause: "recovery", previousRunId: RECOVERY_RID },
  });
  const body = utf8Bytes("fresh recovery projection");
  const bodyHash = hash(body);
  const snapshotId = opaque<RequestSnapshotId>("rqs", "5");
  const payload: JournalPayloadByType["request_snapshot_stored"] = {
    requestSnapshotId: snapshotId,
    bodyRef: snapshotRef(bodyHash),
    bodyHash,
    byteCount: body.byteLength,
    cacheAbiId: fixture.cacheAbi.cacheAbiId,
    projectorVersion: "dsh-projector-v1",
    headEventId: fixture.boundaryEvent.id,
    commitBoundaryId: fixture.boundaryId,
    segmentHashes: [fixture.cacheAbi.headerHash, fixture.chainHash],
    recoveryFromSnapshotId: null,
  };
  fixture.builder.append({
    type: "request_snapshot_stored",
    sessionId: SID,
    lineageId: LID,
    runId: SECOND_RECOVERY_RID,
    parentId: fixture.boundaryEvent.id,
    payload,
  });
  if (duplicate) {
    fixture.builder.append({
      type: "request_snapshot_stored",
      sessionId: SID,
      lineageId: LID,
      runId: SECOND_RECOVERY_RID,
      parentId: fixture.boundaryEvent.id,
      payload: {
        ...payload,
        requestSnapshotId: opaque<RequestSnapshotId>("rqs", "6"),
      },
    });
  }
  const attemptId = opaque<AttemptId>("att", "5");
  fixture.builder.append({
    type: "request_attempt_started",
    sessionId: SID,
    lineageId: LID,
    runId: SECOND_RECOVERY_RID,
    payload: { attemptId, requestSnapshotId: snapshotId, ordinal: 1 },
  });
  fixture.builder.append({
    type: "request_semantic_started",
    sessionId: SID,
    lineageId: LID,
    runId: SECOND_RECOVERY_RID,
    payload: { attemptId },
  });
  const assistant = appendAssistant(
    fixture,
    { snapshotId, attemptId },
    materializeAssistant({
      content: "recovered",
      reasoningContent: "project predecessor boundary once",
      toolCalls: [],
    }),
    SECOND_RECOVERY_RID,
  );
  const checkpoint = appendCheckpoint(
    fixture,
    { snapshotId },
    assistant,
    "5",
  );
  const finalBoundary = appendBoundary(fixture.builder, {
    idDigit: "5",
    blobCount: 2,
    chainHash: assistant.payload.chainHash,
    sourceEventIds: [assistant.id],
    runId: SECOND_RECOVERY_RID,
    cacheCheckpointId: checkpoint.payload.cacheCheckpointId,
  });
  return { fixture, finalBoundary };
}

test("a later recovery Run projects one fresh Snapshot after its predecessor crashes before projection", () => {
  const valid = freshRecoveryProjectionFixture();
  assert.equal(
    select(valid.fixture, valid.finalBoundary.payload.commitBoundaryId).blobCount,
    2,
  );
  const duplicate = freshRecoveryProjectionFixture(true);
  assert.throws(
    () =>
      select(
        duplicate.fixture,
        duplicate.finalBoundary.payload.commitBoundaryId,
      ),
    /ordinary Request Snapshot does not bind one unprojected safe Boundary/u,
  );
});

test("recovery Snapshot aliases are exact cross-Run copies", () => {
  const valid = recoveryAliasFixture();
  assert.equal(
    select(valid.fixture, valid.finalBoundary.payload.commitBoundaryId).blobCount,
    2,
  );

  for (const violation of [
    "same_run",
    "non_recovery",
    "altered_body",
  ] as const) {
    const invalid = recoveryAliasFixture(violation);
    assert.throws(
      () =>
        select(
          invalid.fixture,
          invalid.finalBoundary.payload.commitBoundaryId,
        ),
      /not an exact cross-Run alias|user Run is not the first/u,
    );
  }
});
