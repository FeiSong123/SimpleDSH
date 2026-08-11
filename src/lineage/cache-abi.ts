import {
  bytesEqual,
  concatBytes,
  lengthPrefix,
  sha256Hex,
  utf8Bytes,
} from "../bytes/ops.js";
import {
  assertReasoningEffort,
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from "../bytes/request.js";
import {
  CANONICAL_TOOLS_BYTES,
  PREVIOUS_CANONICAL_TOOLS_BYTES,
  toolSchemaProfileForBytes,
} from "../bytes/schemas.js";
import {
  BASE_SYSTEM_PROMPT,
  LEGACY_BASE_SYSTEM_PROMPT,
  PREVIOUS_BASE_SYSTEM_PROMPT,
  PRIOR_BASE_SYSTEM_PROMPT,
  RESOLVE_BASE_SYSTEM_PROMPT,
  materializeLegacySystemMessage,
  materializePreviousSystemMessage,
  materializePriorSystemMessage,
  materializeResolveSystemMessage,
  materializeSystemMessage,
} from "../bytes/system.js";
import { freezeBytes, FrozenBytes } from "../bytes/types.js";
import type { ToolResultProfile } from "../bytes/tool-result.js";
import { viewSystem } from "../bytes/view.js";
import type { CacheAbiId, Sha256 } from "../journal/types.js";

export const PROTOCOL_VERSION_V1 = "dsh-protocol-v1" as const;
export const PROTOCOL_VERSION_V2 = "dsh-protocol-v2" as const;
export const PROJECTOR_VERSION_V1 = "dsh-projector-v1" as const;

export type ProtocolVersion =
  | typeof PROTOCOL_VERSION_V1
  | typeof PROTOCOL_VERSION_V2;

/**
 * One frozen tuple per admitted effort. The effort is part of the Cache ABI,
 * so `low`, `high` and `max` are three distinct ABIs and never share a prefix.
 */
const MODEL_TUPLE_BY_EFFORT: Readonly<Record<ReasoningEffort, FrozenBytes>> =
  Object.freeze(
    Object.fromEntries(
      REASONING_EFFORTS.map((effort) => [
        effort,
        utf8Bytes(
          '{"model":"deepseek-v4-flash","thinking":{"type":"enabled"},"reasoning_effort":"' +
            effort +
            '"}',
        ),
      ]),
    ) as Record<ReasoningEffort, FrozenBytes>,
  );

export function modelTupleBytesFor(effort: ReasoningEffort): FrozenBytes {
  const bytes = MODEL_TUPLE_BY_EFFORT[assertReasoningEffort(effort)];
  if (bytes === undefined) throw new TypeError("unknown reasoning effort");
  return bytes;
}

/** The default (`max`) tuple, kept as a named export for existing callers. */
export const MODEL_TUPLE_BYTES = modelTupleBytesFor(DEFAULT_REASONING_EFFORT);

/** Recover the effort a durable manifest was built with. */
export function reasoningEffortFromTuple(
  tupleBytes: FrozenBytes,
): ReasoningEffort | null {
  for (const effort of REASONING_EFFORTS) {
    const candidate = MODEL_TUPLE_BY_EFFORT[effort];
    if (candidate !== undefined && bytesEqual(tupleBytes, candidate)) {
      return effort;
    }
  }
  return null;
}

const MANIFEST_DOMAIN_BYTES = utf8Bytes("dsh-cache-abi-v1\0");
const PROTOCOL_VERSION_V1_BYTES = utf8Bytes(PROTOCOL_VERSION_V1);
const PROTOCOL_VERSION_V2_BYTES = utf8Bytes(PROTOCOL_VERSION_V2);
const PROJECTOR_VERSION_BYTES = utf8Bytes(PROJECTOR_VERSION_V1);

export interface FrozenCacheAbiManifest {
  readonly manifestBytes: FrozenBytes;
  readonly cacheAbiId: CacheAbiId;
  readonly protocolVersion: ProtocolVersion;
  readonly projectorVersion: typeof PROJECTOR_VERSION_V1;
  readonly modelTupleBytes: FrozenBytes;
  readonly systemBlob: FrozenBytes;
  readonly toolsBlob: FrozenBytes;
  readonly headerHash: Sha256;
}

const CACHE_ABI_KEYS = Object.freeze([
  "manifestBytes",
  "cacheAbiId",
  "protocolVersion",
  "projectorVersion",
  "modelTupleBytes",
  "systemBlob",
  "toolsBlob",
  "headerHash",
] as const);

interface ParsedManifestFields {
  readonly protocolVersionBytes: FrozenBytes;
  readonly projectorVersionBytes: FrozenBytes;
  readonly modelTupleBytes: FrozenBytes;
  readonly systemBlob: FrozenBytes;
  readonly toolsBlob: FrozenBytes;
}

function cacheAbiId(bytes: FrozenBytes): CacheAbiId {
  return `sha256:${sha256Hex(bytes)}` as CacheAbiId;
}

function sha256(bytes: FrozenBytes): Sha256 {
  return `sha256:${sha256Hex(bytes)}` as Sha256;
}

function copyFrozen(bytes: FrozenBytes): FrozenBytes {
  return freezeBytes(bytes.copy());
}

function freezeManifest(
  manifestBytes: FrozenBytes,
  fields: Pick<
    ParsedManifestFields,
    "modelTupleBytes" | "systemBlob" | "toolsBlob"
  >,
  protocolVersion: ProtocolVersion,
): FrozenCacheAbiManifest {
  const headerBytes = concatBytes([
    lengthPrefix(fields.systemBlob),
    lengthPrefix(fields.toolsBlob),
  ]);

  return Object.freeze({
    manifestBytes: copyFrozen(manifestBytes),
    cacheAbiId: cacheAbiId(manifestBytes),
    protocolVersion,
    projectorVersion: PROJECTOR_VERSION_V1,
    modelTupleBytes: copyFrozen(fields.modelTupleBytes),
    systemBlob: copyFrozen(fields.systemBlob),
    toolsBlob: copyFrozen(fields.toolsBlob),
    headerHash: sha256(headerBytes),
  });
}

function manifestBytesFor(
  protocolVersionBytes: FrozenBytes,
  systemBlob: FrozenBytes,
  toolsBlob: FrozenBytes,
  effort: ReasoningEffort = DEFAULT_REASONING_EFFORT,
): FrozenBytes {
  return concatBytes([
    MANIFEST_DOMAIN_BYTES,
    lengthPrefix(protocolVersionBytes),
    lengthPrefix(PROJECTOR_VERSION_BYTES),
    lengthPrefix(modelTupleBytesFor(effort)),
    lengthPrefix(systemBlob),
    lengthPrefix(toolsBlob),
  ]);
}

function canonicalSystemBlobFor(
  systemBlob: FrozenBytes,
  content: string,
  basePrompt: string,
  materialize: (projectInstructions?: FrozenBytes) => FrozenBytes,
): boolean {
  const marker = `${basePrompt}\n\nProject instructions:\n`;
  let projectInstructions: FrozenBytes | undefined;
  if (content !== basePrompt) {
    if (!content.startsWith(marker)) return false;
    const instructions = content.slice(marker.length);
    if (instructions.length === 0) return false;
    projectInstructions = utf8Bytes(instructions);
  }
  return bytesEqual(systemBlob, materialize(projectInstructions));
}

type SystemPromptProfile =
  | "current"
  | "resolve"
  | "previous"
  | "prior"
  | "legacy";

function canonicalSystemProfile(
  systemBlob: FrozenBytes,
): SystemPromptProfile {
  let content: string;
  try {
    content = viewSystem(systemBlob).content;
  } catch {
    throw new TypeError("Cache ABI system blob does not round-trip canonically");
  }

  if (
    canonicalSystemBlobFor(
      systemBlob,
      content,
      BASE_SYSTEM_PROMPT,
      materializeSystemMessage,
    )
  ) return "current";
  if (
    canonicalSystemBlobFor(
      systemBlob,
      content,
      RESOLVE_BASE_SYSTEM_PROMPT,
      materializeResolveSystemMessage,
    )
  ) return "resolve";
  if (
    canonicalSystemBlobFor(
      systemBlob,
      content,
      PREVIOUS_BASE_SYSTEM_PROMPT,
      materializePreviousSystemMessage,
    )
  ) return "previous";
  if (
    canonicalSystemBlobFor(
      systemBlob,
      content,
      PRIOR_BASE_SYSTEM_PROMPT,
      materializePriorSystemMessage,
    )
  ) return "prior";
  if (
    canonicalSystemBlobFor(
      systemBlob,
      content,
      LEGACY_BASE_SYSTEM_PROMPT,
      materializeLegacySystemMessage,
    )
  ) return "legacy";
  throw new TypeError("Cache ABI system blob does not round-trip canonically");
}

function parseManifest(bytes: FrozenBytes): ParsedManifestFields {
  const source = bytes.copy();
  const domain = MANIFEST_DOMAIN_BYTES.copy();
  if (
    source.byteLength < domain.byteLength ||
    !Uint8Array.prototype.every.call(
      domain,
      (value: number, index: number) => source[index] === value,
    )
  ) {
    throw new TypeError("Cache ABI manifest has the wrong domain");
  }

  let offset = domain.byteLength;
  const readFrame = (label: string): FrozenBytes => {
    if (source.byteLength - offset < 8) {
      throw new TypeError(`Cache ABI ${label} length prefix is truncated`);
    }
    const length = new DataView(
      source.buffer,
      source.byteOffset + offset,
      8,
    ).getBigUint64(0, false);
    offset += 8;
    if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new TypeError(`Cache ABI ${label} length is unsafe`);
    }
    const byteLength = Number(length);
    if (byteLength > source.byteLength - offset) {
      throw new TypeError(`Cache ABI ${label} payload is truncated`);
    }
    const value = freezeBytes(source.slice(offset, offset + byteLength));
    offset += byteLength;
    return value;
  };

  const fields: ParsedManifestFields = {
    protocolVersionBytes: readFrame("protocol version"),
    projectorVersionBytes: readFrame("projector version"),
    modelTupleBytes: readFrame("model tuple"),
    systemBlob: readFrame("system blob"),
    toolsBlob: readFrame("tools blob"),
  };
  if (offset !== source.byteLength) {
    throw new TypeError("Cache ABI manifest has trailing bytes");
  }
  return fields;
}

export function buildCacheAbiV1(
  projectInstructions?: FrozenBytes,
): FrozenCacheAbiManifest {
  const systemBlob = materializePreviousSystemMessage(projectInstructions);
  // v1 is the historical builder: it must keep producing the previous edit-v5
  // tools ABI so its byte-identical manifest and id stay loadable forever.
  const toolsBlob = copyFrozen(PREVIOUS_CANONICAL_TOOLS_BYTES);
  const manifestBytes = manifestBytesFor(
    PROTOCOL_VERSION_V1_BYTES,
    systemBlob,
    toolsBlob,
  );
  return freezeManifest(manifestBytes, {
    modelTupleBytes: MODEL_TUPLE_BYTES,
    systemBlob,
    toolsBlob,
  }, PROTOCOL_VERSION_V1);
}

export function buildCacheAbiV2(
  projectInstructions?: FrozenBytes,
  effort: ReasoningEffort = DEFAULT_REASONING_EFFORT,
): FrozenCacheAbiManifest {
  const systemBlob = materializeSystemMessage(projectInstructions);
  const toolsBlob = copyFrozen(CANONICAL_TOOLS_BYTES);
  const manifestBytes = manifestBytesFor(
    PROTOCOL_VERSION_V2_BYTES,
    systemBlob,
    toolsBlob,
    effort,
  );
  return freezeManifest(manifestBytes, {
    modelTupleBytes: modelTupleBytesFor(effort),
    systemBlob,
    toolsBlob,
  }, PROTOCOL_VERSION_V2);
}

function loadCacheAbiForProtocol(
  bytes: FrozenBytes,
  expectedCacheAbiId: CacheAbiId,
  expectedProtocol?: ProtocolVersion,
): FrozenCacheAbiManifest {
  const fields = parseManifest(bytes);

  let protocolVersion: ProtocolVersion;
  if (bytesEqual(fields.protocolVersionBytes, PROTOCOL_VERSION_V1_BYTES)) {
    protocolVersion = PROTOCOL_VERSION_V1;
  } else if (bytesEqual(fields.protocolVersionBytes, PROTOCOL_VERSION_V2_BYTES)) {
    protocolVersion = PROTOCOL_VERSION_V2;
  } else {
    throw new TypeError("Cache ABI protocol version is not admitted");
  }
  if (expectedProtocol !== undefined && protocolVersion !== expectedProtocol) {
    throw new TypeError(
      `Cache ABI protocol version is not canonical ${expectedProtocol === PROTOCOL_VERSION_V1 ? "v1" : "v2"}`,
    );
  }
  if (!bytesEqual(fields.projectorVersionBytes, PROJECTOR_VERSION_BYTES)) {
    throw new TypeError("Cache ABI projector version is not canonical");
  }
  if (reasoningEffortFromTuple(fields.modelTupleBytes) === null) {
    throw new TypeError("Cache ABI model tuple is not canonical");
  }
  const systemProfile = canonicalSystemProfile(fields.systemBlob);
  const toolsProfile = toolSchemaProfileForBytes(fields.toolsBlob);
  const admitted =
    (protocolVersion === PROTOCOL_VERSION_V2 &&
      (toolsProfile === "search-v1" || toolsProfile === "edit-v5") &&
      (systemProfile === "current" ||
        systemProfile === "resolve" ||
        systemProfile === "previous")) ||
    (protocolVersion === PROTOCOL_VERSION_V1 &&
      (toolsProfile === "search-v1" || toolsProfile === "edit-v5") &&
      systemProfile === "previous") ||
    (protocolVersion === PROTOCOL_VERSION_V1 &&
      toolsProfile === "edit-v4" &&
      (systemProfile === "previous" ||
        systemProfile === "prior" ||
        systemProfile === "legacy"));
  if (!admitted) {
    throw new TypeError("Cache ABI system/tools pairing is not admitted");
  }

  const actualCacheAbiId = cacheAbiId(bytes);
  if (actualCacheAbiId !== expectedCacheAbiId) {
    throw new TypeError("Cache ABI manifest hash does not match its identity");
  }

  return freezeManifest(bytes, fields, protocolVersion);
}

export function loadCacheAbiV1(
  bytes: FrozenBytes,
  expectedCacheAbiId: CacheAbiId,
): FrozenCacheAbiManifest {
  return loadCacheAbiForProtocol(
    bytes,
    expectedCacheAbiId,
    PROTOCOL_VERSION_V1,
  );
}

export function loadCacheAbi(
  bytes: FrozenBytes,
  expectedCacheAbiId: CacheAbiId,
): FrozenCacheAbiManifest {
  return loadCacheAbiForProtocol(bytes, expectedCacheAbiId);
}

export function toolResultProfileForCacheAbi(
  cacheAbi: Pick<FrozenCacheAbiManifest, "protocolVersion">,
): ToolResultProfile {
  return cacheAbi.protocolVersion === PROTOCOL_VERSION_V2
    ? "compact-v2"
    : "verbose-v1";
}

function sameBytes(left: unknown, right: FrozenBytes): boolean {
  return left instanceof FrozenBytes && bytesEqual(left, right);
}

function loadAndAssertCacheAbiWith(
  candidate: FrozenCacheAbiManifest,
  loader: (
    bytes: FrozenBytes,
    expectedCacheAbiId: CacheAbiId,
  ) => FrozenCacheAbiManifest,
): FrozenCacheAbiManifest {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Reflect.ownKeys(candidate).length !== CACHE_ABI_KEYS.length ||
    !CACHE_ABI_KEYS.every((key) =>
      Object.prototype.hasOwnProperty.call(candidate, key),
    ) ||
    !(candidate.manifestBytes instanceof FrozenBytes) ||
    typeof candidate.cacheAbiId !== "string"
  ) {
    throw new TypeError("Cache ABI object does not match its manifest");
  }

  const loaded = loader(
    candidate.manifestBytes,
    candidate.cacheAbiId,
  );
  if (
    !sameBytes(candidate.manifestBytes, loaded.manifestBytes) ||
    candidate.cacheAbiId !== loaded.cacheAbiId ||
    candidate.protocolVersion !== loaded.protocolVersion ||
    candidate.projectorVersion !== loaded.projectorVersion ||
    !sameBytes(candidate.modelTupleBytes, loaded.modelTupleBytes) ||
    !sameBytes(candidate.systemBlob, loaded.systemBlob) ||
    !sameBytes(candidate.toolsBlob, loaded.toolsBlob) ||
    candidate.headerHash !== loaded.headerHash
  ) {
    throw new TypeError("Cache ABI object does not match its manifest");
  }
  return loaded;
}

export function loadAndAssertCacheAbiV1(
  candidate: FrozenCacheAbiManifest,
): FrozenCacheAbiManifest {
  return loadAndAssertCacheAbiWith(candidate, loadCacheAbiV1);
}

export function loadAndAssertCacheAbi(
  candidate: FrozenCacheAbiManifest,
): FrozenCacheAbiManifest {
  return loadAndAssertCacheAbiWith(candidate, loadCacheAbi);
}
