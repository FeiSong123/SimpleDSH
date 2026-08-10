import assert from "node:assert/strict";
import test from "node:test";

import {
  createToolOutputFrameParser,
  encodeToolOutputData,
  encodeToolOutputHardLimit,
  type ToolOutputStream,
} from "../../src/artifact/tool-output.js";
import type { ToolTerminal } from "../../src/artifact/terminal.js";
import {
  parseCompactToolResultContent,
  TOOL_RESULT_PROJECTION_LIMIT_BYTES,
} from "../../src/bytes/tool-result.js";
import {
  concatBytes,
  sha256Hex,
  utf8Bytes,
} from "../../src/bytes/ops.js";
import type { FrozenBytes } from "../../src/bytes/types.js";
import {
  createArtifactToolResultProjector,
  projectArtifactToolResult,
  ToolResultProjectionError,
  type ProjectedArtifactToolResult,
  type StreamArtifactToolResultInput,
} from "../../src/artifact/tool-result.js";

type ProjectedToolName = "bash" | "read";

interface OutputRecord {
  readonly stream: ToolOutputStream;
  readonly bytes: Uint8Array | FrozenBytes;
}

interface ProjectionFixture {
  readonly input: StreamArtifactToolResultInput;
  readonly framedBytes: FrozenBytes;
  readonly displayBytes: Uint8Array;
}

const ARTIFACT_ID = `art_${"1".repeat(32)}`;

function copyBytes(value: Uint8Array | FrozenBytes): Uint8Array {
  return "copy" in value ? value.copy() : Uint8Array.from(value);
}

function fixture(
  toolName: ProjectedToolName,
  records: readonly OutputRecord[],
  readOffset?: number,
): ProjectionFixture {
  const frames = records.map((record) =>
    encodeToolOutputData(record.stream, record.bytes)
  );
  const framedBytes = concatBytes(frames);
  const displayBytes = Buffer.concat(records.map((record) => copyBytes(record.bytes)));
  const digest = sha256Hex(framedBytes);
  const payloadBytes = { read: 0, stdout: 0, stderr: 0 };
  for (const record of records) {
    payloadBytes[record.stream] += record.bytes.byteLength;
  }
  const terminal: ToolTerminal = toolName === "bash"
    ? Object.freeze({
        status: "succeeded",
        code: "ok",
        exitCode: 0,
        signal: null,
        descendantsReaped: true,
      })
    : Object.freeze({
        status: "succeeded",
        code: "ok",
        exitCode: null,
        signal: null,
        descendantsReaped: null,
      });
  return Object.freeze({
    input: Object.freeze({
      toolCallId: `call_streaming_${toolName}`,
      toolName,
      toolsProfile: "edit-v5",
      resultProfile: "verbose-v1",
      terminalSource: toolName === "bash" ? "effect" : "artifact",
      ...(readOffset === undefined ? {} : { readOffset }),
      artifact: Object.freeze({
        artifactId: ARTIFACT_ID,
        artifactRef: `artifacts/sha256/${digest}`,
        artifactSha256: `sha256:${digest}`,
        byteCount: framedBytes.byteLength,
        payloadBytes: Object.freeze(payloadBytes),
        hardLimitReached: false,
      }),
      terminal,
    }),
    framedBytes,
    displayBytes,
  });
}

function feedByPattern(
  input: StreamArtifactToolResultInput,
  framedBytes: FrozenBytes,
  pattern: readonly number[],
): ProjectedArtifactToolResult {
  assert.ok(pattern.length > 0);
  assert.equal(pattern.every((size) => Number.isSafeInteger(size) && size > 0), true);
  const projector = createArtifactToolResultProjector(input);
  const bytes = framedBytes.copy();
  let offset = 0;
  let ordinal = 0;
  while (offset < bytes.byteLength) {
    const size = pattern[ordinal % pattern.length];
    if (size === undefined) throw new TypeError("split pattern is incomplete");
    const end = Math.min(bytes.byteLength, offset + size);
    projector.push(bytes.subarray(offset, end));
    offset = end;
    ordinal += 1;
  }
  return projector.finish();
}

function eager(value: ProjectionFixture): ProjectedArtifactToolResult {
  return projectArtifactToolResult({
    ...value.input,
    framedBytes: value.framedBytes,
  });
}

function assertSameProjection(
  expected: ProjectedArtifactToolResult,
  actual: ProjectedArtifactToolResult,
): void {
  assert.deepEqual(actual.content, expected.content);
  assert.equal(actual.contentText, expected.contentText);
  assert.deepEqual(actual.messageBytes.copy(), expected.messageBytes.copy());
  assert.ok(actual.messageBytes.byteLength <= TOOL_RESULT_PROJECTION_LIMIT_BYTES);
}

test("streaming projection equals eager projection across one-byte and arbitrary splits", () => {
  const value = fixture("bash", [
    { stream: "stdout", bytes: Uint8Array.of(0xef) },
    { stream: "stderr", bytes: Uint8Array.of(0xbb) },
    { stream: "stdout", bytes: Uint8Array.of(0xbf, 0x41, 0xf0, 0x9f) },
    { stream: "stderr", bytes: Uint8Array.of(0x99, 0x82, 0x42) },
  ]);
  const expected = eager(value);

  assert.equal(expected.content.encoding, "utf8");
  assert.equal(expected.content.head, "\ufeffA\u{1f642}B");
  assert.equal(expected.content.tail, "");
  assert.equal(expected.content.truncated, false);
  for (const pattern of [[1], [2, 7, 3, 11, 5], [6, 1, 13, 2]]) {
    assertSameProjection(expected, feedByPattern(value.input, value.framedBytes, pattern));
  }
});

test("bash cleanup observation is excluded from provider-visible result bytes", () => {
  const value = fixture("bash", [
    { stream: "stdout", bytes: utf8Bytes("same provider result") },
  ]);
  const reaped = eager(value);
  const notReaped = projectArtifactToolResult({
    ...value.input,
    terminal: Object.freeze({
      ...value.input.terminal,
      descendantsReaped: false,
    }),
    framedBytes: value.framedBytes,
  });

  assert.deepEqual(notReaped.content, reaped.content);
  assert.deepEqual(notReaped.messageBytes.copy(), reaped.messageBytes.copy());
  assert.equal(notReaped.contentText.includes("descendants"), false);
});

test("streaming projection rejects a terminal from the wrong durable source phase", () => {
  const bash = fixture("bash", [
    { stream: "stdout", bytes: utf8Bytes("effect output") },
  ]);
  assertProjectionFails(
    Object.freeze({ ...bash.input, terminalSource: "artifact" }),
    bash.framedBytes,
  );

  const read = fixture("read", [
    { stream: "read", bytes: utf8Bytes("observation\n") },
  ]);
  assertProjectionFails(
    Object.freeze({ ...read.input, terminalSource: "effect" }),
    read.framedBytes,
  );
});

test("late invalid UTF-8 and NUL select exact unnumbered base64", () => {
  const cases = [
    fixture("bash", [
      { stream: "stdout", bytes: utf8Bytes("valid \u{1f642}") },
      { stream: "stderr", bytes: Uint8Array.of(0xff) },
    ]),
    fixture("bash", [
      { stream: "stdout", bytes: utf8Bytes("left") },
      { stream: "stderr", bytes: Uint8Array.of(0, 0x72, 0x69, 0x67, 0x68, 0x74) },
    ]),
    fixture("read", [
      { stream: "read", bytes: utf8Bytes("text\n") },
      { stream: "read", bytes: Uint8Array.of(0xff, 0x0a) },
    ], 37),
  ];

  for (const value of cases) {
    const expectedHead = Buffer.from(value.displayBytes).toString("base64");
    const expected = eager(value);
    assert.equal(expected.content.encoding, "base64");
    assert.equal(expected.content.head, expectedHead);
    assert.equal(expected.content.tail, "");
    assert.equal(expected.content.truncated, false);
    assertSameProjection(
      expected,
      feedByPattern(value.input, value.framedBytes, [1, 5, 2, 8, 3]),
    );
  }
});

test("read line numbering preserves empty records, trailing LF, and MAX_SAFE offset", () => {
  const offset = Number.MAX_SAFE_INTEGER;
  const value = fixture("read", [
    { stream: "read", bytes: utf8Bytes("\nalpha") },
    { stream: "read", bytes: utf8Bytes("\n\nomega\n") },
  ], offset);
  const expected = eager(value);

  assert.equal(expected.content.encoding, "utf8");
  assert.equal(
    expected.content.head,
    "9007199254740992\t\n" +
      "9007199254740993\talpha\n" +
      "9007199254740994\t\n" +
      "9007199254740995\tomega\n",
  );
  assert.equal(expected.content.tail, "");
  assert.equal(expected.content.truncated, false);
  assertSameProjection(
    expected,
    feedByPattern(value.input, value.framedBytes, [1]),
  );

  const empty = fixture("read", [], offset);
  const emptyExpected = eager(empty);
  assert.equal(emptyExpected.content.encoding, "utf8");
  assert.equal(emptyExpected.content.head, "");
  assert.equal(emptyExpected.content.tail, "");
  assert.equal(emptyExpected.content.truncated, false);
  assertSameProjection(emptyExpected, feedByPattern(empty.input, empty.framedBytes, [1]));
});

test("base64 projection preserves modulo-three padding across framed mux records", () => {
  const cases = [
    Uint8Array.of(0xff),
    Uint8Array.of(0xff, 0xfe),
    Uint8Array.of(0xff, 0xfe, 0xfd),
  ];
  for (const bytes of cases) {
    const records: OutputRecord[] = bytes.byteLength === 1
      ? [{ stream: "stdout", bytes }]
      : [
          { stream: "stdout", bytes: bytes.subarray(0, 1) },
          { stream: "stderr", bytes: bytes.subarray(1) },
        ];
    const value = fixture("bash", records);
    const expected = eager(value);
    const expectedBase64 = Buffer.from(bytes).toString("base64");
    assert.equal(expected.content.encoding, "base64");
    assert.equal(expected.content.head, expectedBase64);
    assert.equal(expected.content.head.length % 4, 0);
    assert.equal(expected.content.tail, "");
    assert.equal(expected.content.truncated, false);
    assertSameProjection(
      expected,
      feedByPattern(value.input, value.framedBytes, [2, 1, 4, 3]),
    );
  }
});

test("truncated base64 keeps exact non-overlapping head and tail quanta", () => {
  const bytes = new Uint8Array(30_002);
  bytes.fill(0xa5);
  bytes[bytes.byteLength - 1] = 0xff;
  const value = fixture("bash", [
    { stream: "stdout", bytes: bytes.subarray(0, 10_001) },
    { stream: "stderr", bytes: bytes.subarray(10_001, 20_000) },
    { stream: "stdout", bytes: bytes.subarray(20_000) },
  ]);
  const expected = eager(value);
  const full = Buffer.from(bytes).toString("base64");

  assert.equal(expected.content.encoding, "base64");
  assert.equal(expected.content.truncated, true);
  assert.equal(expected.content.head.length % 4, 0);
  assert.equal(expected.content.tail.length % 4, 0);
  assert.equal(expected.content.head.includes("="), false);
  assert.equal(full.startsWith(expected.content.head), true);
  assert.equal(full.endsWith(expected.content.tail), true);
  assert.ok(expected.content.head.length + expected.content.tail.length < full.length);
  assertSameProjection(
    expected,
    feedByPattern(value.input, value.framedBytes, [1_003, 7, 64, 2_047]),
  );
});

test("compact v2 removes only durable metadata after the exact verbose display fit", () => {
  for (const value of [
    fixture("bash", [{ stream: "stdout", bytes: utf8Bytes("small utf8\n") }]),
    fixture("bash", [{ stream: "stdout", bytes: Uint8Array.of(0xff, 0x00, 0x7f) }]),
    fixture("bash", [{ stream: "stdout", bytes: utf8Bytes("x".repeat(50_000)) }]),
  ]) {
    const verbose = projectArtifactToolResult({
      ...value.input,
      resultProfile: "verbose-v1",
      framedBytes: value.framedBytes,
    });
    const compact = projectArtifactToolResult({
      ...value.input,
      resultProfile: "compact-v2",
      framedBytes: value.framedBytes,
    });
    assert.equal("artifactId" in verbose.content, true);
    assert.equal("artifactId" in compact.content, false);
    assert.deepEqual(
      {
        status: compact.content.status,
        code: compact.content.code,
        matchCount: compact.content.matchCount,
        hardLimitReached: compact.content.hardLimitReached,
        exitCode: compact.content.exitCode,
        signal: compact.content.signal,
        encoding: compact.content.encoding,
        head: compact.content.head,
        tail: compact.content.tail,
        truncated: compact.content.truncated,
      },
      {
        status: verbose.content.status,
        code: verbose.content.code,
        matchCount: verbose.content.matchCount,
        hardLimitReached: verbose.content.hardLimitReached,
        exitCode: verbose.content.exitCode,
        signal: verbose.content.signal,
        encoding: verbose.content.encoding,
        head: verbose.content.head,
        tail: verbose.content.tail,
        truncated: verbose.content.truncated,
      },
    );
    assert.equal(
      compact.content.artifactRef,
      compact.content.truncated && "artifactRef" in verbose.content
        ? verbose.content.artifactRef
        : undefined,
    );
    assert.ok(compact.messageBytes.byteLength < verbose.messageBytes.byteLength);
    assert.deepEqual(
      parseCompactToolResultContent(compact.contentText),
      compact.content,
    );
  }
});

test("compact v2 preserves active edit matchCount without verbose identity fields", () => {
  const framed = encodeToolOutputData("stdout", utf8Bytes("2"));
  const input = editMatchInput("edit-v5", "edit_not_unique", framed);
  const verbose = projectArtifactToolResult({
    ...input,
    resultProfile: "verbose-v1",
    framedBytes: framed,
  });
  const compact = projectArtifactToolResult({
    ...input,
    resultProfile: "compact-v2",
    framedBytes: framed,
  });
  assert.equal(compact.content.matchCount, 2);
  assert.equal(compact.content.head, verbose.content.head);
  assert.equal(compact.content.truncated, false);
  assert.equal(compact.content.artifactRef, undefined);
  assert.equal("artifactId" in compact.content, false);
});

function malformedInput(
  framedBytes: FrozenBytes,
  toolName: ProjectedToolName = "bash",
): StreamArtifactToolResultInput {
  const digest = sha256Hex(framedBytes);
  return Object.freeze({
    toolCallId: "call_malformed_projection",
    toolName,
    toolsProfile: "edit-v5",
    resultProfile: "verbose-v1",
    terminalSource: toolName === "bash" ? "effect" : "artifact",
    artifact: Object.freeze({
      artifactId: ARTIFACT_ID,
      artifactRef: `artifacts/sha256/${digest}`,
      artifactSha256: `sha256:${digest}`,
      byteCount: framedBytes.byteLength,
      payloadBytes: Object.freeze({ read: 0, stdout: 0, stderr: 0 }),
      hardLimitReached: false,
    }),
    terminal: Object.freeze({
      status: "succeeded",
      code: "ok",
      exitCode: toolName === "bash" ? 0 : null,
      signal: null,
      descendantsReaped: toolName === "bash" ? true : null,
    }),
  });
}

function assertProjectionFails(
  input: StreamArtifactToolResultInput,
  framedBytes: FrozenBytes,
  pattern: readonly number[] = [1],
): void {
  assert.throws(
    () => feedByPattern(input, framedBytes, pattern),
    ToolResultProjectionError,
  );
}

function editMatchInput(
  toolsProfile: "edit-v5" | "edit-v4",
  code: "edit_no_match" | "edit_not_unique",
  framedBytes: FrozenBytes,
): StreamArtifactToolResultInput {
  const parser = createToolOutputFrameParser();
  parser.push(framedBytes);
  const summary = parser.finish();
  const digest = sha256Hex(framedBytes);
  return Object.freeze({
    toolCallId: "call_edit_match_projection",
    toolName: "edit",
    toolsProfile,
    resultProfile: "verbose-v1",
    terminalSource: "artifact",
    artifact: Object.freeze({
      artifactId: ARTIFACT_ID,
      artifactRef: `artifacts/sha256/${digest}`,
      artifactSha256: `sha256:${digest}`,
      byteCount: summary.byteCount,
      payloadBytes: summary.payloadBytes,
      hardLimitReached: summary.hardLimitReached,
    }),
    terminal: Object.freeze({
      status: "failed",
      code,
      exitCode: null,
      signal: null,
      descendantsReaped: null,
    }),
  });
}

test("active edit match count projects identically while legacy remains empty", () => {
  for (const [code, count] of [
    ["edit_no_match", 0],
    ["edit_not_unique", 2],
    ["edit_not_unique", Number.MAX_SAFE_INTEGER],
  ] as const) {
    const text = String(count);
    const framed = encodeToolOutputData("stdout", utf8Bytes(text));
    const input = editMatchInput("edit-v5", code, framed);
    const projected = projectArtifactToolResult({
      ...input,
      framedBytes: framed,
    });
    assert.equal(projected.content.matchCount, count);
    assert.equal(projected.content.encoding, "utf8");
    assert.equal(projected.content.head, text);
    assert.equal(projected.content.tail, "");
    assert.equal(projected.content.truncated, false);
    assertSameProjection(projected, feedByPattern(input, framed, [1]));
  }

  const empty = concatBytes([]);
  const legacyInput = editMatchInput("edit-v4", "edit_no_match", empty);
  const legacy = projectArtifactToolResult({
    ...legacyInput,
    framedBytes: empty,
  });
  assert.equal("matchCount" in legacy.content, false);
  assert.equal(legacy.content.head, "");
});

test("edit match count rejects count, stream, record, and profile tampering", () => {
  const empty = concatBytes([]);
  assertProjectionFails(
    editMatchInput("edit-v5", "edit_no_match", empty),
    empty,
  );

  for (const framed of [
    encodeToolOutputData("stderr", utf8Bytes("2")),
    encodeToolOutputData("stdout", utf8Bytes("02")),
    encodeToolOutputData("stdout", utf8Bytes("-1")),
    encodeToolOutputData("stdout", utf8Bytes("9007199254740992")),
    concatBytes([
      encodeToolOutputData("stdout", utf8Bytes("2")),
      encodeToolOutputData("stdout", utf8Bytes("3")),
    ]),
  ]) {
    assertProjectionFails(
      editMatchInput("edit-v5", "edit_not_unique", framed),
      framed,
    );
  }

  const wrongRelation = encodeToolOutputData("stdout", utf8Bytes("2"));
  assertProjectionFails(
    editMatchInput("edit-v5", "edit_no_match", wrongRelation),
    wrongRelation,
  );
  assertProjectionFails(
    editMatchInput("edit-v4", "edit_not_unique", wrongRelation),
    wrongRelation,
  );
});

test("streaming projection fails closed on malformed framing and tool streams", () => {
  const malformed = [
    concatBytes([Uint8Array.of(2, 0, 0)]),
    concatBytes([Uint8Array.of(2, 0, 0, 0, 0, 2, 0x61)]),
    concatBytes([Uint8Array.of(9, 0, 0, 0, 0, 1, 0x61)]),
    concatBytes([Uint8Array.of(2, 2, 0, 0, 0, 0)]),
    concatBytes([Uint8Array.of(2, 0, 0, 0, 0, 0)]),
    concatBytes([
      encodeToolOutputHardLimit("stdout"),
      encodeToolOutputData("stdout", Uint8Array.of(0x61)),
    ]),
    concatBytes([
      encodeToolOutputHardLimit("stdout"),
      encodeToolOutputHardLimit("stdout"),
    ]),
  ];
  for (const framedBytes of malformed) {
    assertProjectionFails(malformedInput(framedBytes), framedBytes);
  }

  const wrongReadStream = encodeToolOutputData("stdout", utf8Bytes("not read"));
  assertProjectionFails(
    malformedInput(wrongReadStream, "read"),
    wrongReadStream,
    [2, 5, 1],
  );

  const valid = encodeToolOutputData("stdout", utf8Bytes("metadata mismatch"));
  assertProjectionFails(malformedInput(valid), valid, [3, 1, 9]);
});
