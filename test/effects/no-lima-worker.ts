import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { TestContext } from "node:test";

import {
  createToolOutputFrameParser,
  type ArtifactChunkVisitor,
  type ArtifactDescriptor,
  type ToolOutputFrameSummary,
} from "../../src/artifact/index.js";
import { openJournal } from "../../src/journal/open.js";
import type { AnyVerifiedJournalEvent } from "../../src/journal/types.js";
import {
  createRuntimeFixture,
  runtimeFixtureClock,
  runtimeFixtureEventIds,
  RUNTIME_FIXTURE_SESSION_ID,
  toolCall,
} from "./runtime-fixture.js";

type ArtifactEvent = Extract<
  AnyVerifiedJournalEvent,
  { readonly type: "artifact_published" }
>;

interface DecodedOutput {
  readonly read: Buffer;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly summary: ToolOutputFrameSummary;
}

function artifactDescriptor(event: ArtifactEvent): ArtifactDescriptor {
  const payload = event.payload;
  return Object.freeze({
    artifactRef: payload.artifactRef,
    artifactHash: payload.artifactHash,
    byteCount: payload.byteCount,
    lineCount: payload.lineCount,
    mediaType: payload.mediaType,
    artifactType: payload.artifactType,
    streamBytes: payload.streamBytes,
    hardLimitReached: payload.hardLimitReached,
    descendantsReaped: payload.descendantsReaped,
    toolCallId: payload.toolCallId,
    terminal: payload.terminal,
  });
}

function artifactFor(
  events: readonly AnyVerifiedJournalEvent[],
  toolCallId: string,
): ArtifactEvent {
  const event = events.find(
    (candidate): candidate is ArtifactEvent =>
      candidate.type === "artifact_published" &&
      candidate.payload.toolCallId === toolCallId,
  );
  if (event === undefined) assert.fail(`missing Artifact for ${toolCallId}`);
  return event;
}

async function decodeOutput(
  event: ArtifactEvent,
  scan: (
    descriptor: ArtifactDescriptor,
    visit: ArtifactChunkVisitor,
  ) => Promise<void>,
): Promise<DecodedOutput> {
  const read: Buffer[] = [];
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const parser = createToolOutputFrameParser({
    data(stream, bytes) {
      const copy = Buffer.from(bytes);
      if (stream === "read") read.push(copy);
      else if (stream === "stdout") stdout.push(copy);
      else stderr.push(copy);
    },
  });
  await scan(artifactDescriptor(event), (bytes) => parser.push(bytes));
  const summary = parser.finish();
  return Object.freeze({
    read: Buffer.concat(read),
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
    summary,
  });
}

async function main(): Promise<void> {
  const emptyBin = process.argv[2];
  if (emptyBin === undefined) {
    throw new TypeError("empty PATH directory is required");
  }
  assert.equal(isAbsolute(process.execPath), true, "Node path must be absolute");
  assert.equal(process.env["SIMPLEDSH_TEST_SANITIZED_PATH"], "1");
  assert.equal(process.env["PATH"], emptyBin);
  const emptyBinEntries = await readdir(emptyBin);
  assert.deepEqual(emptyBinEntries, []);

  const cleanups: Array<() => void | Promise<void>> = [];
  const testContext = Object.freeze({
    after(cleanup: () => void | Promise<void>) {
      cleanups.push(cleanup);
    },
  }) as unknown as TestContext;
  const calls = [
    toolCall(
      "call_no_lima_write",
      "write",
      JSON.stringify({ path: "seed.txt", content: "seed\n" }),
    ),
    toolCall(
      "call_no_lima_bash",
      "bash",
      JSON.stringify({
        command:
          "/bin/cat seed.txt > from-bash.txt && " +
          "printf native-stdout && printf native-stderr >&2",
        timeout: 4,
      }),
    ),
    toolCall(
      "call_no_lima_read",
      "read",
      JSON.stringify({ path: "from-bash.txt" }),
    ),
  ];

  try {
    const fixture = await createRuntimeFixture(testContext, calls);
    const committed = await fixture.runtime.execute(
      fixture.calls,
      new AbortController().signal,
    );
    const seedText = await readFile(`${fixture.workspace}/seed.txt`, "utf8");
    const bashFileText = await readFile(
      `${fixture.workspace}/from-bash.txt`,
      "utf8",
    );
    assert.equal(seedText, "seed\n");
    assert.equal(bashFileText, "seed\n");

    await fixture.closeWriter();
    const reopened = await openJournal(
      fixture.workspace,
      RUNTIME_FIXTURE_SESSION_ID,
      runtimeFixtureClock,
      runtimeFixtureEventIds("f"),
    );
    try {
      const events = reopened.replay.events;
      const bashArtifact = artifactFor(events, "call_no_lima_bash");
      const readArtifact = artifactFor(events, "call_no_lima_read");
      const bashOutput = await decodeOutput(
        bashArtifact,
        async (descriptor, visit) =>
          reopened.artifacts.scanArtifact(descriptor, visit),
      );
      const readOutput = await decodeOutput(
        readArtifact,
        async (descriptor, visit) =>
          reopened.artifacts.scanArtifact(descriptor, visit),
      );
      assert.equal(bashOutput.stdout.toString("utf8"), "native-stdout");
      assert.equal(bashOutput.stderr.toString("utf8"), "native-stderr");
      assert.equal(bashOutput.read.byteLength, 0);
      assert.equal(readOutput.read.toString("utf8"), "seed\n");
      assert.equal(readOutput.stdout.byteLength, 0);
      assert.equal(readOutput.stderr.byteLength, 0);
      assert.deepEqual(bashOutput.summary.payloadBytes, {
        read: 0,
        stdout: 13,
        stderr: 13,
      });
      assert.deepEqual(readOutput.summary.payloadBytes, {
        read: 5,
        stdout: 0,
        stderr: 0,
      });

      const completed = events.filter(
        (event) => event.type === "effect_completed",
      );
      const bashCompleted = completed.find(
        (event) => event.payload.toolCallId === "call_no_lima_bash",
      );
      if (bashCompleted === undefined) {
        assert.fail("missing completed Bash Effect");
      }
      assert.equal(
        bashArtifact.payload.descendantsReaped,
        bashCompleted.payload.terminal.descendantsReaped,
      );

      process.stdout.write(
        JSON.stringify({
          parentPath: process.env["PATH"],
          emptyBinEntries,
          committedToolCallIds: committed.map((result) => result.toolCallId),
          seedText,
          bashFileText,
          bashStdout: bashOutput.stdout.toString("utf8"),
          bashStderr: bashOutput.stderr.toString("utf8"),
          readOutput: readOutput.read.toString("utf8"),
          replayToolResults: events.filter(
            (event) => event.type === "tool_result_committed",
          ).length,
          replayEffectsCompleted: completed.length,
          replayEffectsIndeterminate: events.filter(
            (event) => event.type === "effect_indeterminate",
          ).length,
          bashTerminal: bashCompleted.payload.terminal,
        }),
      );
    } finally {
      await reopened.writer.close();
    }
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
