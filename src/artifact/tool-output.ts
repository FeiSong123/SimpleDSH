import { concatBytes } from "../bytes/ops.js";
import type { FrozenBytes } from "../bytes/types.js";

export const TOOL_OUTPUT_MEDIA_TYPE =
  "application/vnd.simpledsh.tool-output.v1";
export const RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES = 16_777_216;

export type ToolOutputStream = "read" | "stdout" | "stderr";

export interface ToolOutputPayloadBytes {
  readonly read: number;
  readonly stdout: number;
  readonly stderr: number;
}

export interface ToolOutputFrameSummary {
  readonly byteCount: number;
  readonly payloadBytes: ToolOutputPayloadBytes;
  readonly recordCount: number;
  readonly framingByteCount: number;
  readonly hardLimitReached: boolean;
  readonly hardLimitStream: ToolOutputStream | null;
}

export interface ToolOutputFrameVisitor {
  data?(stream: ToolOutputStream, bytes: Uint8Array): void;
  hardLimit?(stream: ToolOutputStream): void;
}

export interface ToolOutputByteSink {
  write(bytes: Uint8Array | FrozenBytes): Promise<void>;
}

export interface ToolOutputWriteResult {
  readonly acceptedBytes: number;
  readonly hardLimitReached: boolean;
}

const streamToByte: Readonly<Record<ToolOutputStream, number>> = Object.freeze({
  read: 1,
  stdout: 2,
  stderr: 3,
});

function outputError(message: string): TypeError {
  return new TypeError(`invalid framed tool output: ${message}`);
}

function streamFromByte(value: number): ToolOutputStream {
  if (value === 1) return "read";
  if (value === 2) return "stdout";
  if (value === 3) return "stderr";
  throw outputError("unknown stream");
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw outputError(`${label} exceeds the safe integer range`);
  }
  return result;
}

function copyInputBytes(input: Uint8Array | FrozenBytes): Uint8Array {
  return input instanceof Uint8Array ? Uint8Array.from(input) : input.copy();
}

export class ToolOutputFrameParser {
  readonly #visitor: ToolOutputFrameVisitor | undefined;
  readonly #header = new Uint8Array(6);
  #headerLength = 0;
  #payloadRemaining = 0;
  #payloadStream: ToolOutputStream | undefined;
  #byteCount = 0;
  #readBytes = 0;
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #recordCount = 0;
  #hardLimitStream: ToolOutputStream | null = null;
  #finished = false;
  #failure: unknown;

  constructor(visitor?: ToolOutputFrameVisitor) {
    this.#visitor = visitor;
  }

  push(input: Uint8Array | FrozenBytes): void {
    if (this.#finished) throw outputError("parser is finished");
    if (this.#failure !== undefined) throw this.#failure;
    const bytes = copyInputBytes(input);
    try {
      this.#byteCount = safeAdd(this.#byteCount, bytes.byteLength, "byteCount");
      let offset = 0;
      while (offset < bytes.byteLength) {
        if (this.#hardLimitStream !== null) {
          throw outputError("bytes follow HARD_LIMIT");
        }
        if (this.#payloadRemaining > 0) {
          const take = Math.min(this.#payloadRemaining, bytes.byteLength - offset);
          const payload = bytes.subarray(offset, offset + take);
          const stream = this.#payloadStream;
          if (stream === undefined) throw outputError("missing DATA stream");
          if (stream === "read") {
            this.#readBytes = safeAdd(this.#readBytes, take, "read payload");
          } else if (stream === "stdout") {
            this.#stdoutBytes = safeAdd(this.#stdoutBytes, take, "stdout payload");
          } else {
            this.#stderrBytes = safeAdd(this.#stderrBytes, take, "stderr payload");
          }
          this.#visitor?.data?.(stream, Uint8Array.from(payload));
          this.#payloadRemaining -= take;
          offset += take;
          if (this.#payloadRemaining === 0) this.#payloadStream = undefined;
          continue;
        }

        const headerTake = Math.min(6 - this.#headerLength, bytes.byteLength - offset);
        this.#header.set(bytes.subarray(offset, offset + headerTake), this.#headerLength);
        this.#headerLength += headerTake;
        offset += headerTake;
        if (this.#headerLength < 6) continue;

        const stream = streamFromByte(this.#header[0] ?? 0);
        const flags = this.#header[1] ?? 0;
        const payloadLength = new DataView(
          this.#header.buffer,
          this.#header.byteOffset,
          this.#header.byteLength,
        ).getUint32(2, false);
        this.#headerLength = 0;
        this.#recordCount = safeAdd(this.#recordCount, 1, "recordCount");
        if (flags === 0) {
          if (payloadLength === 0) throw outputError("DATA payload is empty");
          this.#payloadStream = stream;
          this.#payloadRemaining = payloadLength;
        } else if (flags === 1) {
          if (payloadLength !== 0) throw outputError("HARD_LIMIT has a payload");
          this.#hardLimitStream = stream;
          this.#visitor?.hardLimit?.(stream);
        } else {
          throw outputError("unknown flags");
        }
      }
    } catch (error) {
      this.#failure = error;
      throw error;
    }
  }

  finish(): ToolOutputFrameSummary {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#finished) throw outputError("parser is finished");
    this.#finished = true;
    if (this.#headerLength !== 0) throw outputError("truncated header");
    if (this.#payloadRemaining !== 0) throw outputError("truncated DATA payload");
    const payloadBytes = Object.freeze({
      read: this.#readBytes,
      stdout: this.#stdoutBytes,
      stderr: this.#stderrBytes,
    });
    const framingByteCount = this.#recordCount * 6;
    if (!Number.isSafeInteger(framingByteCount)) {
      throw outputError("framingByteCount exceeds the safe integer range");
    }
    const payloadByteCount = safeAdd(
      safeAdd(this.#readBytes, this.#stdoutBytes, "payload bytes"),
      this.#stderrBytes,
      "payload bytes",
    );
    if (safeAdd(payloadByteCount, framingByteCount, "framed byteCount") !== this.#byteCount) {
      throw outputError("framing equation does not match byteCount");
    }
    return Object.freeze({
      byteCount: this.#byteCount,
      payloadBytes,
      recordCount: this.#recordCount,
      framingByteCount,
      hardLimitReached: this.#hardLimitStream !== null,
      hardLimitStream: this.#hardLimitStream,
    });
  }
}

export function createToolOutputFrameParser(
  visitor?: ToolOutputFrameVisitor,
): ToolOutputFrameParser {
  return new ToolOutputFrameParser(visitor);
}

function frameHeader(
  stream: ToolOutputStream,
  flags: 0 | 1,
  payloadLength: number,
): Uint8Array {
  const header = new Uint8Array(6);
  header[0] = streamToByte[stream];
  header[1] = flags;
  new DataView(header.buffer).setUint32(2, payloadLength, false);
  return header;
}

export function encodeToolOutputData(
  stream: ToolOutputStream,
  input: Uint8Array | FrozenBytes,
): FrozenBytes {
  const bytes = copyInputBytes(input);
  if (bytes.byteLength < 1 || bytes.byteLength > 0xffff_ffff) {
    throw outputError("DATA payload length must be in 1..2^32-1");
  }
  return concatBytes([frameHeader(stream, 0, bytes.byteLength), bytes]);
}

export function encodeToolOutputHardLimit(
  stream: ToolOutputStream,
): FrozenBytes {
  return concatBytes([frameHeader(stream, 1, 0)]);
}

export class ToolOutputFrameWriter {
  readonly #sink: ToolOutputByteSink;
  #queue: Promise<void> = Promise.resolve();
  #failure: unknown;
  #finished = false;
  #readBytes = 0;
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #recordCount = 0;
  #byteCount = 0;
  #hardLimitStream: ToolOutputStream | null = null;

  constructor(sink: ToolOutputByteSink) {
    this.#sink = sink;
  }

  write(
    stream: ToolOutputStream,
    input: Uint8Array | FrozenBytes,
  ): Promise<ToolOutputWriteResult> {
    if (this.#finished) throw outputError("writer is finished");
    const bytes = copyInputBytes(input);
    let resolveResult!: (value: ToolOutputWriteResult) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<ToolOutputWriteResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const task = this.#queue.then(async () => {
      if (this.#failure !== undefined) throw this.#failure;
      if (this.#hardLimitStream !== null) {
        resolveResult(Object.freeze({ acceptedBytes: 0, hardLimitReached: true }));
        return;
      }
      const total = this.#readBytes + this.#stdoutBytes + this.#stderrBytes;
      const remaining = RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES - total;
      const acceptedBytes = Math.min(bytes.byteLength, remaining);
      if (acceptedBytes > 0) {
        const frame = encodeToolOutputData(stream, bytes.subarray(0, acceptedBytes));
        await this.#sink.write(frame);
        this.#recordCount += 1;
        this.#byteCount = safeAdd(this.#byteCount, frame.byteLength, "writer byteCount");
        if (stream === "read") this.#readBytes += acceptedBytes;
        else if (stream === "stdout") this.#stdoutBytes += acceptedBytes;
        else this.#stderrBytes += acceptedBytes;
      }
      const nextTotal = this.#readBytes + this.#stdoutBytes + this.#stderrBytes;
      if (nextTotal === RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES) {
        const marker = encodeToolOutputHardLimit(stream);
        await this.#sink.write(marker);
        this.#recordCount += 1;
        this.#byteCount = safeAdd(this.#byteCount, marker.byteLength, "writer byteCount");
        this.#hardLimitStream = stream;
      }
      resolveResult(Object.freeze({
        acceptedBytes,
        hardLimitReached: this.#hardLimitStream !== null,
      }));
    });
    this.#queue = task.then(
      () => undefined,
      (error: unknown) => {
        this.#failure = error;
        rejectResult(error);
      },
    );
    return result;
  }

  async finish(): Promise<ToolOutputFrameSummary> {
    if (this.#finished) throw outputError("writer is finished");
    this.#finished = true;
    await this.#queue;
    if (this.#failure !== undefined) throw this.#failure;
    const payloadBytes = Object.freeze({
      read: this.#readBytes,
      stdout: this.#stdoutBytes,
      stderr: this.#stderrBytes,
    });
    const framingByteCount = this.#recordCount * 6;
    const expectedByteCount =
      this.#readBytes + this.#stdoutBytes + this.#stderrBytes + framingByteCount;
    if (!Number.isSafeInteger(expectedByteCount) || expectedByteCount !== this.#byteCount) {
      throw outputError("writer framing equation does not match byteCount");
    }
    return Object.freeze({
      byteCount: this.#byteCount,
      payloadBytes,
      recordCount: this.#recordCount,
      framingByteCount,
      hardLimitReached: this.#hardLimitStream !== null,
      hardLimitStream: this.#hardLimitStream,
    });
  }
}

export function createToolOutputFrameWriter(
  sink: ToolOutputByteSink,
): ToolOutputFrameWriter {
  return new ToolOutputFrameWriter(sink);
}
