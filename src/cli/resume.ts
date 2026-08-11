import { SessionInterruptedError } from "../session/index.js";
import type { CompletedSessionResult } from "../session/index.js";

/** Bounded so a persistently broken connection cannot loop forever. */
export const MAX_AUTO_RESUMES = 3;

/**
 * Classes a new Run cannot fix. Invariant 7 already forbids retrying a 400 or
 * 422 — the request itself is wrong, so re-sending the same prefix from the
 * same boundary reproduces it exactly. Credential and balance failures need a
 * person, not another attempt.
 */
const PERMANENT: ReadonlySet<string> = new Set([
  "request_invalid",
  "authentication",
  "balance",
  "protocol",
]);

/**
 * Whether continuing the Session from its last safe boundary is worth trying.
 *
 * A turn the Journal closed with `request_failed` or `semantic_interrupted`
 * left the durable record consistent, so a new Run can pick it up — unless the
 * provider said the request itself was invalid, which no new Run repairs. An
 * indeterminate effect or an integrity violation always needs an operator.
 */
export function isResumable(error: unknown): boolean {
  if (!(error instanceof SessionInterruptedError)) return false;
  if (
    error.reason !== "request_failed" &&
    error.reason !== "semantic_interrupted"
  ) {
    return false;
  }
  return error.retryClass === undefined || !PERMANENT.has(error.retryClass);
}

/**
 * Run a turn, then take over from the last safe boundary if the stream broke.
 *
 * Both the one-shot `flashcoder run` path and interactive mode use this, so a dropped
 * connection costs a resumed Run rather than the whole task.
 */
export async function withAutoResume(
  start: () => Promise<CompletedSessionResult>,
  resume: () => Promise<CompletedSessionResult>,
  onResumeAttempt?: (attempt: number, max: number) => void,
): Promise<CompletedSessionResult> {
  let lastError: unknown;
  try {
    return await start();
  } catch (error) {
    if (!isResumable(error)) throw error;
    lastError = error;
  }

  for (let attempt = 1; attempt <= MAX_AUTO_RESUMES; attempt += 1) {
    onResumeAttempt?.(attempt, MAX_AUTO_RESUMES);
    try {
      return await resume();
    } catch (error) {
      if (!isResumable(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
