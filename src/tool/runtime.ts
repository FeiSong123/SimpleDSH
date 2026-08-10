import { delimiter, dirname, isAbsolute, resolve } from "node:path";

import {
  createToolOutputFrameWriter,
  normalizeEffectTerminal,
  normalizeToolTerminal,
  type EffectTerminal,
  type ToolOutputFrameSummary,
  type ToolSignal,
  type ToolTerminal,
} from "../artifact/index.js";
import {
  materializeToolResultMessage,
  type StaticToolResultContent,
  type ToolResultProfile,
} from "../bytes/tool-result.js";
import { sha256Hex, utf8Bytes } from "../bytes/ops.js";
import type { ToolCallId } from "../bytes/tool-call-id.js";
import type { FrozenBytes } from "../bytes/types.js";
import type { ToolSchemaProfile } from "../bytes/schemas.js";
import {
  validateToolCallForProfile,
  type ToolCallValidation,
  type ToolName,
  type ValidatedToolArguments,
} from "../bytes/tool-arguments.js";
import type { ToolCall } from "../ds/types.js";
import type {
  ArtifactId,
  EffectId,
  EventId,
  Sha256,
} from "../journal/index.js";
import {
  BashProcessStateUnknownError,
  runNativeBash,
  type BashChildEnvironment,
  type BashRunResult,
} from "../proc/index.js";
import {
  createFileToolBoundary,
  executePreparedFileMutation,
  executeReadFile,
  FileToolIntegrityError,
  FileToolOutputError,
  preflightFileMutation,
  resolveFileSubject,
  type FileMutationControls,
  type FileObservationFailure,
  type FileToolBoundary,
} from "./file.js";
import {
  JournalToolDurability,
  type CompletedToolEffect,
  type PreparedToolEffect,
  type PublishedToolArtifact,
} from "./durability.js";
import {
  createArtifactToolResultProjector,
  ToolResultProjectionError,
} from "../artifact/tool-result.js";

export const READ_TOOL_PARALLELISM = 12;

interface PendingToolResult {
  readonly toolCallId: ToolCallId;
  readonly effectId: EffectId | null;
  readonly artifactId: ArtifactId | null;
  readonly sourceEventId: EventId;
  readonly messageBytes: FrozenBytes;
}

export interface CommittedToolResult {
  readonly toolCallId: ToolCallId;
  readonly messageBytes: FrozenBytes;
  readonly eventId: EventId;
}

export interface ToolRuntimeOptions {
  readonly durability: JournalToolDurability;
  readonly cwd: string;
  readonly storageRoot: string;
  readonly canonicalEnvPath: string;
  readonly umask?: number;
  readonly fileMutationControls?: FileMutationControls;
  readonly effectGate?: Readonly<{ beforeEffect(): void }>;
  readonly toolsProfile: ToolSchemaProfile;
  readonly resultProfile: ToolResultProfile;
}

export class ToolRuntimeInterruptedError extends Error {
  constructor() {
    super("tool runtime interrupted the run");
    this.name = "ToolRuntimeInterruptedError";
  }
}

function staticResult(
  toolCallId: ToolCallId,
  sourceEventId: EventId,
  content: StaticToolResultContent,
): PendingToolResult {
  return Object.freeze({
    toolCallId,
    effectId: null,
    artifactId: null,
    sourceEventId,
    messageBytes: materializeToolResultMessage(toolCallId, content),
  });
}

function terminal(
  status: ToolTerminal["status"],
  code: ToolTerminal["code"],
  exitCode: number | null = null,
  signal: ToolSignal | null = null,
  descendantsReaped: boolean | null = null,
): ToolTerminal {
  return normalizeToolTerminal({
    status,
    code,
    exitCode,
    signal,
    descendantsReaped,
  });
}

function effectTerminal(
  status: EffectTerminal["status"],
  code: EffectTerminal["code"],
  exitCode: number | null = null,
  signal: ToolSignal | null = null,
  descendantsReaped: boolean | null = null,
): EffectTerminal {
  return normalizeEffectTerminal({
    status,
    code,
    exitCode,
    signal,
    descendantsReaped,
  });
}

const BASE_CHILD_PATH = Object.freeze([
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
] as const);

/** The closed environment every bash child gets, verification included. */
export function childEnvironment(home: string): BashChildEnvironment {
  const nodeBin = dirname(process.execPath);
  if (!isAbsolute(nodeBin) || nodeBin.includes(delimiter) || nodeBin.includes("\0")) {
    throw new TypeError("Node executable directory cannot form the closed child PATH");
  }
  const pathEntries = [...new Set([nodeBin, ...BASE_CHILD_PATH])];
  return Object.freeze({
    HOME: resolve(home),
    HOSTNAME: "simpledsh",
    LANG: "C",
    LC_ALL: "C",
    LOGNAME: "dsh",
    PATH: pathEntries.join(delimiter),
    USER: "dsh",
  });
}

function failureTerminal(failure: FileObservationFailure): ToolTerminal {
  return terminal(failure.status, failure.code);
}

function exactlyOneProcessTerminal(result: BashRunResult): boolean {
  return (result.exitCode === null) !== (result.signal === null);
}

function classifyBash(
  result: BashRunResult,
  hardLimitReached: boolean,
): EffectTerminal {
  if ((result.reason === "output_limit") !== hardLimitReached) {
    throw new TypeError("native bash reason does not match the hard-limit marker");
  }
  if (result.reason === "output_limit") {
    if (!exactlyOneProcessTerminal(result)) {
      throw new TypeError("output-limit bash lacks a direct-child terminal");
    }
    return effectTerminal(
      "failed",
      "output_limit",
      result.exitCode,
      result.signal,
      result.descendantsReaped,
    );
  }
  if (result.reason === "timeout") {
    if (!exactlyOneProcessTerminal(result)) {
      throw new TypeError("timed-out bash lacks a direct-child terminal");
    }
    return effectTerminal(
      "failed",
      "timeout",
      result.exitCode,
      result.signal,
      result.descendantsReaped,
    );
  }
  if (result.reason === "cancelled") {
    if (!exactlyOneProcessTerminal(result)) {
      throw new TypeError("cancelled bash lacks a direct-child terminal");
    }
    return effectTerminal(
      "failed",
      "cancelled",
      result.exitCode,
      result.signal,
      result.descendantsReaped,
    );
  }
  if (result.reason === "io_error") {
    return effectTerminal(
      "failed",
      "io_error",
      null,
      null,
      result.descendantsReaped,
    );
  }
  if (result.signal !== null && result.exitCode === null) {
    return effectTerminal(
      "failed",
      "signaled",
      null,
      result.signal,
      result.descendantsReaped,
    );
  }
  if (result.signal === null && result.exitCode === 0) {
    return effectTerminal(
      "succeeded",
      "ok",
      0,
      null,
      result.descendantsReaped,
    );
  }
  if (
    result.signal === null &&
    result.exitCode !== null &&
    result.exitCode >= 1 &&
    result.exitCode <= 255
  ) {
    return effectTerminal(
      "failed",
      "nonzero_exit",
      result.exitCode,
      null,
      result.descendantsReaped,
    );
  }
  throw new TypeError("native bash lacks a classified direct-child terminal");
}

export class ToolRuntime {
  readonly #durability: JournalToolDurability;
  readonly #fileBoundary: FileToolBoundary;
  readonly #bashCwd: string;
  readonly #bashChildEnvironment: BashChildEnvironment;
  readonly #fileControls: FileMutationControls | undefined;
  readonly #effectGate: Readonly<{ beforeEffect(): void }> | undefined;
  readonly #toolsProfile: ToolSchemaProfile;
  readonly #resultProfile: ToolResultProfile;

  constructor(options: ToolRuntimeOptions) {
    this.#durability = options.durability;
    this.#fileBoundary = createFileToolBoundary({
      cwd: options.cwd,
      storageRoot: options.storageRoot,
      canonicalEnvPath: options.canonicalEnvPath,
      ...(options.umask === undefined ? {} : { umask: options.umask }),
      artifacts: options.durability,
    });
    this.#bashCwd = resolve(options.cwd);
    this.#bashChildEnvironment = childEnvironment(this.#bashCwd);
    this.#fileControls = options.fileMutationControls;
    this.#effectGate = options.effectGate;
    this.#toolsProfile = options.toolsProfile;
    this.#resultProfile = options.resultProfile;
  }

  async execute(
    calls: readonly ToolCall[],
    signal: AbortSignal,
  ): Promise<readonly CommittedToolResult[]> {
    const validated = calls.map((call) => Object.freeze({
      call,
      validation: validateToolCallForProfile(call, this.#toolsProfile),
    }));
    const committed: CommittedToolResult[] = [];
    let index = 0;
    let t2Reached = false;
    while (index < validated.length) {
      if (signal.aborted) {
        await this.#durability.interruptRun(
          "cancelled",
          this.#durability.currentRunSourceEventId,
        );
      }
      const current = validated[index];
      if (current === undefined) throw new ToolRuntimeInterruptedError();
      if (
        !t2Reached &&
        current.validation.ok &&
        current.validation.arguments.name === "read"
      ) {
        let end = index;
        while (end < validated.length) {
          const next = validated[end];
          if (
            next === undefined ||
            !next.validation.ok ||
            next.validation.arguments.name !== "read"
          ) {
            break;
          }
          end += 1;
        }
        for (let start = index; start < end; start += READ_TOOL_PARALLELISM) {
          const slice = validated.slice(
            start,
            Math.min(start + READ_TOOL_PARALLELISM, end),
          );
          const settled = await Promise.allSettled(
            slice.map(({ call, validation }) =>
              this.#executeValidated(call, validation, signal),
            ),
          );
          const rejection = settled.find(
            (value): value is PromiseRejectedResult => value.status === "rejected",
          );
          if (rejection !== undefined) throw rejection.reason;
          for (const value of settled) {
            if (value.status !== "fulfilled") continue;
            committed.push(await this.#commit(value.value));
          }
          await this.#interruptIfAborted(
            signal,
            committed,
            validated.length,
          );
        }
        index = end;
        continue;
      }
      if (
        current.validation.ok &&
        current.validation.arguments.name !== "read"
      ) {
        t2Reached = true;
      }
      const pending = await this.#executeValidated(
        current.call,
        current.validation,
        signal,
      );
      committed.push(await this.#commit(pending));
      index += 1;
      await this.#interruptIfAborted(signal, committed, validated.length);
    }
    return Object.freeze(committed);
  }

  async #interruptIfAborted(
    signal: AbortSignal,
    committed: readonly CommittedToolResult[],
    declaredCallCount: number,
  ): Promise<void> {
    if (!signal.aborted || committed.length === declaredCallCount) return;
    await this.#durability.interruptRun(
      "cancelled",
      this.#durability.currentRunSourceEventId,
    );
  }

  async #commit(pending: PendingToolResult): Promise<CommittedToolResult> {
    const event = await this.#durability.commitResult(pending);
    return Object.freeze({
      toolCallId: pending.toolCallId,
      messageBytes: pending.messageBytes,
      eventId: event.id,
    });
  }

  async #executeValidated(
    call: ToolCall,
    validation: ToolCallValidation,
    signal: AbortSignal,
  ): Promise<PendingToolResult> {
    if (!validation.ok) {
      return staticResult(
        validation.toolCallId,
        this.#durability.sourceAssistantEventId,
        Object.freeze({
          kind: "static",
          status: "invalid",
          code: validation.code,
        }),
      );
    }
    const args = validation.arguments;
    if (args.name === "read") {
      return this.#executeRead(validation.toolCallId, args, signal);
    }
    if (args.name === "bash") {
      return this.#executeBash(validation.toolCallId, call, args, signal);
    }
    return this.#executeMutation(validation.toolCallId, call, args);
  }

  async #executeRead(
    toolCallId: ToolCallId,
    args: Extract<ValidatedToolArguments, { readonly name: "read" }>,
    _signal: AbortSignal,
  ): Promise<PendingToolResult> {
    const subject = resolveFileSubject(
      this.#fileBoundary,
      "read",
      args.value.path,
    );
    const permission = await this.#durability.permission(
      toolCallId,
      subject.directDecision,
    );
    if (subject.directDecision === "deny") {
      return staticResult(
        toolCallId,
        permission.id,
        Object.freeze({
          kind: "static",
          status: "denied",
          code: "permission_denied",
        }),
      );
    }
    let sink;
    try {
      sink = await this.#durability.beginArtifact();
    } catch {
      return this.#durability.interruptRun("durability_failure", permission.id);
    }
    const writer = createToolOutputFrameWriter(sink);
    let failure: FileObservationFailure | undefined;
    try {
      failure = await executeReadFile(
        this.#fileBoundary,
        subject,
        args.value,
        writer,
      );
    } catch (error) {
      await sink.abort().catch(() => undefined);
      if (error instanceof FileToolIntegrityError) {
        return this.#durability.interruptRun("integrity_violation", permission.id);
      }
      if (error instanceof FileToolOutputError) {
        return this.#durability.interruptRun("durability_failure", permission.id);
      }
      throw error;
    }
    let summary: ToolOutputFrameSummary;
    try {
      summary = await writer.finish();
    } catch {
      await sink.abort().catch(() => undefined);
      return this.#durability.interruptRun("durability_failure", permission.id);
    }
    const resultTerminal = summary.hardLimitReached
      ? terminal("succeeded", "ok")
      : failure === undefined
        ? terminal("succeeded", "ok")
        : failureTerminal(failure);
    let artifact: PublishedToolArtifact;
    try {
      artifact = await this.#durability.publish(
        toolCallId,
        sink,
        summary,
        null,
        resultTerminal,
      );
    } catch {
      return this.#durability.interruptRun("durability_failure", permission.id);
    }
    return this.#artifactResult(
      toolCallId,
      "read",
      artifact,
      resultTerminal,
      null,
      artifact.event.id,
      args.value.offset,
    );
  }

  async #executeMutation(
    toolCallId: ToolCallId,
    call: ToolCall,
    args: Extract<
      ValidatedToolArguments,
      { readonly name: "write" | "edit" }
    >,
  ): Promise<PendingToolResult> {
    const subject = resolveFileSubject(
      this.#fileBoundary,
      args.name,
      args.value.path,
    );
    const permission = await this.#durability.permission(
      toolCallId,
      subject.directDecision,
    );
    if (subject.directDecision === "deny") {
      return staticResult(
        toolCallId,
        permission.id,
        Object.freeze({
          kind: "static",
          status: "denied",
          code: "permission_denied",
        }),
      );
    }
    const preflight = await preflightFileMutation(
      this.#fileBoundary,
      subject,
      args.value,
    );
    if ("status" in preflight) {
      return this.#publishObservation(
        toolCallId,
        args.name,
        failureTerminal(preflight),
        permission.id,
        this.#toolsProfile === "edit-v5" && "matchCount" in preflight
          ? preflight.matchCount
          : undefined,
      );
    }
    this.#effectGate?.beforeEffect();
    const prepared = await this.#durability.prepare(
      toolCallId,
      args.name,
      `sha256:${sha256Hex(utf8Bytes(call.function.arguments))}` as Sha256,
    );
    const outcome = await executePreparedFileMutation(
      preflight,
      this.#fileControls,
    ).catch(() =>
      this.#durability.indeterminate(prepared, "filesystem_state_unknown"),
    );
    if ("reason" in outcome) {
      return this.#durability.indeterminate(prepared, outcome.reason);
    }
    const settledTerminal = effectTerminal(outcome.status, outcome.code);
    const { artifact, completed } = await this.#settleEffectWithEmptyArtifact(
      prepared,
      toolCallId,
      settledTerminal,
    );
    return this.#artifactResult(
      toolCallId,
      args.name,
      artifact,
      settledTerminal,
      prepared.effectId,
      completed.event.id,
    );
  }

  async #executeBash(
    toolCallId: ToolCallId,
    call: ToolCall,
    args: Extract<ValidatedToolArguments, { readonly name: "bash" }>,
    signal: AbortSignal,
  ): Promise<PendingToolResult> {
    const permission = await this.#durability.permission(toolCallId, "allow");
    if (signal.aborted) {
      return this.#durability.interruptRun("cancelled", permission.id);
    }
    if (process.platform === "win32") {
      return this.#publishObservation(
        toolCallId,
        "bash",
        terminal("unavailable", "bash_supervisor_unavailable"),
        permission.id,
      );
    }
    this.#effectGate?.beforeEffect();
    const prepared = await this.#durability.prepare(
      toolCallId,
      "bash",
      `sha256:${sha256Hex(utf8Bytes(call.function.arguments))}` as Sha256,
    );
    return this.#runBash(prepared, toolCallId, args, signal);
  }

  async #runBash(
    prepared: PreparedToolEffect,
    toolCallId: ToolCallId,
    args: Extract<ValidatedToolArguments, { readonly name: "bash" }>,
    signal: AbortSignal,
  ): Promise<PendingToolResult> {
    const sink = await this.#durability.beginArtifact().catch(() =>
      this.#durability.indeterminate(prepared, "artifact_durability_failed"),
    );
    const writer = createToolOutputFrameWriter(sink);
    let result: BashRunResult | undefined;
    let processUnknown: BashProcessStateUnknownError | undefined;
    try {
      result = await runNativeBash({
        command: args.value.command,
        cwd: this.#bashCwd,
        childEnvironment: this.#bashChildEnvironment,
        timeoutSeconds: args.value.timeoutSeconds,
        signal,
      });
    } catch (error) {
      if (error instanceof BashProcessStateUnknownError) {
        processUnknown = error;
      } else {
        await sink.abort().catch(() => undefined);
        return this.#durability.indeterminate(prepared, "process_state_unknown");
      }
    }
    let summary: ToolOutputFrameSummary;
    try {
      const output = result?.output ?? processUnknown?.output ?? Object.freeze([]);
      for (const record of output) {
        await writer.write(record.stream, record.bytes);
      }
      summary = await writer.finish();
    } catch {
      await sink.abort().catch(() => undefined);
      return this.#durability.indeterminate(prepared, "artifact_durability_failed");
    }
    let artifact: PublishedToolArtifact;
    const descendantsReaped =
      result?.descendantsReaped ?? processUnknown?.descendantsReaped;
    if (descendantsReaped === undefined) {
      await sink.abort().catch(() => undefined);
      return this.#durability.indeterminate(prepared, "process_state_unknown");
    }
    try {
      artifact = await this.#durability.publish(
        toolCallId,
        sink,
        summary,
        descendantsReaped,
        null,
      );
    } catch {
      return this.#durability.indeterminate(prepared, "artifact_durability_failed");
    }
    if (processUnknown !== undefined || result === undefined) {
      return this.#durability.indeterminate(prepared, "process_state_unknown");
    }
    let resultTerminal: EffectTerminal;
    try {
      resultTerminal = classifyBash(result, summary.hardLimitReached);
    } catch {
      return this.#durability.indeterminate(prepared, "process_state_unknown");
    }
    let completed: CompletedToolEffect;
    try {
      completed = await this.#durability.complete(
        prepared,
        toolCallId,
        artifact,
        resultTerminal,
      );
    } catch {
      throw new ToolRuntimeInterruptedError();
    }
    return this.#artifactResult(
      toolCallId,
      "bash",
      artifact,
      resultTerminal,
      prepared.effectId,
      completed.event.id,
    );
  }

  async #settleEffectWithEmptyArtifact(
    prepared: PreparedToolEffect,
    toolCallId: ToolCallId,
    resultTerminal: EffectTerminal,
  ): Promise<Readonly<{
    readonly artifact: PublishedToolArtifact;
    readonly completed: CompletedToolEffect;
  }>> {
    const sink = await this.#durability.beginArtifact().catch(() =>
      this.#durability.indeterminate(prepared, "artifact_durability_failed"),
    );
    const summary = await createToolOutputFrameWriter(sink).finish();
    let artifact: PublishedToolArtifact;
    try {
      artifact = await this.#durability.publish(
        toolCallId,
        sink,
        summary,
        null,
        null,
      );
    } catch {
      return this.#durability.indeterminate(prepared, "artifact_durability_failed");
    }
    let completed: CompletedToolEffect;
    try {
      completed = await this.#durability.complete(
        prepared,
        toolCallId,
        artifact,
        resultTerminal,
      );
    } catch {
      throw new ToolRuntimeInterruptedError();
    }
    return Object.freeze({ artifact, completed });
  }

  async #publishObservation(
    toolCallId: ToolCallId,
    toolName: ToolName,
    resultTerminal: ToolTerminal,
    failureSourceEventId: EventId,
    matchCount?: number,
  ): Promise<PendingToolResult> {
    let sink;
    try {
      sink = await this.#durability.beginArtifact();
    } catch {
      return this.#durability.interruptRun(
        "durability_failure",
        failureSourceEventId,
      );
    }
    const writer = createToolOutputFrameWriter(sink);
    let summary: ToolOutputFrameSummary;
    try {
      const isActiveEditMatch =
        this.#toolsProfile === "edit-v5" &&
        toolName === "edit" &&
        (resultTerminal.code === "edit_no_match" ||
          resultTerminal.code === "edit_not_unique");
      if (isActiveEditMatch) {
        if (
          !Number.isSafeInteger(matchCount) ||
          (resultTerminal.code === "edit_no_match"
            ? matchCount !== 0
            : (matchCount as number) < 2)
        ) {
          await sink.abort().catch(() => undefined);
          return this.#durability.interruptRun(
            "integrity_violation",
            failureSourceEventId,
          );
        }
        await writer.write("stdout", utf8Bytes(String(matchCount)));
      } else if (matchCount !== undefined) {
        await sink.abort().catch(() => undefined);
        return this.#durability.interruptRun(
          "integrity_violation",
          failureSourceEventId,
        );
      }
      summary = await writer.finish();
    } catch {
      await sink.abort().catch(() => undefined);
      return this.#durability.interruptRun(
        "durability_failure",
        failureSourceEventId,
      );
    }
    let artifact: PublishedToolArtifact;
    try {
      artifact = await this.#durability.publish(
        toolCallId,
        sink,
        summary,
        null,
        resultTerminal,
      );
    } catch {
      return this.#durability.interruptRun(
        "durability_failure",
        failureSourceEventId,
      );
    }
    return this.#artifactResult(
      toolCallId,
      toolName,
      artifact,
      resultTerminal,
      null,
      artifact.event.id,
    );
  }

  async #artifactResult(
    toolCallId: ToolCallId,
    toolName: ToolName,
    artifact: PublishedToolArtifact,
    resultTerminal: ToolTerminal,
    effectId: EffectId | null,
    sourceEventId: EventId,
    readOffset?: number,
  ): Promise<PendingToolResult> {
    const payloadBytes = artifact.descriptor.streamBytes;
    const hardLimitReached = artifact.descriptor.hardLimitReached;
    const descendantsReaped = artifact.descriptor.descendantsReaped;
    if (payloadBytes === null || hardLimitReached === null) {
      return this.#durability.interruptRun("integrity_violation", sourceEventId);
    }
    const bashPreEffectUnavailable =
      toolName === "bash" &&
      resultTerminal.code === "bash_supervisor_unavailable";
    if (
      (toolName === "bash" &&
        !bashPreEffectUnavailable &&
        (typeof descendantsReaped !== "boolean" ||
          resultTerminal.descendantsReaped !== descendantsReaped)) ||
      ((toolName !== "bash" || bashPreEffectUnavailable) &&
        (descendantsReaped !== null ||
          resultTerminal.descendantsReaped !== null))
    ) {
      return this.#durability.interruptRun("integrity_violation", sourceEventId);
    }
    let projector;
    try {
      projector = createArtifactToolResultProjector({
        toolCallId,
        toolName,
        toolsProfile: this.#toolsProfile,
        resultProfile: this.#resultProfile,
        terminalSource: effectId === null ? "artifact" : "effect",
        ...(readOffset === undefined ? {} : { readOffset }),
        artifact: {
          artifactId: artifact.artifactId,
          artifactRef: artifact.descriptor.artifactRef,
          artifactSha256: artifact.descriptor.artifactHash,
          byteCount: artifact.descriptor.byteCount,
          payloadBytes,
          hardLimitReached,
        },
        terminal: resultTerminal,
      });
    } catch (error) {
      if (error instanceof ToolResultProjectionError) {
        return this.#durability.interruptRun("durability_failure", sourceEventId);
      }
      throw error;
    }
    try {
      await this.#durability.scanArtifact(
        artifact.descriptor,
        (bytes) => projector.push(bytes),
      );
    } catch {
      return this.#durability.interruptRun("integrity_violation", sourceEventId);
    }
    try {
      const projected = projector.finish();
      return Object.freeze({
        toolCallId,
        effectId,
        artifactId: artifact.artifactId,
        sourceEventId,
        messageBytes: projected.messageBytes,
      });
    } catch (error) {
      if (error instanceof ToolResultProjectionError) {
        return this.#durability.interruptRun("durability_failure", sourceEventId);
      }
      throw error;
    }
  }
}
