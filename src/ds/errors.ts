export const DEEPSEEK_MAX_TOTAL_ATTEMPTS = 3;
export const DEEPSEEK_RETRY_BASE_DELAY_MS = 500;
export const DEEPSEEK_RETRY_BACKOFF_CAP_MS = 8_000;
export const DEEPSEEK_RETRY_AFTER_CAP_MS = 60_000;

export type DeepSeekHttpClass =
  | "request_invalid"
  | "authentication"
  | "balance"
  | "rate_limited"
  | "server"
  | "unknown";

export type DeepSeekSemanticState =
  | "pre_semantic"
  | "post_semantic"
  | "unknown";

export type DeepSeekRetryClass =
  | DeepSeekHttpClass
  | "timeout"
  | "cancelled"
  | "protocol"
  | "transport_unknown";

export class DeepSeekProtocolError extends Error {
  readonly kind = "protocol" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeepSeekProtocolError";
  }
}

export class DeepSeekHttpError extends Error {
  readonly kind = "http" as const;
  readonly status: number;
  readonly retryAfterHeader: string | null;

  constructor(
    status: number,
    retryAfterHeader: string | null = null,
    options?: ErrorOptions,
  ) {
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new RangeError("DeepSeek HTTP status must be an integer from 100 to 599");
    }

    super(`DeepSeek HTTP ${status}`, options);
    this.name = "DeepSeekHttpError";
    this.status = status;
    this.retryAfterHeader = retryAfterHeader;
  }
}

export type DeepSeekRetryFailure =
  | DeepSeekHttpError
  | DeepSeekProtocolError
  | { readonly kind: "timeout" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "transport"; readonly code: string };

export interface DeepSeekRetryDecisionInput {
  readonly failure: DeepSeekRetryFailure;
  readonly semanticState: DeepSeekSemanticState;
  /** The one-based physical attempt that just failed. */
  readonly failedAttempt: number;
  /** Required for deterministic HTTP-date Retry-After handling. */
  readonly nowMs?: number;
  /** Test seam for the 429 jitter. Math.random() is used when omitted. */
  readonly randomUnit?: number;
}

export interface DeepSeekRetryDecision {
  readonly retry: boolean;
  readonly delayMs: number | null;
  readonly retryClass: DeepSeekRetryClass;
  readonly integritySelfCheck: boolean;
}

export type DeepSeekRetryDelayReason = 429 | 500 | 503 | "timeout";

export interface DeepSeekRetryDelayInput {
  readonly reason: DeepSeekRetryDelayReason;
  /** The one-based physical attempt that just failed. */
  readonly failedAttempt: number;
  readonly retryAfterMs?: number;
  /** A number in [0, 1); only consumed for a 429 delay. */
  readonly randomUnit?: number;
}

function assertFailedAttempt(failedAttempt: number): void {
  if (!Number.isSafeInteger(failedAttempt) || failedAttempt < 1) {
    throw new RangeError("failedAttempt must be a positive safe integer");
  }
}

function cappedExponentialBackoff(failedAttempt: number): number {
  assertFailedAttempt(failedAttempt);
  if (failedAttempt >= 5) return DEEPSEEK_RETRY_BACKOFF_CAP_MS;
  return DEEPSEEK_RETRY_BASE_DELAY_MS * 2 ** (failedAttempt - 1);
}

function bounded429Jitter(nominalMs: number, randomUnit: number): number {
  if (!Number.isFinite(randomUnit) || randomUnit < 0 || randomUnit >= 1) {
    throw new RangeError("randomUnit must be in [0, 1)");
  }

  const floorMs = Math.floor(nominalMs / 2);
  const inclusiveSpan = nominalMs - floorMs + 1;
  return floorMs + Math.floor(randomUnit * inclusiveSpan);
}

function boundedRetryAfter(retryAfterMs: number | undefined): number | undefined {
  if (retryAfterMs === undefined) return undefined;
  if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
    throw new RangeError("retryAfterMs must be a finite non-negative number");
  }
  return Math.min(Math.ceil(retryAfterMs), DEEPSEEK_RETRY_AFTER_CAP_MS);
}

export function classifyDeepSeekHttpStatus(status: number): DeepSeekHttpClass {
  switch (status) {
    case 400:
    case 422:
      return "request_invalid";
    case 401:
      return "authentication";
    case 402:
      return "balance";
    case 429:
      return "rate_limited";
    case 500:
    case 503:
      return "server";
    default:
      return "unknown";
  }
}

/**
 * Parses the Retry-After forms defined for HTTP: delay-seconds or IMF-fixdate.
 * The returned delay is bounded and never negative.
 */
export function parseDeepSeekRetryAfter(
  header: string | null | undefined,
  nowMs: number,
): number | undefined {
  if (header === null || header === undefined) return undefined;

  const value = header.trim();
  if (value.length === 0) return undefined;

  if (/^\d+$/.test(value)) {
    const seconds = BigInt(value);
    const capSeconds = BigInt(DEEPSEEK_RETRY_AFTER_CAP_MS / 1_000);
    if (seconds >= capSeconds) return DEEPSEEK_RETRY_AFTER_CAP_MS;
    return Number(seconds) * 1_000;
  }

  // Reject malformed numeric delays before Date.parse can reinterpret them.
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return undefined;
  if (!Number.isFinite(nowMs)) {
    throw new RangeError("nowMs must be finite");
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  if (new Date(timestamp).toUTCString() !== value) return undefined;

  const delayMs = timestamp - nowMs;
  if (delayMs < 0) return undefined;
  return Math.min(Math.ceil(delayMs), DEEPSEEK_RETRY_AFTER_CAP_MS);
}

export function deepSeekRetryDelayMs(input: DeepSeekRetryDelayInput): number {
  const nominalMs = cappedExponentialBackoff(input.failedAttempt);
  const backoffMs =
    input.reason === 429
      ? bounded429Jitter(nominalMs, input.randomUnit ?? Math.random())
      : nominalMs;
  const retryAfterMs = boundedRetryAfter(input.retryAfterMs);
  return retryAfterMs === undefined
    ? backoffMs
    : Math.max(backoffMs, retryAfterMs);
}

function classifyFailure(failure: DeepSeekRetryFailure): DeepSeekRetryClass {
  switch (failure.kind) {
    case "http":
      return classifyDeepSeekHttpStatus(failure.status);
    case "timeout":
      return "timeout";
    case "cancelled":
      return "cancelled";
    case "protocol":
      return "protocol";
    case "transport":
      return "transport_unknown";
  }
}

function retryableReason(
  failure: DeepSeekRetryFailure,
): DeepSeekRetryDelayReason | undefined {
  if (failure.kind === "timeout") return "timeout";
  if (failure.kind !== "http") return undefined;
  if (
    failure.status === 429 ||
    failure.status === 500 ||
    failure.status === 503
  ) {
    return failure.status;
  }
  return undefined;
}

export function decideDeepSeekRetry(
  input: DeepSeekRetryDecisionInput,
): DeepSeekRetryDecision {
  assertFailedAttempt(input.failedAttempt);

  const retryClass = classifyFailure(input.failure);
  const integritySelfCheck =
    input.failure.kind === "http" &&
    (input.failure.status === 400 || input.failure.status === 422);
  const reason = retryableReason(input.failure);

  if (
    reason === undefined ||
    input.semanticState !== "pre_semantic" ||
    input.failedAttempt >= DEEPSEEK_MAX_TOTAL_ATTEMPTS
  ) {
    return {
      retry: false,
      delayMs: null,
      retryClass,
      integritySelfCheck,
    };
  }

  const retryAfterMs =
    input.failure.kind === "http"
      ? parseDeepSeekRetryAfter(
          input.failure.retryAfterHeader,
          input.nowMs ?? Date.now(),
        )
      : undefined;
  const delayInput: DeepSeekRetryDelayInput = {
    reason,
    failedAttempt: input.failedAttempt,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(input.randomUnit === undefined
      ? {}
      : { randomUnit: input.randomUnit }),
  };

  return {
    retry: true,
    delayMs: deepSeekRetryDelayMs(delayInput),
    retryClass,
    integritySelfCheck,
  };
}
