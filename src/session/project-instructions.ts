/**
 * The workspace's own rules, frozen into the prefix when a Session starts.
 *
 * A repository knows things the model cannot guess: which command proves a
 * change, which directories are generated, what the conventions are. Those
 * facts are the same for every turn of every Session in that workspace, so
 * they belong in the frozen zone, where they are part of the Cache ABI and
 * cost nothing after the first request.
 *
 * Read once, at session creation. A Session that has already started keeps the
 * bytes it froze even if the file changes underneath it — the prefix is
 * append-only, and silently rewriting what the model was told would be the
 * second source of truth this system does not have.
 */

import { lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { utf8Bytes } from "../bytes/ops.js";
import type { FrozenBytes } from "../bytes/types.js";

export const PROJECT_INSTRUCTIONS_FILE = "AGENTS.md";

/**
 * Roughly four thousand tokens. Generous for a rules file and small against a
 * 1M window, but bounded: this text is in front of every request the Session
 * ever makes.
 */
export const PROJECT_INSTRUCTIONS_LIMIT_BYTES = 16_384;

export class ProjectInstructionsError extends Error {
  constructor(
    readonly reason: "too_large" | "not_a_file" | "not_utf8" | "unreadable",
    readonly path: string,
    detail: string,
  ) {
    super(`${PROJECT_INSTRUCTIONS_FILE}: ${detail}`);
    this.name = "ProjectInstructionsError";
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * The workspace's instructions, or `undefined` when it has none.
 *
 * Absence is ordinary and silent. Anything else — a directory in its place, a
 * file too large to freeze, bytes that are not UTF-8 — fails loudly rather than
 * being dropped or cut: half a rule can say the opposite of the whole rule.
 */
export function loadProjectInstructions(
  workspaceRoot: string,
): FrozenBytes | undefined {
  const path = join(workspaceRoot, PROJECT_INSTRUCTIONS_FILE);

  // Absent means nothing is there under that name. A symlink is there, so a
  // symlink whose target is gone is a broken setup, not an absence: someone
  // meant to give the model rules and it would silently get none.
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ProjectInstructionsError(
      "unreadable",
      path,
      `cannot be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`,
    );
  }

  let size: number;
  try {
    // Follows a symlink on purpose: this is documentation, not a credential,
    // and pointing it at a file shared across repositories is reasonable.
    const stats = statSync(path);
    if (!stats.isFile()) {
      throw new ProjectInstructionsError(
        "not_a_file",
        path,
        "is not a regular file",
      );
    }
    size = stats.size;
  } catch (error) {
    if (error instanceof ProjectInstructionsError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new ProjectInstructionsError(
      "unreadable",
      path,
      code === "ENOENT"
        ? "is a symlink whose target does not exist"
        : `cannot be read (${code ?? "unknown error"})`,
    );
  }

  if (size > PROJECT_INSTRUCTIONS_LIMIT_BYTES) {
    throw new ProjectInstructionsError(
      "too_large",
      path,
      `is ${String(size)} bytes; the limit is ${String(PROJECT_INSTRUCTIONS_LIMIT_BYTES)}`,
    );
  }

  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ProjectInstructionsError(
      "unreadable",
      path,
      `cannot be read (${code ?? "unknown error"})`,
    );
  }

  let text: string;
  try {
    text = decoder.decode(raw);
  } catch {
    throw new ProjectInstructionsError("not_utf8", path, "is not valid UTF-8");
  }

  // Trailing whitespace is editor noise. Dropping it keeps the Cache ABI stable
  // across a newline someone's editor added, and an empty file stays absent
  // rather than freezing an empty heading into every request.
  const trimmed = text.trimEnd();
  return trimmed.length === 0 ? undefined : utf8Bytes(trimmed);
}
