import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { sha256Hex, utf8Bytes } from "../bytes/ops.js";
import { runNativeBash, type BashChildEnvironment } from "../proc/index.js";

export type GateVerdict = "passed" | "failed" | "tampered" | "errored";

export interface GateSpec {
  /** The command whose exit code decides the verdict. Never shown to the model. */
  readonly command: string;
  /** Files and directories the check itself depends on. */
  readonly protectedPaths: readonly string[];
  readonly timeoutSeconds: number;
}

export interface Inventory {
  readonly digest: string;
  readonly lines: readonly string[];
}

export interface GateResult {
  readonly verdict: GateVerdict;
  readonly exitCode: number | null;
  /** stdout and stderr, in the order produced. */
  readonly output: string;
  readonly changedProtectedPaths: readonly string[];
  /** The inventory this verdict was measured against. */
  readonly baselineDigest: string;
}

const OUTPUT_LIMIT = 16_384;

async function walk(root: string, target: string, into: string[]): Promise<void> {
  let stats;
  try {
    stats = await lstat(target);
  } catch {
    into.push(`${relative(root, target) || "."}\tmissing`);
    return;
  }
  const name = relative(root, target) || ".";
  const mode = (stats.mode & 0o7777).toString(8);
  if (stats.isSymbolicLink()) {
    into.push(`${name}\tlink\t${mode}\t${await readlink(target)}`);
    return;
  }
  if (stats.isDirectory()) {
    into.push(`${name}\tdir\t${mode}`);
    for (const entry of (await readdir(target)).sort()) {
      await walk(root, join(target, entry), into);
    }
    return;
  }
  if (!stats.isFile()) {
    into.push(`${name}\tother\t${mode}`);
    return;
  }
  into.push(`${name}\tfile\t${mode}\t${sha256Hex(await readFile(target))}`);
}

/**
 * Record what the protected paths look like right now.
 *
 * Taken once, before the model has run. bash executes as the current user and
 * keeps full write authority over the workspace, so the check cannot be put
 * beyond the model's reach — but a check whose own inputs moved is not a check,
 * and this is what makes that detectable.
 */
export async function takeInventory(
  workspaceRoot: string,
  protectedPaths: readonly string[],
): Promise<Inventory> {
  const root = resolve(workspaceRoot);
  const lines: string[] = [];
  for (const path of [...protectedPaths].sort()) {
    const target = resolve(root, path);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`protected path escapes the workspace: ${path}`);
    }
    await walk(root, target, lines);
  }
  lines.sort();
  return Object.freeze({
    digest: `sha256:${sha256Hex(utf8Bytes(lines.join("\n")))}`,
    lines: Object.freeze(lines),
  });
}

/** Which protected paths differ between two inventories. */
export function changedProtectedPaths(
  baseline: Inventory,
  current: Inventory,
): readonly string[] {
  const before = new Map(baseline.lines.map((line) => [line.split("\t")[0] ?? "", line]));
  const after = new Map(current.lines.map((line) => [line.split("\t")[0] ?? "", line]));
  const changed = new Set<string>();
  for (const [path, line] of before) {
    if (after.get(path) !== line) changed.add(path);
  }
  for (const [path, line] of after) {
    if (before.get(path) !== line) changed.add(path);
  }
  return Object.freeze([...changed].sort());
}

/**
 * Run the declared check and decide.
 *
 * `tampered` outranks the exit code on purpose: once the check's own inputs
 * have moved, a zero exit proves nothing about the work, so it must not be
 * reported as a pass — and it is not offered a retry either, because the model
 * has already shown it will edit what it is judged by.
 */
export async function runGate(
  spec: GateSpec,
  workspaceRoot: string,
  baseline: Inventory,
  childEnvironment: BashChildEnvironment,
  signal: AbortSignal,
): Promise<GateResult> {
  const current = await takeInventory(workspaceRoot, spec.protectedPaths);
  const changed = changedProtectedPaths(baseline, current);

  let result;
  try {
    result = await runNativeBash({
      command: spec.command,
      cwd: resolve(workspaceRoot),
      childEnvironment,
      timeoutSeconds: spec.timeoutSeconds,
      signal,
    });
  } catch (error) {
    return Object.freeze({
      verdict: "errored" as const,
      exitCode: null,
      output: error instanceof Error ? error.message : "verification could not run",
      changedProtectedPaths: changed,
      baselineDigest: baseline.digest,
    });
  }

  const decoder = new TextDecoder("utf-8");
  let output = result.output
    .map((record) => decoder.decode(record.bytes.copy()))
    .join("");
  if (output.length > OUTPUT_LIMIT) {
    output = `${output.slice(0, OUTPUT_LIMIT)}\n[verification output truncated]`;
  }

  const verdict: GateVerdict =
    changed.length > 0
      ? "tampered"
      : result.reason !== "natural"
        ? "errored"
        : result.exitCode === 0
          ? "passed"
          : "failed";

  return Object.freeze({
    verdict,
    exitCode: result.exitCode,
    output,
    changedProtectedPaths: changed,
    baselineDigest: baseline.digest,
  });
}
