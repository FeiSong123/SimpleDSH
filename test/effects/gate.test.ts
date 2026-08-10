import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { childEnvironment } from "../../src/tool/runtime.js";
import {
  changedProtectedPaths,
  runGate,
  takeInventory,
  type GateSpec,
} from "../../src/verify/gate.js";

async function workspace(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "tests", "check.py"), "assert True\n", { mode: 0o644 });
  await writeFile(join(root, "work.txt"), "before\n", { mode: 0o644 });
  return root;
}

function spec(command: string, protectedPaths: readonly string[] = ["tests"]): GateSpec {
  return Object.freeze({ command, protectedPaths, timeoutSeconds: 30 });
}

async function gate(root: string, command: string, protectedPaths?: readonly string[]) {
  const declared = spec(command, protectedPaths);
  const baseline = await takeInventory(root, declared.protectedPaths);
  return { declared, baseline };
}

test("a zero exit with the protected paths intact passes", async (t) => {
  const root = await workspace(t);
  const { declared, baseline } = await gate(root, "exit 0");
  const result = await runGate(
    declared,
    root,
    baseline,
    childEnvironment(root),
    new AbortController().signal,
  );
  assert.equal(result.verdict, "passed");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.changedProtectedPaths, []);
});

test("a non-zero exit fails and keeps the output", async (t) => {
  const root = await workspace(t);
  const { declared, baseline } = await gate(root, "echo 'boom: expected 5' >&2; exit 1");
  const result = await runGate(
    declared,
    root,
    baseline,
    childEnvironment(root),
    new AbortController().signal,
  );
  assert.equal(result.verdict, "failed");
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /boom: expected 5/u);
});

test("editing a protected file cannot produce a pass", async (t) => {
  // The whole point. bash runs as the user and can rewrite the tests, so the
  // gate has to refuse rather than believe a zero exit.
  const root = await workspace(t);
  const { declared, baseline } = await gate(root, "exit 0");
  await writeFile(join(root, "tests", "check.py"), "assert False\n");
  const result = await runGate(
    declared,
    root,
    baseline,
    childEnvironment(root),
    new AbortController().signal,
  );
  assert.equal(result.verdict, "tampered");
  assert.deepEqual(result.changedProtectedPaths, [join("tests", "check.py")]);
});

test("adding or deleting inside a protected directory counts as a change", async (t) => {
  const root = await workspace(t);
  const { declared, baseline } = await gate(root, "exit 0");
  await writeFile(join(root, "tests", "extra.py"), "assert True\n");
  const result = await runGate(
    declared,
    root,
    baseline,
    childEnvironment(root),
    new AbortController().signal,
  );
  assert.equal(result.verdict, "tampered");
  assert.ok(result.changedProtectedPaths.includes(join("tests", "extra.py")));
});

test("work outside the protected paths does not count", async (t) => {
  const root = await workspace(t);
  const { declared, baseline } = await gate(root, "exit 0");
  await writeFile(join(root, "work.txt"), "after\n");
  const result = await runGate(
    declared,
    root,
    baseline,
    childEnvironment(root),
    new AbortController().signal,
  );
  assert.equal(result.verdict, "passed");
});

test("a mode change counts, not only contents", async (t) => {
  const root = await workspace(t);
  const { declared, baseline } = await gate(root, "exit 0");
  await writeFile(join(root, "tests", "check.py"), "assert True\n", { mode: 0o755 });
  const { chmod } = await import("node:fs/promises");
  await chmod(join(root, "tests", "check.py"), 0o755);
  const result = await runGate(
    declared,
    root,
    baseline,
    childEnvironment(root),
    new AbortController().signal,
  );
  assert.equal(result.verdict, "tampered");
});

test("a command that cannot finish is errored, never passed", async (t) => {
  const root = await workspace(t);
  const declared = Object.freeze({
    command: "sleep 5",
    protectedPaths: ["tests"],
    timeoutSeconds: 1,
  });
  const baseline = await takeInventory(root, declared.protectedPaths);
  const result = await runGate(
    declared,
    root,
    baseline,
    childEnvironment(root),
    new AbortController().signal,
  );
  assert.equal(result.verdict, "errored");
});

test("tampering outranks the exit code", async (t) => {
  // A gate whose own inputs moved proves nothing, however it exited.
  const root = await workspace(t);
  const { declared, baseline } = await gate(root, "exit 0");
  await rm(join(root, "tests", "check.py"));
  const result = await runGate(
    declared,
    root,
    baseline,
    childEnvironment(root),
    new AbortController().signal,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.verdict, "tampered");
});

test("a protected path outside the workspace is refused", async (t) => {
  const root = await workspace(t);
  await assert.rejects(() => takeInventory(root, ["../elsewhere"]), /escapes the workspace/u);
});

test("the inventory digest changes only when something moved", async (t) => {
  const root = await workspace(t);
  const first = await takeInventory(root, ["tests"]);
  const again = await takeInventory(root, ["tests"]);
  assert.equal(first.digest, again.digest);
  assert.deepEqual(changedProtectedPaths(first, again), []);

  await writeFile(join(root, "tests", "check.py"), "assert 1\n");
  const third = await takeInventory(root, ["tests"]);
  assert.notEqual(first.digest, third.digest);
  assert.deepEqual(changedProtectedPaths(first, third), [join("tests", "check.py")]);
});
