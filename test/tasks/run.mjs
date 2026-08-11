#!/usr/bin/env node
// Fixed real-task runner.
//
//   node test/tasks/run.mjs --check       verify each task still fails before the
//                                         solution patch and passes after it; no model
//   node test/tasks/run.mjs               run the model on every task (needs DSH_LIVE=1)
//   node test/tasks/run.mjs rt03          run one task
//   node test/tasks/run.mjs --keep        keep the run directory for inspection
//
// A task passes when its verifier commands exit exactly as `expectAfterFix` and the
// model changed nothing outside `writablePaths`. `.dsh/` and `dist/` are harness output
// and are ignored.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const TASKS_DIR = import.meta.dirname;
const REPO = resolve(TASKS_DIR, "..", "..");
const CLI = join(REPO, "dist", "src", "cli.js");
const IGNORED_ROOTS = new Set([".flashcoder", ".dsh", "dist", "node_modules", ".git"]);
const DEFAULT_TIMEOUT_SECONDS = 1800;

function parseArguments(argv) {
  const ids = [];
  let check = false;
  let keep = false;
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--check") check = true;
    else if (value === "--keep") keep = true;
    else if (value === "--timeout") {
      timeoutSeconds = Number(argv[index + 1]);
      index += 1;
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        throw new Error("--timeout needs a positive number of seconds");
      }
    } else if (value.startsWith("-")) throw new Error(`unknown option ${value}`);
    else ids.push(value);
  }
  return { ids, check, keep, timeoutSeconds };
}

function run(argv, options) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function extractTar(tarPath, destination) {
  const result = run(["tar", "-xf", tarPath, "-C", destination], {});
  if (result.status !== 0) throw new Error(`tar failed for ${tarPath}: ${result.stderr}`);
}

async function hashTree(root) {
  const entries = new Map();
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const relativePath = relative(root, absolute);
      if (IGNORED_ROOTS.has(relativePath.split("/")[0])) continue;
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        entries.set(relativePath, createHash("sha256").update(await readFile(absolute)).digest("hex"));
      } else entries.set(relativePath, `non-file:${entry.isSymbolicLink() ? "symlink" : "other"}`);
    }
  }
  await walk(root);
  return entries;
}

function diffTrees(before, after) {
  const changed = [];
  for (const [path, hash] of after) {
    if (!before.has(path)) changed.push(path);
    else if (before.get(path) !== hash) changed.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) changed.push(path);
  return changed.sort();
}

function isInsideWritable(path, writablePaths) {
  return writablePaths.some((allowed) => path === allowed || path.startsWith(`${allowed}/`));
}

async function prepareWorkspace(task, runRoot) {
  const work = join(runRoot, "work");
  await mkdir(work, { recursive: true });
  extractTar(join(TASKS_DIR, task.workspace), work);
  await cp(join(REPO, "node_modules"), join(work, "node_modules"), { recursive: true });
  return work;
}

async function prepareVerifier(task, runRoot) {
  const verifier = join(runRoot, "verifier");
  await mkdir(verifier, { recursive: true });
  extractTar(join(TASKS_DIR, task.verifier), verifier);
  return verifier;
}

async function installOverlay(verifierDirectory, work) {
  const bundle = JSON.parse(await readFile(join(verifierDirectory, "bundle.json"), "utf8"));
  for (const overlay of bundle.overlays) {
    const target = join(work, overlay.sourcePath);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(verifierDirectory, overlay.bundlePath), target);
  }
  return bundle;
}

function applySolution(verifierDirectory, work) {
  const result = run(["git", "apply", join(verifierDirectory, "solution.patch")], { cwd: work });
  if (result.status !== 0) throw new Error(`solution.patch did not apply: ${result.stderr}`);
}

function verifierEnvironment(runRoot) {
  return {
    ...process.env,
    HOME: join(runRoot, "home"),
    npm_config_cache: join(runRoot, "npm-cache"),
    npm_config_update_notifier: "false",
  };
}

function runVerifier(task, work, environment, timeoutMs) {
  const exitCodes = [];
  for (const command of task.verifierCommands) {
    const result = run(command, { cwd: work, env: environment, timeoutMs });
    exitCodes.push(result.status);
  }
  return exitCodes;
}

function sameCodes(actual, expected) {
  return actual.length === expected.length && actual.every((code, index) => code === expected[index]);
}

async function checkTask(task, keep) {
  const runRoot = await mkdtemp(join(tmpdir(), `dsh-task-${task.id}-`));
  try {
    await mkdir(join(runRoot, "home"), { recursive: true });
    const work = await prepareWorkspace(task, runRoot);
    const verifierDirectory = await prepareVerifier(task, runRoot);
    await installOverlay(verifierDirectory, work);
    const environment = verifierEnvironment(runRoot);

    const before = runVerifier(task, work, environment, 900_000);
    applySolution(verifierDirectory, work);
    const after = runVerifier(task, work, environment, 900_000);

    const failsFirst = sameCodes(before, task.expectBeforeFix);
    const passesAfter = sameCodes(after, task.expectAfterFix);
    return {
      id: task.id,
      ok: failsFirst && passesAfter,
      detail: `before=${JSON.stringify(before)} (want ${JSON.stringify(task.expectBeforeFix)}), after=${JSON.stringify(after)} (want ${JSON.stringify(task.expectAfterFix)})`,
      runRoot,
    };
  } finally {
    if (!keep) await rm(runRoot, { recursive: true, force: true });
  }
}

function runModel(work, prompt, environment, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI, "run"], {
      cwd: work,
      env: environment,
      stdio: ["pipe", "inherit", "inherit"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
    child.stdin.end(prompt);
  });
}

async function liveTask(task, keep, timeoutSeconds) {
  const runRoot = await mkdtemp(join(tmpdir(), `dsh-task-${task.id}-`));
  let removeRoot = !keep;
  try {
    await mkdir(join(runRoot, "home"), { recursive: true });
    const work = await prepareWorkspace(task, runRoot);
    const prompt = await readFile(join(TASKS_DIR, task.prompt), "utf8");
    const environment = verifierEnvironment(runRoot);

    const before = await hashTree(work);
    const started = Date.now();
    const child = await runModel(work, prompt, environment, timeoutSeconds * 1000);
    const elapsedMs = Date.now() - started;
    const after = await hashTree(work);

    const changed = diffTrees(before, after);
    const outOfScope = changed.filter((path) => !isInsideWritable(path, task.writablePaths));

    const verifierDirectory = await prepareVerifier(task, runRoot);
    await installOverlay(verifierDirectory, work);
    const exitCodes = runVerifier(task, work, environment, 900_000);

    const verifierOk = sameCodes(exitCodes, task.expectAfterFix);
    const ok = verifierOk && outOfScope.length === 0;
    if (!ok) removeRoot = false;
    return {
      id: task.id,
      ok,
      detail: [
        `dsh exit=${child.code ?? `signal:${child.signal}`} in ${(elapsedMs / 1000).toFixed(1)}s`,
        `changed=${changed.length === 0 ? "(none)" : changed.join(", ")}`,
        outOfScope.length === 0 ? "scope=ok" : `scope=VIOLATED: ${outOfScope.join(", ")}`,
        `verifier=${JSON.stringify(exitCodes)} (want ${JSON.stringify(task.expectAfterFix)})`,
      ].join("\n    "),
      runRoot,
    };
  } finally {
    if (removeRoot) await rm(runRoot, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const catalog = JSON.parse(await readFile(join(TASKS_DIR, "tasks.json"), "utf8"));
  const selected =
    options.ids.length === 0
      ? catalog.tasks
      : options.ids.map((id) => {
          const task = catalog.tasks.find((candidate) => candidate.id === id);
          if (task === undefined) throw new Error(`unknown task ${id}`);
          return task;
        });

  if (!options.check) {
    if (process.env.DSH_LIVE !== "1") {
      process.stderr.write("live task run needs DSH_LIVE=1 (use --check for the offline self-check)\n");
      process.exitCode = 2;
      return;
    }
    if (!existsSync(CLI)) {
      process.stderr.write("dist/src/cli.js is missing; run npm run build first\n");
      process.exitCode = 2;
      return;
    }
    await stat(join(REPO, "node_modules"));
  }

  const results = [];
  for (const task of selected) {
    process.stdout.write(`\n=== ${task.id} — ${task.title} ===\n`);
    const result = options.check
      ? await checkTask(task, options.keep)
      : await liveTask(task, options.keep, options.timeoutSeconds);
    results.push(result);
    process.stdout.write(`  ${result.ok ? "PASS" : "FAIL"}\n    ${result.detail}\n`);
    if (!result.ok || options.keep) process.stdout.write(`    run root: ${result.runRoot}\n`);
  }

  const passed = results.filter((result) => result.ok).length;
  process.stdout.write(`\n${options.check ? "self-check" : "task run"}: ${passed}/${results.length}\n`);
  process.exitCode = passed === results.length ? 0 : 1;
}

await main();
