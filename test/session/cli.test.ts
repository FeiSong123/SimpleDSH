import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cliPath = resolve(projectRoot, "dist/src/cli.js");

function runCli(
  arguments_: readonly string[],
  options: Readonly<{ cwd?: string; input?: string }> = {},
) {
  return spawnSync(process.execPath, [cliPath, ...arguments_], {
    cwd: options.cwd ?? projectRoot,
    encoding: "utf8",
    env: {},
    input: options.input,
    timeout: 5_000,
  });
}

test("CLI help is local, stable, and credential independent", () => {
  const result = runCli(["--help"]);

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.equal(
    result.stdout,
    `Usage: flashcoder
       flashcoder run [--effort low|high|max] [--verify <command>]
               [--protect <path>]... [--verify-timeout <sec>] <prompt...>
       printf '<prompt>' | flashcoder run
       flashcoder login
       flashcoder logout
       flashcoder sessions
       flashcoder continue [session-id]
       flashcoder inspect <session-id>
       flashcoder recover <session-id> [quarantine options]
       flashcoder reconcile <session-id> <evidence.json> [quarantine options]

With no arguments flashcoder starts an interactive multi-turn session.

Verification (run only). The check decides the exit code; its command is never
shown to the model, only its output when it fails:
       --verify <command>        shell command whose exit code decides
       --protect <path>          a path the check depends on; if it moved by
                                 the time the check runs the verdict is
                                 tampered, never passed (repeatable)
       --verify-timeout <sec>    default 600

Turn budget (interactive/continue only; each turn stops cleanly at a boundary):
       --max-tool-rounds <n>     default 50
       --max-cost-usd <amount>   default 1
       --max-minutes <n>         default 30
       --auto-compact-tokens <n> replace the conversation with a summary once
                                 the prefix reaches n prompt tokens; 0 disables
                                 (default 512000)

Quarantine options (recover/reconcile only):
       --quarantine-fingerprint <sha256:...>
       --confirm-no-concurrent-start
       [--force-ambiguous]
`,
  );
  assert.equal(result.stderr, "");
});

test("CLI rejects invalid input with a fixed exit and no stdout", () => {
  const result = runCli(["not-a-subcommand"]);

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "flashcoder: invalid_invocation\n");
});

test("interactive mode refuses to start without a terminal", () => {
  // No arguments means interactive. Piped stdio has no editor, so it must say
  // so and exit before touching credentials or the network.
  const result = runCli([]);

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "flashcoder: interactive mode needs a terminal; use flashcoder run <prompt> instead\nflashcoder: invalid_invocation\n",
  );
});

test("CLI fails closed before a request when the credential is absent", () => {
  const workspace = mkdtempSync(join(tmpdir(), "flashcoder-cli-missing-key-"));
  try {
    const result = runCli(["run", "offline prompt"], { cwd: workspace });

    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 3);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^flashcoder: session_id=ses_[0-9a-f]{32}\nflashcoder: credential_missing\n$/u,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
