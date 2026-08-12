import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  captureSessionEnvironment,
  GIT_STATUS_ENTRY_LIMIT,
  TREE_ENTRY_LIMIT,
} from "../../src/session/index.js";

async function workspace(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flashcoder-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function git(root: string, ...args: readonly string[]): void {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

async function repository(t: TestContext): Promise<string> {
  const root = await workspace(t);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  await writeFile(join(root, "seed.txt"), "seed\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "seed");
  return root;
}

test("a clean repository says so instead of showing an empty list", async (t) => {
  const facts = await captureSessionEnvironment(await repository(t));
  assert.match(facts.git ?? "", /^branch: \S+\nstatus: clean$/u);
});

test("changed files are listed, and the list has a visible end", async (t) => {
  // The list grows while the model works and is resent every turn. Unbounded,
  // a task touching fifty files puts fifty lines in front of every later turn.
  const root = await repository(t);
  const count = GIT_STATUS_ENTRY_LIMIT + 7;
  for (let index = 0; index < count; index += 1) {
    await writeFile(join(root, `changed-${String(index)}.txt`), "x\n");
  }
  const facts = await captureSessionEnvironment(root);
  const status = facts.git ?? "";
  const listed = status
    .split("\n")
    .filter((line) => line.startsWith("?") || line.startsWith(" "));
  assert.equal(listed.length, GIT_STATUS_ENTRY_LIMIT);
  assert.match(status, new RegExp(`…and ${String(count - GIT_STATUS_ENTRY_LIMIT)} more files`, "u"));
});

test("a workspace that is not a repository says that", async (t) => {
  const facts = await captureSessionEnvironment(await workspace(t));
  assert.equal(facts.git, "not a git repository");
});

test("the tree is the top level only, directories first", async (t) => {
  const root = await workspace(t);
  await mkdir(join(root, "src"));
  await mkdir(join(root, "src", "deep"));
  await writeFile(join(root, "src", "deep", "buried.ts"), "");
  await writeFile(join(root, "package.json"), "{}");
  await mkdir(join(root, "test"));

  const tree = (await captureSessionEnvironment(root)).tree ?? "";
  assert.deepEqual(tree.split("\n"), ["src/", "test/", "package.json"]);
  assert.doesNotMatch(tree, /buried/u, "the second level is not walked");
});

test("the tree ends visibly when there is more than it shows", async (t) => {
  const root = await workspace(t);
  const count = TREE_ENTRY_LIMIT + 5;
  for (let index = 0; index < count; index += 1) {
    await writeFile(join(root, `file-${String(index).padStart(3, "0")}.txt`), "");
  }
  const tree = (await captureSessionEnvironment(root)).tree ?? "";
  assert.equal(tree.split("\n").length, TREE_ENTRY_LIMIT + 1);
  assert.match(tree, new RegExp(`…and ${String(count - TREE_ENTRY_LIMIT)} more entries`, "u"));
});

test("what the repository ignores stays out of the tree", async (t) => {
  // The rule is the repository's own, not one the harness invented.
  const root = await repository(t);
  await writeFile(join(root, ".gitignore"), "node_modules/\n*.log\n");
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "debug.log"), "");
  await writeFile(join(root, "keep.ts"), "");

  const tree = (await captureSessionEnvironment(root)).tree ?? "";
  assert.doesNotMatch(tree, /node_modules/u);
  assert.doesNotMatch(tree, /debug\.log/u);
  assert.match(tree, /keep\.ts/u);
});

test("git's own directory is never listed", async (t) => {
  const tree = (await captureSessionEnvironment(await repository(t))).tree ?? "";
  assert.doesNotMatch(tree, /\.git\//u);
});

test("an empty workspace says empty rather than nothing", async (t) => {
  assert.equal((await captureSessionEnvironment(await workspace(t))).tree, "empty");
});
