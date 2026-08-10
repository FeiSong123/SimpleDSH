import { freezeBytes, FrozenBytes } from "../bytes/types.js";
import { asToolCallId } from "../bytes/tool-call-id.js";
import type { PersistenceTestControls } from "../journal/faults.js";
import { ArtifactStoreError } from "./errors.js";
import {
  createArtifactCas,
  openArtifactCasReadOnly,
} from "./internal-cas.js";
import type { CasCandidate, FixedCas } from "./internal-cas.js";
import type {
  ArtifactDescriptor,
  ArtifactChunkVisitor,
  ArtifactMetadata,
  ArtifactRange,
  ArtifactRangeOptions,
  ArtifactRef,
  ArtifactSink,
  ArtifactStore,
  ArtifactStreamBytes,
} from "./types.js";
import { normalizeToolTerminal } from "./terminal.js";
import {
  createToolOutputFrameParser,
  RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES,
  TOOL_OUTPUT_MEDIA_TYPE,
} from "./tool-output.js";
import type { ToolOutputFrameSummary } from "./tool-output.js";

const artifactRangeLimit = 32_768;
const artifactTypes = new Set([
  "cache_abi_manifest",
  "project_instructions",
  "fact",
  "tool_output",
  "operator_evidence",
  "user_state",
]);

function metadataError(message: string): ArtifactStoreError {
  return new ArtifactStoreError("artifact_closed_metadata", message);
}

function assertClosedRecord(
  value: object,
  expectedKeys: readonly string[],
  label: string,
): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw metadataError(`${label} must be a plain closed record`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw metadataError(`${label} fields are not closed`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = (ownKeys as string[]).sort();
  const canonicalKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== canonicalKeys.length ||
    actualKeys.some((key, index) => key !== canonicalKeys[index])
  ) {
    throw metadataError(`${label} fields are not closed`);
  }
  for (const key of actualKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      throw metadataError(`${label} fields must be data properties`);
    }
  }
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw metadataError(`${label} must be a non-negative safe integer`);
  }
}

function validateStreamBytes(
  value: ArtifactStreamBytes,
): ArtifactStreamBytes {
  assertClosedRecord(value, ["read", "stdout", "stderr"], "streamBytes");
  assertNonNegativeSafeInteger(value.read, "streamBytes.read");
  assertNonNegativeSafeInteger(value.stdout, "streamBytes.stdout");
  assertNonNegativeSafeInteger(value.stderr, "streamBytes.stderr");
  const total = value.read + value.stdout + value.stderr;
  if (!Number.isSafeInteger(total)) {
    throw metadataError("streamBytes sum exceeds the safe integer range");
  }
  return Object.freeze({
    read: value.read,
    stdout: value.stdout,
    stderr: value.stderr,
  });
}

function validateMetadata(
  value: ArtifactMetadata,
  byteCount: number,
  computedLineCount: number,
  frameSummary: ToolOutputFrameSummary | null,
): ArtifactMetadata {
  if (typeof value !== "object" || value === null) {
    throw metadataError("Artifact metadata must be a closed record");
  }
  assertClosedRecord(
    value,
    [
      "lineCount",
      "mediaType",
      "artifactType",
      "streamBytes",
      "hardLimitReached",
      "descendantsReaped",
      "toolCallId",
      "terminal",
    ],
    "Artifact metadata",
  );

  if (
    typeof value.mediaType !== "string" ||
    value.mediaType.length === 0 ||
    Buffer.byteLength(value.mediaType, "utf8") > 127 ||
    !/^[\x20-\x7e]+$/u.test(value.mediaType)
  ) {
    throw metadataError("mediaType must be 1..127 bytes of printable ASCII");
  }
  if (!artifactTypes.has(value.artifactType)) {
    throw metadataError("artifactType is not recognized");
  }
  if (value.lineCount !== null) {
    assertNonNegativeSafeInteger(value.lineCount, "lineCount");
    if (value.lineCount !== computedLineCount) {
      throw metadataError("lineCount does not match the raw Artifact bytes");
    }
  }

  let streamBytes: ArtifactStreamBytes | null = null;
  let hardLimitReached: boolean | null = null;
  let descendantsReaped: boolean | null = null;
  let toolCallId = null;
  let terminal = null;
  if (value.artifactType === "tool_output") {
    if (
      value.mediaType !== TOOL_OUTPUT_MEDIA_TYPE ||
      value.lineCount !== null ||
      value.streamBytes === null ||
      typeof value.hardLimitReached !== "boolean" ||
      (value.descendantsReaped !== null &&
        typeof value.descendantsReaped !== "boolean") ||
      value.toolCallId === null ||
      frameSummary === null
    ) {
      throw metadataError("tool_output Artifact metadata is incomplete");
    }
    streamBytes = validateStreamBytes(value.streamBytes);
    hardLimitReached = value.hardLimitReached;
    descendantsReaped = value.descendantsReaped;
    try {
      toolCallId = asToolCallId(value.toolCallId);
      terminal = value.terminal === null
        ? null
        : normalizeToolTerminal(value.terminal);
    } catch {
      throw metadataError("tool_output Artifact identity or terminal is invalid");
    }
    if (
      frameSummary.byteCount !== byteCount ||
      frameSummary.payloadBytes.read !== streamBytes.read ||
      frameSummary.payloadBytes.stdout !== streamBytes.stdout ||
      frameSummary.payloadBytes.stderr !== streamBytes.stderr ||
      frameSummary.hardLimitReached !== hardLimitReached
    ) {
      throw metadataError("tool_output framing does not match metadata");
    }
    const payloadByteCount =
      streamBytes.read + streamBytes.stdout + streamBytes.stderr;
    if (
      payloadByteCount > RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES ||
      hardLimitReached !==
        (payloadByteCount === RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES)
    ) {
      throw metadataError("tool_output hard-limit boundary is invalid");
    }
    if (terminal !== null && descendantsReaped !== null) {
      throw metadataError("pre-effect Artifact terminal cannot carry cleanup state");
    }
  } else if (
    value.streamBytes !== null ||
    value.hardLimitReached !== null ||
    value.descendantsReaped !== null ||
    value.toolCallId !== null ||
    value.terminal !== null ||
    frameSummary !== null
  ) {
    throw metadataError("non-tool Artifact has tool-only metadata");
  }

  return Object.freeze({
    lineCount: value.lineCount,
    mediaType: value.mediaType,
    artifactType: value.artifactType,
    streamBytes,
    hardLimitReached,
    descendantsReaped,
    toolCallId,
    terminal,
  });
}

function validateRangeOptions(options: ArtifactRangeOptions): void {
  if (typeof options !== "object" || options === null) {
    throw new ArtifactStoreError(
      "artifact_range",
      "Artifact range options must be a closed record",
    );
  }
  try {
    assertClosedRecord(options, ["offset", "maxBytes"], "Artifact range options");
  } catch {
    throw new ArtifactStoreError(
      "artifact_range",
      "Artifact range options must contain only offset and maxBytes",
    );
  }
  if (
    !Number.isSafeInteger(options.offset) ||
    options.offset < 0 ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    options.maxBytes > artifactRangeLimit
  ) {
    throw new ArtifactStoreError(
      "artifact_range",
      "Artifact range requires a non-negative offset and maxBytes in 1..32768",
    );
  }
}

class ArtifactSinkImplementation implements ArtifactSink {
  readonly #candidate: CasCandidate<ArtifactRef>;
  #byteCount = 0;
  #lfCount = 0;
  #lastByte: number | undefined;
  #state: "open" | "finalizing" | "published" | "aborted" = "open";
  #writeQueue: Promise<void> = Promise.resolve();
  #writeFailure: unknown;
  readonly #toolOutputParser = createToolOutputFrameParser();
  #toolOutputFailure: unknown;
  #toolOutputSummary: ToolOutputFrameSummary | undefined;

  constructor(candidate: CasCandidate<ArtifactRef>) {
    this.#candidate = candidate;
  }

  write(bytes: Uint8Array | FrozenBytes): Promise<void> {
    if (this.#state !== "open") {
      throw new ArtifactStoreError("artifact_state", "Artifact sink is closed");
    }
    const copy = bytes instanceof FrozenBytes
      ? bytes.copy()
      : bytes instanceof Uint8Array
        ? Uint8Array.from(bytes)
        : undefined;
    if (copy === undefined) {
      throw new TypeError("Artifact sink accepts only explicit bytes");
    }
    const task = this.#writeQueue.then(async () => {
      if (this.#writeFailure !== undefined) throw this.#writeFailure;
      if (this.#toolOutputFailure === undefined) {
        try {
          this.#toolOutputParser.push(copy);
        } catch (error) {
          this.#toolOutputFailure = error;
        }
      }
      await this.#candidate.write(copy);
      this.#byteCount += copy.byteLength;
      if (!Number.isSafeInteger(this.#byteCount)) {
        throw new ArtifactStoreError(
          "artifact_integrity",
          "Artifact byte count exceeds the safe integer range",
        );
      }
      for (const byte of copy) {
        if (byte === 0x0a) this.#lfCount += 1;
        this.#lastByte = byte;
      }
    });
    this.#writeQueue = task.then(
      () => undefined,
      (error: unknown) => {
        this.#writeFailure = error;
      },
    );
    return task;
  }

  async publish(metadata: ArtifactMetadata): Promise<ArtifactDescriptor> {
    if (this.#state !== "open") {
      throw new ArtifactStoreError("artifact_state", "Artifact sink is closed");
    }
    this.#state = "finalizing";
    await this.#writeQueue;
    if (this.#writeFailure !== undefined) {
      await this.#candidate.abort().catch(() => undefined);
      this.#state = "aborted";
      throw this.#writeFailure;
    }
    const computedLineCount =
      this.#byteCount === 0
        ? 0
        : this.#lfCount + (this.#lastByte === 0x0a ? 0 : 1);
    if (
      this.#toolOutputSummary === undefined &&
      this.#toolOutputFailure === undefined
    ) {
      try {
        this.#toolOutputSummary = this.#toolOutputParser.finish();
      } catch (error) {
        this.#toolOutputFailure = error;
      }
    }
    let checked: ArtifactMetadata;
    try {
      if (metadata.artifactType === "tool_output" && this.#toolOutputFailure !== undefined) {
        throw metadataError("tool_output framing is malformed");
      }
      checked = validateMetadata(
        metadata,
        this.#byteCount,
        computedLineCount,
        metadata.artifactType === "tool_output"
          ? (this.#toolOutputSummary ?? null)
          : null,
      );
    } catch (error) {
      this.#state = "open";
      throw error;
    }
    let publication;
    try {
      publication = await this.#candidate.publish();
    } catch (error) {
      this.#state = "aborted";
      throw error;
    }
    if (publication.byteCount !== this.#byteCount) {
      throw new ArtifactStoreError(
        "artifact_integrity",
        "Artifact byte count changed during publication",
      );
    }
    this.#state = "published";
    return Object.freeze({
      artifactRef: publication.ref,
      artifactHash: publication.hash,
      byteCount: publication.byteCount,
      lineCount: checked.lineCount,
      mediaType: checked.mediaType,
      artifactType: checked.artifactType,
      streamBytes: checked.streamBytes,
      hardLimitReached: checked.hardLimitReached,
      descendantsReaped: checked.descendantsReaped,
      toolCallId: checked.toolCallId,
      terminal: checked.terminal,
    });
  }

  async abort(): Promise<void> {
    if (this.#state === "published" || this.#state === "finalizing") {
      throw new ArtifactStoreError(
        "artifact_state",
        "Published Artifact cannot be aborted",
      );
    }
    if (this.#state === "aborted") return;
    this.#state = "aborted";
    await this.#writeQueue;
    await this.#candidate.abort();
  }
}

class ArtifactStoreImplementation implements ArtifactStore {
  readonly #cas: FixedCas<ArtifactRef>;

  constructor(cas: FixedCas<ArtifactRef>) {
    this.#cas = cas;
  }

  async beginArtifact(): Promise<ArtifactSink> {
    return new ArtifactSinkImplementation(await this.#cas.begin());
  }

  async publishArtifact(
    bytes: Uint8Array | FrozenBytes,
    metadata: ArtifactMetadata,
  ): Promise<ArtifactDescriptor> {
    const sink = await this.beginArtifact();
    try {
      await sink.write(bytes);
      return await sink.publish(metadata);
    } catch (error) {
      await sink.abort().catch(() => undefined);
      throw error;
    }
  }

  async readArtifactRange(
    ref: ArtifactRef,
    options: ArtifactRangeOptions,
  ): Promise<ArtifactRange> {
    validateRangeOptions(options);
    const range = await this.#cas.readVerifiedRange(ref, options);
    return Object.freeze({
      bytes: freezeBytes(range.bytes.copy()),
      offset: range.offset,
      byteCount: range.byteCount,
      totalByteCount: range.totalByteCount,
      eof: range.eof,
    });
  }

  async #scanArtifact(
    descriptor: ArtifactDescriptor,
    visit?: ArtifactChunkVisitor,
  ): Promise<void> {
    if (typeof descriptor !== "object" || descriptor === null) {
      throw metadataError("Artifact descriptor must be a closed record");
    }
    assertClosedRecord(
      descriptor,
      [
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
      ],
      "Artifact descriptor",
    );
    assertNonNegativeSafeInteger(descriptor.byteCount, "byteCount");
    const parser = descriptor.artifactType === "tool_output"
      ? createToolOutputFrameParser()
      : undefined;
    let offset = 0;
    const verified = await this.#cas.scanVerifiedObject(
      descriptor.artifactRef,
      {
        hash: descriptor.artifactHash,
        byteCount: descriptor.byteCount,
      },
      async (chunk) => {
        offset += chunk.byteLength;
        if (parser !== undefined) {
          try {
            parser.push(chunk);
          } catch {
            throw new ArtifactStoreError(
              "artifact_integrity",
              "tool_output Artifact framing is malformed",
            );
          }
        }
        await visit?.(freezeBytes(chunk));
      },
    );
    if (offset !== verified.byteCount) {
      throw new ArtifactStoreError(
        "artifact_integrity",
        "Artifact verified scan made incomplete progress",
      );
    }
    let frameSummary: ToolOutputFrameSummary | null = null;
    if (parser !== undefined) {
      try {
        frameSummary = parser.finish();
      } catch {
        throw new ArtifactStoreError(
          "artifact_integrity",
          "tool_output Artifact framing is malformed",
        );
      }
    }
    validateMetadata(
      {
        lineCount: descriptor.lineCount,
        mediaType: descriptor.mediaType,
        artifactType: descriptor.artifactType,
        streamBytes: descriptor.streamBytes,
        hardLimitReached: descriptor.hardLimitReached,
        descendantsReaped: descriptor.descendantsReaped,
        toolCallId: descriptor.toolCallId,
        terminal: descriptor.terminal,
      },
      verified.byteCount,
      verified.lineCount,
      frameSummary,
    );
  }

  async scanArtifact(
    descriptor: ArtifactDescriptor,
    visit: ArtifactChunkVisitor,
  ): Promise<void> {
    if (typeof visit !== "function") {
      throw new TypeError("Artifact scan requires a chunk visitor");
    }
    await this.#scanArtifact(descriptor, visit);
  }

  async verifyArtifact(descriptor: ArtifactDescriptor): Promise<void> {
    await this.#scanArtifact(descriptor);
  }
}

export async function createArtifactStore(
  sessionDir: string,
  controls?: PersistenceTestControls,
): Promise<ArtifactStore> {
  return new ArtifactStoreImplementation(
    await createArtifactCas(sessionDir, controls),
  );
}

export async function openArtifactStoreReadOnly(
  sessionDir: string,
): Promise<ArtifactStore> {
  return new ArtifactStoreImplementation(
    await openArtifactCasReadOnly(sessionDir),
  );
}

export { artifactRangeLimit };
