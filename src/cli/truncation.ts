import type { CompletedSessionResult } from "../session/index.js";

/** Bounded, so a model that keeps overrunning cannot loop forever. */
export const MAX_TRUNCATION_CONTINUATIONS = 3;

/**
 * What to say when the model ran out of output tokens part-way through.
 *
 * Short on purpose. It goes at the end of a prefix that is otherwise a cache
 * hit, and every word costs a cache miss on the turn after it. It says what
 * happened, forbids restating the fragment already in the prefix, and asks for
 * an action rather than more prose — the failure being repaired is a turn that
 * spent its whole budget thinking and emitted no tool call.
 */
export const TRUNCATION_CONTINUATION =
  "Your last message stopped at the output token limit, mid-sentence. " +
  "Do not repeat it. Take the next concrete step with a tool now.";

/**
 * Keep going after a reply that was cut off rather than finished.
 *
 * A Run with no tool calls usually means the model is done, and the Session
 * Kernel closes it as completed — correctly, because the bytes are durable and
 * the Commit Boundary stands. But when the provider reported `length` the model
 * did not choose to stop, and `content` is a fragment. Left alone, that
 * fragment is returned as the answer.
 *
 * Continuing is a new user turn from the closed boundary, which is the ordinary
 * multi-turn path: append-only, cache-eligible, and recorded like any other
 * turn. Nothing is replayed and nothing is rewritten.
 */
export async function withTruncationContinuation(
  first: CompletedSessionResult,
  continueTurn: (userInput: string) => Promise<CompletedSessionResult>,
  onContinue?: (attempt: number, max: number) => void,
): Promise<CompletedSessionResult> {
  let result = first;
  for (
    let attempt = 1;
    result.truncated && attempt <= MAX_TRUNCATION_CONTINUATIONS;
    attempt += 1
  ) {
    onContinue?.(attempt, MAX_TRUNCATION_CONTINUATIONS);
    result = await continueTurn(TRUNCATION_CONTINUATION);
  }
  return result;
}
