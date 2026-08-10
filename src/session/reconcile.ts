import {
  createToolOutputFrameWriter,
  normalizeEffectTerminal,
  RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES,
  TOOL_OUTPUT_MEDIA_TYPE,
  validateToolTerminalForSource,
  type ArtifactDescriptor,
  type EffectTerminal,
  type ToolOutputFrameSummary,
  type ToolOutputStream,
} from "../artifact/index.js";
import {
  assertUnicodeScalarString,
  bytesEqual,
  concatBytes,
  fromBase64,
  sha256Hex,
} from "../bytes/ops.js";
import { freezeBytes, type FrozenBytes } from "../bytes/types.js";
import {
  newArtifactId,
  type AnyVerifiedJournalEvent,
  type EffectId,
  type EventId,
  type LineageId,
  type OpenJournalResult,
  type RecoveryViewV1,
  type RunId,
  type SessionId,
  type ToolCallId,
  type VerifiedJournalEvent,
} from "../journal/index.js";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_RECONCILIATION_EVIDENCE_BYTES = 32 * 1024 * 1024;
const MAX_OPERATOR_STATEMENT_BYTES = 8 * 1024;
const MAX_RECONCILIATION_RECORDS = 65_536;

type ReconciliationRecord = Readonly<{
  readonly stream: ToolOutputStream;
  readonly bytes: FrozenBytes;
}>;

export type ReconciliationDocumentV1 =
  | Readonly<{
      readonly v: 1;
      readonly effectId: EffectId;
      readonly resolution: "proven_not_executed";
      readonly statement: string;
    }>
  | Readonly<{
      readonly v: 1;
      readonly effectId: EffectId;
      readonly resolution: "completed";
      readonly statement: string;
      readonly terminal: EffectTerminal;
      readonly records: readonly ReconciliationRecord[];
    }>;

export class ReconciliationInputError extends Error {
  constructor(readonly code: "invalid_evidence" | "conflicting_evidence") {
    super(`Reconciliation input failed: ${code}`);
    this.name = "ReconciliationInputError";
  }
}

function invalidEvidence(): never {
  throw new ReconciliationInputError("invalid_evidence");
}

function conflictingEvidence(): never {
  throw new ReconciliationInputError("conflicting_evidence");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function skipJsonWhitespace(text: string, offset: number): number {
  while (
    offset < text.length &&
    (text[offset] === " " ||
      text[offset] === "\n" ||
      text[offset] === "\r" ||
      text[offset] === "\t")
  ) {
    offset += 1;
  }
  return offset;
}

function scanJsonString(
  text: string,
  start: number,
): Readonly<{ readonly value: string; readonly end: number }> {
  if (text[start] !== '"') invalidEvidence();
  let offset = start + 1;
  while (offset < text.length) {
    const character = text[offset];
    if (character === '"') {
      const raw = text.slice(start, offset + 1);
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        invalidEvidence();
      }
      if (typeof value !== "string") invalidEvidence();
      return Object.freeze({ value, end: offset + 1 });
    }
    if (character === "\\") offset += 2;
    else offset += 1;
  }
  return invalidEvidence();
}

function scanJsonValue(text: string, start: number): number {
  let offset = skipJsonWhitespace(text, start);
  const first = text[offset];
  if (first === '"') return scanJsonString(text, offset).end;
  if (first === "{") {
    offset = skipJsonWhitespace(text, offset + 1);
    const keys = new Set<string>();
    if (text[offset] === "}") return offset + 1;
    for (;;) {
      const key = scanJsonString(text, offset);
      if (keys.has(key.value)) invalidEvidence();
      keys.add(key.value);
      offset = skipJsonWhitespace(text, key.end);
      if (text[offset] !== ":") invalidEvidence();
      offset = skipJsonWhitespace(text, scanJsonValue(text, offset + 1));
      if (text[offset] === "}") return offset + 1;
      if (text[offset] !== ",") invalidEvidence();
      offset = skipJsonWhitespace(text, offset + 1);
    }
  }
  if (first === "[") {
    offset = skipJsonWhitespace(text, offset + 1);
    if (text[offset] === "]") return offset + 1;
    for (;;) {
      offset = skipJsonWhitespace(text, scanJsonValue(text, offset));
      if (text[offset] === "]") return offset + 1;
      if (text[offset] !== ",") invalidEvidence();
      offset = skipJsonWhitespace(text, offset + 1);
    }
  }
  const valueStart = offset;
  while (
    offset < text.length &&
    text[offset] !== "," &&
    text[offset] !== "]" &&
    text[offset] !== "}" &&
    text[offset] !== " " &&
    text[offset] !== "\n" &&
    text[offset] !== "\r" &&
    text[offset] !== "\t"
  ) {
    offset += 1;
  }
  if (offset === valueStart) invalidEvidence();
  return offset;
}

function rejectDuplicateJsonKeys(text: string): void {
  const end = skipJsonWhitespace(text, scanJsonValue(text, 0));
  if (end !== text.length) invalidEvidence();
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    keys.length !== wanted.length ||
    keys.some((key, index) => key !== wanted[index])
  ) {
    invalidEvidence();
  }
}

function operatorStatement(value: unknown): string {
  if (typeof value !== "string") invalidEvidence();
  try {
    assertUnicodeScalarString(value, "reconciliation statement");
  } catch {
    invalidEvidence();
  }
  const byteCount = new TextEncoder().encode(value).byteLength;
  if (byteCount < 1 || byteCount > MAX_OPERATOR_STATEMENT_BYTES) {
    invalidEvidence();
  }
  return value;
}

function effectId(value: unknown): EffectId {
  if (typeof value !== "string" || !/^eff_[0-9a-f]{32}$/u.test(value)) {
    invalidEvidence();
  }
  return value as EffectId;
}

function parseRecords(value: unknown): readonly ReconciliationRecord[] {
  if (!Array.isArray(value) || value.length > MAX_RECONCILIATION_RECORDS) {
    invalidEvidence();
  }
  const records: ReconciliationRecord[] = [];
  let rawByteCount = 0;
  for (const candidate of value) {
    if (!isPlainRecord(candidate)) invalidEvidence();
    exactKeys(candidate, ["stream", "enc", "bytes"]);
    const stream = candidate["stream"];
    if (stream !== "read" && stream !== "stdout" && stream !== "stderr") {
      invalidEvidence();
    }
    if (candidate["enc"] !== "b64" || typeof candidate["bytes"] !== "string") {
      invalidEvidence();
    }
    let bytes: FrozenBytes;
    try {
      bytes = fromBase64(candidate["bytes"]);
    } catch {
      invalidEvidence();
    }
    if (bytes.byteLength === 0) invalidEvidence();
    rawByteCount += bytes.byteLength;
    if (
      !Number.isSafeInteger(rawByteCount) ||
      rawByteCount > RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES
    ) {
      invalidEvidence();
    }
    records.push(Object.freeze({ stream, bytes }));
  }
  return Object.freeze(records);
}

export function parseReconciliationEvidenceV1(
  evidenceBytes: FrozenBytes,
): ReconciliationDocumentV1 {
  if (
    evidenceBytes.byteLength < 1 ||
    evidenceBytes.byteLength > MAX_RECONCILIATION_EVIDENCE_BYTES
  ) {
    invalidEvidence();
  }
  let parsed: unknown;
  try {
    const text = utf8Decoder.decode(evidenceBytes.copy());
    rejectDuplicateJsonKeys(text);
    parsed = JSON.parse(text);
  } catch {
    invalidEvidence();
  }
  if (!isPlainRecord(parsed) || parsed["v"] !== 1) invalidEvidence();
  const resolution = parsed["resolution"];
  if (resolution === "proven_not_executed") {
    exactKeys(parsed, ["v", "effectId", "resolution", "statement"]);
    return Object.freeze({
      v: 1,
      effectId: effectId(parsed["effectId"]),
      resolution,
      statement: operatorStatement(parsed["statement"]),
    });
  }
  if (resolution !== "completed") invalidEvidence();
  exactKeys(parsed, [
    "v",
    "effectId",
    "resolution",
    "statement",
    "terminal",
    "records",
  ]);
  let terminal: EffectTerminal;
  try {
    terminal = normalizeEffectTerminal(parsed["terminal"]);
  } catch {
    invalidEvidence();
  }
  return Object.freeze({
    v: 1,
    effectId: effectId(parsed["effectId"]),
    resolution,
    statement: operatorStatement(parsed["statement"]),
    terminal,
    records: parseRecords(parsed["records"]),
  });
}

function descriptor(
  payload: VerifiedJournalEvent<"artifact_published">["payload"],
): ArtifactDescriptor {
  return Object.freeze({
    artifactRef: payload.artifactRef,
    artifactHash: payload.artifactHash,
    byteCount: payload.byteCount,
    lineCount: payload.lineCount,
    mediaType: payload.mediaType,
    artifactType: payload.artifactType,
    streamBytes: payload.streamBytes,
    hardLimitReached: payload.hardLimitReached,
    descendantsReaped: payload.descendantsReaped,
    toolCallId: payload.toolCallId,
    terminal: payload.terminal,
  });
}

async function exactArtifactBytes(
  opened: OpenJournalResult,
  event: VerifiedJournalEvent<"artifact_published">,
): Promise<FrozenBytes> {
  const chunks: FrozenBytes[] = [];
  await opened.artifacts.scanArtifact(descriptor(event.payload), (chunk) => {
    chunks.push(freezeBytes(chunk.copy()));
  });
  return concatBytes(chunks);
}

function artifactEvent(
  events: readonly AnyVerifiedJournalEvent[],
  artifactId: string,
): VerifiedJournalEvent<"artifact_published"> {
  const event = events.find(
    (candidate): candidate is VerifiedJournalEvent<"artifact_published"> =>
      candidate.type === "artifact_published" &&
      candidate.payload.artifactId === artifactId,
  );
  return event ?? invalidEvidence();
}

function activeRecoveryScope(
  view: RecoveryViewV1,
): Readonly<{ lineageId: LineageId; runId: RunId }> {
  const run = view.runs.find(({ runId }) => runId === view.activeRunId);
  if (
    view.activeLineageId === undefined ||
    run === undefined ||
    run.status !== "active" ||
    run.cause !== "recovery" ||
    run.lineageId !== view.activeLineageId
  ) {
    invalidEvidence();
  }
  return Object.freeze({
    lineageId: view.activeLineageId as LineageId,
    runId: run.runId as RunId,
  });
}

type ExpectedOutput = Readonly<{
  readonly bytes: FrozenBytes;
  readonly summary: ToolOutputFrameSummary;
  readonly terminal: EffectTerminal;
  readonly descendantsReaped: boolean | null;
}>;

async function expectedOutput(
  document: Extract<ReconciliationDocumentV1, { readonly resolution: "completed" }>,
  toolName: "write" | "edit" | "bash",
): Promise<ExpectedOutput> {
  const chunks: FrozenBytes[] = [];
  const writer = createToolOutputFrameWriter({
    write: (chunk): Promise<void> => {
      chunks.push(freezeBytes("copy" in chunk ? chunk.copy() : Uint8Array.from(chunk)));
      return Promise.resolve();
    },
  });
  for (const record of document.records) {
    await writer.write(record.stream, record.bytes);
  }
  const summary = await writer.finish();
  if ((toolName === "write" || toolName === "edit") && summary.byteCount !== 0) {
    invalidEvidence();
  }
  try {
    validateToolTerminalForSource(
      toolName,
      "effect",
      document.terminal,
      summary.hardLimitReached,
    );
  } catch {
    invalidEvidence();
  }
  return Object.freeze({
    bytes: concatBytes(chunks),
    summary,
    terminal: document.terminal,
    descendantsReaped:
      toolName === "bash" ? document.terminal.descendantsReaped : null,
  });
}

function matchingArtifact(
  events: readonly AnyVerifiedJournalEvent[],
  input: Readonly<{
    readonly runId: RunId;
    readonly artifactType: "operator_evidence" | "tool_output";
    readonly hash: string;
    readonly byteCount: number;
    readonly toolCallId: ToolCallId | null;
  }>,
): VerifiedJournalEvent<"artifact_published"> | undefined {
  const matches = events.filter(
    (event): event is VerifiedJournalEvent<"artifact_published"> =>
      event.type === "artifact_published" &&
      event.runId === input.runId &&
      event.payload.artifactType === input.artifactType &&
      event.payload.artifactHash === input.hash &&
      event.payload.byteCount === input.byteCount &&
      event.payload.toolCallId === input.toolCallId,
  );
  if (matches.length > 1) conflictingEvidence();
  return matches[0];
}

async function publishEvidence(
  opened: OpenJournalResult,
  sessionId: SessionId,
  scope: Readonly<{ lineageId: LineageId; runId: RunId }>,
  bytes: FrozenBytes,
): Promise<VerifiedJournalEvent<"artifact_published">> {
  const hash = `sha256:${sha256Hex(bytes)}`;
  const existing = matchingArtifact(opened.writer.events, {
    runId: scope.runId,
    artifactType: "operator_evidence",
    hash,
    byteCount: bytes.byteLength,
    toolCallId: null,
  });
  if (existing !== undefined) {
    if (!bytesEqual(await exactArtifactBytes(opened, existing), bytes)) {
      conflictingEvidence();
    }
    return existing;
  }
  const descriptor = await opened.artifacts.publishArtifact(bytes, {
    lineCount: null,
    mediaType: "application/json",
    artifactType: "operator_evidence",
    streamBytes: null,
    hardLimitReached: null,
    descendantsReaped: null,
    toolCallId: null,
    terminal: null,
  });
  return (await opened.writer.append({
    type: "artifact_published",
    sessionId,
    lineageId: scope.lineageId,
    runId: scope.runId,
    payload: { artifactId: newArtifactId(), ...descriptor },
  })) as VerifiedJournalEvent<"artifact_published">;
}

async function publishOutput(
  opened: OpenJournalResult,
  sessionId: SessionId,
  scope: Readonly<{ lineageId: LineageId; runId: RunId }>,
  toolCallId: ToolCallId,
  output: ExpectedOutput,
): Promise<VerifiedJournalEvent<"artifact_published">> {
  const hash = `sha256:${sha256Hex(output.bytes)}`;
  const existing = matchingArtifact(opened.writer.events, {
    runId: scope.runId,
    artifactType: "tool_output",
    hash,
    byteCount: output.bytes.byteLength,
    toolCallId,
  });
  if (existing !== undefined) {
    const payload = existing.payload;
    if (
      payload.mediaType !== TOOL_OUTPUT_MEDIA_TYPE ||
      payload.lineCount !== null ||
      payload.terminal !== null ||
      payload.hardLimitReached !== output.summary.hardLimitReached ||
      payload.descendantsReaped !== output.descendantsReaped ||
      payload.streamBytes?.read !== output.summary.payloadBytes.read ||
      payload.streamBytes.stdout !== output.summary.payloadBytes.stdout ||
      payload.streamBytes.stderr !== output.summary.payloadBytes.stderr ||
      !bytesEqual(await exactArtifactBytes(opened, existing), output.bytes)
    ) {
      conflictingEvidence();
    }
    return existing;
  }
  const descriptor = await opened.artifacts.publishArtifact(output.bytes, {
    lineCount: null,
    mediaType: TOOL_OUTPUT_MEDIA_TYPE,
    artifactType: "tool_output",
    streamBytes: output.summary.payloadBytes,
    hardLimitReached: output.summary.hardLimitReached,
    descendantsReaped: output.descendantsReaped,
    toolCallId,
    terminal: null,
  });
  return (await opened.writer.append({
    type: "artifact_published",
    sessionId,
    lineageId: scope.lineageId,
    runId: scope.runId,
    payload: { artifactId: newArtifactId(), ...descriptor },
  })) as VerifiedJournalEvent<"artifact_published">;
}

function reconciliationEvent(
  events: readonly AnyVerifiedJournalEvent[],
  effectId: EffectId,
): VerifiedJournalEvent<"effect_reconciled"> | undefined {
  const matches = events.filter(
    (event): event is VerifiedJournalEvent<"effect_reconciled"> =>
      event.type === "effect_reconciled" && event.payload.effectId === effectId,
  );
  if (matches.length > 1) conflictingEvidence();
  return matches[0];
}

async function validateExistingReconciliation(
  opened: OpenJournalResult,
  document: ReconciliationDocumentV1,
  evidenceBytes: FrozenBytes,
  event: VerifiedJournalEvent<"effect_reconciled">,
): Promise<void> {
  if (event.payload.resolution !== document.resolution) conflictingEvidence();
  const evidence = artifactEvent(
    opened.writer.events,
    event.payload.evidenceArtifactId,
  );
  if (
    evidence.payload.artifactType !== "operator_evidence" ||
    !bytesEqual(await exactArtifactBytes(opened, evidence), evidenceBytes)
  ) {
    conflictingEvidence();
  }
  if (document.resolution === "proven_not_executed") return;
  if (event.payload.resolution !== "completed") conflictingEvidence();
  const effect = opened.recoveryView().effects.find(
    ({ effectId }) => effectId === document.effectId,
  );
  if (effect === undefined) invalidEvidence();
  const expected = await expectedOutput(document, effect.toolName);
  const output = artifactEvent(opened.writer.events, event.payload.outputArtifactId);
  if (
    !bytesEqual(await exactArtifactBytes(opened, output), expected.bytes) ||
    JSON.stringify(event.payload.terminal) !== JSON.stringify(expected.terminal)
  ) {
    conflictingEvidence();
  }
}

export async function applyReconciliationV1(input: Readonly<{
  readonly opened: OpenJournalResult;
  readonly sessionId: SessionId;
  readonly evidenceBytes: FrozenBytes;
  readonly document: ReconciliationDocumentV1;
}>): Promise<EventId> {
  const existing = reconciliationEvent(
    input.opened.writer.events,
    input.document.effectId,
  );
  if (existing !== undefined) {
    await validateExistingReconciliation(
      input.opened,
      input.document,
      input.evidenceBytes,
      existing,
    );
    return existing.id;
  }

  const view = input.opened.recoveryView();
  const effect = view.effects.find(
    ({ effectId }) => effectId === input.document.effectId,
  );
  if (effect === undefined || effect.status !== "indeterminate") {
    invalidEvidence();
  }
  const scope = activeRecoveryScope(view);
  const call = view.toolCalls.find(
    ({ toolCallId }) => toolCallId === effect.toolCallId,
  );
  if (
    call === undefined ||
    call.validatedArguments === null ||
    call.validatedArguments.name !== effect.toolName
  ) {
    invalidEvidence();
  }

  let output: ExpectedOutput | undefined;
  if (input.document.resolution === "completed") {
    output = await expectedOutput(input.document, effect.toolName);
  }

  const evidence = await publishEvidence(
    input.opened,
    input.sessionId,
    scope,
    input.evidenceBytes,
  );
  if (input.document.resolution === "proven_not_executed") {
    const event = await input.opened.writer.append({
      type: "effect_reconciled",
      sessionId: input.sessionId,
      lineageId: scope.lineageId,
      runId: scope.runId,
      payload: {
        effectId: input.document.effectId,
        resolution: "proven_not_executed",
        evidenceArtifactId: evidence.payload.artifactId,
      },
    });
    return event.id;
  }
  if (output === undefined) invalidEvidence();
  const publishedOutput = await publishOutput(
    input.opened,
    input.sessionId,
    scope,
    effect.toolCallId as ToolCallId,
    output,
  );
  const event = await input.opened.writer.append({
    type: "effect_reconciled",
    sessionId: input.sessionId,
    lineageId: scope.lineageId,
    runId: scope.runId,
    payload: {
      effectId: input.document.effectId,
      resolution: "completed",
      evidenceArtifactId: evidence.payload.artifactId,
      outputArtifactId: publishedOutput.payload.artifactId,
      terminal: output.terminal,
    },
  });
  return event.id;
}
