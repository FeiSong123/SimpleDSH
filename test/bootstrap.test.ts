import { strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function runNode(args: readonly string[]) {
  return spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: {},
    timeout: 5_000,
  });
}

test("compiled CLI rejects an invalid invocation without starting a Session", () => {
  const result = runNode([resolve(projectRoot, "dist/src/cli.js")]);

  strictEqual(result.error, undefined);
  strictEqual(result.signal, null);
  strictEqual(result.status, 2);
  strictEqual(result.stdout, "");
  strictEqual(result.stderr, "simpledsh: invalid_invocation\n");
});

test("blocked-stage helper reports the requested stage", () => {
  const result = runNode([
    resolve(projectRoot, "scripts/blocked-stage.mjs"),
    "Stage 02",
  ]);

  strictEqual(result.error, undefined);
  strictEqual(result.signal, null);
  strictEqual(result.status, 2);
  strictEqual(result.stdout, "");
  strictEqual(result.stderr, "BLOCKED: Stage 02\n");
});

test("targeted test runner rejects a zero-match pattern instead of reporting PASS", () => {
  const result = runNode([
    resolve(projectRoot, "scripts/run-node-tests.mjs"),
    resolve(projectRoot, "dist/test/session"),
    "--test-name-pattern=definitely-no-such-test-019fc80e",
  ]);

  strictEqual(result.error, undefined);
  strictEqual(result.signal, null);
  strictEqual(result.status, 2);
  strictEqual(result.stdout.includes("# pass"), true);
  strictEqual(
    result.stderr.endsWith(
      "run-node-tests: test-name-pattern matched no real test\n",
    ),
    true,
  );
});
