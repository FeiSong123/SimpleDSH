import type {
  RequestOptions as HttpsRequestOptions,
} from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";

import { DEEPSEEK_MODEL } from "../bytes/request.js";
import type { DeepSeekCredential } from "./credential.js";
import { authorizationHeaderForDeepSeekTransport } from "./credential.js";
import { DeepSeekHttpError, DeepSeekProtocolError } from "./errors.js";
import {
  DEEPSEEK_HTTPS_REQUEST,
  DeepSeekTransportError,
} from "./transport.js";

/**
 * The official DeepSeek web search lives in the Responses API: a server-side
 * `web_search` tool. The provider searches the live web and returns a
 * search-grounded answer; there is no client-side search endpoint, and chat
 * completions only accept `function` tools. This module performs one search
 * round: it sends the model query as a user input item together with the
 * built-in web_search tool, then extracts the grounded answer and the search
 * actions the server executed.
 */
export const DEEPSEEK_WEB_SEARCH_ENDPOINT = "https://api.deepseek.com/responses";
export const DEEPSEEK_WEB_SEARCH_CONNECT_TIMEOUT_MS = 30_000;
export const DEEPSEEK_WEB_SEARCH_TOTAL_TIMEOUT_MS = 120_000;
export const DEEPSEEK_WEB_SEARCH_MAX_OUTPUT_TOKENS = 1_024;

export type DeepSeekWebSearchHttpsRequestFunction = (
  options: HttpsRequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

export interface DeepSeekWebSearchInput {
  readonly searchQuery: string;
  readonly searchLocale?: string;
}

export interface DeepSeekWebSearchUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

/**
 * What one official search round produced. The provider performs the search
 * and composes the grounded answer, so the caller receives that answer plus
 * the search actions it executed instead of raw result rows.
 */
export interface DeepSeekWebSearchResponse {
  readonly searchId: string;
  readonly answer: string;
  readonly queries: readonly string[];
  readonly openedUrls: readonly string[];
  readonly usage: DeepSeekWebSearchUsage;
}

/**
 * The seam the ToolRuntime uses to execute a model-declared web search. The
 * runtime never sees a credential; the kernel binds one and tests bind a stub.
 */
export type DeepSeekWebSearchExecutor = (
  input: DeepSeekWebSearchInput,
  signal: AbortSignal,
) => Promise<DeepSeekWebSearchResponse>;

export interface DeepSeekWebSearchOptions {
  readonly credential: DeepSeekCredential;
  readonly searchQuery: string;
  readonly searchLocale?: string;
  readonly signal?: AbortSignal;
  readonly requestFunction?: DeepSeekWebSearchHttpsRequestFunction;
  readonly timerDriver?: DeepSeekTimerDriverForWebSearch;
  readonly connectTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
}

export interface DeepSeekTimerDriverForWebSearch {
  readonly set: (callback: () => void, delayMs: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

const DEFAULT_TIMERS: DeepSeekTimerDriverForWebSearch = Object.freeze({
  set: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clear: (handle: unknown) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function searchProtocolFailure(message: string): never {
  throw new DeepSeekProtocolError(`web_search: ${message}`);
}

function requiredStringField(
  value: Record<string, unknown>,
  key: string,
): string {
  const field = value[key];
  if (typeof field !== "string") {
    searchProtocolFailure(`${key} must be a string`);
  }
  return field;
}

function nonNegativeIntegerField(
  value: Record<string, unknown>,
  key: string,
): number {
  const field = value[key];
  if (
    typeof field !== "number" ||
    !Number.isSafeInteger(field) ||
    field < 0
  ) {
    searchProtocolFailure(`${key} must be a non-negative integer`);
  }
  return field;
}

function stringArrayField(
  value: Record<string, unknown>,
  key: string,
): readonly string[] {
  const field = value[key];
  if (!Array.isArray(field)) {
    searchProtocolFailure(`${key} must be an array`);
  }
  return Object.freeze(
    field.map((item) => {
      if (typeof item !== "string") {
        searchProtocolFailure(`${key} entries must be strings`);
      }
      return item;
    }),
  );
}

/**
 * Extracts the provider's grounded answer from the response output items.
 * Commentary messages come first; the final answer is the last message item
 * (the API marks it `phase: "final_answer"` when present).
 */
function extractAnswer(output: readonly unknown[]): string {
  let answer = "";
  for (const rawItem of output) {
    if (!isRecord(rawItem) || rawItem["type"] !== "message") continue;
    const content = rawItem["content"];
    if (!Array.isArray(content)) {
      searchProtocolFailure("message output item content must be an array");
    }
    const texts: string[] = [];
    for (const rawPart of content) {
      if (!isRecord(rawPart) || rawPart["type"] !== "output_text") continue;
      const text = rawPart["text"];
      if (typeof text !== "string") {
        searchProtocolFailure("output_text part text must be a string");
      }
      texts.push(text);
    }
    answer = texts.join("");
  }
  return answer;
}

function parseWebSearchResponse(raw: string): DeepSeekWebSearchResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    searchProtocolFailure("response body is not JSON");
  }
  if (!isRecord(parsed)) {
    searchProtocolFailure("response body must be a JSON object");
  }
  const searchId = requiredStringField(parsed, "id");
  const rawOutput = parsed["output"];
  if (!Array.isArray(rawOutput)) {
    searchProtocolFailure("output must be an array");
  }
  const queries: string[] = [];
  const openedUrls: string[] = [];
  for (const rawItem of rawOutput) {
    if (!isRecord(rawItem) || rawItem["type"] !== "web_search_call") continue;
    const action = rawItem["action"];
    if (!isRecord(action)) {
      searchProtocolFailure("web_search_call action must be an object");
    }
    const actionType = action["type"];
    if (actionType === "search") {
      for (const query of stringArrayField(action, "queries")) {
        // The server appends its own bookkeeping query; it is not a real one.
        if (query.startsWith("ws_call_id=")) continue;
        queries.push(query);
      }
    } else if (actionType === "open_page") {
      const url = requiredStringField(action, "url");
      if (/^https?:\/\//u.test(url)) {
        // Strip the server-internal call-id fragment from opened page URLs.
        const fragmentIndex = url.indexOf("#ws_call_id=");
        openedUrls.push(
          fragmentIndex === -1
            ? url
            : url.slice(0, fragmentIndex),
        );
      }
    }
  }
  const answer = extractAnswer(rawOutput);
  const rawUsage = parsed["usage"];
  if (!isRecord(rawUsage)) {
    searchProtocolFailure("usage must be an object");
  }
  const rawDetails = rawUsage["output_tokens_details"];
  const reasoningTokens = isRecord(rawDetails)
    ? nonNegativeIntegerField(rawDetails, "reasoning_tokens")
    : 0;
  const usage = Object.freeze({
    inputTokens: nonNegativeIntegerField(rawUsage, "input_tokens"),
    outputTokens: nonNegativeIntegerField(rawUsage, "output_tokens"),
    reasoningTokens,
  });
  return Object.freeze({
    searchId,
    answer,
    queries: Object.freeze(queries),
    openedUrls: Object.freeze(openedUrls),
    usage,
  });
}

/**
 * Runs one official DeepSeek web search round: `POST /responses` with the
 * built-in server-side `web_search` tool and the same credential as the Chat
 * Completions traffic. The provider searches and grounds its answer; this only
 * carries the query there and validates the JSON it returns.
 */
export function runDeepSeekWebSearch(
  options: DeepSeekWebSearchOptions,
): Promise<DeepSeekWebSearchResponse> {
  if (options.searchQuery.length === 0) {
    throw new TypeError("search_query must be a non-empty string");
  }
  if (
    options.searchLocale !== undefined &&
    (options.searchLocale.length === 0 ||
      !/^[A-Za-z0-9_-]+$/u.test(options.searchLocale))
  ) {
    throw new TypeError("search_locale must be a non-empty locale tag");
  }
  const requestFunction =
    options.requestFunction ?? DEEPSEEK_HTTPS_REQUEST;
  const timers = options.timerDriver ?? DEFAULT_TIMERS;
  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEEPSEEK_WEB_SEARCH_CONNECT_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEEPSEEK_WEB_SEARCH_TOTAL_TIMEOUT_MS;
  for (const [name, value] of [
    ["connectTimeoutMs", connectTimeoutMs],
    ["totalTimeoutMs", totalTimeoutMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be a finite positive timeout`);
    }
  }
  if (totalTimeoutMs <= connectTimeoutMs) {
    throw new RangeError("totalTimeoutMs must exceed connectTimeoutMs");
  }

  const instructions =
    options.searchLocale === undefined
      ? "You are a web search assistant. Search the live web for the user query and answer concisely and factually, citing the sources you found."
      : `You are a web search assistant. Search the live web for the user query and answer concisely and factually, citing the sources you found. Prefer results in the locale: ${options.searchLocale}.`;
  const body = JSON.stringify({
    model: DEEPSEEK_MODEL,
    instructions,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: options.searchQuery }],
      },
    ],
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
    reasoning: { effort: "low" },
    max_output_tokens: DEEPSEEK_WEB_SEARCH_MAX_OUTPUT_TOKENS,
    stream: false,
  });
  const headers = {
    accept: "application/json",
    authorization: authorizationHeaderForDeepSeekTransport(options.credential),
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json",
  } as const;

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted === true) {
      reject(new DeepSeekTransportError("cancelled", "ABORTED"));
      return;
    }
    let settled = false;
    let connectTimer: unknown;
    let totalTimer: unknown;
    let request: ClientRequest | undefined;

    const clearTimers = (): void => {
      if (connectTimer !== undefined) timers.clear(connectTimer);
      if (totalTimer !== undefined) timers.clear(totalTimer);
      connectTimer = undefined;
      totalTimer = undefined;
    };
    const cleanup = (): void => {
      clearTimers();
      options.signal?.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (error: Error, destroy = true): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (destroy && request !== undefined && !request.destroyed) {
        request.destroy(error);
      }
      reject(error);
    };
    const onAbort = (): void => {
      rejectOnce(new DeepSeekTransportError("cancelled", "ABORTED"));
    };

    try {
      request = requestFunction(
        {
          protocol: "https:",
          hostname: "api.deepseek.com",
          port: 443,
          method: "POST",
          path: "/responses",
          headers,
        },
        (response) => {
          if (settled) {
            response.destroy();
            return;
          }
          const status = response.statusCode;
          if (status !== 200) {
            response.resume();
            rejectOnce(
              status === undefined
                ? new DeepSeekProtocolError(
                    "DeepSeek web search response has no HTTP status",
                  )
                : new DeepSeekHttpError(
                    status,
                    (() => {
                      const retryAfter = response.headers["retry-after"];
                      return Array.isArray(retryAfter)
                        ? (retryAfter[0] ?? null)
                        : (retryAfter ?? null);
                    })(),
                  ),
              false,
            );
            return;
          }
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", (error: Error) => {
            rejectOnce(
              new DeepSeekTransportError("transport", error.message),
            );
          });
          response.on("end", () => {
            if (settled) return;
            let completed: DeepSeekWebSearchResponse;
            try {
              completed = parseWebSearchResponse(
                Buffer.concat(chunks).toString("utf8"),
              );
            } catch (error) {
              rejectOnce(error as Error, false);
              return;
            }
            settled = true;
            cleanup();
            resolve(completed);
          });
        },
      );
    } catch {
      rejectOnce(
        new DeepSeekTransportError("transport", "REQUEST_CONSTRUCTION"),
        false,
      );
      return;
    }

    request.once("socket", (socket) => {
      const connected = (): void => {
        if (connectTimer !== undefined) timers.clear(connectTimer);
        connectTimer = undefined;
      };
      if (!socket.connecting) {
        connected();
      } else {
        socket.once("secureConnect", connected);
      }
    });
    request.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      rejectOnce(
        new DeepSeekTransportError("transport", error.code ?? "UNKNOWN"),
        false,
      );
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });

    connectTimer = timers.set(
      () => rejectOnce(new DeepSeekTransportError("timeout", "CONNECT_TIMEOUT")),
      connectTimeoutMs,
    );
    totalTimer = timers.set(
      () => rejectOnce(new DeepSeekTransportError("timeout", "TOTAL_TIMEOUT")),
      totalTimeoutMs,
    );
    try {
      request.write(body);
      request.end();
    } catch {
      rejectOnce(new DeepSeekTransportError("transport", "REQUEST_WRITE"));
    }
  });
}
