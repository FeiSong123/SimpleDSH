import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const NATIVE_TEST_OPTIONS = Object.freeze({
  skip:
    process.platform === "win32"
      ? "native Bash is unavailable on Windows"
      : false,
  timeout: 20_000,
});

interface WorkerReport {
  readonly parentPath: string;
  readonly emptyBinEntries: readonly string[];
  readonly committedToolCallIds: readonly string[];
  readonly seedText: string;
  readonly bashFileText: string;
  readonly bashStdout: string;
  readonly bashStderr: string;
  readonly readOutput: string;
  readonly replayToolResults: number;
  readonly replayEffectsCompleted: number;
  readonly replayEffectsIndeterminate: number;
  readonly bashTerminal: Readonly<{
    readonly status: string;
    readonly code: string;
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly descendantsReaped: boolean | null;
  }>;
}

async function runWorker(
  workerPath: string,
  emptyBin: string,
): Promise<Readonly<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [workerPath, emptyBin], {
      cwd: process.cwd(),
      env: {
        PATH: emptyBin,
        SIMPLEDSH_TEST_SANITIZED_PATH: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      resolvePromise(Object.freeze({
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }));
    });
  });
}

test(
  "real ToolRuntime write/bash/read/replay needs no Lima or container executable",
  NATIVE_TEST_OPTIONS,
  async () => {
    assert.equal(
      isAbsolute(process.execPath),
      true,
      "Node must be launched absolutely",
    );
    const root = await mkdtemp(join(tmpdir(), "flashcoder-no-lima-parent-"));
    const emptyBin = join(root, "empty-bin");
    const workerPath = fileURLToPath(
      new URL("./no-lima-worker.js", import.meta.url),
    );
    try {
      await mkdir(emptyBin, { mode: 0o700 });
      assert.deepEqual(await readdir(emptyBin), []);

      const child = await runWorker(workerPath, emptyBin);
      assert.equal(child.code, 0, child.stderr.toString("utf8"));
      assert.equal(child.signal, null);
      assert.equal(child.stderr.byteLength, 0);

      const report = JSON.parse(child.stdout.toString("utf8")) as WorkerReport;
      assert.deepEqual(report, {
        parentPath: emptyBin,
        emptyBinEntries: [],
        committedToolCallIds: [
          "call_no_lima_write",
          "call_no_lima_bash",
          "call_no_lima_read",
        ],
        seedText: "seed\n",
        bashFileText: "seed\n",
        bashStdout: "native-stdout",
        bashStderr: "native-stderr",
        readOutput: "seed\n",
        replayToolResults: 3,
        replayEffectsCompleted: 2,
        replayEffectsIndeterminate: 0,
        bashTerminal: {
          status: "succeeded",
          code: "ok",
          exitCode: 0,
          signal: null,
          descendantsReaped: true,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
