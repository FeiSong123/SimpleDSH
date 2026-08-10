import { normalizeToolTerminal } from "../artifact/terminal.js";
import type {
  ToolSignal,
  ToolTerminal,
  ToolTerminalCode,
} from "../artifact/terminal.js";
import { assertUnicodeScalarString } from "./ops.js";
import { materializeToolMessage } from "./tool.js";
import { asToolCallId } from "./tool-call-id.js";
import type { ToolCallId } from "./tool-call-id.js";
import type { FrozenBytes } from "./types.js";

export const TOOL_RESULT_PROJECTION_LIMIT_BYTES = 32_768;

export type ToolResultProfile = "verbose-v1" | "compact-v2";

export interface ToolResultPayloadBytes {
  readonly read: number;
  readonly stdout: number;
  readonly stderr: number;
}

export interface StaticToolResultContent {
  readonly kind: "static";
  readonly status: "invalid" | "denied";
  readonly code:
    | "unknown_tool"
    | "invalid_json"
    | "invalid_arguments"
    | "missing_required_field"
    | "unknown_field"
    | "wrong_type"
    | "permission_denied";
}

export interface ArtifactToolResultContent {
  readonly kind: "artifact";
  readonly status: ToolTerminal["status"];
  readonly code: ToolTerminalCode;
  readonly matchCount?: number;
  readonly artifactId: string;
  readonly artifactRef: string;
  readonly artifactSha256: string;
  readonly byteCount: number;
  readonly payloadBytes: ToolResultPayloadBytes;
  readonly framingByteCount: number;
  readonly hardLimitReached: boolean;
  readonly exitCode: number | null;
  readonly signal: ToolSignal | null;
  readonly encoding: "utf8" | "base64";
  readonly head: string;
  readonly tail: string;
  readonly truncated: boolean;
}

export type ToolResultContent =
  | StaticToolResultContent
  | ArtifactToolResultContent;

export interface CompactArtifactToolResultContent {
  readonly kind: "artifact";
  readonly status: ToolTerminal["status"];
  readonly code: ToolTerminalCode;
  readonly matchCount?: number;
  readonly artifactRef?: string;
  readonly hardLimitReached: boolean;
  readonly exitCode: number | null;
  readonly signal: ToolSignal | null;
  readonly encoding: "utf8" | "base64";
  readonly head: string;
  readonly tail: string;
  readonly truncated: boolean;
}

export type CompactToolResultContent =
  | StaticToolResultContent
  | CompactArtifactToolResultContent;

const artifactIdPattern = /^art_[0-9a-f]{32}$/u;
const artifactRefPattern = /^artifacts\/sha256\/([0-9a-f]{64})$/u;
const sha256Pattern = /^sha256:([0-9a-f]{64})$/u;

function contentError(message: string): TypeError {
  return new TypeError(`invalid canonical tool result content: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactOrderedKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw contentError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function scalarString(value: unknown, label: string): string {
  if (typeof value !== "string") throw contentError(`${label} must be a string`);
  try {
    assertUnicodeScalarString(value, label);
  } catch {
    throw contentError(`${label} must be a Unicode-scalar string`);
  }
  return value;
}

function normalizePayloadBytes(value: unknown): ToolResultPayloadBytes {
  if (
    !isRecord(value) ||
    !hasExactOrderedKeys(value, ["read", "stdout", "stderr"])
  ) {
    throw contentError("payload_bytes must be a closed ordered record");
  }
  const read = nonNegativeSafeInteger(value["read"], "payload_bytes.read");
  const stdout = nonNegativeSafeInteger(value["stdout"], "payload_bytes.stdout");
  const stderr = nonNegativeSafeInteger(value["stderr"], "payload_bytes.stderr");
  if (!Number.isSafeInteger(read + stdout + stderr)) {
    throw contentError("payload_bytes sum exceeds the safe integer range");
  }
  return Object.freeze({ read, stdout, stderr });
}

function normalizeStatic(
  status: unknown,
  code: unknown,
): StaticToolResultContent {
  if (
    (status === "invalid" &&
      (code === "unknown_tool" ||
        code === "invalid_json" ||
        code === "invalid_arguments" ||
        code === "missing_required_field" ||
        code === "unknown_field" ||
        code === "wrong_type")) ||
    (status === "denied" && code === "permission_denied")
  ) {
    return Object.freeze({
      kind: "static",
      status,
      code,
    }) as StaticToolResultContent;
  }
  throw contentError("static status/code pair is not allowed");
}

function normalizeDisplay(
  encodingValue: unknown,
  headValue: unknown,
  tailValue: unknown,
  truncatedValue: unknown,
): Pick<ArtifactToolResultContent, "encoding" | "head" | "tail" | "truncated"> {
  if (encodingValue !== "utf8" && encodingValue !== "base64") {
    throw contentError("encoding must be utf8 or base64");
  }
  const head = scalarString(headValue, "head");
  const tail = scalarString(tailValue, "tail");
  if (typeof truncatedValue !== "boolean") {
    throw contentError("truncated must be boolean");
  }
  if (!truncatedValue && tail !== "") {
    throw contentError("an untruncated result must have an empty tail");
  }
  if (encodingValue === "utf8") {
    if (head.includes("\0") || tail.includes("\0")) {
      throw contentError("utf8 display must not contain NUL");
    }
  } else {
    const base64Part = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
    if (!base64Part.test(head) || !base64Part.test(tail)) {
      throw contentError("base64 display is not quantum-aligned canonical text");
    }
    if (truncatedValue && head.includes("=")) {
      throw contentError("a truncated base64 head cannot contain padding");
    }
  }
  return Object.freeze({
    encoding: encodingValue,
    head,
    tail,
    truncated: truncatedValue,
  });
}

function normalizeArtifactRecord(
  value: Record<string, unknown>,
): ArtifactToolResultContent {
  const hasMatchCount = Object.prototype.hasOwnProperty.call(
    value,
    "matchCount",
  );
  if (
    !hasExactOrderedKeys(value, [
      "status",
      "code",
      ...(hasMatchCount ? ["matchCount"] : []),
      "artifact_id",
      "artifact_ref",
      "artifact_sha256",
      "byte_count",
      "payload_bytes",
      "framing_byte_count",
      "hard_limit_reached",
      "exit_code",
      "signal",
      "encoding",
      "head",
      "tail",
      "truncated",
    ])
  ) {
    throw contentError("Artifact-backed fields are not closed and ordered");
  }
  let terminal: ToolTerminal;
  try {
    terminal = normalizeToolTerminal({
      status: value["status"],
      code: value["code"],
      exitCode: value["exit_code"],
      signal: value["signal"],
      descendantsReaped: null,
    });
  } catch {
    throw contentError("terminal fields are invalid");
  }
  let matchCount: number | undefined;
  if (hasMatchCount) {
    matchCount = nonNegativeSafeInteger(value["matchCount"], "matchCount");
    if (
      (terminal.code === "edit_no_match" && matchCount !== 0) ||
      (terminal.code === "edit_not_unique" && matchCount < 2) ||
      (terminal.code !== "edit_no_match" &&
        terminal.code !== "edit_not_unique")
    ) {
      throw contentError("matchCount does not match the edit terminal code");
    }
  }
  const artifactId = scalarString(value["artifact_id"], "artifact_id");
  const artifactRef = scalarString(value["artifact_ref"], "artifact_ref");
  const artifactSha256 = scalarString(
    value["artifact_sha256"],
    "artifact_sha256",
  );
  const refMatch = artifactRefPattern.exec(artifactRef);
  const hashMatch = sha256Pattern.exec(artifactSha256);
  if (
    !artifactIdPattern.test(artifactId) ||
    refMatch === null ||
    hashMatch === null ||
    refMatch[1] !== hashMatch[1]
  ) {
    throw contentError("Artifact identity is invalid or inconsistent");
  }
  const byteCount = nonNegativeSafeInteger(value["byte_count"], "byte_count");
  const payloadBytes = normalizePayloadBytes(value["payload_bytes"]);
  const framingByteCount = nonNegativeSafeInteger(
    value["framing_byte_count"],
    "framing_byte_count",
  );
  const payloadByteCount =
    payloadBytes.read + payloadBytes.stdout + payloadBytes.stderr;
  if (
    framingByteCount % 6 !== 0 ||
    !Number.isSafeInteger(payloadByteCount + framingByteCount) ||
    payloadByteCount + framingByteCount !== byteCount
  ) {
    throw contentError("framing equation does not match byte_count");
  }
  if (typeof value["hard_limit_reached"] !== "boolean") {
    throw contentError("hard_limit_reached must be boolean");
  }
  const hardLimitReached = value["hard_limit_reached"];
  if (
    (terminal.code === "output_limit" && !hardLimitReached) ||
    (hardLimitReached && terminal.code !== "output_limit" && terminal.code !== "ok")
  ) {
    throw contentError("terminal code does not match hard-limit state");
  }
  const display = normalizeDisplay(
    value["encoding"],
    value["head"],
    value["tail"],
    value["truncated"],
  );
  return Object.freeze({
    kind: "artifact",
    status: terminal.status,
    code: terminal.code,
    ...(matchCount === undefined ? {} : { matchCount }),
    artifactId,
    artifactRef,
    artifactSha256,
    byteCount,
    payloadBytes,
    framingByteCount,
    hardLimitReached,
    exitCode: terminal.exitCode,
    signal: terminal.signal,
    ...display,
  });
}

function normalizeCompactArtifactRecord(
  value: Record<string, unknown>,
): CompactArtifactToolResultContent {
  const hasMatchCount = Object.prototype.hasOwnProperty.call(
    value,
    "matchCount",
  );
  const hasArtifactRef = Object.prototype.hasOwnProperty.call(
    value,
    "artifact_ref",
  );
  if (
    !hasExactOrderedKeys(value, [
      "status",
      "code",
      ...(hasMatchCount ? ["matchCount"] : []),
      ...(hasArtifactRef ? ["artifact_ref"] : []),
      "hard_limit_reached",
      "exit_code",
      "signal",
      "encoding",
      "head",
      "tail",
      "truncated",
    ])
  ) {
    throw contentError("compact Artifact-backed fields are not closed and ordered");
  }
  let terminal: ToolTerminal;
  try {
    terminal = normalizeToolTerminal({
      status: value["status"],
      code: value["code"],
      exitCode: value["exit_code"],
      signal: value["signal"],
      descendantsReaped: null,
    });
  } catch {
    throw contentError("terminal fields are invalid");
  }
  let matchCount: number | undefined;
  if (hasMatchCount) {
    matchCount = nonNegativeSafeInteger(value["matchCount"], "matchCount");
    if (
      (terminal.code === "edit_no_match" && matchCount !== 0) ||
      (terminal.code === "edit_not_unique" && matchCount < 2) ||
      (terminal.code !== "edit_no_match" &&
        terminal.code !== "edit_not_unique")
    ) {
      throw contentError("matchCount does not match the edit terminal code");
    }
  }
  let artifactRef: string | undefined;
  if (hasArtifactRef) {
    artifactRef = scalarString(value["artifact_ref"], "artifact_ref");
    if (!artifactRefPattern.test(artifactRef)) {
      throw contentError("Artifact reference is invalid");
    }
  }
  if (typeof value["hard_limit_reached"] !== "boolean") {
    throw contentError("hard_limit_reached must be boolean");
  }
  const hardLimitReached = value["hard_limit_reached"];
  if (
    (terminal.code === "output_limit" && !hardLimitReached) ||
    (hardLimitReached && terminal.code !== "output_limit" && terminal.code !== "ok")
  ) {
    throw contentError("terminal code does not match hard-limit state");
  }
  const display = normalizeDisplay(
    value["encoding"],
    value["head"],
    value["tail"],
    value["truncated"],
  );
  if (
    hasArtifactRef !== display.truncated ||
    (hardLimitReached && !display.truncated)
  ) {
    throw contentError("compact Artifact handle does not match truncation state");
  }
  return Object.freeze({
    kind: "artifact",
    status: terminal.status,
    code: terminal.code,
    ...(matchCount === undefined ? {} : { matchCount }),
    ...(artifactRef === undefined ? {} : { artifactRef }),
    hardLimitReached,
    exitCode: terminal.exitCode,
    signal: terminal.signal,
    ...display,
  });
}

function quote(value: string): string {
  return JSON.stringify(value);
}

export function materializeToolResultContent(value: ToolResultContent): string {
  if (value.kind === "static") {
    const checked = normalizeStatic(value.status, value.code);
    return `{"status":${quote(checked.status)},"code":${quote(checked.code)}}`;
  }
  const checked = normalizeArtifactRecord({
    status: value.status,
    code: value.code,
    ...(value.matchCount === undefined
      ? {}
      : { matchCount: value.matchCount }),
    artifact_id: value.artifactId,
    artifact_ref: value.artifactRef,
    artifact_sha256: value.artifactSha256,
    byte_count: value.byteCount,
    payload_bytes: {
      read: value.payloadBytes.read,
      stdout: value.payloadBytes.stdout,
      stderr: value.payloadBytes.stderr,
    },
    framing_byte_count: value.framingByteCount,
    hard_limit_reached: value.hardLimitReached,
    exit_code: value.exitCode,
    signal: value.signal,
    encoding: value.encoding,
    head: value.head,
    tail: value.tail,
    truncated: value.truncated,
  });
  return (
    `{"status":${quote(checked.status)},"code":${quote(checked.code)}` +
    (checked.matchCount === undefined
      ? ""
      : `,"matchCount":${String(checked.matchCount)}`) +
    `,"artifact_id":${quote(checked.artifactId)}` +
    `,"artifact_ref":${quote(checked.artifactRef)}` +
    `,"artifact_sha256":${quote(checked.artifactSha256)}` +
    `,"byte_count":${String(checked.byteCount)}` +
    `,"payload_bytes":{"read":${String(checked.payloadBytes.read)}` +
    `,"stdout":${String(checked.payloadBytes.stdout)}` +
    `,"stderr":${String(checked.payloadBytes.stderr)}}` +
    `,"framing_byte_count":${String(checked.framingByteCount)}` +
    `,"hard_limit_reached":${String(checked.hardLimitReached)}` +
    `,"exit_code":${checked.exitCode === null ? "null" : String(checked.exitCode)}` +
    `,"signal":${checked.signal === null ? "null" : quote(checked.signal)}` +
    `,"encoding":${quote(checked.encoding)}` +
    `,"head":${quote(checked.head)},"tail":${quote(checked.tail)}` +
    `,"truncated":${String(checked.truncated)}}`
  );
}

export function materializeCompactToolResultContent(
  value: CompactToolResultContent,
): string {
  if (value.kind === "static") return materializeToolResultContent(value);
  const checked = normalizeCompactArtifactRecord({
    status: value.status,
    code: value.code,
    ...(value.matchCount === undefined
      ? {}
      : { matchCount: value.matchCount }),
    ...(value.artifactRef === undefined
      ? {}
      : { artifact_ref: value.artifactRef }),
    hard_limit_reached: value.hardLimitReached,
    exit_code: value.exitCode,
    signal: value.signal,
    encoding: value.encoding,
    head: value.head,
    tail: value.tail,
    truncated: value.truncated,
  });
  return (
    `{"status":${quote(checked.status)},"code":${quote(checked.code)}` +
    (checked.matchCount === undefined
      ? ""
      : `,"matchCount":${String(checked.matchCount)}`) +
    (checked.artifactRef === undefined
      ? ""
      : `,"artifact_ref":${quote(checked.artifactRef)}`) +
    `,"hard_limit_reached":${String(checked.hardLimitReached)}` +
    `,"exit_code":${checked.exitCode === null ? "null" : String(checked.exitCode)}` +
    `,"signal":${checked.signal === null ? "null" : quote(checked.signal)}` +
    `,"encoding":${quote(checked.encoding)}` +
    `,"head":${quote(checked.head)},"tail":${quote(checked.tail)}` +
    `,"truncated":${String(checked.truncated)}}`
  );
}

export function parseToolResultContent(content: string): ToolResultContent {
  scalarString(content, "tool result content");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw contentError("content is not JSON");
  }
  if (!isRecord(parsed)) throw contentError("content must be a closed record");
  const keys = Object.keys(parsed);
  const normalized =
    keys.length === 2
      ? (() => {
          if (!hasExactOrderedKeys(parsed, ["status", "code"])) {
            throw contentError("static fields are not ordered");
          }
          return normalizeStatic(parsed["status"], parsed["code"]);
        })()
      : normalizeArtifactRecord(parsed);
  if (materializeToolResultContent(normalized) !== content) {
    throw contentError("content is not canonical");
  }
  return normalized;
}

export function parseCompactToolResultContent(
  content: string,
): CompactToolResultContent {
  scalarString(content, "tool result content");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw contentError("content is not JSON");
  }
  if (!isRecord(parsed)) throw contentError("content must be a closed record");
  const keys = Object.keys(parsed);
  const normalized =
    keys.length === 2
      ? (() => {
          if (!hasExactOrderedKeys(parsed, ["status", "code"])) {
            throw contentError("static fields are not ordered");
          }
          return normalizeStatic(parsed["status"], parsed["code"]);
        })()
      : normalizeCompactArtifactRecord(parsed);
  if (materializeCompactToolResultContent(normalized) !== content) {
    throw contentError("content is not canonical");
  }
  return normalized;
}

export function parseToolResultContentForProfile(
  content: string,
  profile: ToolResultProfile,
): ToolResultContent | CompactToolResultContent {
  return profile === "compact-v2"
    ? parseCompactToolResultContent(content)
    : parseToolResultContent(content);
}

export function materializeToolResultMessage(
  toolCallIdValue: string,
  content: ToolResultContent | CompactToolResultContent,
): FrozenBytes {
  const toolCallId: ToolCallId = asToolCallId(toolCallIdValue);
  return materializeToolMessage({
    toolCallId,
    content:
      content.kind === "artifact" && !("artifactId" in content)
        ? materializeCompactToolResultContent(content)
        : materializeToolResultContent(content),
  });
}

export function materializeCompactToolResultMessage(
  toolCallIdValue: string,
  content: CompactToolResultContent,
): FrozenBytes {
  const toolCallId: ToolCallId = asToolCallId(toolCallIdValue);
  return materializeToolMessage({
    toolCallId,
    content: materializeCompactToolResultContent(content),
  });
}
