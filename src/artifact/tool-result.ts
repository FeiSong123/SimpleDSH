import {
  createToolOutputFrameParser,
  RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES,
} from "./tool-output.js";
import type { ToolTerminal } from "./terminal.js";
import {
  validateToolTerminalForSource,
  type ToolTerminalSource,
} from "./tool-terminal-source.js";
import {
  materializeCompactToolResultContent,
  materializeCompactToolResultMessage,
  materializeToolResultContent,
  materializeToolResultMessage,
  TOOL_RESULT_PROJECTION_LIMIT_BYTES,
} from "../bytes/tool-result.js";
import type {
  ArtifactToolResultContent,
  CompactArtifactToolResultContent,
  ToolResultProfile,
  ToolResultPayloadBytes,
} from "../bytes/tool-result.js";
import type { FrozenBytes } from "../bytes/types.js";
import type { ToolName } from "../bytes/tool-arguments.js";
import type { ToolSchemaProfile } from "../bytes/schemas.js";

export interface ToolResultArtifactIdentity {
  readonly artifactId: string;
  readonly artifactRef: string;
  readonly artifactSha256: string;
  readonly byteCount: number;
  readonly payloadBytes: ToolResultPayloadBytes;
  readonly hardLimitReached: boolean;
}

export interface ProjectArtifactToolResultInput {
  readonly toolCallId: string;
  readonly toolName: ToolName;
  readonly toolsProfile: ToolSchemaProfile;
  readonly resultProfile: ToolResultProfile;
  readonly terminalSource: ToolTerminalSource;
  readonly readOffset?: number;
  readonly artifact: ToolResultArtifactIdentity;
  readonly terminal: ToolTerminal;
  readonly framedBytes: FrozenBytes;
}

export type StreamArtifactToolResultInput = Omit<
  ProjectArtifactToolResultInput,
  "framedBytes"
>;

export interface ProjectedArtifactToolResult {
  readonly content:
    | ArtifactToolResultContent
    | CompactArtifactToolResultContent;
  readonly contentText: string;
  readonly messageBytes: FrozenBytes;
}

export class ToolResultProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolResultProjectionError";
  }
}

function projectionFailure(message: string): never {
  throw new ToolResultProjectionError(message);
}

function contentCandidate(
  base: Omit<ArtifactToolResultContent, "head" | "tail" | "truncated">,
  head: string,
  tail: string,
  truncated: boolean,
): ArtifactToolResultContent {
  return Object.freeze({ ...base, head, tail, truncated });
}

interface EncodedDisplayProjection {
  readonly encoding: "utf8" | "base64";
  readonly totalUnits: number;
  full(): string | undefined;
  slice(
    headCount: number,
    tailCount: number,
  ): Readonly<{ readonly head: string; readonly tail: string }>;
}

function projectBounded(
  toolCallId: string,
  base: Omit<ArtifactToolResultContent, "head" | "tail" | "truncated">,
  display: EncodedDisplayProjection,
): ProjectedArtifactToolResult {
  const completeDisplay = display.full();
  if (completeDisplay !== undefined) {
    const full = contentCandidate(base, completeDisplay, "", false);
    let fullMessage: FrozenBytes;
    try {
      fullMessage = materializeToolResultMessage(toolCallId, full);
    } catch {
      return projectionFailure("Artifact result metadata is invalid");
    }
    if (fullMessage.byteLength <= TOOL_RESULT_PROJECTION_LIMIT_BYTES) {
      return Object.freeze({
        content: full,
        contentText: materializeToolResultContent(full),
        messageBytes: fullMessage,
      });
    }
  }

  let low = 0;
  // A UTF-8 scalar costs at least one outer byte and a base64 quantum exactly
  // four before JSON framing. Counts above these bounds cannot fit.
  let high = Math.min(
    display.totalUnits,
    display.encoding === "base64"
      ? Math.floor(TOOL_RESULT_PROJECTION_LIMIT_BYTES / 4)
      : TOOL_RESULT_PROJECTION_LIMIT_BYTES,
  );
  let best: ArtifactToolResultContent | undefined;
  let bestMessage: FrozenBytes | undefined;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const headCount = Math.ceil(count / 2);
    const tailCount = Math.floor(count / 2);
    let retained: Readonly<{ readonly head: string; readonly tail: string }>;
    try {
      retained = display.slice(headCount, tailCount);
    } catch {
      high = count - 1;
      continue;
    }
    const candidate = contentCandidate(
      base,
      retained.head,
      retained.tail,
      true,
    );
    let message: FrozenBytes;
    try {
      message = materializeToolResultMessage(toolCallId, candidate);
    } catch {
      high = count - 1;
      continue;
    }
    if (message.byteLength <= TOOL_RESULT_PROJECTION_LIMIT_BYTES) {
      best = candidate;
      bestMessage = message;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  if (best === undefined || bestMessage === undefined) {
    return projectionFailure("fixed Artifact metadata exceeds the projection limit");
  }
  return Object.freeze({
    content: best,
    contentText: materializeToolResultContent(best),
    messageBytes: bestMessage,
  });
}

function compactProjection(
  toolCallId: string,
  verbose: ProjectedArtifactToolResult,
): ProjectedArtifactToolResult {
  const source = verbose.content;
  if (!("artifactId" in source)) {
    return projectionFailure("verbose Artifact projection is missing identity");
  }
  const content: CompactArtifactToolResultContent = Object.freeze({
    kind: "artifact",
    status: source.status,
    code: source.code,
    ...(source.matchCount === undefined
      ? {}
      : { matchCount: source.matchCount }),
    ...(source.truncated ? { artifactRef: source.artifactRef } : {}),
    hardLimitReached: source.hardLimitReached,
    exitCode: source.exitCode,
    signal: source.signal,
    encoding: source.encoding,
    head: source.head,
    tail: source.tail,
    truncated: source.truncated,
  });
  let contentText: string;
  let messageBytes: FrozenBytes;
  try {
    contentText = materializeCompactToolResultContent(content);
    messageBytes = materializeCompactToolResultMessage(toolCallId, content);
  } catch {
    return projectionFailure("compact Artifact result metadata is invalid");
  }
  if (
    messageBytes.byteLength > TOOL_RESULT_PROJECTION_LIMIT_BYTES ||
    messageBytes.byteLength >= verbose.messageBytes.byteLength
  ) {
    return projectionFailure("compact Artifact result is not strictly smaller");
  }
  return Object.freeze({ content, contentText, messageBytes });
}

const UTF8_PREFIX_UNITS = TOOL_RESULT_PROJECTION_LIMIT_BYTES;
const UTF8_TAIL_UNITS = Math.floor(TOOL_RESULT_PROJECTION_LIMIT_BYTES / 2);
const BASE64_FULL_UNITS = Math.floor(TOOL_RESULT_PROJECTION_LIMIT_BYTES / 4);
const BASE64_PREFIX_BYTES = BASE64_FULL_UNITS * 3;
const BASE64_TAIL_BYTES = Math.ceil(BASE64_FULL_UNITS / 2) * 3;

function safeUnitCount(value: number, increment: number): number {
  const result = value + increment;
  if (!Number.isSafeInteger(result)) {
    return projectionFailure("display unit count exceeds the safe integer range");
  }
  return result;
}

function codePointsToString(values: Uint32Array): string {
  const parts: string[] = [];
  const chunkUnits = 1_024;
  for (let offset = 0; offset < values.length; offset += chunkUnits) {
    const end = Math.min(values.length, offset + chunkUnits);
    const chunk: number[] = [];
    for (let index = offset; index < end; index += 1) {
      const value = values[index];
      if (value === undefined) {
        return projectionFailure("display scalar window is incomplete");
      }
      chunk.push(value);
    }
    parts.push(String.fromCodePoint(...chunk));
  }
  return parts.join("");
}

class ScalarWindow implements EncodedDisplayProjection {
  readonly encoding = "utf8" as const;
  readonly #prefix = new Uint32Array(UTF8_PREFIX_UNITS);
  readonly #tail = new Uint32Array(UTF8_TAIL_UNITS);
  #prefixLength = 0;
  #tailLength = 0;
  #tailWrite = 0;
  #totalUnits = 0;

  get totalUnits(): number {
    return this.#totalUnits;
  }

  push(value: number): void {
    if (
      !Number.isInteger(value) ||
      value < 0 ||
      value > 0x10ffff ||
      (value >= 0xd800 && value <= 0xdfff)
    ) {
      projectionFailure("decoded display contains an invalid scalar");
    }
    this.#totalUnits = safeUnitCount(this.#totalUnits, 1);
    if (this.#prefixLength < this.#prefix.length) {
      this.#prefix[this.#prefixLength] = value;
      this.#prefixLength += 1;
    }
    if (this.#tail.length > 0) {
      this.#tail[this.#tailWrite] = value;
      this.#tailWrite = (this.#tailWrite + 1) % this.#tail.length;
      this.#tailLength = Math.min(this.#tail.length, this.#tailLength + 1);
    }
  }

  full(): string | undefined {
    if (this.#totalUnits > this.#prefixLength) return undefined;
    return codePointsToString(this.#prefix.slice(0, this.#totalUnits));
  }

  #tailSuffix(count: number): Uint32Array {
    if (count < 0 || count > this.#tailLength) {
      return projectionFailure("display tail exceeds its retained scalar window");
    }
    const result = new Uint32Array(count);
    if (count === 0) return result;
    const oldest = this.#tailLength === this.#tail.length ? this.#tailWrite : 0;
    const start = (oldest + this.#tailLength - count) % this.#tail.length;
    const first = Math.min(count, this.#tail.length - start);
    result.set(this.#tail.subarray(start, start + first));
    if (first < count) result.set(this.#tail.subarray(0, count - first), first);
    return result;
  }

  slice(
    headCount: number,
    tailCount: number,
  ): Readonly<{ readonly head: string; readonly tail: string }> {
    if (
      !Number.isSafeInteger(headCount) ||
      !Number.isSafeInteger(tailCount) ||
      headCount < 0 ||
      tailCount < 0 ||
      headCount + tailCount > this.#totalUnits ||
      headCount > this.#prefixLength
    ) {
      return projectionFailure("display scalar slice is invalid");
    }
    return Object.freeze({
      head: codePointsToString(this.#prefix.slice(0, headCount)),
      tail: codePointsToString(this.#tailSuffix(tailCount)),
    });
  }
}

class ByteWindow {
  readonly #prefix = new Uint8Array(BASE64_PREFIX_BYTES);
  readonly #tail = new Uint8Array(BASE64_TAIL_BYTES);
  #prefixLength = 0;
  #tailLength = 0;
  #tailWrite = 0;
  #totalBytes = 0;

  get totalBytes(): number {
    return this.#totalBytes;
  }

  push(bytes: Uint8Array): void {
    this.#totalBytes = safeUnitCount(this.#totalBytes, bytes.byteLength);
    const prefixTake = Math.min(
      bytes.byteLength,
      this.#prefix.length - this.#prefixLength,
    );
    if (prefixTake > 0) {
      this.#prefix.set(bytes.subarray(0, prefixTake), this.#prefixLength);
      this.#prefixLength += prefixTake;
    }
    if (this.#tail.length === 0 || bytes.byteLength === 0) return;
    if (bytes.byteLength >= this.#tail.length) {
      this.#tail.set(bytes.subarray(bytes.byteLength - this.#tail.length));
      this.#tailLength = this.#tail.length;
      this.#tailWrite = 0;
      return;
    }
    const first = Math.min(bytes.byteLength, this.#tail.length - this.#tailWrite);
    this.#tail.set(bytes.subarray(0, first), this.#tailWrite);
    if (first < bytes.byteLength) {
      this.#tail.set(bytes.subarray(first), 0);
    }
    this.#tailWrite = (this.#tailWrite + bytes.byteLength) % this.#tail.length;
    this.#tailLength = Math.min(
      this.#tail.length,
      this.#tailLength + bytes.byteLength,
    );
  }

  prefix(count: number): Uint8Array {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.#prefixLength) {
      return projectionFailure("base64 head exceeds its retained byte window");
    }
    return this.#prefix.slice(0, count);
  }

  suffix(count: number): Uint8Array {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.#tailLength) {
      return projectionFailure("base64 tail exceeds its retained byte window");
    }
    const result = new Uint8Array(count);
    if (count === 0) return result;
    const oldest = this.#tailLength === this.#tail.length ? this.#tailWrite : 0;
    const start = (oldest + this.#tailLength - count) % this.#tail.length;
    const first = Math.min(count, this.#tail.length - start);
    result.set(this.#tail.subarray(start, start + first));
    if (first < count) result.set(this.#tail.subarray(0, count - first), first);
    return result;
  }
}

class Base64Window implements EncodedDisplayProjection {
  readonly encoding = "base64" as const;
  readonly #bytes: ByteWindow;

  constructor(bytes: ByteWindow) {
    this.#bytes = bytes;
  }

  get totalUnits(): number {
    return Math.ceil(this.#bytes.totalBytes / 3);
  }

  full(): string | undefined {
    if (this.totalUnits > BASE64_FULL_UNITS) return undefined;
    return Buffer.from(this.#bytes.prefix(this.#bytes.totalBytes)).toString("base64");
  }

  slice(
    headCount: number,
    tailCount: number,
  ): Readonly<{ readonly head: string; readonly tail: string }> {
    if (
      !Number.isSafeInteger(headCount) ||
      !Number.isSafeInteger(tailCount) ||
      headCount < 0 ||
      tailCount < 0 ||
      headCount + tailCount > this.totalUnits
    ) {
      return projectionFailure("base64 quantum slice is invalid");
    }
    const headByteCount = headCount * 3;
    const tailStart = 3 * (this.totalUnits - tailCount);
    const tailByteCount = this.#bytes.totalBytes - tailStart;
    return Object.freeze({
      head: Buffer.from(this.#bytes.prefix(headByteCount)).toString("base64"),
      tail: Buffer.from(this.#bytes.suffix(tailByteCount)).toString("base64"),
    });
  }
}

class DisplayCollector {
  readonly #toolName: ToolName;
  readonly #raw = new ByteWindow();
  readonly #text = new ScalarWindow();
  readonly #decoder = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  });
  #textRejected = false;
  #readLine: bigint;
  #readLineStart = true;
  #finished = false;

  constructor(toolName: ToolName, readOffset: number | undefined) {
    this.#toolName = toolName;
    const offset = readOffset ?? 0;
    if (toolName === "read" && (!Number.isSafeInteger(offset) || offset < 0)) {
      projectionFailure("read offset is invalid");
    }
    this.#readLine = BigInt(offset) + 1n;
  }

  #pushReadPrefix(): void {
    for (const unit of this.#readLine.toString()) {
      const code = unit.codePointAt(0);
      if (code === undefined) projectionFailure("read line number is invalid");
      this.#text.push(code);
    }
    this.#text.push(0x09);
    this.#readLineStart = false;
  }

  #pushText(value: string): void {
    for (let index = 0; index < value.length;) {
      const code = value.codePointAt(index);
      if (code === undefined) projectionFailure("decoded display is incomplete");
      index += code > 0xffff ? 2 : 1;
      if (code === 0) {
        this.#textRejected = true;
        return;
      }
      if (this.#toolName === "read") {
        if (this.#readLineStart) this.#pushReadPrefix();
        this.#text.push(code);
        if (code === 0x0a) {
          this.#readLine += 1n;
          this.#readLineStart = true;
        }
      } else {
        this.#text.push(code);
      }
    }
  }

  push(bytes: Uint8Array): void {
    if (this.#finished) projectionFailure("display collector is finished");
    this.#raw.push(bytes);
    if (this.#textRejected) return;
    try {
      this.#pushText(this.#decoder.decode(bytes, { stream: true }));
    } catch {
      this.#textRejected = true;
    }
  }

  finish(): EncodedDisplayProjection {
    if (this.#finished) return projectionFailure("display collector is finished");
    this.#finished = true;
    if (!this.#textRejected) {
      try {
        this.#pushText(this.#decoder.decode());
      } catch {
        this.#textRejected = true;
      }
    }
    return this.#textRejected ? new Base64Window(this.#raw) : this.#text;
  }
}

export interface ArtifactToolResultProjector {
  push(bytes: Uint8Array | FrozenBytes): void;
  finish(): ProjectedArtifactToolResult;
}

class StreamingArtifactToolResultProjector implements ArtifactToolResultProjector {
  readonly #input: StreamArtifactToolResultInput;
  readonly #display: DisplayCollector;
  readonly #parser;
  readonly #activeEditMatchCount: boolean;
  readonly #matchCountBytes: number[] = [];
  #matchCountOverflow = false;
  #finished = false;

  constructor(input: StreamArtifactToolResultInput) {
    this.#input = input;
    this.#display = new DisplayCollector(input.toolName, input.readOffset);
    this.#activeEditMatchCount =
      input.toolsProfile === "edit-v5" &&
      input.toolName === "edit" &&
      input.terminalSource === "artifact" &&
      (input.terminal.code === "edit_no_match" ||
        input.terminal.code === "edit_not_unique");
    const display = this.#display;
    this.#parser = createToolOutputFrameParser({
      data: (stream, bytes) => {
        if (this.#activeEditMatchCount && stream === "stdout") {
          for (const byte of bytes) {
            if (this.#matchCountBytes.length < 16) {
              this.#matchCountBytes.push(byte);
            } else {
              this.#matchCountOverflow = true;
            }
          }
          display.push(bytes);
          return;
        }
        if (
          (input.toolName === "read" && stream !== "read") ||
          (input.toolName === "bash" && stream === "read") ||
          (input.toolName === "write" || input.toolName === "edit")
        ) {
          projectionFailure("framed stream is not valid for the tool");
        }
        display.push(bytes);
      },
      hardLimit: (stream) => {
        if (
          (input.toolName !== "read" && input.toolName !== "bash") ||
          (input.toolName === "read" && stream !== "read") ||
          (input.toolName === "bash" && stream === "read")
        ) {
          projectionFailure("hard-limit marker is not valid for the tool");
        }
      },
    });
  }

  push(bytes: Uint8Array | FrozenBytes): void {
    if (this.#finished) projectionFailure("Artifact projector is finished");
    try {
      this.#parser.push(bytes);
    } catch {
      projectionFailure("framed Artifact bytes are malformed");
    }
  }

  finish(): ProjectedArtifactToolResult {
    if (this.#finished) return projectionFailure("Artifact projector is finished");
    this.#finished = true;
    let summary;
    try {
      summary = this.#parser.finish();
    } catch {
      return projectionFailure("framed Artifact bytes are incomplete");
    }
    const input = this.#input;
    const payloadBytes = input.artifact.payloadBytes;
    const totalPayload =
      payloadBytes.read + payloadBytes.stdout + payloadBytes.stderr;
    if (
      summary.byteCount !== input.artifact.byteCount ||
      summary.payloadBytes.read !== payloadBytes.read ||
      summary.payloadBytes.stdout !== payloadBytes.stdout ||
      summary.payloadBytes.stderr !== payloadBytes.stderr ||
      summary.hardLimitReached !== input.artifact.hardLimitReached ||
      totalPayload > RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES ||
      input.artifact.hardLimitReached !==
        (totalPayload === RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES)
    ) {
      return projectionFailure(
        "framed Artifact metadata does not match its bytes",
      );
    }
    if (
      input.terminalSource === "artifact" &&
      input.toolName === "bash" &&
      summary.byteCount !== 0
    ) {
      return projectionFailure("pre-effect bash Artifact must be empty");
    }
    let terminal: ToolTerminal;
    try {
      terminal = validateToolTerminalForSource(
        input.toolName,
        input.terminalSource,
        input.terminal,
        input.artifact.hardLimitReached,
      );
    } catch {
      return projectionFailure("terminal is invalid for its durable source");
    }
    const editMatchTerminal =
      input.toolName === "edit" &&
      (terminal.code === "edit_no_match" ||
        terminal.code === "edit_not_unique");
    let matchCount: number | undefined;
    if (input.toolsProfile === "edit-v5" && editMatchTerminal) {
      if (
        !this.#activeEditMatchCount ||
        this.#matchCountOverflow ||
        this.#matchCountBytes.length === 0 ||
        summary.recordCount !== 1 ||
        summary.payloadBytes.read !== 0 ||
        summary.payloadBytes.stderr !== 0 ||
        summary.payloadBytes.stdout !== this.#matchCountBytes.length ||
        summary.hardLimitReached
      ) {
        return projectionFailure("active edit match count Artifact is invalid");
      }
      const countText = String.fromCharCode(...this.#matchCountBytes);
      if (!/^(?:0|[1-9][0-9]*)$/u.test(countText)) {
        return projectionFailure("active edit match count is not canonical decimal");
      }
      matchCount = Number(countText);
      if (
        !Number.isSafeInteger(matchCount) ||
        (terminal.code === "edit_no_match"
          ? matchCount !== 0
          : matchCount < 2)
      ) {
        return projectionFailure("active edit match count disagrees with terminal");
      }
    } else if (editMatchTerminal && summary.byteCount !== 0) {
      return projectionFailure("legacy edit match Artifact must be empty");
    }
    if (
      input.terminalSource === "artifact" &&
      input.toolName === "read" &&
      terminal.code === "invalid_arguments" &&
      summary.byteCount !== 0
    ) {
      return projectionFailure("pre-read argument observation must be empty");
    }
    const display = this.#display.finish();
    const base = Object.freeze({
      kind: "artifact" as const,
      status: terminal.status,
      code: terminal.code,
      ...(matchCount === undefined ? {} : { matchCount }),
      artifactId: input.artifact.artifactId,
      artifactRef: input.artifact.artifactRef,
      artifactSha256: input.artifact.artifactSha256,
      byteCount: input.artifact.byteCount,
      payloadBytes: Object.freeze({ ...payloadBytes }),
      framingByteCount: summary.framingByteCount,
      hardLimitReached: input.artifact.hardLimitReached,
      exitCode: terminal.exitCode,
      signal: terminal.signal,
      encoding: display.encoding,
    });
    const verbose = projectBounded(input.toolCallId, base, display);
    return input.resultProfile === "compact-v2"
      ? compactProjection(input.toolCallId, verbose)
      : verbose;
  }
}

export function createArtifactToolResultProjector(
  input: StreamArtifactToolResultInput,
): ArtifactToolResultProjector {
  return new StreamingArtifactToolResultProjector(input);
}

export function projectArtifactToolResult(
  input: ProjectArtifactToolResultInput,
): ProjectedArtifactToolResult {
  const projector = createArtifactToolResultProjector(input);
  projector.push(input.framedBytes);
  return projector.finish();
}
