import assert from "node:assert/strict";
import test from "node:test";

import {
  createToolOutputFrameParser,
  createToolOutputFrameWriter,
  encodeToolOutputData,
  encodeToolOutputHardLimit,
  RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES,
  type ToolOutputStream,
} from "../../src/artifact/tool-output.js";
import {
  normalizeEffectTerminal,
  normalizeToolTerminal,
  type ToolTerminal,
} from "../../src/artifact/terminal.js";
import {
  materializeCompactToolResultContent,
  materializeToolResultContent,
  materializeToolResultMessage,
  parseCompactToolResultContent,
  parseToolResultContent,
  TOOL_RESULT_PROJECTION_LIMIT_BYTES,
  type ArtifactToolResultContent,
  type CompactArtifactToolResultContent,
  type StaticToolResultContent,
} from "../../src/bytes/tool-result.js";
import {
  asToolCallId,
  assertToolCallId,
  isToolCallId,
  MAX_TOOL_CALL_ID_UTF8_BYTES,
} from "../../src/bytes/tool-call-id.js";
import { bytesEqual, concatBytes, utf8Bytes } from "../../src/bytes/ops.js";
import { materializeToolMessage } from "../../src/bytes/tool.js";
import type { FrozenBytes } from "../../src/bytes/types.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
const HASH_HEX = "a".repeat(64);

function copyBytes(input: Uint8Array | FrozenBytes): Uint8Array {
  return "copy" in input ? input.copy() : Uint8Array.from(input);
}

function terminal(
  status: ToolTerminal["status"],
  code: ToolTerminal["code"],
  exitCode: number | null = null,
  signal: ToolTerminal["signal"] = null,
  descendantsReaped: boolean | null = null,
): ToolTerminal {
  return { status, code, exitCode, signal, descendantsReaped };
}

function artifactResult(
  overrides: Partial<ArtifactToolResultContent> = {},
): ArtifactToolResultContent {
  return {
    kind: "artifact",
    status: "succeeded",
    code: "ok",
    artifactId: `art_${"1".repeat(32)}`,
    artifactRef: `artifacts/sha256/${HASH_HEX}`,
    artifactSha256: `sha256:${HASH_HEX}`,
    byteCount: 9,
    payloadBytes: { read: 3, stdout: 0, stderr: 0 },
    framingByteCount: 6,
    hardLimitReached: false,
    exitCode: null,
    signal: null,
    encoding: "utf8",
    head: "one",
    tail: "",
    truncated: false,
    ...overrides,
  };
}

function compactArtifactResult(
  overrides: Partial<CompactArtifactToolResultContent> = {},
): CompactArtifactToolResultContent {
  return {
    kind: "artifact",
    status: "succeeded",
    code: "ok",
    hardLimitReached: false,
    exitCode: null,
    signal: null,
    encoding: "utf8",
    head: "one",
    tail: "",
    truncated: false,
    ...overrides,
  };
}

test("ToolCallId accepts exactly 1..4096 UTF-8 bytes and only Unicode scalars", () => {
  assert.equal(MAX_TOOL_CALL_ID_UTF8_BYTES, 4_096);

  const oneByte = "x";
  const asciiLimit = "a".repeat(4_096);
  const fourByteLimit = "\u{1f642}".repeat(1_024);
  const mixedLimit = `${"a".repeat(4_092)}\u{1f642}`;
  for (const value of [oneByte, asciiLimit, fourByteLimit, mixedLimit]) {
    assert.equal(asToolCallId(value), value);
    assert.equal(isToolCallId(value), true);
    assert.doesNotThrow(() => assertToolCallId(value, "fixture id"));
  }

  for (const value of [
    "",
    "a".repeat(4_097),
    "\u{1f642}".repeat(1_025),
    "\ud800",
    "\udc00",
    `ok\ud800bad`,
  ]) {
    assert.throws(() => asToolCallId(value), TypeError);
    assert.equal(isToolCallId(value), false);
  }
  assert.throws(
    () => assertToolCallId("", "assistant call id"),
    /assistant call id: tool call id must contain 1\.\.4096 UTF-8 bytes/u,
  );
  assert.throws(() => asToolCallId(1), /must be a string/u);
});

test("terminal status/code mapping is closed across every declared code", () => {
  const accepted: readonly ToolTerminal[] = [
    terminal("succeeded", "ok"),
    terminal("failed", "io_error"),
    terminal("failed", "edit_no_match"),
    terminal("failed", "edit_not_unique"),
    terminal("failed", "target_changed"),
    terminal("failed", "nonzero_exit", 1),
    terminal("failed", "signaled", null, "SIGTERM"),
    terminal("failed", "timeout", 124),
    terminal("failed", "cancelled", null, "SIGKILL"),
    terminal("failed", "output_limit", 137, null, true),
    terminal("invalid", "unknown_tool"),
    terminal("invalid", "invalid_json"),
    terminal("invalid", "invalid_arguments"),
    terminal("denied", "permission_denied"),
    terminal("unavailable", "bash_supervisor_unavailable"),
    terminal("unavailable", "credential_shield_unavailable"),
  ];

  for (const value of accepted) {
    const normalized = normalizeToolTerminal(value);
    assert.deepEqual(normalized, value);
    assert.equal(Object.isFrozen(normalized), true);

    const wrongStatus = value.status === "succeeded" ? "failed" : "succeeded";
    assert.throws(
      () => normalizeToolTerminal({ ...value, status: wrongStatus }),
      /status\/code pair is not recognized/u,
    );
  }

  assert.throws(
    () => normalizeToolTerminal({ ...terminal("succeeded", "ok"), extra: true }),
    /fields are not closed/u,
  );
  assert.throws(
    () => normalizeToolTerminal({ status: "succeeded", code: "ok", exitCode: null }),
    /fields are not closed/u,
  );
  assert.throws(() => normalizeToolTerminal([]), /expected a closed record/u);

  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(accessor, {
    status: { enumerable: true, get: () => "succeeded" },
    code: { enumerable: true, value: "ok" },
    exitCode: { enumerable: true, value: null },
    signal: { enumerable: true, value: null },
    descendantsReaped: { enumerable: true, value: null },
  });
  assert.throws(
    () => normalizeToolTerminal(accessor),
    /fields must be enumerable data properties/u,
  );
});

test("terminal exitCode/signal pairs fail closed at every special boundary", () => {
  assert.deepEqual(
    normalizeToolTerminal(terminal("succeeded", "ok", 0)),
    terminal("succeeded", "ok", 0),
  );
  assert.throws(
    () => normalizeToolTerminal(terminal("succeeded", "ok", 1)),
    /ok requires null\/null or 0\/null/u,
  );

  assert.doesNotThrow(() =>
    normalizeToolTerminal(terminal("failed", "nonzero_exit", 255)),
  );
  for (const exitCode of [0, 256, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() =>
      normalizeToolTerminal(terminal("failed", "nonzero_exit", exitCode)),
    );
  }
  assert.throws(() =>
    normalizeToolTerminal(terminal("failed", "nonzero_exit", 1, "SIGTERM")),
  );

  assert.throws(() =>
    normalizeToolTerminal(terminal("failed", "signaled", null, null)),
  );
  assert.throws(
    () =>
      normalizeToolTerminal({
        status: "failed",
        code: "signaled",
        exitCode: null,
        signal: "SIG_NOT_REAL",
        descendantsReaped: null,
      }),
    /signal is not in the frozen enum/u,
  );

  for (const code of ["timeout", "cancelled"] as const) {
    assert.doesNotThrow(() =>
      normalizeToolTerminal(terminal("failed", code, 124, null)),
    );
    assert.doesNotThrow(() =>
      normalizeToolTerminal(terminal("failed", code, null, "SIGTERM")),
    );
    assert.throws(() =>
      normalizeToolTerminal(terminal("failed", code, null, null)),
    );
    assert.throws(() =>
      normalizeToolTerminal(terminal("failed", code, 124, "SIGTERM")),
    );
  }

  const legalOutputLimitTerminals = [
    terminal("failed", "output_limit", 137, null),
    terminal("failed", "output_limit", null, "SIGKILL"),
  ] as const;
  for (const value of legalOutputLimitTerminals) {
    assert.doesNotThrow(() => normalizeToolTerminal(value));
    assert.doesNotThrow(() => normalizeEffectTerminal(value));
  }
  const invalidOutputLimitTerminals = [
    terminal("failed", "output_limit", null, null),
    terminal("failed", "output_limit", 137, "SIGKILL"),
  ] as const;
  for (const value of invalidOutputLimitTerminals) {
    assert.throws(
      () => normalizeToolTerminal(value),
      /output_limit requires exactly one exitCode or signal/u,
    );
    assert.throws(
      () => normalizeEffectTerminal(value),
      /output_limit requires exactly one exitCode or signal/u,
    );
  }
  assert.throws(() =>
    normalizeToolTerminal(terminal("failed", "io_error", 1, null)),
  );
  assert.throws(() =>
    normalizeToolTerminal({
      ...terminal("failed", "io_error"),
      descendantsReaped: "yes",
    }),
  );

  assert.doesNotThrow(() =>
    normalizeEffectTerminal(terminal("succeeded", "ok")),
  );
  assert.doesNotThrow(() =>
    normalizeEffectTerminal(terminal("failed", "io_error")),
  );
  assert.throws(
    () => normalizeEffectTerminal(terminal("invalid", "invalid_arguments")),
    /status is not allowed at this source/u,
  );
});

test("framed parser survives split headers and payloads without losing mux order", () => {
  const observed: Record<ToolOutputStream, number[]> = {
    read: [],
    stdout: [],
    stderr: [],
  };
  const order: ToolOutputStream[] = [];
  const parser = createToolOutputFrameParser({
    data(stream, bytes) {
      if (order.at(-1) !== stream) order.push(stream);
      observed[stream].push(...bytes);
    },
  });
  const framed = concatBytes([
    encodeToolOutputData("read", Uint8Array.of(0, 0xff, 10)),
    encodeToolOutputData("stderr", utf8Bytes("tail")),
  ]).copy();

  for (const byte of framed) parser.push(Uint8Array.of(byte));
  const summary = parser.finish();

  assert.deepEqual(order, ["read", "stderr"]);
  assert.deepEqual(observed, {
    read: [0, 0xff, 10],
    stdout: [],
    stderr: [116, 97, 105, 108],
  });
  assert.deepEqual(summary, {
    byteCount: 19,
    payloadBytes: { read: 3, stdout: 0, stderr: 4 },
    recordCount: 2,
    framingByteCount: 12,
    hardLimitReached: false,
    hardLimitStream: null,
  });
});

test("framed tool output accepts Node Buffer as its declared Uint8Array input", async () => {
  const framed = encodeToolOutputData(
    "stdout",
    Uint8Array.of(0x00, 0xff, 0x2a),
  ).copy();
  const parser = createToolOutputFrameParser();
  parser.push(Buffer.from(framed));
  assert.deepEqual(parser.finish(), {
    byteCount: 9,
    payloadBytes: { read: 0, stdout: 3, stderr: 0 },
    recordCount: 1,
    framingByteCount: 6,
    hardLimitReached: false,
    hardLimitStream: null,
  });

  assert.equal(
    bytesEqual(
      encodeToolOutputData("read", Buffer.from([0x01, 0x02])),
      encodeToolOutputData("read", Uint8Array.of(0x01, 0x02)),
    ),
    true,
  );

  const sinkFrames: Uint8Array[] = [];
  const writer = createToolOutputFrameWriter({
    async write(bytes) {
      sinkFrames.push(copyBytes(bytes));
    },
  });
  assert.deepEqual(await writer.write("stderr", Buffer.from([0x03, 0x04])), {
    acceptedBytes: 2,
    hardLimitReached: false,
  });
  assert.deepEqual(await writer.finish(), {
    byteCount: 8,
    payloadBytes: { read: 0, stdout: 0, stderr: 2 },
    recordCount: 1,
    framingByteCount: 6,
    hardLimitReached: false,
    hardLimitStream: null,
  });
  const replay = createToolOutputFrameParser();
  for (const frame of sinkFrames) replay.push(frame);
  assert.deepEqual(replay.finish().payloadBytes, { read: 0, stdout: 0, stderr: 2 });
});

test("framed parser rejects malformed and truncated records", () => {
  const malformed: readonly [Uint8Array, RegExp][] = [
    [Uint8Array.of(9, 0, 0, 0, 0, 1, 1), /unknown stream/u],
    [Uint8Array.of(1, 2, 0, 0, 0, 0), /unknown flags/u],
    [Uint8Array.of(1, 0, 0, 0, 0, 0), /DATA payload is empty/u],
    [Uint8Array.of(1, 1, 0, 0, 0, 1, 0), /HARD_LIMIT has a payload/u],
  ];
  for (const [bytes, expected] of malformed) {
    const parser = createToolOutputFrameParser();
    assert.throws(() => parser.push(bytes), expected);
  }

  const header = createToolOutputFrameParser();
  header.push(Uint8Array.of(1, 0, 0));
  assert.throws(() => header.finish(), /truncated header/u);

  const payload = createToolOutputFrameParser();
  payload.push(Uint8Array.of(1, 0, 0, 0, 0, 2, 42));
  assert.throws(() => payload.finish(), /truncated DATA payload/u);
  assert.throws(
    () => encodeToolOutputData("read", new Uint8Array()),
    /DATA payload length must be in 1\.\.2\^32-1/u,
  );
});

test("HARD_LIMIT must be the single final frame", () => {
  const marker = encodeToolOutputHardLimit("stdout");
  const data = encodeToolOutputData("stderr", Uint8Array.of(1));

  const nonfinal = createToolOutputFrameParser();
  assert.throws(
    () => nonfinal.push(concatBytes([marker, data])),
    /bytes follow HARD_LIMIT/u,
  );

  const duplicate = createToolOutputFrameParser();
  assert.throws(
    () => duplicate.push(concatBytes([marker, marker])),
    /bytes follow HARD_LIMIT/u,
  );

  const final = createToolOutputFrameParser();
  final.push(concatBytes([data, marker]));
  assert.deepEqual(final.finish(), {
    byteCount: 13,
    payloadBytes: { read: 0, stdout: 0, stderr: 1 },
    recordCount: 2,
    framingByteCount: 12,
    hardLimitReached: true,
    hardLimitStream: "stdout",
  });
});

test("writer accepts exactly 16 MiB, emits one final marker, and discards overflow", async () => {
  const parser = createToolOutputFrameParser();
  let sinkWrites = 0;
  const writer = createToolOutputFrameWriter({
    async write(bytes) {
      sinkWrites += 1;
      parser.push(bytes);
    },
  });
  const half = RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES / 2;
  const first = new Uint8Array(half).fill(0x61);
  const second = new Uint8Array(half + 17).fill(0x62);

  assert.deepEqual(await writer.write("stdout", first), {
    acceptedBytes: half,
    hardLimitReached: false,
  });
  assert.deepEqual(await writer.write("stderr", second), {
    acceptedBytes: half,
    hardLimitReached: true,
  });
  assert.deepEqual(await writer.write("read", Uint8Array.of(1, 2, 3)), {
    acceptedBytes: 0,
    hardLimitReached: true,
  });

  const writerSummary = await writer.finish();
  const parserSummary = parser.finish();
  assert.equal(sinkWrites, 3);
  assert.deepEqual(writerSummary, parserSummary);
  assert.deepEqual(writerSummary, {
    byteCount: RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES + 18,
    payloadBytes: { read: 0, stdout: half, stderr: half },
    recordCount: 3,
    framingByteCount: 18,
    hardLimitReached: true,
    hardLimitStream: "stderr",
  });
});

test("concurrent writer calls serialize sink access and retain call order", async () => {
  const frames: Uint8Array[] = [];
  let active = 0;
  let maximumActive = 0;
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const writer = createToolOutputFrameWriter({
    async write(bytes) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      frames.push(copyBytes(bytes));
      if (frames.length === 1) {
        markFirstStarted();
        await firstGate;
      }
      active -= 1;
    },
  });

  const first = writer.write("stdout", utf8Bytes("one"));
  const second = writer.write("stderr", utf8Bytes("two"));
  const third = writer.write("read", utf8Bytes("three"));
  await firstStarted;
  assert.equal(frames.length, 1);
  releaseFirst();
  await Promise.all([first, second, third]);
  const summary = await writer.finish();

  const order: Array<{ readonly stream: ToolOutputStream; readonly text: string }> = [];
  const parser = createToolOutputFrameParser({
    data(stream, bytes) {
      order.push({ stream, text: decoder.decode(bytes) });
    },
  });
  for (const frame of frames) parser.push(frame);
  assert.deepEqual(parser.finish(), summary);
  assert.equal(maximumActive, 1);
  assert.deepEqual(order, [
    { stream: "stdout", text: "one" },
    { stream: "stderr", text: "two" },
    { stream: "read", text: "three" },
  ]);
});

test("writer preserves the first sink failure for queued writes and finish", async () => {
  const failure = new Error("fixture sink failed");
  let calls = 0;
  const writer = createToolOutputFrameWriter({
    async write() {
      calls += 1;
      throw failure;
    },
  });
  const first = writer.write("stdout", Uint8Array.of(1));
  const second = writer.write("stderr", Uint8Array.of(2));
  const isFailure = (error: unknown): boolean => error === failure;

  await assert.rejects(first, isFailure);
  await assert.rejects(second, isFailure);
  await assert.rejects(writer.finish(), isFailure);
  assert.equal(calls, 1);
});

test("static tool-result content is exact, ordered, and closed", () => {
  const cases: readonly [StaticToolResultContent, string][] = [
    [
      { kind: "static", status: "invalid", code: "unknown_tool" },
      '{"status":"invalid","code":"unknown_tool"}',
    ],
    [
      { kind: "static", status: "invalid", code: "invalid_json" },
      '{"status":"invalid","code":"invalid_json"}',
    ],
    [
      { kind: "static", status: "invalid", code: "invalid_arguments" },
      '{"status":"invalid","code":"invalid_arguments"}',
    ],
    [
      { kind: "static", status: "invalid", code: "missing_required_field" },
      '{"status":"invalid","code":"missing_required_field"}',
    ],
    [
      { kind: "static", status: "invalid", code: "unknown_field" },
      '{"status":"invalid","code":"unknown_field"}',
    ],
    [
      { kind: "static", status: "invalid", code: "wrong_type" },
      '{"status":"invalid","code":"wrong_type"}',
    ],
    [
      { kind: "static", status: "denied", code: "permission_denied" },
      '{"status":"denied","code":"permission_denied"}',
    ],
  ];
  for (const [value, expected] of cases) {
    assert.equal(materializeToolResultContent(value), expected);
    assert.deepEqual(parseToolResultContent(expected), value);
  }

  for (const content of [
    '{"code":"unknown_tool","status":"invalid"}',
    '{"status": "invalid","code":"unknown_tool"}',
    '{"status":"denied","code":"unknown_tool"}',
    '{"status":"invalid","code":"unknown_tool","extra":0}',
  ]) {
    assert.throws(() => parseToolResultContent(content), TypeError);
  }
});

test("edit match results carry only an ordered deterministic matchCount variant", () => {
  const noMatch = artifactResult({
    status: "failed",
    code: "edit_no_match",
    matchCount: 0,
    byteCount: 7,
    payloadBytes: { read: 0, stdout: 1, stderr: 0 },
    framingByteCount: 6,
    head: "0",
  });
  const noMatchText = materializeToolResultContent(noMatch);
  assert.match(
    noMatchText,
    /^\{"status":"failed","code":"edit_no_match","matchCount":0,"artifact_id"/u,
  );
  assert.deepEqual(parseToolResultContent(noMatchText), noMatch);

  const notUnique = artifactResult({
    status: "failed",
    code: "edit_not_unique",
    matchCount: 2,
    byteCount: 7,
    payloadBytes: { read: 0, stdout: 1, stderr: 0 },
    framingByteCount: 6,
    head: "2",
  });
  assert.deepEqual(
    parseToolResultContent(materializeToolResultContent(notUnique)),
    notUnique,
  );

  const legacy = artifactResult({
    status: "failed",
    code: "edit_no_match",
    byteCount: 0,
    payloadBytes: { read: 0, stdout: 0, stderr: 0 },
    framingByteCount: 0,
    head: "",
  });
  assert.equal("matchCount" in legacy, false);
  assert.deepEqual(
    parseToolResultContent(materializeToolResultContent(legacy)),
    legacy,
  );

  for (const invalid of [
    { ...noMatch, matchCount: 1 },
    { ...notUnique, matchCount: 1 },
    { ...artifactResult(), matchCount: 0 },
  ]) {
    assert.throws(() => materializeToolResultContent(invalid), TypeError);
  }
  assert.throws(
    () =>
      parseToolResultContent(
        noMatchText.replace(
          '"code":"edit_no_match","matchCount":0',
          '"matchCount":0,"code":"edit_no_match"',
        ),
      ),
    TypeError,
  );
});

test("Artifact-backed tool-result content round-trips one exact canonical shape", () => {
  const value = artifactResult();
  const expected =
    `{"status":"succeeded","code":"ok"` +
    `,"artifact_id":"art_${"1".repeat(32)}"` +
    `,"artifact_ref":"artifacts/sha256/${HASH_HEX}"` +
    `,"artifact_sha256":"sha256:${HASH_HEX}"` +
    `,"byte_count":9,"payload_bytes":{"read":3,"stdout":0,"stderr":0}` +
    `,"framing_byte_count":6,"hard_limit_reached":false` +
    `,"exit_code":null,"signal":null,"encoding":"utf8"` +
    `,"head":"one","tail":"","truncated":false}`;

  assert.equal(materializeToolResultContent(value), expected);
  const parsed = parseToolResultContent(expected);
  assert.deepEqual(parsed, value);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(parsed.kind, "artifact");
  if (parsed.kind !== "artifact") assert.fail("expected Artifact-backed result");
  assert.equal(Object.isFrozen(parsed.payloadBytes), true);

  const wrongIdentity = expected.replace(
    `artifacts/sha256/${HASH_HEX}`,
    `artifacts/sha256/${"b".repeat(64)}`,
  );
  const wrongFraming = expected.replace(
    '"framing_byte_count":6',
    '"framing_byte_count":12',
  );
  const wrongLimit = expected
    .replace(
      '"status":"succeeded","code":"ok"',
      '"status":"failed","code":"output_limit"',
    )
    .replace('"exit_code":null', '"exit_code":137');
  const noncanonical = expected.replace('"byte_count":9', '"byte_count":09');
  for (const content of [wrongIdentity, wrongFraming, wrongLimit, noncanonical]) {
    assert.throws(() => parseToolResultContent(content), TypeError);
  }

  assert.throws(() =>
    parseToolResultContent(
      materializeToolResultContent({
        ...value,
        encoding: "utf8",
        head: "one\0two",
      }),
    ),
  );
});

test("compact Artifact result is closed, ordered, and exposes a ref iff truncated", () => {
  const full = compactArtifactResult();
  const fullText =
    '{"status":"succeeded","code":"ok","hard_limit_reached":false,' +
    '"exit_code":null,"signal":null,"encoding":"utf8",' +
    '"head":"one","tail":"","truncated":false}';
  assert.equal(materializeCompactToolResultContent(full), fullText);
  assert.deepEqual(parseCompactToolResultContent(fullText), full);
  for (const removed of [
    "artifact_id",
    "artifact_sha256",
    "byte_count",
    "payload_bytes",
    "framing_byte_count",
  ]) {
    assert.equal(fullText.includes(removed), false);
  }

  const truncated = compactArtifactResult({
    artifactRef: `artifacts/sha256/${HASH_HEX}`,
    head: "front",
    tail: "back",
    truncated: true,
  });
  const truncatedText = materializeCompactToolResultContent(truncated);
  assert.deepEqual(parseCompactToolResultContent(truncatedText), truncated);
  assert.match(
    truncatedText,
    /"code":"ok","artifact_ref":"artifacts\/sha256\/[a-f0-9]{64}","hard_limit_reached":false/u,
  );

  const hardLimited = compactArtifactResult({
    artifactRef: `artifacts/sha256/${HASH_HEX}`,
    hardLimitReached: true,
    head: "front",
    tail: "back",
    truncated: true,
  });
  assert.deepEqual(
    parseCompactToolResultContent(
      materializeCompactToolResultContent(hardLimited),
    ),
    hardLimited,
  );

  const { artifactRef: _removedRef, ...truncatedWithoutRef } = truncated;
  for (const invalid of [
    { ...full, artifactRef: `artifacts/sha256/${HASH_HEX}` },
    truncatedWithoutRef,
    { ...full, hardLimitReached: true },
  ]) {
    assert.throws(
      () => materializeCompactToolResultContent(invalid),
      TypeError,
    );
  }
  assert.throws(
    () => parseCompactToolResultContent(fullText.replace(
      '"hard_limit_reached"',
      `"artifact_id":"art_${"1".repeat(32)}","hard_limit_reached"`,
    )),
    TypeError,
  );
});

test("read hard-limit content stays succeeded/ok without a process terminal", () => {
  const value = artifactResult({
    byteCount: 15,
    framingByteCount: 12,
    hardLimitReached: true,
  });
  const content = materializeToolResultContent(value);
  const parsed = parseToolResultContent(content);

  assert.deepEqual(parsed, value);
  assert.equal(parsed.status, "succeeded");
  assert.equal(parsed.code, "ok");
  if (parsed.kind !== "artifact") assert.fail("expected Artifact-backed result");
  assert.equal(parsed.hardLimitReached, true);
  assert.equal(parsed.exitCode, null);
  assert.equal(parsed.signal, null);
});

test("outer tool-result measurement uses fully escaped canonical bytes at 32768", () => {
  assert.equal(TOOL_RESULT_PROJECTION_LIMIT_BYTES, 32_768);
  const toolCallId = "call_projection_boundary";
  const empty = artifactResult({
    byteCount: 7,
    payloadBytes: { read: 1, stdout: 0, stderr: 0 },
    head: "",
  });
  const emptyMessage = materializeToolResultMessage(toolCallId, empty);
  const room = TOOL_RESULT_PROJECTION_LIMIT_BYTES - emptyMessage.byteLength;
  assert.ok(room > 0);

  const exact = artifactResult({
    ...empty,
    head: "x".repeat(room),
  });
  const exactContent = materializeToolResultContent(exact);
  const exactMessage = materializeToolResultMessage(toolCallId, exact);
  assert.equal(exactMessage.byteLength, TOOL_RESULT_PROJECTION_LIMIT_BYTES);
  assert.equal(
    bytesEqual(
      exactMessage,
      materializeToolMessage({ toolCallId, content: exactContent }),
    ),
    true,
  );

  const over = materializeToolResultMessage(toolCallId, {
    ...exact,
    head: `${exact.head}x`,
  });
  assert.equal(over.byteLength, TOOL_RESULT_PROJECTION_LIMIT_BYTES + 1);
});
