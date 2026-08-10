import {
  TOOL_OUTPUT_MEDIA_TYPE,
  type ArtifactChunkVisitor,
  type ArtifactDescriptor,
  type ArtifactSink,
  type ArtifactStore,
  type EffectTerminal,
  type ToolOutputFrameSummary,
  type ToolTerminal,
} from "../artifact/index.js";
import type { ArtifactRef as StoreArtifactRef } from "../artifact/types.js";
import type { BlobPosition, BlobStore } from "../blob/index.js";
import type { ToolCallId } from "../bytes/tool-call-id.js";
import type { FrozenBytes } from "../bytes/types.js";
import {
  newArtifactId,
  newEffectId,
  type AnyVerifiedJournalEvent,
  type ArtifactId,
  type EffectId,
  type EventId,
  type LineageId,
  type RunId,
  type SessionId,
  type Sha256,
} from "../journal/index.js";
import type { JournalWriter } from "../journal/writer.js";
import type {
  ActiveArtifactBindings,
  BoundReadArtifact,
} from "./file.js";
import type { ToolName } from "../bytes/tool-arguments.js";

export interface ToolRuntimeScope {
  readonly sessionId: SessionId;
  readonly lineageId: LineageId;
  readonly runId: RunId;
  readonly sourceAssistantEventId: EventId;
}

export interface PublishedToolArtifact extends BoundReadArtifact {
  readonly artifactId: ArtifactId;
  readonly event: Extract<
    AnyVerifiedJournalEvent,
    { readonly type: "artifact_published" }
  >;
}

export interface PreparedToolEffect {
  readonly effectId: EffectId;
  readonly event: Extract<
    AnyVerifiedJournalEvent,
    { readonly type: "effect_prepared" }
  >;
}

export interface CompletedToolEffect {
  readonly event: Extract<
    AnyVerifiedJournalEvent,
    { readonly type: "effect_completed" }
  >;
}

export class ToolDurabilityError extends Error {
  constructor() {
    super("tool durability boundary failed");
    this.name = "ToolDurabilityError";
  }
}

function asEvent<Type extends AnyVerifiedJournalEvent["type"]>(
  event: AnyVerifiedJournalEvent,
  type: Type,
): Extract<AnyVerifiedJournalEvent, { readonly type: Type }> {
  if (event.type !== type) throw new ToolDurabilityError();
  return event as Extract<AnyVerifiedJournalEvent, { readonly type: Type }>;
}

export class JournalToolDurability implements ActiveArtifactBindings {
  readonly #scope: ToolRuntimeScope;
  readonly #writer: JournalWriter;
  readonly #artifacts: ArtifactStore;
  readonly #blobs: BlobStore;
  readonly #bindings = new Map<StoreArtifactRef, PublishedToolArtifact>();
  #blobPosition: BlobPosition;

  constructor(options: {
    readonly scope: ToolRuntimeScope;
    readonly writer: JournalWriter;
    readonly artifacts: ArtifactStore;
    readonly blobs: BlobStore;
    readonly blobPosition: BlobPosition;
    readonly existingArtifacts?: readonly PublishedToolArtifact[];
  }) {
    this.#scope = Object.freeze({ ...options.scope });
    this.#writer = options.writer;
    this.#artifacts = options.artifacts;
    this.#blobs = options.blobs;
    this.#blobPosition = Object.freeze({ ...options.blobPosition });
    for (const artifact of options.existingArtifacts ?? []) {
      this.#bindings.set(artifact.descriptor.artifactRef, artifact);
    }
  }

  get(ref: StoreArtifactRef): PublishedToolArtifact | undefined {
    return this.#bindings.get(ref);
  }

  get blobPosition(): BlobPosition {
    return Object.freeze({ ...this.#blobPosition });
  }

  get sourceAssistantEventId(): EventId {
    return this.#scope.sourceAssistantEventId;
  }

  get currentRunSourceEventId(): EventId {
    for (let index = this.#writer.events.length - 1; index >= 0; index -= 1) {
      const event = this.#writer.events[index];
      if (
        event !== undefined &&
        event.sessionId === this.#scope.sessionId &&
        event.lineageId === this.#scope.lineageId &&
        event.runId === this.#scope.runId
      ) {
        return event.id;
      }
    }
    throw new ToolDurabilityError();
  }

  #journalScope(): Readonly<{
    readonly sessionId: SessionId;
    readonly lineageId: LineageId;
    readonly runId: RunId;
  }> {
    return Object.freeze({
      sessionId: this.#scope.sessionId,
      lineageId: this.#scope.lineageId,
      runId: this.#scope.runId,
    });
  }

  beginArtifact(): Promise<ArtifactSink> {
    return this.#artifacts.beginArtifact();
  }

  async permission(
    toolCallId: ToolCallId,
    decision: "allow" | "deny",
  ): Promise<Extract<AnyVerifiedJournalEvent, { readonly type: "permission_decided" }>> {
    try {
      const existing = this.#writer.events.find(
        (event): event is Extract<
          AnyVerifiedJournalEvent,
          { readonly type: "permission_decided" }
        > =>
          event.type === "permission_decided" &&
          event.sessionId === this.#scope.sessionId &&
          event.lineageId === this.#scope.lineageId &&
          event.payload.toolCallId === toolCallId,
      );
      if (existing !== undefined) {
        if (existing.payload.finalDecision !== decision) {
          throw new ToolDurabilityError();
        }
        return existing;
      }
      return asEvent(
        await this.#writer.append({
          type: "permission_decided",
          ...this.#journalScope(),
          payload: {
            toolCallId,
            policyDecision: decision,
            finalDecision: decision,
            resolution: "policy",
          },
        }),
        "permission_decided",
      );
    } catch {
      throw new ToolDurabilityError();
    }
  }

  async prepare(
    toolCallId: ToolCallId,
    toolName: Exclude<ToolName, "read">,
    argumentsHash: Sha256,
  ): Promise<PreparedToolEffect> {
    const effectId = newEffectId();
    try {
      const event = asEvent(
        await this.#writer.append({
          type: "effect_prepared",
          ...this.#journalScope(),
          payload: { effectId, toolCallId, toolName, argumentsHash },
        }),
        "effect_prepared",
      );
      return Object.freeze({ effectId, event });
    } catch {
      throw new ToolDurabilityError();
    }
  }

  async publish(
    toolCallId: ToolCallId,
    sink: ArtifactSink,
    summary: ToolOutputFrameSummary,
    descendantsReaped: boolean | null,
    terminal: ToolTerminal | null,
  ): Promise<PublishedToolArtifact> {
    const artifactId = newArtifactId();
    let descriptor: ArtifactDescriptor;
    try {
      descriptor = await sink.publish({
        lineCount: null,
        mediaType: TOOL_OUTPUT_MEDIA_TYPE,
        artifactType: "tool_output",
        streamBytes: summary.payloadBytes,
        hardLimitReached: summary.hardLimitReached,
        descendantsReaped,
        toolCallId,
        terminal,
      });
      const event = asEvent(
        await this.#writer.append({
          type: "artifact_published",
          ...this.#journalScope(),
          payload: {
            artifactId,
            artifactRef: descriptor.artifactRef,
            artifactHash: descriptor.artifactHash,
            byteCount: descriptor.byteCount,
            lineCount: descriptor.lineCount,
            mediaType: descriptor.mediaType,
            artifactType: descriptor.artifactType,
            streamBytes: descriptor.streamBytes,
            hardLimitReached: descriptor.hardLimitReached,
            descendantsReaped: descriptor.descendantsReaped,
            toolCallId: descriptor.toolCallId,
            terminal: descriptor.terminal,
          },
        }),
        "artifact_published",
      );
      const published = Object.freeze({
        artifactId,
        descriptor,
        store: this.#artifacts,
        event,
      });
      this.#bindings.set(descriptor.artifactRef, published);
      return published;
    } catch {
      await sink.abort().catch(() => undefined);
      throw new ToolDurabilityError();
    }
  }

  async complete(
    effect: PreparedToolEffect,
    toolCallId: ToolCallId,
    artifact: PublishedToolArtifact,
    terminal: EffectTerminal,
  ): Promise<CompletedToolEffect> {
    try {
      const event = asEvent(
        await this.#writer.append({
          type: "effect_completed",
          ...this.#journalScope(),
          payload: {
            effectId: effect.effectId,
            toolCallId,
            artifactId: artifact.artifactId,
            terminal,
          },
        }),
        "effect_completed",
      );
      return Object.freeze({ event });
    } catch {
      throw new ToolDurabilityError();
    }
  }

  async indeterminate(
    effect: PreparedToolEffect,
    reason:
      | "crash_gap"
      | "process_state_unknown"
      | "filesystem_state_unknown"
      | "artifact_durability_failed",
  ): Promise<never> {
    try {
      const fact = asEvent(
        await this.#writer.append({
          type: "effect_indeterminate",
          ...this.#journalScope(),
          payload: { effectId: effect.effectId, reason },
        }),
        "effect_indeterminate",
      );
      await this.#writer.append({
        type: "run_interrupted",
        ...this.#journalScope(),
        payload: { reason: "effect_indeterminate", sourceEventId: fact.id },
      });
    } catch {
      throw new ToolDurabilityError();
    }
    throw new ToolDurabilityError();
  }

  async interruptDurability(sourceEventId: EventId): Promise<never> {
    try {
      await this.#writer.append({
        type: "run_interrupted",
        ...this.#journalScope(),
        payload: { reason: "durability_failure", sourceEventId },
      });
    } catch {
      throw new ToolDurabilityError();
    }
    throw new ToolDurabilityError();
  }

  async interruptRun(
    reason: "cancelled" | "durability_failure" | "integrity_violation",
    sourceEventId: EventId,
  ): Promise<never> {
    try {
      await this.#writer.append({
        type: "run_interrupted",
        ...this.#journalScope(),
        payload: { reason, sourceEventId },
      });
    } catch {
      throw new ToolDurabilityError();
    }
    throw new ToolDurabilityError();
  }

  async commitResult(input: {
    readonly toolCallId: ToolCallId;
    readonly effectId: EffectId | null;
    readonly artifactId: ArtifactId | null;
    readonly sourceEventId: EventId;
    readonly messageBytes: FrozenBytes;
  }): Promise<Extract<AnyVerifiedJournalEvent, { readonly type: "tool_result_committed" }>> {
    try {
      const payload = await this.#blobs.publish(
        "tool",
        input.messageBytes,
        this.#blobPosition,
      );
      const event = asEvent(
        await this.#writer.append({
          type: "tool_result_committed",
          ...this.#journalScope(),
          payload: {
            ...payload,
            toolCallId: input.toolCallId,
            effectId: input.effectId,
            artifactId: input.artifactId,
            sourceEventId: input.sourceEventId,
          },
        }),
        "tool_result_committed",
      );
      this.#blobPosition = Object.freeze({
        blobIndex: payload.blobIndex + 1,
        previousChainHash: payload.chainHash,
      });
      return event;
    } catch {
      throw new ToolDurabilityError();
    }
  }

  async scanArtifact(
    descriptor: ArtifactDescriptor,
    visit: ArtifactChunkVisitor,
  ): Promise<void> {
    try {
      await this.#artifacts.scanArtifact(descriptor, visit);
    } catch {
      throw new ToolDurabilityError();
    }
  }
}
