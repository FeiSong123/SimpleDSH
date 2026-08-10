import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { materializeAssistant } from "../../src/bytes/assistant.js";
import { DEEPSEEK_MODEL } from "../../src/bytes/request.js";
import type {
  CompletedDeepSeekResponse,
  DeepSeekUsage,
} from "../../src/ds/types.js";
import {
  openJournal,
  type AnyVerifiedJournalEvent,
  type CanonicalTimestamp,
  type EventId,
  type EventIdentitySource,
  type SessionId,
  type VerifiedJournalEvent,
} from "../../src/journal/index.js";
import {
  continueSessionFixture,
  runSessionFixture,
  SessionKernelError,
  type SessionFixtureTurn,
} from "../../src/session/index.js";

const FIXED_AT = "2026-08-07T08:00:00.000Z" as CanonicalTimestamp;
const fixedClock = Object.freeze({ now: () => FIXED_AT });

function sessionId(fill: string): SessionId {
  return `ses_${fill.repeat(32)}` as SessionId;
}

function eventIds(fill: string): EventIdentitySource {
  let counter = 0;
  return Object.freeze({
    nextEventId: () => {
      counter += 1;
      return `evt_${fill}${counter.toString(16).padStart(31, "0")}` as EventId;
    },
  });
}

async function workspace(t: TestContext, label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dsh-continue-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function usage(): DeepSeekUsage {
  return Object.freeze({
    promptTokens: 120,
    promptCacheHitTokens: 100,
    promptCacheMissTokens: 20,
    completionTokens: 12,
    reasoningTokens: 6,
    rawFinishReason: "stop",
  });
}

function answer(text: string, providerRequestId: string): SessionFixtureTurn {
  const materialization = Object.freeze({
    content: text,
    reasoningContent: "Answered directly.",
    toolCalls: Object.freeze([]),
  });
  const response: CompletedDeepSeekResponse = Object.freeze({
    assistantBytes: materializeAssistant(materialization),
    content: materialization.content,
    reasoningContent: materialization.reasoningContent,
    toolCalls: materialization.toolCalls,
    usage: usage(),
    providerRequestId,
    responseModel: DEEPSEEK_MODEL,
    systemFingerprint: null,
    semanticDeltaCount: 1,
  });
  return Object.freeze({
    kind: "success" as const,
    response,
    fragments: Object.freeze([
      Object.freeze({ kind: "content" as const, text }),
    ]),
  });
}

async function replay(
  root: string,
  id: SessionId,
  fill: string,
): Promise<readonly AnyVerifiedJournalEvent[]> {
  const reopened = await openJournal(root, id, fixedClock, eventIds(fill));
  try {
    return reopened.replay.events;
  } finally {
    await reopened.writer.close();
  }
}

function runsOf(
  events: readonly AnyVerifiedJournalEvent[],
): readonly VerifiedJournalEvent<"run_started">[] {
  return events.filter(
    (event): event is VerifiedJournalEvent<"run_started"> =>
      event.type === "run_started",
  );
}

test("a second user turn appends to the same Lineage as a continue Run", async (t) => {
  const root = await workspace(t, "second-turn");
  const id = sessionId("1");

  const first = await runSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "First question.",
    turns: [answer("First answer.", "fixture-1")],
    clock: fixedClock,
    eventIds: eventIds("a"),
  });
  assert.equal(first.status, "completed");
  assert.equal(first.content, "First answer.");

  const second = await continueSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "Second question.",
    turns: [answer("Second answer.", "fixture-2")],
    clock: fixedClock,
    eventIds: eventIds("b"),
  });
  assert.equal(second.status, "completed");
  assert.equal(second.content, "Second answer.");
  assert.equal(second.sessionId, id);

  const events = await replay(root, id, "c");
  const runs = runsOf(events);
  assert.equal(runs.length, 2);

  const [firstRun, secondRun] = runs;
  assert.ok(firstRun && secondRun);
  assert.deepEqual(firstRun.payload, { cause: "user", previousRunId: null });
  assert.deepEqual(secondRun.payload, {
    cause: "continue",
    previousRunId: firstRun.runId,
  });

  // One Lineage, one Cache ABI: the second turn is a tail append, not a branch.
  assert.equal(secondRun.lineageId, firstRun.lineageId);
  assert.equal(
    events.filter((event) => event.type === "lineage_started").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "cache_abi_declared").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "lineage_activated").length,
    1,
  );
  assert.equal(events.filter((event) => event.type === "cache_break").length, 0);

  // Blob indices continue instead of restarting.
  const roleIndices = events.flatMap((event) =>
    event.type === "user_committed" || event.type === "assistant_committed"
      ? [event.payload.blobIndex]
      : [],
  );
  assert.deepEqual(roleIndices, [0, 1, 2, 3]);
});

test("the second turn's request bytes extend the first turn's prefix", async (t) => {
  const root = await workspace(t, "prefix-append");
  const id = sessionId("2");
  const bodies: Uint8Array[] = [];

  await runSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "First question.",
    turns: [answer("First answer.", "fixture-1")],
    clock: fixedClock,
    eventIds: eventIds("a"),
    onBeforeSend: (observation) => {
      bodies.push(observation.snapshot.body.copy());
    },
  });
  await continueSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "Second question.",
    turns: [answer("Second answer.", "fixture-2")],
    clock: fixedClock,
    eventIds: eventIds("b"),
    onBeforeSend: (observation) => {
      bodies.push(observation.snapshot.body.copy());
    },
  });

  assert.equal(bodies.length, 2);
  const [firstBody, secondBody] = bodies;
  assert.ok(firstBody && secondBody);
  assert.ok(secondBody.byteLength > firstBody.byteLength);

  // The frozen header plus every earlier message byte must be reused exactly.
  // Only the tail after the first turn's messages differs, so the prefix stays
  // eligible for a provider cache hit.
  const shared = firstBody.indexOf(0x5d); // first "]" closes the messages array
  assert.ok(shared > 0);
  assert.deepEqual(
    Array.from(secondBody.subarray(0, shared)),
    Array.from(firstBody.subarray(0, shared)),
  );
});

test("continue refuses a Session whose last Run never completed", async (t) => {
  const root = await workspace(t, "never-completed");
  const id = sessionId("3");

  await assert.rejects(
    continueSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Nothing to continue.",
      turns: [answer("Unreachable.", "fixture-1")],
      clock: fixedClock,
      eventIds: eventIds("a"),
    }),
    (error: unknown) => error instanceof Error,
  );
});

test("continue rejects empty user input without touching the Journal", async (t) => {
  const root = await workspace(t, "empty-input");
  const id = sessionId("4");

  await runSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "First question.",
    turns: [answer("First answer.", "fixture-1")],
    clock: fixedClock,
    eventIds: eventIds("a"),
  });
  const before = await replay(root, id, "b");

  await assert.rejects(
    continueSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "",
      turns: [answer("Unreachable.", "fixture-2")],
      clock: fixedClock,
      eventIds: eventIds("c"),
    }),
    (error: unknown) => error instanceof SessionKernelError,
  );

  const after = await replay(root, id, "d");
  assert.equal(after.length, before.length);
  assert.equal(runsOf(after).length, 1);
});

test("three turns keep one Lineage and a single append-only chain", async (t) => {
  const root = await workspace(t, "three-turns");
  const id = sessionId("5");

  await runSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "Turn one.",
    turns: [answer("Answer one.", "fixture-1")],
    clock: fixedClock,
    eventIds: eventIds("a"),
  });
  for (const [index, fill] of [["two", "b"], ["three", "c"]] as const) {
    await continueSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: `Turn ${index}.`,
      turns: [answer(`Answer ${index}.`, `fixture-${fill}`)],
      clock: fixedClock,
      eventIds: eventIds(fill),
    });
  }

  const events = await replay(root, id, "d");
  const runs = runsOf(events);
  assert.equal(runs.length, 3);
  assert.deepEqual(
    runs.map((run) => run.payload.cause),
    ["user", "continue", "continue"],
  );
  assert.equal(new Set(runs.map((run) => run.lineageId)).size, 1);
  assert.deepEqual(
    runs.map((run) => run.payload.previousRunId),
    [null, runs[0]!.runId, runs[1]!.runId],
  );
});
