import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES } from "../../src/artifact/tool-output.js";
import {
  runNativeBash,
  type BashChildEnvironment,
  type BashRunResult,
} from "../../src/proc/index.js";

const NATIVE_TEST_OPTIONS = Object.freeze({
  skip: process.platform === "win32" ? "native Bash is unavailable on Windows" : false,
  timeout: 10_000,
});

interface CapturedRun {
  readonly result: BashRunResult;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

interface CaptureOptions {
  readonly timeoutSeconds?: number;
  readonly signal?: AbortSignal;
  readonly childEnvironment?: BashChildEnvironment;
}

function closedChildEnvironment(cwd: string): BashChildEnvironment {
  return Object.freeze({
    HOME: cwd,
    HOSTNAME: "flashcoder-test-host",
    LANG: "C",
    LC_ALL: "C",
    LOGNAME: "flashcoder-test-user",
    PATH: "/usr/bin:/bin",
    USER: "flashcoder-test-user",
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function nodeCommand(source: string): string {
  return `${shellQuote(process.execPath)} --input-type=module -e ${shellQuote(source)}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

function assertKnownDirectTerminal(result: BashRunResult): void {
  assert.equal(
    Number(result.exitCode !== null) + Number(result.signal !== null),
    1,
    "a spawned direct child must yield exactly one exit code or signal",
  );
}

function terminalOf(result: BashRunResult): Readonly<{
  readonly reason: BashRunResult["reason"];
  readonly exitCode: number | null;
  readonly signal: BashRunResult["signal"];
  readonly descendantsReaped: boolean;
}> {
  return Object.freeze({
    reason: result.reason,
    exitCode: result.exitCode,
    signal: result.signal,
    descendantsReaped: result.descendantsReaped,
  });
}

function outputPayloadBytes(result: BashRunResult): number {
  return result.output.reduce(
    (total, record) => total + record.bytes.byteLength,
    0,
  );
}

function assertOutputLimitReasonMatchesBytes(result: BashRunResult): void {
  assert.equal(
    result.reason === "output_limit",
    outputPayloadBytes(result) === RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES,
    "output_limit must match the exact captured payload boundary",
  );
}

async function withWorkspace<T>(
  action: (workspace: string) => Promise<T>,
): Promise<T> {
  const workspace = await mkdtemp(join(tmpdir(), "flashcoder-native-bash-"));
  try {
    return await action(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function captureRun(
  cwd: string,
  command: string,
  options: CaptureOptions = {},
): Promise<CapturedRun> {
  const controller = new AbortController();
  const result = await runNativeBash({
    command,
    cwd,
    childEnvironment:
      options.childEnvironment ?? closedChildEnvironment(cwd),
    timeoutSeconds: options.timeoutSeconds ?? 5,
    signal: options.signal ?? controller.signal,
  });
  const stdout = result.output
    .filter((record) => record.stream === "stdout")
    .map((record) => Buffer.from(record.bytes.copy()));
  const stderr = result.output
    .filter((record) => record.stream === "stderr")
    .map((record) => Buffer.from(record.bytes.copy()));
  return Object.freeze({
    result,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
  });
}

test("native Bash records natural, nonzero, and signaled terminals", NATIVE_TEST_OPTIONS, async (t) => {
  await withWorkspace(async (workspace) => {
    await t.test("natural exit", async () => {
      const captured = await captureRun(workspace, "printf 'natural-output'");
      assert.deepEqual(terminalOf(captured.result), {
        reason: "natural",
        exitCode: 0,
        signal: null,
        descendantsReaped: true,
      });
      assert.equal(captured.stdout.toString("utf8"), "natural-output");
      assert.equal(captured.stderr.byteLength, 0);
    });

    await t.test("nonzero exit", async () => {
      const captured = await captureRun(workspace, "exit 37");
      assert.deepEqual(terminalOf(captured.result), {
        reason: "natural",
        exitCode: 37,
        signal: null,
        descendantsReaped: true,
      });
    });

    await t.test("signal exit", async () => {
      const captured = await captureRun(workspace, "kill -TERM $$");
      assert.deepEqual(terminalOf(captured.result), {
        reason: "natural",
        exitCode: null,
        signal: "SIGTERM",
        descendantsReaped: true,
      });
    });
  });
});

test("native Bash captures every byte emitted before a finite natural exit", NATIVE_TEST_OPTIONS, async () => {
  await withWorkspace(async (workspace) => {
    const expected = Buffer.alloc(100_000, 0x61);
    const captured = await captureRun(
      workspace,
      nodeCommand("process.stdout.write(Buffer.alloc(100000, 0x61));"),
    );

    assert.deepEqual(terminalOf(captured.result), {
      reason: "natural",
      exitCode: 0,
      signal: null,
      descendantsReaped: true,
    });
    assert.equal(outputPayloadBytes(captured.result), expected.byteLength);
    assert.deepEqual(captured.stdout, expected);
    assert.equal(captured.stderr.byteLength, 0);
    assertOutputLimitReasonMatchesBytes(captured.result);
  });
});

test("native Bash keeps stream ownership when one callback crosses a coalescing boundary", NATIVE_TEST_OPTIONS, async () => {
  await withWorkspace(async (workspace) => {
    const first = Buffer.alloc(50_000, 0x61);
    const second = Buffer.alloc(50_000, 0x62);
    const error = Buffer.from([0x63]);
    const captured = await captureRun(
      workspace,
      nodeCommand(
        "process.stdout.write(Buffer.alloc(50000,0x61));" +
          "setTimeout(()=>process.stdout.write(Buffer.alloc(50000,0x62)),100);" +
          "setTimeout(()=>process.stderr.write(Buffer.from([0x63])),200);",
      ),
    );

    assert.deepEqual(terminalOf(captured.result), {
      reason: "natural",
      exitCode: 0,
      signal: null,
      descendantsReaped: true,
    });
    assert.deepEqual(captured.stdout, Buffer.concat([first, second]));
    assert.deepEqual(captured.stderr, error);
    assert.deepEqual(
      captured.result.output.map((record) => [
        record.stream,
        record.bytes.byteLength,
      ]),
      [
        ["stdout", 65_536],
        ["stdout", 34_464],
        ["stderr", 1],
      ],
    );
    assertOutputLimitReasonMatchesBytes(captured.result);
  });
});

test("native Bash records timeout, cancellation, and output-limit stops", NATIVE_TEST_OPTIONS, async (t) => {
  await withWorkspace(async (workspace) => {
    await t.test("timeout", async () => {
      const captured = await captureRun(workspace, "exec /bin/sleep 30", {
        timeoutSeconds: 0.05,
      });
      assert.equal(captured.result.reason, "timeout");
      assertKnownDirectTerminal(captured.result);
      assert.equal(captured.result.descendantsReaped, true);
      assertOutputLimitReasonMatchesBytes(captured.result);
    });

    await t.test("cancellation", async () => {
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 50);
      try {
        const captured = await captureRun(workspace, "exec /bin/sleep 30", {
          signal: controller.signal,
        });
        assert.equal(captured.result.reason, "cancelled");
        assertKnownDirectTerminal(captured.result);
        assert.equal(captured.result.descendantsReaped, true);
        assertOutputLimitReasonMatchesBytes(captured.result);
      } finally {
        clearTimeout(abortTimer);
      }
    });

    await t.test("output limit", async () => {
      const captured = await captureRun(workspace, "yes");
      assert.equal(captured.result.reason, "output_limit");
      assertKnownDirectTerminal(captured.result);
      assert.equal(captured.result.descendantsReaped, true);
      assert.equal(captured.stdout.byteLength, RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES);
      assert.equal(captured.stderr.byteLength, 0);
      assertOutputLimitReasonMatchesBytes(captured.result);
    });
  });
});

test("output-limit precedence stays coherent in timeout and cancellation collisions", NATIVE_TEST_OPTIONS, async (t) => {
  await withWorkspace(async (workspace) => {
    const assertCollision = async (captured: CapturedRun): Promise<void> => {
      assert.ok(
        captured.result.reason === "output_limit" ||
          captured.result.reason === "timeout" ||
          captured.result.reason === "cancelled",
      );
      assertKnownDirectTerminal(captured.result);
      assert.equal(captured.result.descendantsReaped, true);
      assertOutputLimitReasonMatchesBytes(captured.result);
      const settledRecords = captured.result.output.map((record) => ({
        stream: record.stream,
        bytes: record.bytes.copy(),
      }));
      assert.equal(Object.isFrozen(captured.result.output), true);
      await delay(50);
      assert.deepEqual(
        captured.result.output.map((record) => ({
          stream: record.stream,
          bytes: record.bytes.copy(),
        })),
        settledRecords,
        "a settled result must not receive late drain bytes",
      );
    };

    await t.test("timeout versus exact cap", async () => {
      await assertCollision(
        await captureRun(workspace, "trap '' TERM; yes", {
          timeoutSeconds: 0.01,
        }),
      );
    });

    await t.test("cancellation versus exact cap", async () => {
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 10);
      try {
        await assertCollision(
          await captureRun(workspace, "trap '' TERM; yes", {
            signal: controller.signal,
          }),
        );
      } finally {
        clearTimeout(abortTimer);
      }
    });
  });
});

test("native Bash escalates an ignored SIGTERM to SIGKILL", NATIVE_TEST_OPTIONS, async () => {
  await withWorkspace(async (workspace) => {
    const captured = await captureRun(
      workspace,
      "trap '' TERM; while :; do :; done",
      { timeoutSeconds: 0.25 },
    );

    assert.deepEqual(terminalOf(captured.result), {
      reason: "timeout",
      exitCode: null,
      signal: "SIGKILL",
      descendantsReaped: true,
    });
    assert.equal(outputPayloadBytes(captured.result), 0);
    assertOutputLimitReasonMatchesBytes(captured.result);
  });
});

test("native Bash preserves binary stdout and stderr independently", NATIVE_TEST_OPTIONS, async () => {
  await withWorkspace(async (workspace) => {
    const stdout = Buffer.from([0x00, 0xff, 0x41, 0x0a]);
    const stderr = Buffer.from([0x80, 0x00, 0x42]);
    const command = nodeCommand(
      `process.stdout.write(Buffer.from([${stdout.join(",")}]));` +
        `process.stderr.write(Buffer.from([${stderr.join(",")}]))`,
    );
    const captured = await captureRun(workspace, command);
    assert.deepEqual(terminalOf(captured.result), {
      reason: "natural",
      exitCode: 0,
      signal: null,
      descendantsReaped: true,
    });
    assert.deepEqual(captured.stdout, stdout);
    assert.deepEqual(captured.stderr, stderr);
  });
});

test("native Bash adds one literal to seven caller env inputs and drops every override", NATIVE_TEST_OPTIONS, async () => {
  await withWorkspace(async (workspace) => {
    const sentinelName = "SIMPLEDSH_NATIVE_BASH_PARENT_SENTINEL";
    const sentinelValue = "must-not-cross-the-spawn-boundary";
    const previousSentinel = process.env[sentinelName];
    const previousPythonSetting = process.env["PYTHONDONTWRITEBYTECODE"];
    const prototypeSentinel = "SIMPLEDSH_ENUMERABLE_PROTOTYPE_SENTINEL";
    process.env[sentinelName] = sentinelValue;
    process.env["PYTHONDONTWRITEBYTECODE"] = "hostile-parent-override";
    Object.defineProperty(Object.prototype, prototypeSentinel, {
      configurable: true,
      enumerable: true,
      value: "must-not-cross-through-spawn-enumeration",
    });
    const declared = closedChildEnvironment(workspace);
    const withUndeclaredField = Object.freeze({
      ...declared,
      PYTHONDONTWRITEBYTECODE: "hostile-caller-override",
      SIMPLEDSH_UNDECLARED_CHILD_FIELD: "must-also-be-dropped",
    });
    const inspectedNames = [
      "HOME",
      "HOSTNAME",
      "LANG",
      "LC_ALL",
      "LOGNAME",
      "PATH",
      "PYTHONDONTWRITEBYTECODE",
      "USER",
      sentinelName,
      "SIMPLEDSH_UNDECLARED_CHILD_FIELD",
      prototypeSentinel,
    ];
    const explicitWrite = "explicit-child-env.txt";
    const inspectEnvironment = nodeCommand(
      `const names=${JSON.stringify(inspectedNames)};` +
        "process.stdout.write(JSON.stringify(Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]))));",
    );
    const command = `printf 'visible\\n' > "$HOME/${explicitWrite}"; ${inspectEnvironment}`;

    try {
      const captured = await captureRun(workspace, command, {
        childEnvironment: withUndeclaredField,
      });
      assert.equal(captured.result.reason, "natural");
      assert.equal(captured.result.exitCode, 0);
      assert.deepEqual(JSON.parse(captured.stdout.toString("utf8")), {
        ...declared,
        PYTHONDONTWRITEBYTECODE: "1",
        [sentinelName]: null,
        SIMPLEDSH_UNDECLARED_CHILD_FIELD: null,
        [prototypeSentinel]: null,
      });
      assert.equal(await readFile(join(workspace, explicitWrite), "utf8"), "visible\n");
    } finally {
      if (previousSentinel === undefined) delete process.env[sentinelName];
      else process.env[sentinelName] = previousSentinel;
      if (previousPythonSetting === undefined) delete process.env["PYTHONDONTWRITEBYTECODE"];
      else process.env["PYTHONDONTWRITEBYTECODE"] = previousPythonSetting;
      delete (Object.prototype as Record<string, unknown>)[prototypeSentinel];
    }
  });
});

test("native Bash reports spawn failure for a missing cwd without a phantom process", NATIVE_TEST_OPTIONS, async () => {
  const parent = await mkdtemp(join(tmpdir(), "flashcoder-native-bash-missing-"));
  const missingCwd = join(parent, "does-not-exist");
  try {
    const captured = await captureRun(missingCwd, "printf 'must-not-run'");
    assert.deepEqual(terminalOf(captured.result), {
      reason: "io_error",
      exitCode: null,
      signal: null,
      descendantsReaped: true,
    });
    assert.equal(captured.result.output.length, 0);
    assert.equal(captured.stdout.byteLength, 0);
    assert.equal(captured.stderr.byteLength, 0);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("an already-aborted launch records a real cancelled direct-child terminal", NATIVE_TEST_OPTIONS, async () => {
  await withWorkspace(async (workspace) => {
    const controller = new AbortController();
    controller.abort();
    const captured = await captureRun(workspace, "exec /bin/sleep 30", {
      signal: controller.signal,
    });

    assert.equal(captured.result.reason, "cancelled");
    assertKnownDirectTerminal(captured.result);
    assert.equal(captured.result.descendantsReaped, true);
    assert.equal(outputPayloadBytes(captured.result), 0);
    assertOutputLimitReasonMatchesBytes(captured.result);
  });
});

test("a self-expiring detached escape is reported honestly without teardown kill", NATIVE_TEST_OPTIONS, async () => {
  await withWorkspace(async (workspace) => {
    const fixture = nodeCommand(
      "import { spawn } from 'node:child_process';" +
        "const child=spawn('/bin/sh',['-c','sleep 3; exit 0']," +
        "{detached:true,stdio:['ignore','inherit','inherit']});" +
        "child.unref();",
    );
    const captured = await captureRun(workspace, fixture, {
      timeoutSeconds: 8,
    });

    assert.deepEqual(terminalOf(captured.result), {
      reason: "natural",
      exitCode: 0,
      signal: null,
      descendantsReaped: false,
    });

    // The escaped process owns its three-second lifetime. Waiting here is only
    // exit hygiene; correctness was already decided by the bounded observation.
    await delay(3_250);
  });
});
