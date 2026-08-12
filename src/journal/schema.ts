import {
  bytesEqual,
  concatBytes,
  fromBase64,
  sha256Hex,
  utf8Bytes,
} from "../bytes/ops.js";
import type { FrozenBytes } from "../bytes/types.js";
import { asToolCallId } from "../bytes/tool-call-id.js";
import { normalizeToolTerminal } from "../artifact/terminal.js";
import type {
  ToolTerminal,
  ToolTerminalStatus,
} from "../artifact/terminal.js";
import { journalError } from "./errors.js";
import type {
  AnyJournalEventDraft,
  AnyVerifiedJournalEvent,
  ArtifactRef,
  ArtifactStreamBytes,
  ArtifactType,
  BlobRef,
  BlobPayload,
  CacheAbiId,
  CanonicalTimestamp,
  EventId,
  JournalEventPreimage,
  JournalEventType,
  JournalPayloadByType,
  LineageId,
  RecoveryRef,
  RunId,
  SessionId,
  Sha256,
  SnapshotRef,
  ToolResultSearchUsage,
} from "./types.js";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf8Encoder = new TextEncoder();

const EVENT_TYPES = new Set<JournalEventType>([
  "session_started",
  "cache_abi_declared",
  "lineage_started",
  "lineage_activated",
  "run_started",
  "fact_recorded",
  "user_committed",
  "artifact_published",
  "artifact_version_created",
  "request_snapshot_stored",
  "request_attempt_started",
  "request_semantic_started",
  "assistant_committed",
  "request_interrupted",
  "cache_checkpoint_created",
  "commit_boundary_created",
  "cache_break",
  "integrity_violation",
  "permission_decided",
  "effect_prepared",
  "effect_completed",
  "effect_indeterminate",
  "effect_reconciled",
  "tool_result_committed",
  "verification_recorded",
  "run_completed",
  "run_interrupted",
  "journal_tail_recovered",
]);

const ID_PATTERNS = Object.freeze({
  event: /^evt_[0-9a-f]{32}$/u,
  session: /^ses_[0-9a-f]{32}$/u,
  lineage: /^lin_[0-9a-f]{32}$/u,
  run: /^run_[0-9a-f]{32}$/u,
  snapshot: /^rqs_[0-9a-f]{32}$/u,
  attempt: /^att_[0-9a-f]{32}$/u,
  artifact: /^art_[0-9a-f]{32}$/u,
  artifactVersion: /^arv_[0-9a-f]{32}$/u,
  effect: /^eff_[0-9a-f]{32}$/u,
  checkpoint: /^ccp_[0-9a-f]{32}$/u,
  boundary: /^cbd_[0-9a-f]{32}$/u,
});

const SHA_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CODE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;

type UnknownRecord = Record<string, unknown>;

function fail(): never {
  throw journalError("JOURNAL_SCHEMA");
}

function record(value: unknown): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of ownKeys as string[]) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      fail();
    }
  }
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, expected: readonly string[]): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    fail();
  }
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function stringValue(value: unknown, allowEmpty = true): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    hasLoneSurrogate(value)
  ) {
    fail();
  }
  return value;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] {
  const parsed = stringValue(value);
  if (!(values as readonly string[]).includes(parsed)) fail();
  return parsed as Values[number];
}

function nonNegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail();
  return value as number;
}

function positive(value: unknown): number {
  const parsed = nonNegative(value);
  if (parsed === 0) fail();
  return parsed;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") fail();
  return value;
}

function literalTrue(value: unknown): true {
  if (value !== true) fail();
  return true;
}

function nullable<T>(value: unknown, parse: (input: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

function searchUsage(value: unknown): ToolResultSearchUsage | null {
  if (value === null) return null;
  const parsed = record(value);
  exactKeys(parsed, [
    "inputTokens",
    "promptCacheHitTokens",
    "outputTokens",
    "reasoningTokens",
  ]);
  const inputTokens = nonNegative(parsed["inputTokens"]);
  const promptCacheHitTokens = nonNegative(parsed["promptCacheHitTokens"]);
  const outputTokens = nonNegative(parsed["outputTokens"]);
  const reasoningTokens = nonNegative(parsed["reasoningTokens"]);
  if (
    promptCacheHitTokens > inputTokens ||
    reasoningTokens > outputTokens
  ) {
    fail();
  }
  return {
    inputTokens,
    promptCacheHitTokens,
    outputTokens,
    reasoningTokens,
  };
}

function toolCallId(value: unknown): ReturnType<typeof asToolCallId> {
  try {
    return asToolCallId(value);
  } catch {
    fail();
  }
}

function terminal(
  value: unknown,
  allowedStatuses?: ReadonlySet<ToolTerminalStatus>,
): ToolTerminal {
  try {
    return normalizeToolTerminal(value, allowedStatuses);
  } catch {
    fail();
  }
}

function opaqueId(value: unknown, pattern: RegExp): string {
  const parsed = stringValue(value);
  if (!pattern.test(parsed)) fail();
  return parsed;
}

export function asEventId(value: unknown): EventId {
  return opaqueId(value, ID_PATTERNS.event) as EventId;
}

export function asSessionId(value: unknown): SessionId {
  return opaqueId(value, ID_PATTERNS.session) as SessionId;
}

export function asLineageId(value: unknown): LineageId {
  return opaqueId(value, ID_PATTERNS.lineage) as LineageId;
}

export function asRunId(value: unknown): RunId {
  return opaqueId(value, ID_PATTERNS.run) as RunId;
}

export function asSha256(value: unknown): Sha256 {
  const parsed = stringValue(value);
  if (!SHA_PATTERN.test(parsed)) fail();
  return parsed as Sha256;
}

export function asCacheAbiId(value: unknown): CacheAbiId {
  return asSha256(value) as unknown as CacheAbiId;
}

export function asCanonicalTimestamp(value: unknown): CanonicalTimestamp {
  const parsed = stringValue(value);
  if (!TIMESTAMP_PATTERN.test(parsed)) fail();
  try {
    if (new Date(parsed).toISOString() !== parsed) fail();
  } catch {
    fail();
  }
  return parsed as CanonicalTimestamp;
}

function typedId(
  value: unknown,
  kind: keyof Omit<typeof ID_PATTERNS, "event" | "session" | "lineage" | "run">,
): string {
  return opaqueId(value, ID_PATTERNS[kind]);
}

function namespacedRef<Ref extends string>(
  value: unknown,
  namespace: "artifacts" | "blobs" | "snapshots" | "recovery",
): Ref {
  const parsed = stringValue(value);
  const pattern = new RegExp(`^${namespace}/sha256/[0-9a-f]{64}$`, "u");
  if (!pattern.test(parsed)) fail();
  return parsed as Ref;
}

function refMatchesHash(ref: string, hash: Sha256): void {
  if (ref.slice(ref.lastIndexOf("/") + 1) !== hash.slice("sha256:".length)) fail();
}

function uniqueArray<T>(
  value: unknown,
  parse: (item: unknown) => T,
  minimumLength = 0,
): readonly T[] {
  if (!Array.isArray(value) || value.length < minimumLength) fail();
  const parsed = value.map(parse);
  if (new Set(parsed).size !== parsed.length) fail();
  return Object.freeze(parsed);
}

function immutablePayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutablePayload(item)));
  }
  if (typeof value === "object" && value !== null) {
    const source = record(value);
    const copy: UnknownRecord = {};
    for (const [key, item] of Object.entries(source)) {
      copy[key] = immutablePayload(item);
    }
    return Object.freeze(copy);
  }
  return value;
}

function closedCode(value: unknown, maximumBytes = 64): string {
  const parsed = stringValue(value, false);
  if (!CODE_PATTERN.test(parsed) || utf8Encoder.encode(parsed).byteLength > maximumBytes) {
    fail();
  }
  return parsed;
}

function optionalScopeId(
  value: UnknownRecord,
  key: "lineageId" | "runId" | "parentId",
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  if (key === "lineageId") return asLineageId(value[key]);
  if (key === "runId") return asRunId(value[key]);
  return asEventId(value[key]);
}

function blobPayload<Role extends "user" | "assistant" | "tool">(
  value: UnknownRecord,
  role: Role,
  trailingKeys: readonly string[],
  optionalTrailingKeys: readonly string[] = [],
): BlobPayload<Role> {
  if (value["role"] !== role) fail();
  const enc = enumValue(value["enc"], ["b64", "ref"] as const);
  const commonTail = ["byteCount", "byteHash", "blobIndex", "chainHash"];
  // Optional trailing keys are admitted only when actually present; the
  // payload must otherwise remain the closed set.
  const presentOptional = optionalTrailingKeys.filter((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
  exactKeys(
    value,
    enc === "b64"
      ? ["role", "enc", "bytes", ...commonTail, ...trailingKeys, ...presentOptional]
      : ["role", "enc", "blobRef", ...commonTail, ...trailingKeys, ...presentOptional],
  );
  const byteCount = nonNegative(value["byteCount"]);
  const byteHash = asSha256(value["byteHash"]);
  const blobIndex = nonNegative(value["blobIndex"]);
  const chainHash = asSha256(value["chainHash"]);
  if (enc === "b64") {
    if (byteCount > 65_536) fail();
    let bytes: FrozenBytes;
    try {
      bytes = fromBase64(stringValue(value["bytes"]));
    } catch {
      fail();
    }
    if (
      bytes.byteLength !== byteCount ||
      `sha256:${sha256Hex(bytes)}` !== byteHash
    ) {
      fail();
    }
    return {
      role,
      enc: "b64",
      bytes: stringValue(value["bytes"]),
      byteCount,
      byteHash,
      blobIndex,
      chainHash,
    };
  }
  if (byteCount <= 65_536) fail();
  const blobRef = namespacedRef<BlobRef>(value["blobRef"], "blobs");
  refMatchesHash(blobRef, byteHash);
  return {
    role,
    enc: "ref",
    blobRef,
    byteCount,
    byteHash,
    blobIndex,
    chainHash,
  };
}

function streamBytes(value: unknown): ArtifactStreamBytes {
  const parsed = record(value);
  exactKeys(parsed, ["read", "stdout", "stderr"]);
  return {
    read: nonNegative(parsed["read"]),
    stdout: nonNegative(parsed["stdout"]),
    stderr: nonNegative(parsed["stderr"]),
  };
}

function usagePayload(value: unknown): JournalPayloadByType["assistant_committed"]["usage"] {
  const parsed = record(value);
  exactKeys(parsed, [
    "promptTokens",
    "promptCacheHitTokens",
    "promptCacheMissTokens",
    "completionTokens",
    "reasoningTokens",
    "rawFinishReason",
  ]);
  const usage = {
    promptTokens: nonNegative(parsed["promptTokens"]),
    promptCacheHitTokens: nonNegative(parsed["promptCacheHitTokens"]),
    promptCacheMissTokens: nonNegative(parsed["promptCacheMissTokens"]),
    completionTokens: nonNegative(parsed["completionTokens"]),
    reasoningTokens: nonNegative(parsed["reasoningTokens"]),
    rawFinishReason: stringValue(parsed["rawFinishReason"]),
  };
  if (
    usage.promptTokens !==
      usage.promptCacheHitTokens + usage.promptCacheMissTokens ||
    usage.reasoningTokens > usage.completionTokens
  ) {
    fail();
  }
  return usage;
}

function normalizePayload(type: JournalEventType, input: unknown): unknown {
  const value = record(input);
  switch (type) {
    case "session_started": {
      exactKeys(value, []);
      return {};
    }
    case "cache_abi_declared": {
      exactKeys(value, ["cacheAbiId", "manifestArtifactId", "manifestByteCount"]);
      return {
        cacheAbiId: asCacheAbiId(value["cacheAbiId"]),
        manifestArtifactId: typedId(value["manifestArtifactId"], "artifact"),
        manifestByteCount: nonNegative(value["manifestByteCount"]),
      };
    }
    case "lineage_started": {
      exactKeys(value, ["cacheAbiId"]);
      return { cacheAbiId: asCacheAbiId(value["cacheAbiId"]) };
    }
    case "lineage_activated": {
      exactKeys(value, ["previousLineageId", "nextLineageId", "reason"]);
      const reason = enumValue(value["reason"], ["initial", "abi_change", "compaction"] as const);
      const previousLineageId = nullable(value["previousLineageId"], asLineageId);
      if ((reason === "initial") !== (previousLineageId === null)) fail();
      return {
        previousLineageId,
        nextLineageId: asLineageId(value["nextLineageId"]),
        reason,
      };
    }
    case "run_started": {
      exactKeys(value, ["cause", "previousRunId"]);
      const cause = enumValue(value["cause"], [
        "user",
        "continue",
        "recovery",
      ] as const);
      const previousRunId = nullable(value["previousRunId"], asRunId);
      if (cause === "user" && previousRunId !== null) fail();
      if (cause !== "user" && previousRunId === null) fail();
      return { cause, previousRunId };
    }
    case "fact_recorded": {
      exactKeys(value, ["kind", "artifactId", "byteCount"]);
      return {
        kind: enumValue(value["kind"], [
          "user_input",
          "project_instructions",
          "date",
          "cwd",
          "git",
          "tree",
        ] as const),
        artifactId: typedId(value["artifactId"], "artifact"),
        byteCount: nonNegative(value["byteCount"]),
      };
    }
    case "user_committed": {
      const blob = blobPayload(value, "user", ["sourceFactEventIds"]);
      return {
        ...blob,
        sourceFactEventIds: uniqueArray(value["sourceFactEventIds"], asEventId, 1),
      };
    }
    case "artifact_published": {
      exactKeys(value, [
        "artifactId",
        "artifactRef",
        "artifactHash",
        "byteCount",
        "lineCount",
        "mediaType",
        "artifactType",
        "streamBytes",
        "hardLimitReached",
        "descendantsReaped",
        "toolCallId",
        "terminal",
      ]);
      const artifactHash = asSha256(value["artifactHash"]);
      const artifactRef = namespacedRef<ArtifactRef>(value["artifactRef"], "artifacts");
      refMatchesHash(artifactRef, artifactHash);
      const byteCount = nonNegative(value["byteCount"]);
      const mediaType = stringValue(value["mediaType"], false);
      const mediaBytes = utf8Encoder.encode(mediaType);
      if (
        mediaBytes.byteLength > 127 ||
        [...mediaBytes].some((byte) => byte < 0x20 || byte > 0x7e)
      ) {
        fail();
      }
      const artifactType = enumValue(value["artifactType"], [
        "cache_abi_manifest",
        "project_instructions",
        "fact",
        "tool_output",
        "operator_evidence",
        "user_state",
      ] as const) as ArtifactType;
      const parsedStreams = nullable(value["streamBytes"], streamBytes);
      const hardLimitReached = nullable(value["hardLimitReached"], booleanValue);
      const descendantsReaped = nullable(
        value["descendantsReaped"],
        booleanValue,
      );
      const parsedToolCallId = nullable(value["toolCallId"], toolCallId);
      const parsedTerminal = nullable(value["terminal"], terminal);
      if (artifactType === "tool_output") {
        if (
          mediaType !== "application/vnd.simpledsh.tool-output.v1" ||
          value["lineCount"] !== null ||
          parsedStreams === null ||
          hardLimitReached === null ||
          parsedToolCallId === null
        ) {
          fail();
        }
        const payloadByteCount =
          parsedStreams.read + parsedStreams.stdout + parsedStreams.stderr;
        const framingByteCount = byteCount - payloadByteCount;
        if (
          !Number.isSafeInteger(payloadByteCount) ||
          framingByteCount < 0 ||
          framingByteCount % 6 !== 0 ||
          (hardLimitReached && framingByteCount < 6) ||
          (parsedTerminal !== null && descendantsReaped !== null)
        ) {
          fail();
        }
      } else if (
        parsedStreams !== null ||
        hardLimitReached !== null ||
        descendantsReaped !== null ||
        parsedToolCallId !== null ||
        parsedTerminal !== null
      ) {
        fail();
      }
      return {
        artifactId: typedId(value["artifactId"], "artifact"),
        artifactRef,
        artifactHash,
        byteCount,
        lineCount: nullable(value["lineCount"], nonNegative),
        mediaType,
        artifactType,
        streamBytes: parsedStreams,
        hardLimitReached,
        descendantsReaped,
        toolCallId: parsedToolCallId,
        terminal: parsedTerminal,
      };
    }
    case "artifact_version_created": {
      exactKeys(value, [
        "artifactVersionId",
        "parentArtifactVersionId",
        "oldArtifactId",
        "newArtifactId",
      ]);
      const oldArtifactId = typedId(value["oldArtifactId"], "artifact");
      const newArtifactId = typedId(value["newArtifactId"], "artifact");
      if (oldArtifactId === newArtifactId) fail();
      return {
        artifactVersionId: typedId(value["artifactVersionId"], "artifactVersion"),
        parentArtifactVersionId: nullable(value["parentArtifactVersionId"], (item) =>
          typedId(item, "artifactVersion"),
        ),
        oldArtifactId,
        newArtifactId,
      };
    }
    case "request_snapshot_stored": {
      exactKeys(value, [
        "requestSnapshotId",
        "bodyRef",
        "bodyHash",
        "byteCount",
        "cacheAbiId",
        "projectorVersion",
        "headEventId",
        "commitBoundaryId",
        "segmentHashes",
        "recoveryFromSnapshotId",
      ]);
      const bodyHash = asSha256(value["bodyHash"]);
      const bodyRef = namespacedRef<SnapshotRef>(value["bodyRef"], "snapshots");
      refMatchesHash(bodyRef, bodyHash);
      const segmentHashes = uniqueArray(value["segmentHashes"], asSha256);
      if (segmentHashes.length !== 2) fail();
      return {
        requestSnapshotId: typedId(value["requestSnapshotId"], "snapshot"),
        bodyRef,
        bodyHash,
        byteCount: nonNegative(value["byteCount"]),
        cacheAbiId: asCacheAbiId(value["cacheAbiId"]),
        projectorVersion: enumValue(value["projectorVersion"], [
          "dsh-projector-v1",
        ] as const),
        headEventId: asEventId(value["headEventId"]),
        commitBoundaryId: typedId(value["commitBoundaryId"], "boundary"),
        segmentHashes: segmentHashes as readonly [Sha256, Sha256],
        recoveryFromSnapshotId: nullable(value["recoveryFromSnapshotId"], (item) =>
          typedId(item, "snapshot"),
        ),
      };
    }
    case "request_attempt_started": {
      exactKeys(value, ["attemptId", "requestSnapshotId", "ordinal"]);
      return {
        attemptId: typedId(value["attemptId"], "attempt"),
        requestSnapshotId: typedId(value["requestSnapshotId"], "snapshot"),
        ordinal: positive(value["ordinal"]),
      };
    }
    case "request_semantic_started": {
      exactKeys(value, ["attemptId"]);
      return { attemptId: typedId(value["attemptId"], "attempt") };
    }
    case "assistant_committed": {
      const trailing = [
        "attemptId",
        "requestSnapshotId",
        "providerRequestId",
        "responseModel",
        "systemFingerprint",
        "semanticDeltaCount",
        "usage",
      ];
      const blob = blobPayload(value, "assistant", trailing);
      return {
        ...blob,
        attemptId: typedId(value["attemptId"], "attempt"),
        requestSnapshotId: typedId(value["requestSnapshotId"], "snapshot"),
        providerRequestId: stringValue(value["providerRequestId"], false),
        responseModel: stringValue(value["responseModel"], false),
        systemFingerprint: nullable(value["systemFingerprint"], stringValue),
        semanticDeltaCount: nonNegative(value["semanticDeltaCount"]),
        usage: usagePayload(value["usage"]),
      };
    }
    case "request_interrupted": {
      exactKeys(value, [
        "attemptId",
        "requestSnapshotId",
        "outcome",
        "status",
        "retryClass",
        "semanticState",
      ]);
      const outcome = enumValue(value["outcome"], [
        "http_error",
        "transport_error",
        "timeout",
        "cancelled",
        "protocol_error",
        "durability_error",
      ] as const);
      const status = nullable(value["status"], (item) => {
        const parsed = positive(item);
        if (parsed < 100 || parsed > 599) fail();
        return parsed;
      });
      if ((outcome === "http_error") !== (status !== null)) fail();
      return {
        attemptId: typedId(value["attemptId"], "attempt"),
        requestSnapshotId: typedId(value["requestSnapshotId"], "snapshot"),
        outcome,
        status,
        retryClass: enumValue(value["retryClass"], [
          "request_invalid",
          "authentication",
          "balance",
          "rate_limited",
          "server",
          "unknown",
          "timeout",
          "cancelled",
          "protocol",
          "transport_unknown",
        ] as const),
        semanticState: enumValue(value["semanticState"], [
          "pre_semantic",
          "post_semantic",
          "semantic_state_unknown",
        ] as const),
      };
    }
    case "cache_checkpoint_created": {
      exactKeys(value, [
        "cacheCheckpointId",
        "requestSnapshotId",
        "blobCount",
        "chainHash",
        "promptTokens",
        "providerRequestId",
        "sourceAssistantEventId",
      ]);
      return {
        cacheCheckpointId: typedId(value["cacheCheckpointId"], "checkpoint"),
        requestSnapshotId: typedId(value["requestSnapshotId"], "snapshot"),
        blobCount: nonNegative(value["blobCount"]),
        chainHash: asSha256(value["chainHash"]),
        promptTokens: nonNegative(value["promptTokens"]),
        providerRequestId: stringValue(value["providerRequestId"], false),
        sourceAssistantEventId: asEventId(value["sourceAssistantEventId"]),
      };
    }
    case "commit_boundary_created": {
      exactKeys(value, [
        "commitBoundaryId",
        "cacheCheckpointId",
        "blobCount",
        "chainHash",
        "protocolClosed",
        "effectsSettled",
        "sourceEventIds",
      ]);
      return {
        commitBoundaryId: typedId(value["commitBoundaryId"], "boundary"),
        cacheCheckpointId: nullable(value["cacheCheckpointId"], (item) =>
          typedId(item, "checkpoint"),
        ),
        blobCount: nonNegative(value["blobCount"]),
        chainHash: asSha256(value["chainHash"]),
        protocolClosed: literalTrue(value["protocolClosed"]),
        effectsSettled: literalTrue(value["effectsSettled"]),
        sourceEventIds: uniqueArray(value["sourceEventIds"], asEventId),
      };
    }
    case "cache_break": {
      const classification = enumValue(value["classification"], [
        "planned",
        "unplanned",
      ] as const);
      if (classification === "planned" && value["reason"] === "compaction") {
        exactKeys(value, [
          "classification",
          "fromLineageId",
          "toLineageId",
          "reason",
          "summaryArtifactId",
          "replacedPromptTokens",
        ]);
        const fromLineageId = asLineageId(value["fromLineageId"]);
        const toLineageId = asLineageId(value["toLineageId"]);
        if (fromLineageId === toLineageId) fail();
        return {
          classification: "planned" as const,
          fromLineageId,
          toLineageId,
          reason: "compaction" as const,
          summaryArtifactId: typedId(
            value["summaryArtifactId"],
            "artifact",
          ) as JournalPayloadByType["artifact_published"]["artifactId"],
          replacedPromptTokens: nonNegative(value["replacedPromptTokens"]),
        };
      }
      if (classification === "planned") {
        exactKeys(value, [
          "classification",
          "fromLineageId",
          "toLineageId",
          "reason",
          "authorizedRevision",
        ]);
        if (value["reason"] !== "abi_change") fail();
        const fromLineageId = asLineageId(value["fromLineageId"]);
        const toLineageId = asLineageId(value["toLineageId"]);
        if (fromLineageId === toLineageId) fail();
        return {
          classification,
          fromLineageId,
          toLineageId,
          reason: "abi_change",
          authorizedRevision: stringValue(value["authorizedRevision"], false),
        };
      }
      exactKeys(value, [
        "classification",
        "reason",
        "expectedHash",
        "actualHash",
        "diffArtifactId",
      ]);
      return {
        classification,
        reason: closedCode(value["reason"]),
        expectedHash: asSha256(value["expectedHash"]),
        actualHash: asSha256(value["actualHash"]),
        diffArtifactId: typedId(value["diffArtifactId"], "artifact"),
      };
    }
    case "verification_recorded": {
      exactKeys(value, [
        "sourceAssistantEventId",
        "verdict",
        "exitCode",
        "outputArtifactId",
        "baselineDigest",
        "changedProtectedPaths",
      ]);
      return {
        sourceAssistantEventId: asEventId(value["sourceAssistantEventId"]),
        verdict: enumValue(value["verdict"], [
          "passed",
          "failed",
          "tampered",
          "errored",
        ]),
        exitCode: nullable(value["exitCode"], nonNegative),
        outputArtifactId: typedId(value["outputArtifactId"], "artifact") as JournalPayloadByType["verification_recorded"]["outputArtifactId"],
        baselineDigest: opaqueId(value["baselineDigest"], /^sha256:[0-9a-f]{64}$/u),
        changedProtectedPaths: uniqueArray(value["changedProtectedPaths"], (entry) => stringValue(entry, false)),
      };
    }
    case "integrity_violation": {
      exactKeys(value, ["code", "relatedEventId", "expectedHash", "actualHash"]);
      return {
        code: enumValue(value["code"], [
          "journal_canonical",
          "journal_schema",
          "journal_sequence",
          "journal_hash",
          "reference_missing",
          "reference_mismatch",
          "cas_collision",
          "prefix_chain",
          "protocol_closure",
          "derived_conflict",
        ] as const),
        relatedEventId: nullable(value["relatedEventId"], asEventId),
        expectedHash: nullable(value["expectedHash"], asSha256),
        actualHash: nullable(value["actualHash"], asSha256),
      };
    }
    case "permission_decided": {
      exactKeys(value, [
        "toolCallId",
        "policyDecision",
        "finalDecision",
        "resolution",
      ]);
      return {
        toolCallId: toolCallId(value["toolCallId"]),
        policyDecision: enumValue(value["policyDecision"], [
          "allow",
          "ask",
          "deny",
        ] as const),
        finalDecision: enumValue(value["finalDecision"], ["allow", "deny"] as const),
        resolution: enumValue(value["resolution"], [
          "policy",
          "interactive",
          "yes_flag",
          "non_interactive",
        ] as const),
      };
    }
    case "effect_prepared": {
      exactKeys(value, ["effectId", "toolCallId", "toolName", "argumentsHash"]);
      return {
        effectId: typedId(value["effectId"], "effect"),
        toolCallId: toolCallId(value["toolCallId"]),
        toolName: enumValue(value["toolName"], ["write", "edit", "bash"] as const),
        argumentsHash: asSha256(value["argumentsHash"]),
      };
    }
    case "effect_completed": {
      exactKeys(value, [
        "effectId",
        "toolCallId",
        "artifactId",
        "terminal",
      ]);
      return {
        effectId: typedId(value["effectId"], "effect"),
        toolCallId: toolCallId(value["toolCallId"]),
        artifactId: typedId(value["artifactId"], "artifact"),
        terminal: terminal(
          value["terminal"],
          new Set(["succeeded", "failed"]),
        ),
      };
    }
    case "effect_indeterminate": {
      exactKeys(value, ["effectId", "reason"]);
      return {
        effectId: typedId(value["effectId"], "effect"),
        reason: enumValue(value["reason"], [
          "crash_gap",
          "process_state_unknown",
          "filesystem_state_unknown",
          "artifact_durability_failed",
        ] as const),
      };
    }
    case "effect_reconciled": {
      const resolution = enumValue(value["resolution"], [
        "completed",
        "proven_not_executed",
      ] as const);
      if (resolution === "completed") {
        exactKeys(value, [
          "effectId",
          "resolution",
          "evidenceArtifactId",
          "outputArtifactId",
          "terminal",
        ]);
        return {
          effectId: typedId(value["effectId"], "effect"),
          resolution,
          evidenceArtifactId: typedId(value["evidenceArtifactId"], "artifact"),
          outputArtifactId: typedId(value["outputArtifactId"], "artifact"),
          terminal: terminal(
            value["terminal"],
            new Set(["succeeded", "failed"]),
          ),
        };
      }
      exactKeys(value, ["effectId", "resolution", "evidenceArtifactId"]);
      return {
        effectId: typedId(value["effectId"], "effect"),
        resolution,
        evidenceArtifactId: typedId(value["evidenceArtifactId"], "artifact"),
      };
    }
    case "tool_result_committed": {
      const blob = blobPayload(
        value,
        "tool",
        ["toolCallId", "effectId", "artifactId", "sourceEventId"],
        ["searchUsage"],
      );
      return {
        ...blob,
        toolCallId: toolCallId(value["toolCallId"]),
        effectId: nullable(value["effectId"], (item) => typedId(item, "effect")),
        artifactId: nullable(value["artifactId"], (item) => typedId(item, "artifact")),
        sourceEventId: asEventId(value["sourceEventId"]),
        ...(Object.prototype.hasOwnProperty.call(value, "searchUsage")
          ? { searchUsage: searchUsage(value["searchUsage"]) }
          : {}),
      };
    }
    case "run_completed": {
      exactKeys(value, ["commitBoundaryId", "sourceAssistantEventId"]);
      return {
        commitBoundaryId: typedId(value["commitBoundaryId"], "boundary"),
        sourceAssistantEventId: asEventId(value["sourceAssistantEventId"]),
      };
    }
    case "run_interrupted": {
      exactKeys(value, ["reason", "sourceEventId"]);
      return {
        reason: enumValue(value["reason"], [
          "request_failed",
          "semantic_interrupted",
          "effect_indeterminate",
          "integrity_violation",
          "cancelled",
          "durability_failure",
        ] as const),
        sourceEventId: asEventId(value["sourceEventId"]),
      };
    }
    case "journal_tail_recovered": {
      exactKeys(value, [
        "recoveryRef",
        "recoveryHash",
        "recoveryByteCount",
        "validPrefixSeq",
        "validPrefixHash",
        "tailByteCount",
        "tailHash",
      ]);
      const recoveryHash = asSha256(value["recoveryHash"]);
      const recoveryRef = namespacedRef<RecoveryRef>(value["recoveryRef"], "recovery");
      refMatchesHash(recoveryRef, recoveryHash);
      return {
        recoveryRef,
        recoveryHash,
        recoveryByteCount: nonNegative(value["recoveryByteCount"]),
        validPrefixSeq: positive(value["validPrefixSeq"]),
        validPrefixHash: asSha256(value["validPrefixHash"]),
        tailByteCount: positive(value["tailByteCount"]),
        tailHash: asSha256(value["tailHash"]),
      };
    }
  }
}

function validateScope(
  type: JournalEventType,
  payload: unknown,
  lineageId: string | undefined,
  runId: string | undefined,
  parentId: string | undefined,
): void {
  if (type === "session_started" && parentId !== undefined) fail();
  const both = lineageId !== undefined && runId !== undefined;
  const neither = lineageId === undefined && runId === undefined;

  if (
    type === "session_started" ||
    type === "cache_abi_declared" ||
    type === "journal_tail_recovered"
  ) {
    if (!neither) fail();
    return;
  }
  if (type === "lineage_started" || type === "lineage_activated") {
    if (lineageId === undefined || runId !== undefined) fail();
    if (
      type === "lineage_activated" &&
      (payload as JournalPayloadByType["lineage_activated"]).nextLineageId !==
        lineageId
    ) {
      fail();
    }
    return;
  }
  if (!both && !neither) fail();
  if (
    type === "fact_recorded" ||
    type === "artifact_published" ||
    type === "artifact_version_created"
  ) {
    return;
  }
  if (type === "cache_break") {
    const classification = (payload as JournalPayloadByType["cache_break"])
      .classification;
    if (classification === "planned" ? !neither : !(neither || both)) fail();
    return;
  }
  // Recorded after its Run closed, so it carries no Run scope; it names the
  // assistant event it judged instead.
  if (type === "integrity_violation" || type === "verification_recorded") return;
  if (!both) fail();
}

function normalizeDraft(input: unknown): AnyJournalEventDraft {
  const value = record(input);
  exactKeys(
    value,
    ["type", "sessionId", "lineageId", "runId", "parentId", "payload"].filter(
      (key) => Object.prototype.hasOwnProperty.call(value, key),
    ),
  );
  const rawType = stringValue(value["type"]);
  if (!EVENT_TYPES.has(rawType as JournalEventType)) fail();
  const type = rawType as JournalEventType;
  const sessionId = asSessionId(value["sessionId"]);
  const lineageId = optionalScopeId(value, "lineageId") as LineageId | undefined;
  const runId = optionalScopeId(value, "runId") as RunId | undefined;
  const parentId = optionalScopeId(value, "parentId") as EventId | undefined;
  const payload = immutablePayload(normalizePayload(type, value["payload"]));
  validateScope(type, payload, lineageId, runId, parentId);
  return {
    type,
    sessionId,
    ...(lineageId === undefined ? {} : { lineageId }),
    ...(runId === undefined ? {} : { runId }),
    ...(parentId === undefined ? {} : { parentId }),
    payload,
  } as AnyJournalEventDraft;
}

function orderedPreimage(input: JournalEventPreimage): object {
  return {
    v: 1,
    seq: input.seq,
    id: input.id,
    type: input.type,
    sessionId: input.sessionId,
    ...(input.lineageId === undefined ? {} : { lineageId: input.lineageId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
    at: input.at,
    payload: input.payload,
    prevHash: input.prevHash,
  };
}

export function createVerifiedJournalEvent(
  draftInput: AnyJournalEventDraft,
  facts: {
    readonly seq: number;
    readonly id: EventId;
    readonly at: CanonicalTimestamp;
    readonly prevHash: Sha256 | null;
  },
): AnyVerifiedJournalEvent {
  const draft = normalizeDraft(draftInput);
  const seq = positive(facts.seq);
  const id = asEventId(facts.id);
  const at = asCanonicalTimestamp(facts.at);
  const prevHash = nullable(facts.prevHash, asSha256);
  if ((seq === 1) !== (prevHash === null)) fail();
  const preimage = {
    v: 1,
    seq,
    id,
    type: draft.type,
    sessionId: draft.sessionId,
    ...(draft.lineageId === undefined ? {} : { lineageId: draft.lineageId }),
    ...(draft.runId === undefined ? {} : { runId: draft.runId }),
    ...(draft.parentId === undefined ? {} : { parentId: draft.parentId }),
    at,
    payload: draft.payload,
    prevHash,
  } as JournalEventPreimage;
  const preimageBytes = utf8Bytes(JSON.stringify(orderedPreimage(preimage)));
  return Object.freeze({
    ...orderedPreimage(preimage),
    hash: `sha256:${sha256Hex(preimageBytes)}` as Sha256,
  }) as AnyVerifiedJournalEvent;
}

export function encodeJournalPreimage(event: JournalEventPreimage): FrozenBytes {
  const draft = normalizeDraft({
    type: event.type,
    sessionId: event.sessionId,
    ...(event.lineageId === undefined ? {} : { lineageId: event.lineageId }),
    ...(event.runId === undefined ? {} : { runId: event.runId }),
    ...(event.parentId === undefined ? {} : { parentId: event.parentId }),
    payload: event.payload,
  });
  const normalized = {
    v: event.v,
    seq: positive(event.seq),
    id: asEventId(event.id),
    type: draft.type,
    sessionId: draft.sessionId,
    ...(draft.lineageId === undefined ? {} : { lineageId: draft.lineageId }),
    ...(draft.runId === undefined ? {} : { runId: draft.runId }),
    ...(draft.parentId === undefined ? {} : { parentId: draft.parentId }),
    at: asCanonicalTimestamp(event.at),
    payload: draft.payload,
    prevHash: nullable(event.prevHash, asSha256),
  } as JournalEventPreimage;
  if (event.v !== 1 || (normalized.seq === 1) !== (normalized.prevHash === null)) fail();
  return utf8Bytes(JSON.stringify(orderedPreimage(normalized)));
}

export function encodeVerifiedJournalEvent(
  event: AnyVerifiedJournalEvent,
): FrozenBytes {
  const preimage = encodeJournalPreimage(event);
  const expectedHash = `sha256:${sha256Hex(preimage)}` as Sha256;
  if (asSha256(event.hash) !== expectedHash) {
    throw journalError("JOURNAL_HASH");
  }
  const preimageBytes = preimage.copy();
  if (preimageBytes.at(-1) !== 0x7d) {
    throw journalError("JOURNAL_CANONICAL");
  }
  return concatBytes([
    preimageBytes.subarray(0, preimageBytes.byteLength - 1),
    utf8Bytes(',"hash":'),
    utf8Bytes(JSON.stringify(expectedHash)),
    utf8Bytes("}"),
  ]);
}

export function decodeJournalRecord(rawLine: Uint8Array): AnyVerifiedJournalEvent {
  let text: string;
  try {
    text = utf8Decoder.decode(rawLine);
  } catch {
    throw journalError("JOURNAL_CANONICAL");
  }
  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(text);
  } catch {
    throw journalError("JOURNAL_CANONICAL");
  }
  const parsed = record(parsedUnknown);
  const optional = ["lineageId", "runId", "parentId"].filter((key) =>
    Object.prototype.hasOwnProperty.call(parsed, key),
  );
  exactKeys(parsed, [
    "v",
    "seq",
    "id",
    "type",
    "sessionId",
    ...optional,
    "at",
    "payload",
    "prevHash",
    "hash",
  ]);
  if (parsed["v"] !== 1) fail();
  const event = createVerifiedJournalEvent(
    {
      type: parsed["type"],
      sessionId: parsed["sessionId"],
      ...(Object.prototype.hasOwnProperty.call(parsed, "lineageId")
        ? { lineageId: parsed["lineageId"] }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(parsed, "runId")
        ? { runId: parsed["runId"] }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(parsed, "parentId")
        ? { parentId: parsed["parentId"] }
        : {}),
      payload: parsed["payload"],
    } as AnyJournalEventDraft,
    {
      seq: nonNegative(parsed["seq"]),
      id: asEventId(parsed["id"]),
      at: asCanonicalTimestamp(parsed["at"]),
      prevHash: nullable(parsed["prevHash"], asSha256),
    },
  );
  if (asSha256(parsed["hash"]) !== event.hash) {
    throw journalError("JOURNAL_HASH");
  }
  const encoded = encodeVerifiedJournalEvent(event);
  if (!bytesEqual(encoded, rawLine)) {
    throw journalError("JOURNAL_CANONICAL");
  }
  return event;
}

export function isJournalEventType(value: string): value is JournalEventType {
  return EVENT_TYPES.has(value as JournalEventType);
}

export const JOURNAL_EVENT_TYPES: readonly JournalEventType[] = Object.freeze(
  [...EVENT_TYPES],
);
