import { concatBytes, utf8Bytes } from "./ops.js";
import type { FrozenBytes } from "./types.js";

export const LEGACY_BASE_SYSTEM_PROMPT =
  "You are SimpleDSH, a coding agent. Work directly with the user using read, write, edit, and bash. Keep plans and durable state in visible files. Treat tool results as the only evidence that an action occurred.";

export const PRIOR_BASE_SYSTEM_PROMPT =
  `${LEGACY_BASE_SYSTEM_PROMPT} For a requested change, once the smallest supported edit is clear, apply it and run the narrowest relevant verification; continue reading only when a concrete unresolved question blocks that edit.`;

export const PREVIOUS_BASE_SYSTEM_PROMPT =
  `${LEGACY_BASE_SYSTEM_PROMPT} When the user requests a change, diagnosis alone is not completion: after locating the causal code, make the smallest reversible edit and run the narrowest relevant test. Use additional reads only to answer one explicitly named question that blocks that edit; let the test resolve remaining uncertainty instead of rereading adjacent code.`;

export const RESOLVE_BASE_SYSTEM_PROMPT =
  "You are SimpleDSH, an expert coding assistant. Resolve the user's request completely in the current workspace using read, write, edit, and bash. Paths and bash commands already use the workspace as their working directory; use relative paths and do not prefix commands with cd. Use read for file contents and bash for focused search and verification. Keep plans and durable state in visible files, and treat tool results as the only evidence that an action occurred. For a requested change, diagnosis or a patch plan is not completion. Once a causal hypothesis is supported, create the smallest missing regression when needed, make the smallest reversible edit, and run the narrowest relevant test; use that edit-test feedback instead of rereading unchanged or adjacent files to eliminate every uncertainty. Continue until the implementation and relevant verification are complete, or report the concrete blocker that makes further action impossible. Be concise in the final response." as const;

/**
 * Load-only compatibility for the four-tools ABI that was ACTIVE before
 * web_search landed. Sessions created by that binary carry this system blob in
 * their Cache ABI manifest, so it must keep round-tripping forever.
 */
export const PRECEDING_BASE_SYSTEM_PROMPT =
  `You are SimpleDSH, an expert coding agent working in the user's workspace with four tools: read, write, edit, and bash. The workspace is already the working directory — use relative paths and never prefix a command with cd.

Act, then prove it.
- A diagnosis, a plan, or a description of the fix is not the fix. Make the edit.
- After a change, run the narrowest command that would fail if you were wrong. Never report a result you have not observed — tool results are the only evidence an action occurred.

Move in batches.
- Independent reads issued in the same reply run in parallel. Ask for them together instead of one per turn.
- bash to search, list and run; read for file contents; edit to change an existing file; write only for a new file or a full replacement.

Finish the job.
- Prefer a reasonable assumption to a question, and say what you assumed.
- Match the conventions already in the file you are editing.
- Keep going until the change is implemented and verified, or name the concrete blocker that stops you.
- End with a short answer: what changed, and what proves it.` as const;

/**
 * The canonical prompt for new Sessions.
 *
 * Written as short lines under three headings rather than one paragraph,
 * because the paragraph form buried the instructions that were actually being
 * disobeyed. Each line here answers to something observed on Terminal-Bench:
 *
 * - the parallel-reads line: reads issued together are dispatched
 *   concurrently, and nothing previously told the model that;
 * - the assumption line: `simpledsh run` has nobody to answer a question, and a turn
 *   that ends in one ends with a question as its answer;
 * - the evidence line: a claim of success without a command behind it is the
 *   most expensive kind of wrong.
 *
 * Deliberately absent: anything telling the model to think less or read less.
 * Turns that ran out of output tokens mid-thought are handled where they belong
 * — the kernel reports the truncation and the CLI takes another turn — and this
 * model is run at a high reasoning effort on purpose. Rationing deliberation or
 * exploration here would trade its strongest behaviour against failures that
 * are either already repaired or caused by something else: the timeouts were
 * dominated by package installs and single long-running commands, not by
 * rereading.
 */
export const BASE_SYSTEM_PROMPT =
  `You are SimpleDSH, an expert coding agent working in the user's workspace with five tools: read, write, edit, bash, and web_search. The workspace is already the working directory — use relative paths and never prefix a command with cd.

Act, then prove it.
- A diagnosis, a plan, or a description of the fix is not the fix. Make the edit.
- After a change, run the narrowest command that would fail if you were wrong. Never report a result you have not observed — tool results are the only evidence an action occurred.

Move in batches.
- Independent reads issued in the same reply run in parallel. Ask for them together instead of one per turn.
- bash to search, list and run; read for file contents; edit to change an existing file; write only for a new file or a full replacement.
- Use web_search for current facts, recent events, or anything the workspace cannot verify — never invent them.

Finish the job.
- Prefer a reasonable assumption to a question, and say what you assumed.
- Match the conventions already in the file you are editing.
- Keep going until the change is implemented and verified, or name the concrete blocker that stops you.
- End with a short answer: what changed, and what proves it.` as const;

const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

function jsonString(value: string): FrozenBytes {
  return utf8Bytes(JSON.stringify(value));
}

function materializeSystemMessageFor(
  basePrompt: string,
  projectInstructions?: FrozenBytes,
): FrozenBytes {
  let content = basePrompt;
  if (projectInstructions !== undefined && projectInstructions.byteLength > 0) {
    content += `\n\nProject instructions:\n${fatalDecoder.decode(projectInstructions.copy())}`;
  }

  return concatBytes([
    utf8Bytes('{"role":"system","content":'),
    jsonString(content),
    utf8Bytes("}"),
  ]);
}

/** New Sessions construct only the current canonical system message. */
export function materializeSystemMessage(
  projectInstructions?: FrozenBytes,
): FrozenBytes {
  return materializeSystemMessageFor(BASE_SYSTEM_PROMPT, projectInstructions);
}

/** Load-only compatibility for Lineages opened under the one-paragraph prompt. */
export function materializeResolveSystemMessage(
  projectInstructions?: FrozenBytes,
): FrozenBytes {
  return materializeSystemMessageFor(
    RESOLVE_BASE_SYSTEM_PROMPT,
    projectInstructions,
  );
}

/**
 * Load-only compatibility for the four-tools ABI that was ACTIVE before
 * web_search landed. Sessions created by that binary load through this.
 */
export function materializePrecedingSystemMessage(
  projectInstructions?: FrozenBytes,
): FrozenBytes {
  return materializeSystemMessageFor(
    PRECEDING_BASE_SYSTEM_PROMPT,
    projectInstructions,
  );
}

/** Load-only compatibility for the immediately previous edit-v5 ABI. */
export function materializePreviousSystemMessage(
  projectInstructions?: FrozenBytes,
): FrozenBytes {
  return materializeSystemMessageFor(
    PREVIOUS_BASE_SYSTEM_PROMPT,
    projectInstructions,
  );
}

/** Closed replay compatibility for already-durable pre-Stage-07 ABI bytes. */
export function materializeLegacySystemMessage(
  projectInstructions?: FrozenBytes,
): FrozenBytes {
  return materializeSystemMessageFor(
    LEGACY_BASE_SYSTEM_PROMPT,
    projectInstructions,
  );
}

/** Closed replay compatibility for the first Stage-07 action prompt. */
export function materializePriorSystemMessage(
  projectInstructions?: FrozenBytes,
): FrozenBytes {
  return materializeSystemMessageFor(
    PRIOR_BASE_SYSTEM_PROMPT,
    projectInstructions,
  );
}

// Frozen legacy wire export retained because the immutable real-task-v2
// evidence imports this exact symbol. Product construction uses the active
// materializer/ACTIVE_SYSTEM_MESSAGE_BYTES instead.
export const BASE_SYSTEM_MESSAGE_BYTES = materializeLegacySystemMessage();

// Frozen evidence-ABI export retained because immutable real-task-v3 sources
// import this exact symbol. Product construction must use ACTIVE_* below.
export const CURRENT_SYSTEM_MESSAGE_BYTES = materializePriorSystemMessage();

// Frozen v4-v7 bytes. Existing edit-v5 Lineages load these without upgrading.
export const PREVIOUS_SYSTEM_MESSAGE_BYTES = materializePreviousSystemMessage();

// Frozen four-tools bytes. Sessions created before web_search landed carry
// this system blob; load-only, never constructed for new Sessions.
export const PRECEDING_SYSTEM_MESSAGE_BYTES = materializePrecedingSystemMessage();

/** New Sessions and provider request construction use only these active bytes. */
export const ACTIVE_SYSTEM_MESSAGE_BYTES = materializeSystemMessage();
