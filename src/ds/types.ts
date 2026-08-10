import type { FrozenBytes } from "../bytes/types.js";

export interface ToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export interface AssistantView {
  readonly role: "assistant";
  readonly content: string;
  readonly reasoningContent: string;
  readonly toolCalls: readonly ToolCall[];
}

export interface DeepSeekUsage {
  readonly promptTokens: number;
  readonly promptCacheHitTokens: number;
  readonly promptCacheMissTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  readonly rawFinishReason: string;
}

export type DeepSeekSemanticFragment =
  | Readonly<{ readonly kind: "reasoning"; readonly text: string }>
  | Readonly<{ readonly kind: "content"; readonly text: string }>
  | Readonly<{ readonly kind: "tool_call" }>;

export type SemanticDeltaKind = DeepSeekSemanticFragment["kind"];

export interface StreamHooks {
  readonly onSemanticDelta?: (
    fragment: DeepSeekSemanticFragment,
  ) => void | Promise<void>;
}

export interface CompletedDeepSeekResponse {
  readonly assistantBytes: FrozenBytes;
  readonly content: string;
  readonly reasoningContent: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: DeepSeekUsage;
  readonly providerRequestId: string;
  readonly responseModel: string;
  readonly systemFingerprint: string | null;
  readonly semanticDeltaCount: number;
}
