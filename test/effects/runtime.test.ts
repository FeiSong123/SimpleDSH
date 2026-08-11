import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  createToolOutputFrameParser,
  RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES,
} from "../../src/artifact/tool-output.js";
import type {
  ArtifactMetadata,
  ArtifactSink,
} from "../../src/artifact/types.js";
import { sha256Hex, utf8Bytes } from "../../src/bytes/ops.js";
import { parseToolResultContent } from "../../src/bytes/tool-result.js";
import type { FrozenBytes } from "../../src/bytes/types.js";
import { viewTool } from "../../src/bytes/view.js";
import { decodeJournalRecord } from "../../src/journal/schema.js";
import type { PersistenceTestControls } from "../../src/journal/faults.js";
import type { AnyVerifiedJournalEvent } from "../../src/journal/types.js";
import { openJournal } from "../../src/journal/open.js";
import { buildCacheAbiV2 } from "../../src/lineage/cache-abi.js";
import type { DeepSeekWebSearchResponse } from "../../src/ds/web-search.js";
import {
  JournalToolDurability,
  ToolDurabilityError,
} from "../../src/tool/durability.js";
import {
  OBSERVATION_PARALLELISM,
  type CommittedToolResult,
} from "../../src/tool/runtime.js";
import {
  createRuntimeFixture,
  runtimeFixtureClock,
  runtimeFixtureEventIds,
  RUNTIME_FIXTURE_SESSION_ID,
  toolCall,
  type RuntimeFixture,
} from "./runtime-fixture.js";

const REPO_ROOT = resolve(process.cwd());

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function journalEvents(
  fixture: RuntimeFixture,
): Promise<readonly AnyVerifiedJournalEvent[]> {
  const text = await readFile(fixture.opened.paths.logPath, "utf8");
  return Object.freeze(
    text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => decodeJournalRecord(Buffer.from(line, "utf8"))),
  );
}

async function eventsAfterAssistant(
  fixture: RuntimeFixture,
): Promise<readonly AnyVerifiedJournalEvent[]> {
  const events = await journalEvents(fixture);
  const index = events.findIndex(
    (event) =>
      event.type === "cache_checkpoint_created" &&
      event.payload.sourceAssistantEventId === fixture.assistant.id,
  );
  assert.notEqual(index, -1);
  return Object.freeze(events.slice(index + 1));
}

function eventTypes(
  events: readonly AnyVerifiedJournalEvent[],
): readonly AnyVerifiedJournalEvent["type"][] {
  return events.map((event) => event.type);
}

function results(
  events: readonly AnyVerifiedJournalEvent[],
): readonly Extract<
  AnyVerifiedJournalEvent,
  { readonly type: "tool_result_committed" }
>[] {
  return events.filter(
    (event): event is Extract<
      AnyVerifiedJournalEvent,
      { readonly type: "tool_result_committed" }
    > => event.type === "tool_result_committed",
  );
}

async function measurePeakRss<T>(
  operation: () => Promise<T>,
): Promise<Readonly<{
  value: T;
  rssBaselineBytes: number;
  peakRssBytes: number;
}>> {
  const rssBaselineBytes = process.memoryUsage().rss;
  let peakRssBytes = rssBaselineBytes;
  const sample = (): void => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  };
  const interval = setInterval(sample, 5);
  interval.unref();
  try {
    const value = await operation();
    sample();
    return Object.freeze({ value, rssBaselineBytes, peakRssBytes });
  } finally {
    clearInterval(interval);
  }
}

test("static invalid tool calls commit only an assistant-sourced result", async (t) => {
  const call = toolCall("call_static_invalid", "unknown", "{}");
  const fixture = await createRuntimeFixture(t, [call]);
  const committed = await fixture.runtime.execute(
    fixture.calls,
    new AbortController().signal,
  );
  assert.equal(committed.length, 1);
  const events = await eventsAfterAssistant(fixture);
  assert.deepEqual(eventTypes(events), ["tool_result_committed"]);
  const result = results(events)[0];
  assert.equal(result?.payload.toolCallId, call.id);
  assert.equal(result?.payload.effectId, null);
  assert.equal(result?.payload.artifactId, null);
  assert.equal(result?.payload.sourceEventId, fixture.assistant.id);
});

test("pre-aborted execution interrupts before permission prepare or launch", async (t) => {
  const call = toolCall(
    "call_pre_aborted",
    "bash",
    JSON.stringify({ command: "printf must-not-run", timeout: 2 }),
  );
  const fixture = await createRuntimeFixture(t, [call]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fixture.runtime.execute(fixture.calls, controller.signal),
    (error: unknown) => error instanceof ToolDurabilityError,
  );
  const events = await eventsAfterAssistant(fixture);
  assert.deepEqual(eventTypes(events), ["run_interrupted"]);
  const interrupted = events[0];
  assert.equal(interrupted?.type, "run_interrupted");
  if (interrupted?.type !== "run_interrupted") {
    assert.fail("pre-aborted runtime did not interrupt the Run");
  }
  assert.equal(interrupted.payload.reason, "cancelled");
  assert.equal(interrupted.payload.sourceEventId, fixture.checkpoint.id);
});

test("abort after a complete one-call batch returns its durable cancelled result", async (t) => {
  const call = toolCall(
    "call_abort_after_prepare",
    "bash",
    JSON.stringify({ command: "exec /bin/sleep 30", timeout: 5 }),
  );
  const controller = new AbortController();
  class AbortAfterPrepareDurability extends JournalToolDurability {
    override async prepare(
      ...args: Parameters<JournalToolDurability["prepare"]>
    ) {
      const prepared = await super.prepare(...args);
      controller.abort();
      return prepared;
    }
  }
  const fixture = await createRuntimeFixture(t, [call], {
    durabilityFactory: (options) => new AbortAfterPrepareDurability(options),
  });

  const committed = await fixture.runtime.execute(fixture.calls, controller.signal);
  assert.equal(committed.length, 1);
  const events = await eventsAfterAssistant(fixture);
  assert.deepEqual(eventTypes(events), [
    "permission_decided",
    "effect_prepared",
    "artifact_published",
    "effect_completed",
    "tool_result_committed",
  ]);
  const artifact = events[2];
  const completed = events[3];
  assert.equal(artifact?.type, "artifact_published");
  assert.equal(completed?.type, "effect_completed");
  if (
    artifact?.type !== "artifact_published" ||
    completed?.type !== "effect_completed"
  ) {
    assert.fail("cancelled prepared Bash did not durably settle");
  }
  assert.equal(artifact.payload.hardLimitReached, false);
  assert.equal(typeof artifact.payload.descendantsReaped, "boolean");
  assert.equal(completed.payload.terminal.status, "failed");
  assert.equal(completed.payload.terminal.code, "cancelled");
  assert.equal(
    (completed.payload.terminal.exitCode === null) !==
      (completed.payload.terminal.signal === null),
    true,
  );
  assert.equal(
    completed.payload.terminal.descendantsReaped,
    artifact.payload.descendantsReaped,
  );
  assert.equal(
    events.some((event) => event.type === "effect_indeterminate"),
    false,
  );
  const result = events[4];
  assert.equal(result?.type, "tool_result_committed");
  assert.equal(
    events.some((event) => event.type === "run_interrupted"),
    false,
  );
});

test("abort after a partial batch terminalizes from the current-Run result", async (t) => {
  const controller = new AbortController();
  let committedCount = 0;
  class AbortAfterFirstResultDurability extends JournalToolDurability {
    override async commitResult(
      ...args: Parameters<JournalToolDurability["commitResult"]>
    ) {
      const result = await super.commitResult(...args);
      committedCount += 1;
      if (committedCount === 1) controller.abort();
      return result;
    }
  }
  const calls = [
    toolCall("call_partial_first", "write", '{"path":"first.txt","content":"one"}'),
    toolCall("call_partial_second", "write", '{"path":"second.txt","content":"two"}'),
  ];
  const fixture = await createRuntimeFixture(t, calls, {
    durabilityFactory: (options) => new AbortAfterFirstResultDurability(options),
  });

  await assert.rejects(
    fixture.runtime.execute(fixture.calls, controller.signal),
    (error: unknown) => error instanceof ToolDurabilityError,
  );
  const events = await eventsAfterAssistant(fixture);
  const durableResults = results(events);
  assert.equal(durableResults.length, 1);
  assert.equal(durableResults[0]?.payload.toolCallId, calls[0]?.id);
  const interrupted = events.at(-1);
  assert.equal(interrupted?.type, "run_interrupted");
  if (interrupted?.type !== "run_interrupted") {
    assert.fail("partial batch did not terminalize its Run");
  }
  assert.equal(interrupted.payload.reason, "cancelled");
  assert.equal(interrupted.payload.sourceEventId, durableResults[0]?.id);
  await assert.rejects(readFile(join(fixture.workspace, "second.txt"), "utf8"));
});

test("direct protected-path deny has one permission source and no Artifact or Effect", async (t) => {
  const call = toolCall(
    "call_direct_deny",
    "read",
    JSON.stringify({ path: join(REPO_ROOT, ".env") }),
  );
  const fixture = await createRuntimeFixture(t, [call]);
  await fixture.runtime.execute(
    fixture.calls,
    new AbortController().signal,
  );
  const events = await eventsAfterAssistant(fixture);
  assert.deepEqual(eventTypes(events), [
    "permission_decided",
    "tool_result_committed",
  ]);
  const permission = events[0];
  assert.equal(permission?.type, "permission_decided");
  if (permission?.type !== "permission_decided") assert.fail("missing permission");
  assert.equal(permission.payload.finalDecision, "deny");
  const result = results(events)[0];
  assert.equal(result?.payload.sourceEventId, permission.id);
  assert.equal(result?.payload.artifactId, null);
  assert.equal(result?.payload.effectId, null);
});

test("mechanical pre-effect failure publishes one zero-byte terminal observation", async (t) => {
  const argumentsText = JSON.stringify({
    path: "missing-parent/target.txt",
    content: "never written",
  });
  const call = toolCall("call_pre_effect", "write", argumentsText);
  const fixture = await createRuntimeFixture(t, [call]);
  await fixture.runtime.execute(fixture.calls, new AbortController().signal);
  const events = await eventsAfterAssistant(fixture);
  assert.deepEqual(eventTypes(events), [
    "permission_decided",
    "artifact_published",
    "tool_result_committed",
  ]);
  const artifact = events[1];
  assert.equal(artifact?.type, "artifact_published");
  if (artifact?.type !== "artifact_published") assert.fail("missing observation");
  assert.equal(artifact.payload.byteCount, 0);
  assert.deepEqual(artifact.payload.streamBytes, {
    read: 0,
    stdout: 0,
    stderr: 0,
  });
  assert.deepEqual(artifact.payload.terminal, {
    status: "invalid",
    code: "invalid_arguments",
    exitCode: null,
    signal: null,
    descendantsReaped: null,
  });
  assert.equal(
    events.some((event) => event.type === "effect_prepared"),
    false,
  );
  assert.equal(results(events)[0]?.payload.sourceEventId, artifact.id);
});

test("active edit match failures durably expose canonical matchCount without an Effect", async (t) => {
  const calls = [
    toolCall(
      "call_edit_no_match",
      "edit",
      JSON.stringify({
        path: "no-match.txt",
        old_string: "absent",
        new_string: "replacement",
      }),
    ),
    toolCall(
      "call_edit_not_unique",
      "edit",
      JSON.stringify({
        path: "not-unique.txt",
        old_string: "one",
        new_string: "replacement",
      }),
    ),
  ];
  const fixture = await createRuntimeFixture(t, calls);
  await writeFile(join(fixture.workspace, "no-match.txt"), "one two");
  await writeFile(join(fixture.workspace, "not-unique.txt"), "one two one");

  const committed = await fixture.runtime.execute(
    fixture.calls,
    new AbortController().signal,
  );
  assert.equal(committed.length, 2);
  const contents = committed.map(({ messageBytes }) =>
    parseToolResultContent(viewTool(messageBytes).content)
  );
  const firstContent = contents[0];
  const secondContent = contents[1];
  assert.equal(firstContent?.kind, "artifact");
  assert.equal(secondContent?.kind, "artifact");
  if (firstContent?.kind !== "artifact" || secondContent?.kind !== "artifact") {
    assert.fail("edit match failures were not Artifact-backed");
  }
  assert.deepEqual(
    [firstContent, secondContent].map(({ code, matchCount, head }) => ({
      code,
      matchCount,
      head,
    })),
    [
      { code: "edit_no_match", matchCount: 0, head: "0" },
      { code: "edit_not_unique", matchCount: 2, head: "2" },
    ],
  );

  const events = await eventsAfterAssistant(fixture);
  assert.equal(
    events.some(
      (event) =>
        event.type === "effect_prepared" || event.type === "effect_completed",
    ),
    false,
  );
  const artifacts = events.filter(
    (event): event is Extract<
      AnyVerifiedJournalEvent,
      { readonly type: "artifact_published" }
    > => event.type === "artifact_published",
  );
  assert.equal(artifacts.length, 2);
  for (const [index, artifact] of artifacts.entries()) {
    assert.equal(artifact.payload.byteCount, 7);
    assert.deepEqual(artifact.payload.streamBytes, {
      read: 0,
      stdout: 1,
      stderr: 0,
    });
    const range = await fixture.opened.artifacts.readArtifactRange(
      artifact.payload.artifactRef,
      { offset: 0, maxBytes: 7 },
    );
    const observed: number[] = [];
    const parser = createToolOutputFrameParser({
      data(stream, bytes) {
        assert.equal(stream, "stdout");
        observed.push(...bytes);
      },
    });
    parser.push(range.bytes);
    assert.equal(parser.finish().recordCount, 1);
    assert.equal(String.fromCharCode(...observed), index === 0 ? "0" : "2");
  }
  assert.equal(await readFile(join(fixture.workspace, "no-match.txt"), "utf8"), "one two");
  assert.equal(
    await readFile(join(fixture.workspace, "not-unique.txt"), "utf8"),
    "one two one",
  );
});

test("read batches cap concurrency and commit results in declaration order", async (t) => {
  // More calls than the cap, so the cap has to actually bind and a second
  // slice has to run after the first.
  const calls = Array.from({ length: OBSERVATION_PARALLELISM + 6 }, (_, index) =>
    toolCall(
      `call_read_${String(index)}`,
      "read",
      JSON.stringify({ path: `read-${String(index)}.txt` }),
    ),
  );
  const probe = { active: 0, max: 0, sinks: 0 };
  const fixture = await createRuntimeFixture(t, calls, {
    durabilityFactory: (options) => {
      class ProbedDurability extends JournalToolDurability {
        override async beginArtifact(): Promise<ArtifactSink> {
          const sink = await super.beginArtifact();
          const ordinal = probe.sinks;
          probe.sinks += 1;
          return Object.freeze({
            write: async (bytes: Uint8Array | FrozenBytes) => {
              probe.active += 1;
              probe.max = Math.max(probe.max, probe.active);
              try {
                // Long enough that every slot in a slice is still writing when
                // the last one starts, and staggered so they finish out of
                // order — which is what the commit order assertion is for.
                await new Promise((resolvePromise) => {
                  setTimeout(resolvePromise, 200 + (3 - (ordinal % 4)) * 10);
                });
                await sink.write(bytes);
              } finally {
                probe.active -= 1;
              }
            },
            publish: (metadata: ArtifactMetadata) => sink.publish(metadata),
            abort: () => sink.abort(),
          });
        }
      }
      return new ProbedDurability(options);
    },
  });
  await Promise.all(
    calls.map((_, index) =>
      writeFile(
        join(fixture.workspace, `read-${String(index)}.txt`),
        `payload-${String(index)}`,
        { flag: "wx", mode: 0o600 },
      ),
    ),
  );
  const committed = await fixture.runtime.execute(
    fixture.calls,
    new AbortController().signal,
  );
  // Pinned: the spec states this number, so a silent change fails here.
  assert.equal(OBSERVATION_PARALLELISM, 12);
  assert.equal(probe.max, OBSERVATION_PARALLELISM);
  assert.deepEqual(
    committed.map((value) => value.toolCallId),
    calls.map((call) => call.id),
  );
  const durableResults = results(await eventsAfterAssistant(fixture));
  assert.deepEqual(
    durableResults.map((event) => event.payload.toolCallId),
    calls.map((call) => call.id),
  );
});

test("T2 mutations serialize and preserve prepared Artifact completed result ordering", async (t) => {
  const firstArguments = '{ "content":"first", "path":"first.txt" }';
  const calls = [
    toolCall("call_write_first", "write", firstArguments),
    toolCall(
      "call_write_second",
      "write",
      '{"path":"second.txt","content":"second"}',
    ),
  ];
  const probe = { active: 0, max: 0, hits: 0 };
  const fixture = await createRuntimeFixture(t, calls, {
    fileMutationControls: {
      reach: async (point) => {
        if (point !== "before_publish") return;
        probe.active += 1;
        probe.hits += 1;
        probe.max = Math.max(probe.max, probe.active);
        try {
          await new Promise((resolvePromise) => {
            setTimeout(resolvePromise, 25);
          });
        } finally {
          probe.active -= 1;
        }
      },
    },
  });
  await fixture.runtime.execute(fixture.calls, new AbortController().signal);
  assert.deepEqual(probe, { active: 0, max: 1, hits: 2 });
  const events = await eventsAfterAssistant(fixture);
  assert.deepEqual(eventTypes(events), [
    "permission_decided",
    "effect_prepared",
    "artifact_published",
    "effect_completed",
    "tool_result_committed",
    "permission_decided",
    "effect_prepared",
    "artifact_published",
    "effect_completed",
    "tool_result_committed",
  ]);
  const prepared = events[1];
  const artifact = events[2];
  const completed = events[3];
  const result = events[4];
  assert.equal(prepared?.type, "effect_prepared");
  assert.equal(artifact?.type, "artifact_published");
  assert.equal(completed?.type, "effect_completed");
  assert.equal(result?.type, "tool_result_committed");
  if (
    prepared?.type !== "effect_prepared" ||
    artifact?.type !== "artifact_published" ||
    completed?.type !== "effect_completed" ||
    result?.type !== "tool_result_committed"
  ) {
    assert.fail("first T2 sequence was malformed");
  }
  assert.equal(
    prepared.payload.argumentsHash,
    `sha256:${sha256Hex(utf8Bytes(firstArguments))}`,
  );
  assert.equal(artifact.payload.terminal, null);
  assert.equal(artifact.payload.byteCount, 0);
  assert.equal(completed.payload.effectId, prepared.payload.effectId);
  assert.equal(completed.payload.artifactId, artifact.payload.artifactId);
  assert.equal(result.payload.effectId, prepared.payload.effectId);
  assert.equal(result.payload.artifactId, artifact.payload.artifactId);
  assert.equal(result.payload.sourceEventId, completed.id);
  assert.equal(await readFile(join(fixture.workspace, "first.txt"), "utf8"), "first");
  assert.equal(await readFile(join(fixture.workspace, "second.txt"), "utf8"), "second");
});

test("Artifact publication fault records indeterminate and commits no result", async (t) => {
  let failPublication = false;
  const controls: PersistenceTestControls = {
    fault(point) {
      if (failPublication && point === "cas.after_link_before_dir_sync") {
        throw new Error("injected Artifact publication fault");
      }
    },
  };
  const call = toolCall(
    "call_faulted_write",
    "write",
    '{"path":"faulted.txt","content":"durably uncertain"}',
  );
  const fixture = await createRuntimeFixture(t, [call], { controls });
  failPublication = true;
  await assert.rejects(
    fixture.runtime.execute(fixture.calls, new AbortController().signal),
    (error: unknown) => error instanceof ToolDurabilityError,
  );
  const events = await eventsAfterAssistant(fixture);
  assert.deepEqual(eventTypes(events), [
    "permission_decided",
    "effect_prepared",
    "effect_indeterminate",
    "run_interrupted",
  ]);
  const indeterminate = events[2];
  assert.equal(indeterminate?.type, "effect_indeterminate");
  if (indeterminate?.type !== "effect_indeterminate") {
    assert.fail("missing indeterminate fact");
  }
  assert.equal(indeterminate.payload.reason, "artifact_durability_failed");
  assert.equal(results(events).length, 0);
  assert.equal(
    events.some((event) => event.type === "effect_completed"),
    false,
  );
});

test("mixed calls commit exactly one result for every declared id", async (t) => {
  const calls = [
    toolCall("call_mix_invalid", "unknown", "{}"),
    toolCall(
      "call_mix_deny",
      "read",
      JSON.stringify({ path: join(REPO_ROOT, ".env") }),
    ),
    toolCall("call_mix_read", "read", '{"path":"readable.txt"}'),
    toolCall(
      "call_mix_observation",
      "edit",
      '{"path":"editable.txt","old_string":"missing","new_string":"x","replace_all":false}',
    ),
    toolCall(
      "call_mix_write",
      "write",
      '{"path":"written.txt","content":"written"}',
    ),
  ];
  const fixture = await createRuntimeFixture(t, calls);
  await writeFile(join(fixture.workspace, "readable.txt"), "readable", {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(join(fixture.workspace, "editable.txt"), "unchanged", {
    flag: "wx",
    mode: 0o600,
  });
  const committed: readonly CommittedToolResult[] = await fixture.runtime.execute(
    fixture.calls,
    new AbortController().signal,
  );
  const durableResults = results(await eventsAfterAssistant(fixture));
  assert.equal(committed.length, calls.length);
  assert.equal(durableResults.length, calls.length);
  assert.deepEqual(
    durableResults.map((event) => event.payload.toolCallId),
    calls.map((call) => call.id),
  );
  const counts = new Map<string, number>();
  for (const event of durableResults) {
    counts.set(
      event.payload.toolCallId,
      (counts.get(event.payload.toolCallId) ?? 0) + 1,
    );
  }
  assert.deepEqual(
    calls.map((call) => counts.get(call.id)),
    calls.map(() => 1),
  );
});

test("bash uses the native path on non-Windows and only Windows is unavailable", async (t) => {
  const call = toolCall(
    "call_bash_native",
    "bash",
    '{"command":"printf native-ok","timeout":2}',
  );
  const fixture = await createRuntimeFixture(t, [call]);
  await fixture.runtime.execute(fixture.calls, new AbortController().signal);
  const events = await eventsAfterAssistant(fixture);
  if (process.platform === "win32") {
    assert.deepEqual(eventTypes(events), [
      "permission_decided",
      "artifact_published",
      "tool_result_committed",
    ]);
    const artifact = events[1];
    assert.equal(artifact?.type, "artifact_published");
    if (artifact?.type !== "artifact_published") assert.fail("missing observation");
    assert.deepEqual(artifact.payload.terminal, {
      status: "unavailable",
      code: "bash_supervisor_unavailable",
      exitCode: null,
      signal: null,
      descendantsReaped: null,
    });
    assert.equal(artifact.payload.descendantsReaped, null);
    return;
  }
  assert.deepEqual(eventTypes(events), [
    "permission_decided",
    "effect_prepared",
    "artifact_published",
    "effect_completed",
    "tool_result_committed",
  ]);
  const artifact = events[2];
  const completed = events[3];
  assert.equal(artifact?.type, "artifact_published");
  assert.equal(completed?.type, "effect_completed");
  if (artifact?.type !== "artifact_published" || completed?.type !== "effect_completed") {
    assert.fail("native bash effect did not settle");
  }
  assert.equal(typeof artifact.payload.descendantsReaped, "boolean");
  assert.equal(
    completed.payload.terminal.descendantsReaped,
    artifact.payload.descendantsReaped,
  );
  assert.equal(completed.payload.terminal.status, "succeeded");
  assert.equal(completed.payload.terminal.code, "ok");
});

test("native bash has the current user's file authority outside the workspace", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows intentionally has no native bash path");
    return;
  }
  const markerRoot = await mkdtemp(join(tmpdir(), "flashcoder-user-authority-"));
  t.after(async () => {
    await rm(markerRoot, { recursive: true, force: true });
  });
  const markerPath = join(markerRoot, "synthetic-not-a-secret.txt");
  const marker = "synthetic-same-user-readable-marker";
  await writeFile(markerPath, marker, { flag: "wx", mode: 0o600 });
  const call = toolCall(
    "call_bash_same_user_authority",
    "bash",
    JSON.stringify({ command: `cat ${shellQuote(markerPath)}`, timeout: 2 }),
  );
  const fixture = await createRuntimeFixture(t, [call]);
  assert.equal(markerPath.startsWith(`${fixture.workspace}/`), false);

  const committed = await fixture.runtime.execute(
    fixture.calls,
    new AbortController().signal,
  );
  assert.equal(committed.length, 1);
  assert.match(
    Buffer.from(committed[0]?.messageBytes.copy() ?? []).toString("utf8"),
    new RegExp(marker, "u"),
  );
  assert.equal(
    (await eventsAfterAssistant(fixture)).some(
      (event) => event.type === "effect_indeterminate",
    ),
    false,
  );
});

test("native bash closed PATH includes the running Node distribution tools", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows intentionally has no native bash path");
    return;
  }
  const call = toolCall(
    "call_bash_node_distribution_path",
    "bash",
    JSON.stringify({
      command: "command -v node >/dev/null && command -v npm >/dev/null",
      timeout: 2,
    }),
  );
  const fixture = await createRuntimeFixture(t, [call]);

  await fixture.runtime.execute(fixture.calls, new AbortController().signal);
  const completed = (await eventsAfterAssistant(fixture)).find(
    (event) =>
      event.type === "effect_completed" && event.payload.toolCallId === call.id,
  );
  assert.equal(completed?.type, "effect_completed");
  if (completed?.type !== "effect_completed") {
    assert.fail("native bash Node-distribution PATH effect did not settle");
  }
  assert.deepEqual(completed.payload.terminal, {
    status: "succeeded",
    code: "ok",
    exitCode: 0,
    signal: null,
    descendantsReaped: true,
  });
});

test("read hard limit settles succeeded/ok without a process terminal", async (t) => {
  const call = toolCall(
    "call_read_hard_limit",
    "read",
    JSON.stringify({ path: "large.txt", limit: 1 }),
  );
  const fixture = await createRuntimeFixture(t, [call]);
  await writeFile(
    join(fixture.workspace, "large.txt"),
    Buffer.alloc(RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES + 1, 0x61),
    { flag: "wx", mode: 0o600 },
  );

  await fixture.runtime.execute(fixture.calls, new AbortController().signal);
  const events = await eventsAfterAssistant(fixture);
  assert.deepEqual(eventTypes(events), [
    "permission_decided",
    "artifact_published",
    "tool_result_committed",
  ]);
  const artifact = events[1];
  assert.equal(artifact?.type, "artifact_published");
  if (artifact?.type !== "artifact_published") assert.fail("missing read Artifact");
  assert.equal(artifact.payload.hardLimitReached, true);
  assert.deepEqual(artifact.payload.streamBytes, {
    read: RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES,
    stdout: 0,
    stderr: 0,
  });
  assert.deepEqual(artifact.payload.terminal, {
    status: "succeeded",
    code: "ok",
    exitCode: null,
    signal: null,
    descendantsReaped: null,
  });
});

test("bash yes stops at the exact raw limit with bounded projection and verified Artifact", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows intentionally has no native bash path");
    return;
  }
  const call = toolCall(
    "call_bash_yes_limit",
    "bash",
    JSON.stringify({ command: "yes", timeout: 8 }),
  );
  const fixture = await createRuntimeFixture(t, [call]);
  const measured = await measurePeakRss(() =>
    fixture.runtime.execute(
      fixture.calls,
      new AbortController().signal,
    )
  );
  const committed = measured.value;
  const events = await eventsAfterAssistant(fixture);
  const artifact = events.find(
    (event) =>
      event.type === "artifact_published" && event.payload.toolCallId === call.id,
  );
  const completed = events.find(
    (event) =>
      event.type === "effect_completed" && event.payload.toolCallId === call.id,
  );
  assert.equal(artifact?.type, "artifact_published");
  assert.equal(completed?.type, "effect_completed");
  if (
    artifact?.type !== "artifact_published" ||
    completed?.type !== "effect_completed"
  ) {
    assert.fail("bounded bash effect was not durably settled");
  }
  assert.equal(artifact.payload.hardLimitReached, true);
  assert.deepEqual(artifact.payload.streamBytes, {
    read: 0,
    stdout: RAW_TOOL_OUTPUT_HARD_LIMIT_BYTES,
    stderr: 0,
  });
  assert.equal(completed.payload.terminal.code, "output_limit");
  assert.equal(
    Number(completed.payload.terminal.exitCode !== null) +
      Number(completed.payload.terminal.signal !== null),
    1,
  );
  assert.equal(completed.payload.terminal.descendantsReaped, true);
  const binding = fixture.durability.get(artifact.payload.artifactRef);
  assert.notEqual(binding, undefined);
  if (binding === undefined) assert.fail("bounded bash Artifact is not active");
  await binding.store.verifyArtifact(binding.descriptor);
  const providerByteCount = committed[0]?.messageBytes.byteLength;
  assert.notEqual(providerByteCount, undefined);
  assert.ok((providerByteCount as number) <= 32_768);
  const peakRssDeltaBytes = measured.peakRssBytes - measured.rssBaselineBytes;
  assert.ok(peakRssDeltaBytes < 256 * 1024 * 1024);
  t.diagnostic(JSON.stringify({
    artifactHash: artifact.payload.artifactHash,
    artifactByteCount: artifact.payload.byteCount,
    payloadByteCount: artifact.payload.streamBytes.stdout,
    providerByteCount,
    rssBaselineBytes: measured.rssBaselineBytes,
    peakRssBytes: measured.peakRssBytes,
    peakRssDeltaBytes,
  }));
});

test("self-expiring detached escape completes with durable false cleanup observation", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows intentionally has no native bash path");
    return;
  }
  const call = toolCall(
    "call_bash_escape",
    "bash",
    JSON.stringify({
      command: `${shellQuote(process.execPath)} "$HOME/escape-fixture.mjs"`,
      timeout: 5,
    }),
  );
  const fixture = await createRuntimeFixture(t, [call]);
  const escapedMarker = join(fixture.workspace, "escape-self-expired.txt");
  const escapedProgram = [
    "import { spawn } from 'node:child_process';",
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(
      `setTimeout(() => { require("node:fs").writeFileSync(${JSON.stringify(
        escapedMarker,
      )}, "done"); process.exit(0); }, 3000);`,
    )}], { detached: true, stdio: ["ignore", "inherit", "inherit"] });`,
    "child.unref();",
  ].join("\n");
  const fixturePath = join(fixture.workspace, "escape-fixture.mjs");
  await writeFile(fixturePath, escapedProgram, { flag: "wx", mode: 0o600 });

  await fixture.runtime.execute(fixture.calls, new AbortController().signal);
  const events = await eventsAfterAssistant(fixture);
  assert.equal(
    events.some((event) => event.type === "effect_indeterminate"),
    false,
  );
  const artifact = events.find(
    (event) =>
      event.type === "artifact_published" &&
      event.payload.toolCallId === call.id,
  );
  const completed = events.find(
    (event) =>
      event.type === "effect_completed" && event.payload.toolCallId === call.id,
  );
  assert.equal(artifact?.type, "artifact_published");
  assert.equal(completed?.type, "effect_completed");
  if (
    artifact?.type !== "artifact_published" ||
    completed?.type !== "effect_completed"
  ) {
    assert.fail("detached escape did not settle through the Effect gateway");
  }
  assert.equal(artifact.payload.descendantsReaped, false);
  assert.equal(completed.payload.terminal.descendantsReaped, false);

  await fixture.closeWriter();
  const reopened = await openJournal(
    fixture.workspace,
    RUNTIME_FIXTURE_SESSION_ID,
    runtimeFixtureClock,
    runtimeFixtureEventIds("e"),
  );
  try {
    const replayArtifact = reopened.replay.events.find(
      (event) =>
        event.type === "artifact_published" &&
        event.payload.toolCallId === call.id,
    );
    const replayCompleted = reopened.replay.events.find(
      (event) =>
        event.type === "effect_completed" &&
        event.payload.toolCallId === call.id,
    );
    assert.equal(
      replayArtifact?.type === "artifact_published"
        ? replayArtifact.payload.descendantsReaped
        : null,
      false,
    );
    assert.equal(
      replayCompleted?.type === "effect_completed"
        ? replayCompleted.payload.terminal.descendantsReaped
        : null,
      false,
    );
  } finally {
    await reopened.writer.close();
  }

  await delay(1_500);
  assert.equal(await readFile(escapedMarker, "utf8"), "done");
});

function webSearchFixtureResponse(
  searchId = "srch_fixture",
): DeepSeekWebSearchResponse {
  return Object.freeze({
    searchId,
    answer: "DeepSeek published the fixture headline story.",
    queries: Object.freeze(["DeepSeek fixture query"]),
    openedUrls: Object.freeze(["https://example.com/story"]),
    usage: Object.freeze({
      inputTokens: 100,
      outputTokens: 40,
      reasoningTokens: 10,
    }),
  });
}

test("web_search settles a provider search as a durable stdout observation", async (t) => {
  const call = toolCall(
    "call_web_search_ok",
    "web_search",
    JSON.stringify({
      search_query: "DeepSeek 最新消息",
      search_locale: "zh-CN",
    }),
  );
  const received: Array<{ searchQuery: string; searchLocale: string }> = [];
  const fixture = await createRuntimeFixture(t, [call], {
    cacheAbi: buildCacheAbiV2(),
    webSearch: async (input) => {
      received.push({
        searchQuery: input.searchQuery,
        searchLocale: input.searchLocale ?? "",
      });
      return webSearchFixtureResponse();
    },
  });

  const committed = await fixture.runtime.execute(
    fixture.calls,
    new AbortController().signal,
  );
  assert.equal(committed.length, 1);
  assert.deepEqual(received, [
    { searchQuery: "DeepSeek 最新消息", searchLocale: "zh-CN" },
  ]);

  const events = await eventsAfterAssistant(fixture);
  assert.deepEqual(eventTypes(events), [
    "permission_decided",
    "artifact_published",
    "tool_result_committed",
  ]);
  const artifact = events[1];
  assert.equal(artifact?.type, "artifact_published");
  if (artifact?.type !== "artifact_published") {
    assert.fail("web search did not publish an Artifact");
  }
  assert.equal(artifact.payload.terminal?.status, "succeeded");
  assert.equal(artifact.payload.terminal?.code, "ok");
  assert.equal(artifact.payload.terminal?.exitCode, null);
  assert.equal(artifact.payload.terminal?.signal, null);
  assert.equal(artifact.payload.terminal?.descendantsReaped, null);
  assert.equal(artifact.payload.hardLimitReached, false);

  const expectedJson = JSON.stringify(webSearchFixtureResponse());
  const streamBytes = artifact.payload.streamBytes;
  assert.notEqual(streamBytes, null);
  if (streamBytes === null) {
    assert.fail("web search Artifact lacks stream bytes");
  }
  assert.equal(streamBytes.read, 0);
  assert.equal(streamBytes.stderr, 0);
  assert.equal(streamBytes.stdout, expectedJson.length);
  const range = await fixture.opened.artifacts.readArtifactRange(
    artifact.payload.artifactRef,
    { offset: 0, maxBytes: artifact.payload.byteCount },
  );
  const framed: number[] = [];
  const parser = createToolOutputFrameParser({
    data(stream, bytes) {
      assert.equal(stream, "stdout");
      framed.push(...bytes);
    },
  });
  parser.push(range.bytes);
  assert.equal(parser.finish().recordCount, 1);
  assert.equal(String.fromCharCode(...framed), expectedJson);

  const result = results(events)[0];
  assert.equal(result?.payload.toolCallId, call.id);
  assert.equal(result?.payload.effectId, null);
  assert.equal(result?.payload.artifactId, artifact.payload.artifactId);
  const view = viewTool(committed[0]!.messageBytes);
  assert.equal(view.toolCallId, call.id);
  assert.equal(view.content.includes("srch_fixture"), true);
  assert.equal(view.content.includes("published the fixture headline story"), true);
});

test("web_search omits the locale when the model left it out", async (t) => {
  const call = toolCall(
    "call_web_search_no_locale",
    "web_search",
    JSON.stringify({ search_query: "news" }),
  );
  const received: Array<{ searchQuery: string; searchLocale?: string }> = [];
  const fixture = await createRuntimeFixture(t, [call], {
    cacheAbi: buildCacheAbiV2(),
    webSearch: async (input) => {
      received.push({ ...input });
      return webSearchFixtureResponse("srch_no_locale");
    },
  });
  await fixture.runtime.execute(fixture.calls, new AbortController().signal);
  assert.deepEqual(received, [{ searchQuery: "news" }]);
});

test("web_search provider failure settles as a failed io_error observation", async (t) => {
  const call = toolCall(
    "call_web_search_fail",
    "web_search",
    JSON.stringify({ search_query: "unreachable" }),
  );
  const fixture = await createRuntimeFixture(t, [call], {
    cacheAbi: buildCacheAbiV2(),
    webSearch: async () => {
      throw new Error("web search HTTP 429");
    },
  });

  const committed = await fixture.runtime.execute(
    fixture.calls,
    new AbortController().signal,
  );
  assert.equal(committed.length, 1);
  const events = await eventsAfterAssistant(fixture);
  assert.deepEqual(eventTypes(events), [
    "permission_decided",
    "artifact_published",
    "tool_result_committed",
  ]);
  const artifact = events[1];
  assert.equal(artifact?.type, "artifact_published");
  if (artifact?.type !== "artifact_published") {
    assert.fail("failed web search did not publish an Artifact");
  }
  assert.equal(artifact.payload.terminal?.status, "failed");
  assert.equal(artifact.payload.terminal?.code, "io_error");
  assert.equal(artifact.payload.terminal?.exitCode, null);
  assert.equal(artifact.payload.terminal?.signal, null);
  assert.equal(artifact.payload.terminal?.descendantsReaped, null);
  const result = results(events)[0];
  assert.equal(result?.payload.effectId, null);
  assert.equal(result?.payload.artifactId, artifact.payload.artifactId);
  const view = viewTool(committed[0]!.messageBytes);
  assert.equal(view.content.includes("web search HTTP 429"), true);
});

test("web_search is unknown under the previous edit-v5 tools ABI", async (t) => {
  const call = toolCall(
    "call_web_search_legacy",
    "web_search",
    JSON.stringify({ search_query: "x" }),
  );
  const fixture = await createRuntimeFixture(t, [call]);
  const committed = await fixture.runtime.execute(
    fixture.calls,
    new AbortController().signal,
  );
  assert.equal(committed.length, 1);
  const events = await eventsAfterAssistant(fixture);
  assert.deepEqual(eventTypes(events), ["tool_result_committed"]);
  const result = results(events)[0];
  assert.equal(result?.payload.effectId, null);
  assert.equal(result?.payload.artifactId, null);
  const view = viewTool(committed[0]!.messageBytes);
  assert.equal(view.content, '{"status":"invalid","code":"unknown_tool"}');
});

test("observations batch after an effect, not only before the first one", async (t) => {
  // The rule used to be that the first effect ended batching for the whole
  // reply, so the reads below ran one at a time. Nothing about them depends on
  // each other: the write ahead of them is a barrier, and once it is committed
  // they all observe the same world.
  const calls = [
    toolCall("call_write_gate", "write", JSON.stringify({
      path: "gate.txt",
      content: "gate",
    })),
    ...Array.from({ length: 4 }, (_, index) =>
      toolCall(
        `call_read_after_${String(index)}`,
        "read",
        JSON.stringify({ path: `after-${String(index)}.txt` }),
      ),
    ),
  ];
  const probe = { active: 0, max: 0 };
  const fixture = await createRuntimeFixture(t, calls, {
    durabilityFactory: (options) => {
      class ProbedDurability extends JournalToolDurability {
        override async beginArtifact(): Promise<ArtifactSink> {
          const sink = await super.beginArtifact();
          return Object.freeze({
            write: async (bytes: Uint8Array | FrozenBytes) => {
              probe.active += 1;
              probe.max = Math.max(probe.max, probe.active);
              try {
                await delay(120);
                await sink.write(bytes);
              } finally {
                probe.active -= 1;
              }
            },
            publish: (metadata: ArtifactMetadata) => sink.publish(metadata),
            abort: () => sink.abort(),
          });
        }
      }
      return new ProbedDurability(options);
    },
  });
  await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      writeFile(
        join(fixture.workspace, `after-${String(index)}.txt`),
        `payload-${String(index)}`,
        { flag: "wx", mode: 0o600 },
      ),
    ),
  );

  const committed = await fixture.runtime.execute(
    fixture.calls,
    new AbortController().signal,
  );
  assert.equal(probe.max, 4, "the reads after the write did not overlap");
  assert.deepEqual(
    committed.map((value) => value.toolCallId),
    calls.map((call) => call.id),
  );
  const durableResults = results(await eventsAfterAssistant(fixture));
  assert.deepEqual(
    durableResults.map((event) => event.payload.toolCallId),
    calls.map((call) => call.id),
  );
});

test("searches in one reply run beside each other", async (t) => {
  const calls = Array.from({ length: 3 }, (_, index) =>
    toolCall(
      `call_search_${String(index)}`,
      "web_search",
      JSON.stringify({ search_query: `query ${String(index)}` }),
    ),
  );
  const probe = { active: 0, max: 0 };
  const fixture = await createRuntimeFixture(t, calls, {
    cacheAbi: buildCacheAbiV2(),
    webSearch: async () => {
      probe.active += 1;
      probe.max = Math.max(probe.max, probe.active);
      try {
        await delay(150);
        return webSearchFixtureResponse();
      } finally {
        probe.active -= 1;
      }
    },
  });

  const committed = await fixture.runtime.execute(
    fixture.calls,
    new AbortController().signal,
  );
  assert.equal(probe.max, 3, "the searches were issued one at a time");
  assert.deepEqual(
    committed.map((value) => value.toolCallId),
    calls.map((call) => call.id),
  );
});

test("an effect between two batches is a barrier", async (t) => {
  // read, read, write, read, read: the reads either side may overlap each
  // other, but nothing may overlap the write, or the second pair could observe
  // a file that is half written.
  const spans = new Map<number, { from: number; to: number }>();
  let step = 0;
  let ordinal = 0;
  const calls = [
    toolCall("call_before_0", "read", JSON.stringify({ path: "before-0.txt" })),
    toolCall("call_before_1", "read", JSON.stringify({ path: "before-1.txt" })),
    toolCall("call_barrier", "write", JSON.stringify({
      path: "barrier.txt",
      content: "barrier",
    })),
    toolCall("call_after_0", "read", JSON.stringify({ path: "after-0.txt" })),
    toolCall("call_after_1", "read", JSON.stringify({ path: "after-1.txt" })),
  ];
  const fixture = await createRuntimeFixture(t, calls, {
    durabilityFactory: (options) => {
      class ProbedDurability extends JournalToolDurability {
        override async beginArtifact(): Promise<ArtifactSink> {
          const sink = await super.beginArtifact();
          // Every tool opens exactly one sink, in declaration order, so the
          // ordinal identifies the call even though `write` never streams.
          const mine = ordinal;
          ordinal += 1;
          step += 1;
          spans.set(mine, { from: step, to: step });
          return Object.freeze({
            write: async (bytes: Uint8Array | FrozenBytes) => {
              await delay(60);
              await sink.write(bytes);
            },
            publish: async (metadata: ArtifactMetadata) => {
              const published = await sink.publish(metadata);
              step += 1;
              const span = spans.get(mine);
              if (span !== undefined) span.to = step;
              return published;
            },
            abort: () => sink.abort(),
          });
        }
      }
      return new ProbedDurability(options);
    },
  });
  await Promise.all(
    ["before-0", "before-1", "after-0", "after-1"].map((name) =>
      writeFile(join(fixture.workspace, `${name}.txt`), name, {
        flag: "wx",
        mode: 0o600,
      }),
    ),
  );

  await fixture.runtime.execute(fixture.calls, new AbortController().signal);
  assert.equal(spans.size, calls.length);
  const overlaps = (left: number, right: number): boolean => {
    const a = spans.get(left);
    const b = spans.get(right);
    if (a === undefined || b === undefined) return false;
    return a.from <= b.to && b.from <= a.to;
  };
  assert.ok(overlaps(0, 1), "the reads before the write did not overlap");
  assert.ok(overlaps(3, 4), "the reads after the write did not overlap");
  for (const other of [0, 1, 3, 4]) {
    assert.ok(!overlaps(2, other), `the write overlapped read ${String(other)}`);
  }
});
