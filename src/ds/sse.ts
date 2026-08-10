import { materializeAssistant } from "../bytes/assistant.js";
import {
  asToolCallId,
  MAX_TOOL_CALL_ID_UTF8_BYTES,
} from "../bytes/tool-call-id.js";
import type {
  CompletedDeepSeekResponse,
  DeepSeekSemanticFragment,
  DeepSeekUsage,
  StreamHooks,
  ToolCall,
} from "./types.js";
import { DeepSeekProtocolError } from "./errors.js";

type DeepSeekProtocolErrorCode =
  | "invalid_utf8"
  | "invalid_sse_line"
  | "invalid_json"
  | "invalid_chunk"
  | "identity_mismatch"
  | "invalid_delta"
  | "invalid_tool_call"
  | "invalid_usage"
  | "invalid_terminal";

interface MutableToolCall {
  readonly index: number;
  id: string;
  idSeen: boolean;
  typeSeen: boolean;
  name: string;
  nameSeen: boolean;
  arguments: string;
  argumentsSeen: boolean;
}

interface ToolCallFragment {
  readonly index: number;
  readonly id: string;
  readonly idSeen: boolean;
  readonly typeSeen: boolean;
  readonly name: string;
  readonly nameSeen: boolean;
  readonly arguments: string;
  readonly argumentsSeen: boolean;
}

function protocolFailure(
  code: DeepSeekProtocolErrorCode,
  message: string,
): never {
  throw new DeepSeekProtocolError(`${code}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  code: DeepSeekProtocolErrorCode,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    protocolFailure(code, `${key} must be a non-empty string`);
  }
  return field;
}

function nonNegativeInteger(
  value: Record<string, unknown>,
  key: string,
): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
    protocolFailure("invalid_usage", `${key} must be a non-negative integer`);
  }
  return field;
}

function decodeLine(rawLine: Uint8Array): string {
  const line =
    rawLine.byteLength > 0 && rawLine[rawLine.byteLength - 1] === 0x0d
      ? rawLine.subarray(0, rawLine.byteLength - 1)
      : rawLine;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  try {
    return decoder.decode(line, { stream: true }) + decoder.decode();
  } catch {
    protocolFailure("invalid_utf8", "SSE line contains invalid UTF-8");
  }
}

function joinLine(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.byteLength;

  const line = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    line.set(part, offset);
    offset += part.byteLength;
  }
  return line;
}

function parseUsage(value: Record<string, unknown>, finishReason: string): DeepSeekUsage {
  const promptTokens = nonNegativeInteger(value, "prompt_tokens");
  const promptCacheHitTokens = nonNegativeInteger(
    value,
    "prompt_cache_hit_tokens",
  );
  const promptCacheMissTokens = nonNegativeInteger(
    value,
    "prompt_cache_miss_tokens",
  );
  const completionTokens = nonNegativeInteger(value, "completion_tokens");
  const totalTokens = nonNegativeInteger(value, "total_tokens");
  const details = value["completion_tokens_details"];
  if (!isRecord(details)) {
    protocolFailure(
      "invalid_usage",
      "completion_tokens_details must be an object",
    );
  }
  const reasoningTokens = nonNegativeInteger(details, "reasoning_tokens");

  if (promptTokens !== promptCacheHitTokens + promptCacheMissTokens) {
    protocolFailure(
      "invalid_usage",
      "prompt token count does not equal cache hit plus cache miss tokens",
    );
  }
  if (totalTokens !== promptTokens + completionTokens) {
    protocolFailure(
      "invalid_usage",
      "total token count must include completion tokens exactly once",
    );
  }
  if (reasoningTokens > completionTokens) {
    protocolFailure(
      "invalid_usage",
      "reasoning tokens cannot exceed completion tokens",
    );
  }

  return {
    promptTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
    completionTokens,
    reasoningTokens,
    rawFinishReason: finishReason,
  };
}

/**
 * Parses one DeepSeek Chat Completions SSE body. All response state remains
 * staging state until the unique usage record and [DONE] terminal validate.
 */
export async function parseDeepSeekSse(
  chunks: AsyncIterable<Uint8Array>,
  hooks: StreamHooks = {},
): Promise<CompletedDeepSeekResponse> {
  let providerRequestId: string | undefined;
  let responseModel: string | undefined;
  let systemFingerprint: string | null | undefined;
  let content = "";
  let reasoningContent = "";
  let reasoningContentSeen = false;
  let finishReason: string | undefined;
  let usage: DeepSeekUsage | undefined;
  let semanticDeltaCount = 0;
  let doneSeen = false;
  const toolCalls = new Map<number, MutableToolCall>();

  const emitSemantic = async (
    fragment: DeepSeekSemanticFragment,
  ): Promise<void> => {
    await hooks.onSemanticDelta?.(Object.freeze(fragment));
    semanticDeltaCount += 1;
  };

  const bindIdentity = (chunk: Record<string, unknown>): void => {
    const id = requiredString(chunk, "id", "invalid_chunk");
    const model = requiredString(chunk, "model", "invalid_chunk");
    if (!hasOwn(chunk, "system_fingerprint")) {
      protocolFailure("invalid_chunk", "system_fingerprint is required");
    }
    const fingerprint = chunk["system_fingerprint"];
    if (fingerprint !== null && typeof fingerprint !== "string") {
      protocolFailure(
        "invalid_chunk",
        "system_fingerprint must be a string or null",
      );
    }

    if (providerRequestId === undefined) {
      providerRequestId = id;
      responseModel = model;
      systemFingerprint = fingerprint;
      return;
    }
    if (
      providerRequestId !== id ||
      responseModel !== model ||
      systemFingerprint !== fingerprint
    ) {
      protocolFailure(
        "identity_mismatch",
        "response identity changed within one stream",
      );
    }
  };

  const parseToolCallDeltas = async (value: unknown): Promise<boolean> => {
    if (value === null) return false;
    if (!Array.isArray(value)) {
      protocolFailure("invalid_tool_call", "tool_calls must be an array or null");
    }

    const fragments: ToolCallFragment[] = [];
    const indexesInChunk = new Set<number>();
    for (const item of value) {
      if (!isRecord(item)) {
        protocolFailure("invalid_tool_call", "tool call delta must be an object");
      }
      const index = item["index"];
      if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) {
        protocolFailure(
          "invalid_tool_call",
          "tool call index must be a non-negative integer",
        );
      }
      if (indexesInChunk.has(index)) {
        protocolFailure(
          "invalid_tool_call",
          "tool call index is duplicated within one delta",
        );
      }
      indexesInChunk.add(index);

      let itemHasPayload = false;
      let id = "";
      let idSeen = false;
      let typeSeen = false;
      let name = "";
      let nameSeen = false;
      let argumentsDelta = "";
      let argumentsSeen = false;
      if (hasOwn(item, "id")) {
        const rawId = item["id"];
        if (typeof rawId !== "string") {
          protocolFailure("invalid_tool_call", "tool call id delta must be a string");
        }
        id = rawId;
        idSeen = true;
        itemHasPayload = true;
      }
      if (hasOwn(item, "type")) {
        if (item["type"] !== "function") {
          protocolFailure("invalid_tool_call", "tool call type must be function");
        }
        typeSeen = true;
        itemHasPayload = true;
      }
      if (hasOwn(item, "function")) {
        const functionDelta = item["function"];
        if (!isRecord(functionDelta)) {
          protocolFailure(
            "invalid_tool_call",
            "tool call function delta must be an object",
          );
        }
        let functionHasPayload = false;
        if (hasOwn(functionDelta, "name")) {
          const rawName = functionDelta["name"];
          if (typeof rawName !== "string") {
            protocolFailure(
              "invalid_tool_call",
              "tool call name delta must be a string",
            );
          }
          name = rawName;
          nameSeen = true;
          functionHasPayload = true;
        }
        if (hasOwn(functionDelta, "arguments")) {
          const rawArguments = functionDelta["arguments"];
          if (typeof rawArguments !== "string") {
            protocolFailure(
              "invalid_tool_call",
              "tool call arguments delta must be a string",
            );
          }
          argumentsDelta = rawArguments;
          argumentsSeen = true;
          functionHasPayload = true;
        }
        if (!functionHasPayload) {
          protocolFailure(
            "invalid_tool_call",
            "tool call function delta has no payload",
          );
        }
        itemHasPayload = true;
      }
      if (!itemHasPayload) {
        protocolFailure("invalid_tool_call", "tool call delta has no payload");
      }
      fragments.push({
        index,
        id,
        idSeen,
        typeSeen,
        name,
        nameSeen,
        arguments: argumentsDelta,
        argumentsSeen,
      });
    }
    if (fragments.length === 0) return false;

    for (const fragment of fragments) {
      if (!fragment.idSeen) continue;
      const existingLength = toolCalls.get(fragment.index)?.id.length ?? 0;
      if (existingLength + fragment.id.length > MAX_TOOL_CALL_ID_UTF8_BYTES) {
        protocolFailure(
          "invalid_tool_call",
          "tool call id exceeds the UTF-16 staging limit",
        );
      }
    }

    // The hook durably marks request_semantic_started before any fragment is
    // copied into staging. A rejected hook therefore leaves staging untouched.
    await emitSemantic({ kind: "tool_call" });
    for (const fragment of fragments) {
      let call = toolCalls.get(fragment.index);
      if (call === undefined) {
        call = {
          index: fragment.index,
          id: "",
          idSeen: false,
          typeSeen: false,
          name: "",
          nameSeen: false,
          arguments: "",
          argumentsSeen: false,
        };
        toolCalls.set(fragment.index, call);
      }
      if (fragment.idSeen) {
        call.id += fragment.id;
        call.idSeen = true;
      }
      if (fragment.typeSeen) call.typeSeen = true;
      if (fragment.nameSeen) {
        call.name += fragment.name;
        call.nameSeen = true;
      }
      if (fragment.argumentsSeen) {
        call.arguments += fragment.arguments;
        call.argumentsSeen = true;
      }
    }
    return true;
  };

  const parseChoice = async (value: unknown): Promise<void> => {
    if (finishReason !== undefined) {
      protocolFailure("invalid_terminal", "choice received after finish reason");
    }
    if (!isRecord(value)) {
      protocolFailure("invalid_chunk", "choice must be an object");
    }
    if (value["index"] !== 0) {
      protocolFailure("invalid_chunk", "only choice index 0 is valid");
    }
    const delta = value["delta"];
    if (!isRecord(delta)) {
      protocolFailure("invalid_delta", "choice delta must be an object");
    }
    if (!hasOwn(value, "finish_reason")) {
      protocolFailure("invalid_terminal", "finish_reason is required on every choice");
    }

    if (
      hasOwn(delta, "role") &&
      delta["role"] !== null &&
      delta["role"] !== "assistant"
    ) {
      protocolFailure("invalid_delta", "delta role must be assistant or null");
    }
    if (hasOwn(delta, "reasoning_content")) {
      const reasoningDelta = delta["reasoning_content"];
      if (reasoningDelta !== null && typeof reasoningDelta !== "string") {
        protocolFailure(
          "invalid_delta",
          "reasoning_content delta must be a string or null",
        );
      }
      if (typeof reasoningDelta === "string") {
        if (reasoningDelta.length > 0) {
          await emitSemantic({ kind: "reasoning", text: reasoningDelta });
        }
        reasoningContentSeen = true;
        reasoningContent += reasoningDelta;
      }
    }
    if (hasOwn(delta, "content")) {
      const contentDelta = delta["content"];
      if (contentDelta !== null && typeof contentDelta !== "string") {
        protocolFailure(
          "invalid_delta",
          "content delta must be a string or null",
        );
      }
      if (typeof contentDelta === "string") {
        if (contentDelta.length > 0) {
          await emitSemantic({ kind: "content", text: contentDelta });
        }
        content += contentDelta;
      }
    }
    if (hasOwn(delta, "tool_calls")) {
      await parseToolCallDeltas(delta["tool_calls"]);
    }

    const rawFinishReason = value["finish_reason"];
    if (rawFinishReason !== null) {
      if (typeof rawFinishReason !== "string" || rawFinishReason.length === 0) {
        protocolFailure(
          "invalid_terminal",
          "finish_reason must be a non-empty string or null",
        );
      }
      finishReason = rawFinishReason;
    }
  };

  const parseData = async (payload: string): Promise<void> => {
    if (payload === "[DONE]") {
      if (doneSeen) {
        protocolFailure("invalid_terminal", "duplicate [DONE] terminal");
      }
      if (finishReason === undefined || usage === undefined) {
        protocolFailure(
          "invalid_terminal",
          "[DONE] arrived before finish reason and complete usage",
        );
      }
      doneSeen = true;
      return;
    }
    if (doneSeen) {
      protocolFailure("invalid_terminal", "data received after [DONE]");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      protocolFailure("invalid_json", "SSE data is not valid JSON");
    }
    if (!isRecord(parsed)) {
      protocolFailure("invalid_chunk", "SSE data must contain a JSON object");
    }
    bindIdentity(parsed);

    const choices = parsed["choices"];
    if (!Array.isArray(choices)) {
      protocolFailure("invalid_chunk", "choices must be an array");
    }
    const rawUsage = parsed["usage"];
    if (rawUsage !== undefined && rawUsage !== null) {
      if (usage !== undefined) {
        protocolFailure("invalid_usage", "duplicate complete usage record");
      }
      if (!isRecord(rawUsage)) {
        protocolFailure("invalid_usage", "complete usage must be an object");
      }
      if (choices.length !== 0 && choices.length !== 1) {
        protocolFailure(
          "invalid_usage",
          "complete usage chunk must have zero or one choice",
        );
      }
      if (choices.length === 1) {
        if (finishReason !== undefined) {
          protocolFailure("invalid_terminal", "choice received after finish reason");
        }
        const terminalChoice = choices[0];
        if (!isRecord(terminalChoice)) {
          protocolFailure("invalid_chunk", "choice must be an object");
        }
        if (!hasOwn(terminalChoice, "finish_reason")) {
          protocolFailure(
            "invalid_terminal",
            "finish_reason is required on every choice",
          );
        }
        const coLocatedFinishReason = terminalChoice["finish_reason"];
        if (coLocatedFinishReason === null) {
          protocolFailure(
            "invalid_usage",
            "usage cannot accompany a nonterminal choice",
          );
        }
        if (
          typeof coLocatedFinishReason !== "string" ||
          coLocatedFinishReason.length === 0
        ) {
          protocolFailure(
            "invalid_terminal",
            "finish_reason must be a non-empty string or null",
          );
        }
        await parseChoice(terminalChoice);
      }
      if (finishReason === undefined) {
        protocolFailure("invalid_usage", "usage arrived before finish reason");
      }
      usage = parseUsage(rawUsage, finishReason);
      return;
    }

    if (choices.length !== 1) {
      protocolFailure(
        "invalid_chunk",
        "non-usage chunk must contain exactly one choice",
      );
    }
    await parseChoice(choices[0]);
  };

  const parseLine = async (rawLine: Uint8Array): Promise<void> => {
    const line = decodeLine(rawLine);
    if (line.length === 0 || line.startsWith(":")) return;
    if (!line.startsWith("data:")) {
      protocolFailure("invalid_sse_line", "unsupported SSE field");
    }
    const rawPayload = line.slice(5);
    const payload = rawPayload.startsWith(" ")
      ? rawPayload.slice(1)
      : rawPayload;
    if (payload.length === 0) {
      protocolFailure("invalid_sse_line", "SSE data field is empty");
    }
    await parseData(payload);
  };

  let lineParts: Uint8Array[] = [];
  for await (const chunk of chunks) {
    let lineStart = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      if (index > lineStart) {
        lineParts.push(chunk.slice(lineStart, index));
      }
      await parseLine(joinLine(lineParts));
      lineParts = [];
      lineStart = index + 1;
    }
    if (lineStart < chunk.byteLength) {
      lineParts.push(chunk.slice(lineStart));
    }
  }
  if (lineParts.length > 0) await parseLine(joinLine(lineParts));

  if (!doneSeen) {
    protocolFailure("invalid_terminal", "stream ended without [DONE]");
  }
  if (
    providerRequestId === undefined ||
    responseModel === undefined ||
    systemFingerprint === undefined ||
    finishReason === undefined ||
    usage === undefined
  ) {
    protocolFailure("invalid_terminal", "stream terminal state is incomplete");
  }

  const orderedIndexes = [...toolCalls.keys()].sort((left, right) => left - right);
  const completedToolCalls: ToolCall[] = [];
  for (const [position, index] of orderedIndexes.entries()) {
    if (index !== position) {
      protocolFailure("invalid_tool_call", "tool call indexes must be contiguous");
    }
    const call = toolCalls.get(index);
    if (
      call === undefined ||
      !call.idSeen ||
      call.id.length === 0 ||
      !call.typeSeen ||
      !call.nameSeen ||
      call.name.length === 0 ||
      !call.argumentsSeen
    ) {
      protocolFailure("invalid_tool_call", "tool call is incomplete");
    }
    let checkedId: string;
    try {
      checkedId = asToolCallId(call.id);
    } catch {
      protocolFailure("invalid_tool_call", "tool call id is invalid");
    }
    completedToolCalls.push({
      id: checkedId,
      type: "function",
      function: {
        name: call.name,
        arguments: call.arguments,
      },
    });
  }
  if (completedToolCalls.length > 0 && !reasoningContentSeen) {
    protocolFailure(
      "invalid_delta",
      "tool call response is missing string reasoning_content",
    );
  }

  return {
    assistantBytes: materializeAssistant({
      content,
      reasoningContent,
      toolCalls: completedToolCalls,
    }),
    content,
    reasoningContent,
    toolCalls: completedToolCalls,
    usage,
    providerRequestId,
    responseModel,
    systemFingerprint,
    semanticDeltaCount,
  };
}
