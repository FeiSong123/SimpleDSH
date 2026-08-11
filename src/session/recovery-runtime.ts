import { resolve } from "node:path";

import {
  type ArtifactDescriptor,
  type EffectTerminal,
  type ToolTerminal,
} from "../artifact/index.js";
import { createArtifactToolResultProjector } from "../artifact/tool-result.js";
import type { BlobPosition, BlobStore } from "../blob/index.js";
import type { ToolCallId } from "../bytes/tool-call-id.js";
import type { ValidatedToolArguments } from "../bytes/tool-arguments.js";
import { viewAssistant } from "../bytes/view.js";
import type { ToolCall } from "../ds/types.js";
import type {
  AnyVerifiedJournalEvent,
  ArtifactId,
  EffectId,
  EventId,
  LineageId,
  RecoveryViewV1,
  RunId,
  SessionId,
} from "../journal/index.js";
import type { OpenJournalResult } from "../journal/open.js";
import {
  JournalToolDurability,
  type PublishedToolArtifact,
} from "../tool/durability.js";
import type { DeepSeekWebSearchExecutor } from "../ds/web-search.js";
import { ToolRuntime } from "../tool/runtime.js";
import type { RecoveryStepV1 } from "./recovery.js";

type ResumeToolStep = Extract<
  RecoveryStepV1,
  { readonly kind: "resume_tool" }
>;

function invalidRecoveryRuntime(): never {
  throw new TypeError("durable recovery tool state is inconsistent");
}

function isRoleEvent(
  event: AnyVerifiedJournalEvent,
): event is Extract<
  AnyVerifiedJournalEvent,
  {
    readonly type:
      | "user_committed"
      | "assistant_committed"
      | "tool_result_committed";
  }
> {
  return (
    event.type === "user_committed" ||
    event.type === "assistant_committed" ||
    event.type === "tool_result_committed"
  );
}

async function loadAssistantCalls(
  events: readonly AnyVerifiedJournalEvent[],
  blobs: BlobStore,
  lineageId: string,
  assistantEventId: string,
): Promise<readonly ToolCall[]> {
  let position: BlobPosition = Object.freeze({
    blobIndex: 0,
    previousChainHash: null,
  });
  for (const event of events) {
    if (!isRoleEvent(event) || event.lineageId !== lineageId) continue;
    const bytes = await blobs.load(event.payload, position);
    if (event.id === assistantEventId) {
      if (event.type !== "assistant_committed") invalidRecoveryRuntime();
      return viewAssistant(bytes).toolCalls;
    }
    position = Object.freeze({
      blobIndex: event.payload.blobIndex + 1,
      previousChainHash: event.payload.chainHash,
    });
  }
  return invalidRecoveryRuntime();
}

function descriptor(
  payload: RecoveryViewV1["artifacts"][number]["payload"],
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

function existingArtifacts(
  opened: OpenJournalResult,
  view: RecoveryViewV1,
): readonly PublishedToolArtifact[] {
  return Object.freeze(
    view.artifacts
      .filter(({ payload }) => payload.artifactType === "tool_output")
      .map((artifact) => {
        const event = opened.writer.events.find(
          (candidate): candidate is Extract<
            AnyVerifiedJournalEvent,
            { readonly type: "artifact_published" }
          > =>
            candidate.id === artifact.eventId &&
            candidate.type === "artifact_published",
        );
        if (event === undefined) return invalidRecoveryRuntime();
        return Object.freeze({
          artifactId: artifact.artifactId as ArtifactId,
          descriptor: descriptor(artifact.payload),
          store: opened.artifacts,
          event,
        });
      }),
  );
}

function terminalFor(
  events: readonly AnyVerifiedJournalEvent[],
  step: ResumeToolStep,
  artifactTerminal: ToolTerminal | null,
): ToolTerminal | EffectTerminal {
  if (step.effectId === null) {
    return artifactTerminal ?? invalidRecoveryRuntime();
  }
  const source = events.find(({ id }) => id === step.sourceEventId);
  if (source?.type === "effect_completed") return source.payload.terminal;
  if (
    source?.type === "effect_reconciled" &&
    source.payload.resolution === "completed"
  ) {
    return source.payload.terminal;
  }
  return invalidRecoveryRuntime();
}

function validatedCall(
  view: RecoveryViewV1,
  toolCallId: string,
): ValidatedToolArguments {
  const binding = view.toolCalls.find(
    (candidate) => candidate.toolCallId === toolCallId,
  );
  return binding?.validatedArguments ?? invalidRecoveryRuntime();
}

function toolCallBinding(
  view: RecoveryViewV1,
  toolCallId: string,
): RecoveryViewV1["toolCalls"][number] {
  return view.toolCalls.find(
    (candidate) => candidate.toolCallId === toolCallId,
  ) ?? invalidRecoveryRuntime();
}

export async function resumeRecoveryToolV1(input: Readonly<{
  readonly opened: OpenJournalResult;
  readonly blobs: BlobStore;
  readonly view: RecoveryViewV1;
  readonly step: ResumeToolStep;
  readonly workspaceRoot: string;
  readonly sessionId: SessionId;
  readonly lineageId: LineageId;
  readonly signal: AbortSignal;
  readonly webSearch: DeepSeekWebSearchExecutor;
}>): Promise<void> {
  const calls = await loadAssistantCalls(
    input.opened.writer.events,
    input.blobs,
    input.lineageId,
    input.step.assistantEventId,
  );
  const call = calls.find(({ id }) => id === input.step.toolCallId);
  if (call === undefined) invalidRecoveryRuntime();
  const binding = toolCallBinding(input.view, input.step.toolCallId);
  const durability = new JournalToolDurability({
    scope: {
      sessionId: input.sessionId,
      lineageId: input.lineageId,
      runId: input.step.runId as RunId,
      sourceAssistantEventId: input.step.assistantEventId,
    },
    writer: input.opened.writer,
    artifacts: input.opened.artifacts,
    blobs: input.blobs,
    blobPosition: {
      blobIndex: input.view.currentPrefix.blobCount,
      previousChainHash: input.view.currentPrefix.chainHash,
    },
    existingArtifacts: existingArtifacts(input.opened, input.view),
  });

  if (input.step.mode === "execute") {
    const results = await new ToolRuntime({
      durability,
      cwd: resolve(input.workspaceRoot),
      storageRoot: input.opened.paths.dshDir,
      canonicalEnvPath: resolve(input.workspaceRoot, ".env"),
      umask: 0o022,
      toolsProfile: binding.toolsProfile,
      resultProfile: binding.resultProfile,
      webSearch: input.webSearch,
    }).execute(Object.freeze([call]), input.signal);
    if (results.length !== 1 || results[0]?.toolCallId !== call.id) {
      invalidRecoveryRuntime();
    }
    return;
  }

  if (
    input.step.artifactId === null ||
    input.step.sourceEventId === null
  ) {
    invalidRecoveryRuntime();
  }
  const artifact = input.view.artifacts.find(
    ({ artifactId }) => artifactId === input.step.artifactId,
  );
  if (artifact === undefined) invalidRecoveryRuntime();
  const args = validatedCall(input.view, input.step.toolCallId);
  const streamBytes = artifact.payload.streamBytes;
  const hardLimitReached = artifact.payload.hardLimitReached;
  if (
    streamBytes === null ||
    hardLimitReached === null ||
    artifact.payload.toolCallId !== input.step.toolCallId
  ) {
    invalidRecoveryRuntime();
  }
  const projector = createArtifactToolResultProjector({
    toolCallId: input.step.toolCallId as ToolCallId,
    toolName: args.name,
    toolsProfile: binding.toolsProfile,
    resultProfile: binding.resultProfile,
    terminalSource: input.step.effectId === null ? "artifact" : "effect",
    ...(args.name === "read" ? { readOffset: args.value.offset } : {}),
    artifact: {
      artifactId: artifact.artifactId as ArtifactId,
      artifactRef: artifact.payload.artifactRef,
      artifactSha256: artifact.payload.artifactHash,
      byteCount: artifact.payload.byteCount,
      payloadBytes: streamBytes,
      hardLimitReached,
    },
    terminal: terminalFor(
      input.opened.writer.events,
      input.step,
      artifact.payload.terminal,
    ),
  });
  await input.opened.artifacts.scanArtifact(
    descriptor(artifact.payload),
    (bytes) => projector.push(bytes),
  );
  const projected = projector.finish();
  await durability.commitResult({
    toolCallId: input.step.toolCallId as ToolCallId,
    effectId: input.step.effectId as EffectId | null,
    artifactId: input.step.artifactId,
    sourceEventId: input.step.sourceEventId as EventId,
    messageBytes: projected.messageBytes,
  });
}
