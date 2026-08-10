import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { materializeAssistant } from "../../src/bytes/assistant.js";
import { DEEPSEEK_MODEL } from "../../src/bytes/request.js";
import { DeepSeekTransportError } from "../../src/ds/transport.js";
import type { CompletedDeepSeekResponse, DeepSeekUsage } from "../../src/ds/types.js";
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
  SessionInterruptedError,
  type SessionFixtureTurn,
} from "../../src/session/index.js";

const FIXED_AT = "2026-08-10T09:00:00.000Z" as CanonicalTimestamp;
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
  const root = await mkdtemp(join(tmpdir(), `dsh-int-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function usage(): DeepSeekUsage {
  return Object.freeze({
    promptTokens: 100,
    promptCacheHitTokens: 80,
    promptCacheMissTokens: 20,
    completionTokens: 10,
    reasoningTokens: 4,
    rawFinishReason: "stop",
  });
}

function answer(text: string, id: string): SessionFixtureTurn {
  const m = Object.freeze({
    content: text,
    reasoningContent: "ok",
    toolCalls: Object.freeze([]),
  });
  const response: CompletedDeepSeekResponse = Object.freeze({
    assistantBytes: materializeAssistant(m),
    content: m.content,
    reasoningContent: m.reasoningContent,
    toolCalls: m.toolCalls,
    usage: usage(),
    providerRequestId: id,
    responseModel: DEEPSEEK_MODEL,
    systemFingerprint: null,
    semanticDeltaCount: 1,
  });
  return Object.freeze({
    kind: "success" as const,
    response,
    fragments: Object.freeze([Object.freeze({ kind: "content" as const, text })]),
  });
}

/** A turn that dies after the model started producing output. */
function brokenStream(): SessionFixtureTurn {
  return Object.freeze({
    kind: "interrupted" as const,
    failure: new DeepSeekTransportError("transport", "FIXTURE_RESET"),
    semanticState: "post_semantic" as const,
    decision: Object.freeze({
      retry: false,
      delayMs: null,
      retryClass: "transport_unknown" as const,
      integritySelfCheck: false,
    }),
    fragments: Object.freeze([
      Object.freeze({ kind: "content" as const, text: "partial" }),
    ]),
  });
}

async function events(
  root: string,
  id: SessionId,
): Promise<readonly AnyVerifiedJournalEvent[]> {
  const reopened = await openJournal(root, id, fixedClock, eventIds("z"));
  try {
    return reopened.replay.events;
  } finally {
    await reopened.writer.close();
  }
}

test("a new turn follows an interrupted one that closed at a safe boundary", async (t) => {
  const root = await workspace(t, "after-interrupt");
  const id = sessionId("1");

  // Turn one dies mid-stream. No assistant is committed, so the tail stays
  // closed at the user Commit Boundary.
  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "First question.",
      turns: [brokenStream()],
      clock: fixedClock,
      eventIds: eventIds("a"),
    }),
    SessionInterruptedError,
  );

  // Before the fix this failed forever with invalid_state, because continue
  // demanded the previous Run be `completed`.
  const second = await continueSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "Second question.",
    turns: [answer("Second answer.", "r2")],
    clock: fixedClock,
    eventIds: eventIds("b"),
  });
  assert.equal(second.status, "completed");
  assert.equal(second.content, "Second answer.");

  const replayed = await events(root, id);
  const runs = replayed.filter(
    (e): e is VerifiedJournalEvent<"run_started"> => e.type === "run_started",
  );
  assert.equal(runs.length, 2);
  assert.equal(runs[1]?.payload.cause, "continue");
  assert.equal(runs[1]?.payload.previousRunId, runs[0]?.runId);
  // Still one Lineage: the interrupted turn did not fork anything.
  assert.equal(runs[1]?.lineageId, runs[0]?.lineageId);
});

test("three turns survive an interruption in the middle", async (t) => {
  const root = await workspace(t, "middle");
  const id = sessionId("2");

  await runSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "One.",
    turns: [answer("A1.", "r1")],
    clock: fixedClock,
    eventIds: eventIds("a"),
  });
  await assert.rejects(
    continueSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Two.",
      turns: [brokenStream()],
      clock: fixedClock,
      eventIds: eventIds("b"),
    }),
    SessionInterruptedError,
  );
  const third = await continueSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "Three.",
    turns: [answer("A3.", "r3")],
    clock: fixedClock,
    eventIds: eventIds("c"),
  });

  assert.equal(third.content, "A3.");
  const runs = (await events(root, id)).filter(
    (e): e is VerifiedJournalEvent<"run_started"> => e.type === "run_started",
  );
  assert.deepEqual(
    runs.map((r) => r.payload.cause),
    ["user", "continue", "continue"],
  );
});
