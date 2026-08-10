import {
  request as httpsRequest,
  type RequestOptions as HttpsRequestOptions,
} from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";

import type { DeepSeekRequestSnapshot } from "../bytes/request.js";
import { DEEPSEEK_ENDPOINT } from "../bytes/request.js";
import {
  authorizationHeaderForDeepSeekTransport,
  redactDeepSeekHeaders,
  type DeepSeekCredential,
} from "./credential.js";
import {
  decideDeepSeekRetry,
  DeepSeekHttpError,
  DeepSeekProtocolError,
  type DeepSeekRetryDecision,
  type DeepSeekRetryFailure,
  type DeepSeekSemanticState,
} from "./errors.js";
import { parseDeepSeekSse } from "./sse.js";
import type {
  CompletedDeepSeekResponse,
  DeepSeekSemanticFragment,
} from "./types.js";

export const DEEPSEEK_CONNECT_TIMEOUT_MS = 30_000;
export const DEEPSEEK_TTFB_TIMEOUT_MS = 620_000;
export const DEEPSEEK_SEMANTIC_IDLE_TIMEOUT_MS = 90_000;

export type DeepSeekHttpsRequestFunction = (
  options: HttpsRequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

export interface DeepSeekTimerDriver {
  readonly set: (callback: () => void, delayMs: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

export interface DeepSeekTransportTimeouts {
  readonly connectMs: number;
  readonly ttfbMs: number;
  readonly semanticIdleMs: number;
}

export interface DeepSeekRequestMetadata {
  readonly endpoint: typeof DEEPSEEK_ENDPOINT;
  readonly bodySha256: string;
  readonly byteCount: number;
  readonly headers: Readonly<Record<string, string | number | readonly string[]>>;
}

export type DeepSeekTransportFailureKind =
  | "timeout"
  | "cancelled"
  | "transport";

export class DeepSeekTransportError extends Error {
  readonly code: string;

  constructor(
    readonly kind: DeepSeekTransportFailureKind,
    code: string,
  ) {
    super(`DeepSeek transport ${kind}: ${code}`);
    this.name = "DeepSeekTransportError";
    this.code = code;
  }
}

/**
 * Fixed, credential-safe failure for a rejected semantic durability barrier.
 * The underlying error is deliberately neither retained nor exposed.
 */
export class DeepSeekDurabilityError extends Error {
  readonly kind = "durability_error" as const;

  constructor() {
    super("DeepSeek semantic durability barrier failed");
    this.name = "DeepSeekDurabilityError";
  }
}

export interface DeepSeekSendOptions {
  readonly requestFunction: DeepSeekHttpsRequestFunction;
  readonly signal?: AbortSignal;
  readonly timeouts?: DeepSeekTransportTimeouts;
  readonly timerDriver?: DeepSeekTimerDriver;
  readonly onRequestMetadata?: (metadata: DeepSeekRequestMetadata) => void;
  readonly onSemanticDelta?: (
    fragment: DeepSeekSemanticFragment,
  ) => void | Promise<void>;
}

export interface DeepSeekRetryLifecycle {
  readonly beforeAttempt: (
    attempt: number,
    snapshot: DeepSeekRequestSnapshot,
  ) => Promise<void>;
  readonly afterInterrupted: (
    attempt: number,
    failure: Error,
    semanticState: DeepSeekSemanticState,
    decision: DeepSeekRetryDecision,
  ) => Promise<void>;
  readonly onSemanticStarted: (attempt: number) => Promise<void>;
  readonly onRetryScheduled?: (
    attempt: number,
    delayMs: number,
    snapshot: DeepSeekRequestSnapshot,
  ) => void;
}

export interface DeepSeekRetryOptions extends DeepSeekSendOptions {
  readonly lifecycle: DeepSeekRetryLifecycle;
  readonly nowMs?: () => number;
  readonly randomUnit?: () => number;
}

/**
 * The production entry deliberately exposes no request, endpoint, model,
 * timeout, timer, clock, or randomness override.
 */
export interface DeepSeekOfficialOptions {
  readonly lifecycle: DeepSeekRetryLifecycle;
  readonly signal?: AbortSignal;
  readonly onRequestMetadata?: (metadata: DeepSeekRequestMetadata) => void;
  readonly onSemanticDelta?: (
    fragment: DeepSeekSemanticFragment,
  ) => void | Promise<void>;
}

const DEFAULT_TIMEOUTS: DeepSeekTransportTimeouts = Object.freeze({
  connectMs: DEEPSEEK_CONNECT_TIMEOUT_MS,
  ttfbMs: DEEPSEEK_TTFB_TIMEOUT_MS,
  semanticIdleMs: DEEPSEEK_SEMANTIC_IDLE_TIMEOUT_MS,
});

const DEFAULT_TIMERS: DeepSeekTimerDriver = Object.freeze({
  set: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clear: (handle: unknown) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
});

function validateTimeouts(timeouts: DeepSeekTransportTimeouts): void {
  for (const [name, value] of Object.entries(timeouts)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be a finite positive timeout`);
    }
  }
  if (timeouts.ttfbMs < 600_000) {
    throw new RangeError("ttfbMs must preserve the official 600 second queue window");
  }
}

function firstHeader(value: string | readonly string[] | undefined): string | null {
  if (typeof value === "string") return value;
  return value?.[0] ?? null;
}

function transportFailureForRetry(error: DeepSeekTransportError): DeepSeekRetryFailure {
  switch (error.kind) {
    case "timeout":
      return { kind: "timeout" };
    case "cancelled":
      return { kind: "cancelled" };
    case "transport":
      return { kind: "transport", code: error.code };
  }
}

function toRetryFailure(error: unknown): DeepSeekRetryFailure | undefined {
  if (error instanceof DeepSeekHttpError || error instanceof DeepSeekProtocolError) {
    return error;
  }
  if (error instanceof DeepSeekTransportError) {
    return transportFailureForRetry(error);
  }
  return undefined;
}

function abortableDelay(
  delayMs: number,
  signal: AbortSignal | undefined,
  timers: DeepSeekTimerDriver,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DeepSeekTransportError("cancelled", "ABORTED"));
      return;
    }
    let handle: unknown;
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => {
      timers.clear(handle);
      finish(() => reject(new DeepSeekTransportError("cancelled", "ABORTED")));
    };
    handle = timers.set(() => {
      finish(resolve);
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function bestEffortSyncObserver<T extends readonly unknown[]>(
  observer: ((...values: T) => void) | undefined,
): (...values: T) => void {
  let enabled = observer !== undefined;
  return (...values: T): void => {
    if (!enabled || observer === undefined) return;
    try {
      observer(...values);
    } catch {
      enabled = false;
    }
  };
}

function bestEffortAsyncObserver<T>(
  observer: ((value: T) => void | Promise<void>) | undefined,
): (value: T) => void {
  let enabled = observer !== undefined;
  let pending = false;
  return (value: T): void => {
    if (!enabled || pending || observer === undefined) return;
    try {
      const completion = observer(value);
      if (completion === undefined) return;
      pending = true;
      void Promise.resolve(completion).then(
        () => {
          pending = false;
        },
        () => {
          pending = false;
          enabled = false;
        },
      );
    } catch {
      enabled = false;
    }
  };
}

export function runDeepSeekTransportFixtureAttempt(
  snapshot: DeepSeekRequestSnapshot,
  credential: DeepSeekCredential,
  options: DeepSeekSendOptions,
): Promise<CompletedDeepSeekResponse> {
  const timeouts = options.timeouts ?? DEFAULT_TIMEOUTS;
  validateTimeouts(timeouts);
  const timers = options.timerDriver ?? DEFAULT_TIMERS;
  const requestFunction = options.requestFunction;

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted === true) {
      reject(new DeepSeekTransportError("cancelled", "ABORTED"));
      return;
    }

    const headers = {
      accept: "text/event-stream",
      authorization: authorizationHeaderForDeepSeekTransport(credential),
      "content-length": snapshot.byteCount,
      "content-type": "application/json",
    } as const;
    bestEffortSyncObserver(options.onRequestMetadata)(
      Object.freeze({
        endpoint: DEEPSEEK_ENDPOINT,
        bodySha256: snapshot.bodySha256,
        byteCount: snapshot.byteCount,
        headers: redactDeepSeekHeaders(headers),
      }),
    );

    let settled = false;
    let semanticSeen = false;
    let connectTimer: unknown;
    let ttfbTimer: unknown;
    let idleTimer: unknown;
    let request: ClientRequest;

    const clearAllTimers = (): void => {
      if (connectTimer !== undefined) timers.clear(connectTimer);
      if (ttfbTimer !== undefined) timers.clear(ttfbTimer);
      if (idleTimer !== undefined) timers.clear(idleTimer);
      connectTimer = undefined;
      ttfbTimer = undefined;
      idleTimer = undefined;
    };
    const cleanup = (): void => {
      clearAllTimers();
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
    const timeout = (code: string): void => {
      rejectOnce(new DeepSeekTransportError("timeout", code));
    };
    const resetIdleTimer = (): void => {
      if (idleTimer !== undefined) timers.clear(idleTimer);
      idleTimer = timers.set(
        () => timeout("SEMANTIC_IDLE_TIMEOUT"),
        timeouts.semanticIdleMs,
      );
    };
    const onSemanticDelta = async (
      fragment: DeepSeekSemanticFragment,
    ): Promise<void> => {
      if (!semanticSeen) {
        semanticSeen = true;
        if (ttfbTimer !== undefined) timers.clear(ttfbTimer);
        ttfbTimer = undefined;
      }
      resetIdleTimer();
      await options.onSemanticDelta?.(fragment);
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
          path: "/chat/completions",
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
                ? new DeepSeekProtocolError("DeepSeek response has no HTTP status")
                : new DeepSeekHttpError(status, firstHeader(response.headers["retry-after"])),
              false,
            );
            return;
          }
          const contentType = firstHeader(response.headers["content-type"]);
          if (contentType === null || !/^text\/event-stream(?:\s*;|$)/iu.test(contentType)) {
            response.resume();
            rejectOnce(new DeepSeekProtocolError("DeepSeek response is not SSE"), false);
            return;
          }

          void parseDeepSeekSse(response, { onSemanticDelta }).then(
            (completed) => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve(completed);
            },
            (error: unknown) => {
              const failure =
                error instanceof DeepSeekProtocolError ||
                error instanceof DeepSeekDurabilityError ||
                error instanceof DeepSeekTransportError
                  ? error
                  : new DeepSeekTransportError("transport", "STREAM_FAILURE");
              rejectOnce(
                failure,
              );
            },
          );
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
      const tlsSocket = socket as TLSSocket;
      const connected = (): void => {
        if (connectTimer !== undefined) timers.clear(connectTimer);
        connectTimer = undefined;
      };
      if (!socket.connecting) {
        connected();
      } else {
        tlsSocket.once("secureConnect", connected);
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
      () => timeout("CONNECT_TIMEOUT"),
      timeouts.connectMs,
    );
    ttfbTimer = timers.set(() => timeout("TTFB_TIMEOUT"), timeouts.ttfbMs);
    try {
      request.write(snapshot.body.copy());
      request.end();
    } catch {
      rejectOnce(new DeepSeekTransportError("transport", "REQUEST_WRITE"));
    }
  });
}

export async function runDeepSeekTransportFixtureWithRetry(
  snapshot: DeepSeekRequestSnapshot,
  credential: DeepSeekCredential,
  options: DeepSeekRetryOptions,
): Promise<CompletedDeepSeekResponse> {
  const timers = options.timerDriver ?? DEFAULT_TIMERS;
  const observeMetadata = bestEffortSyncObserver(options.onRequestMetadata);
  const observePreview = bestEffortAsyncObserver(options.onSemanticDelta);
  const observeRetryScheduled = bestEffortSyncObserver(
    options.lifecycle.onRetryScheduled,
  );
  for (let attempt = 1; ; attempt += 1) {
    await options.lifecycle.beforeAttempt(attempt, snapshot);
    let semanticState: DeepSeekSemanticState = "pre_semantic";
    try {
      return await runDeepSeekTransportFixtureAttempt(snapshot, credential, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
        requestFunction: options.requestFunction,
        ...(options.timerDriver === undefined
          ? {}
          : { timerDriver: options.timerDriver }),
        onRequestMetadata: observeMetadata,
        onSemanticDelta: async (fragment) => {
          if (semanticState === "pre_semantic") {
            semanticState = "post_semantic";
            try {
              await options.lifecycle.onSemanticStarted(attempt);
            } catch {
              semanticState = "unknown";
              throw new DeepSeekDurabilityError();
            }
          }
          observePreview(fragment);
        },
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const decision: DeepSeekRetryDecision =
        error instanceof DeepSeekDurabilityError
          ? {
              retry: false,
              delayMs: null,
              retryClass: "unknown",
              integritySelfCheck: false,
            }
          : (() => {
              const failure = toRetryFailure(error);
              if (failure === undefined) throw error;
              return decideDeepSeekRetry({
                failure,
                semanticState,
                failedAttempt: attempt,
                nowMs: options.nowMs?.() ?? Date.now(),
                ...(options.randomUnit === undefined ||
                !(failure instanceof DeepSeekHttpError) ||
                failure.status !== 429
                  ? {}
                  : { randomUnit: options.randomUnit() }),
              });
            })();
      await options.lifecycle.afterInterrupted(
        attempt,
        error,
        semanticState,
        decision,
      );
      if (!decision.retry || decision.delayMs === null) throw error;
      observeRetryScheduled(attempt, decision.delayMs, snapshot);
      await abortableDelay(decision.delayMs, options.signal, timers);
    }
  }
}

export function runDeepSeekOfficialWithRetry(
  snapshot: DeepSeekRequestSnapshot,
  credential: DeepSeekCredential,
  options: DeepSeekOfficialOptions,
): Promise<CompletedDeepSeekResponse> {
  return runDeepSeekTransportFixtureWithRetry(snapshot, credential, {
    requestFunction: httpsRequest,
    lifecycle: {
      beforeAttempt: options.lifecycle.beforeAttempt,
      afterInterrupted: options.lifecycle.afterInterrupted,
      onSemanticStarted: options.lifecycle.onSemanticStarted,
      ...(options.lifecycle.onRetryScheduled === undefined
        ? {}
        : { onRetryScheduled: options.lifecycle.onRetryScheduled }),
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onRequestMetadata === undefined
      ? {}
      : { onRequestMetadata: options.onRequestMetadata }),
    ...(options.onSemanticDelta === undefined
      ? {}
      : { onSemanticDelta: options.onSemanticDelta }),
  });
}

/**
 * One minimal non-streaming request, used only by `simpledsh login` to reject a bad
 * key before it is stored. Lives here because `src/ds` owns every outbound
 * DeepSeek call; the key only ever appears in the Authorization header.
 */
export function verifyDeepSeekCredential(
  credential: DeepSeekCredential,
): Promise<void> {
  const body = JSON.stringify({
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1,
    stream: false,
  });
  const url = new URL(DEEPSEEK_ENDPOINT);
  return new Promise<void>((resolve, reject) => {
    const request = httpsRequest(
      {
        method: "POST",
        hostname: url.hostname,
        path: url.pathname,
        headers: {
          authorization: authorizationHeaderForDeepSeekTransport(credential),
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body).toString(),
        },
        timeout: 30_000,
      },
      (response: IncomingMessage) => {
        response.resume();
        const status = response.statusCode ?? 0;
        if (status === 401) {
          reject(new Error("the key was rejected by DeepSeek (401)"));
        } else if (status === 402) {
          reject(new Error("the account has no balance (402)"));
        } else if (status >= 500) {
          reject(new Error(`DeepSeek returned HTTP ${String(status)}`));
        } else {
          resolve();
        }
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("verification timed out"));
    });
    request.on("error", reject);
    request.end(body);
  });
}
