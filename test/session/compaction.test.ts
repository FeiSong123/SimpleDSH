import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { materializeAssistant } from "../../src/bytes/assistant.js";
import { DEEPSEEK_MODEL } from "../../src/bytes/request.js";
import type { CompletedDeepSeekResponse, DeepSeekUsage } from "../../src/ds/types.js";
import {
  openJournal,
  type AnyVerifiedJournalEvent,
  type CanonicalTimestamp,
  type EventId,
  type EventIdentitySource,
  type SessionId,
} from "../../src/journal/index.js";
import {
  pendingCompactionSummary,
  recordCompaction,
} from "../../src/session/compaction.js";
import {
  continueSessionFixture,
  runSessionFixture,
  type SessionFixtureTurn,
} from "../../src/session/index.js";

const FIXED_AT = "2026-08-11T09:00:00.000Z" as CanonicalTimestamp;
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
  const root = await mkdtemp(join(tmpdir(), `dsh-compact-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function usage(): DeepSeekUsage {
  return Object.freeze({
    promptTokens: 512_000,
    promptCacheHitTokens: 500_000,
    promptCacheMissTokens: 12_000,
    completionTokens: 40,
    reasoningTokens: 10,
    rawFinishReason: "stop",
  });
}

function answer(text: string, id: string): SessionFixtureTurn {
  const message = Object.freeze({
    content: text,
    reasoningContent: "ok",
    toolCalls: Object.freeze([]),
  });
  const response: CompletedDeepSeekResponse = Object.freeze({
    assistantBytes: materializeAssistant(message),
    content: message.content,
    reasoningContent: message.reasoningContent,
    toolCalls: message.toolCalls,
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

test("compaction opens a new Lineage under the same Cache ABI", async (t) => {
  // The point of compaction is that the frozen zone does not move: same system
  // blob, same tools, same model. Only the conversation is replaced.
  const root = await workspace(t, "abi");
  const id = sessionId("1");
  await runSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "Do the work.",
    turns: [answer("Done.", "r1")],
    clock: fixedClock,
    eventIds: eventIds("a"),
  });

  const result = await recordCompaction({
    workspaceRoot: root,
    sessionId: id,
    summary: "We fixed calc.py and ran the tests.",
    replacedPromptTokens: 512_000,
    clock: fixedClock,
    eventIds: eventIds("b"),
  });
  assert.notEqual(result.fromLineageId, result.toLineageId);

  const all = await events(root, id);
  const starts = all.filter((event) => event.type === "lineage_started");
  assert.equal(starts.length, 2);
  assert.equal(
    starts[0]?.type === "lineage_started" && starts[1]?.type === "lineage_started"
      ? starts[0].payload.cacheAbiId === starts[1].payload.cacheAbiId
      : false,
    true,
  );

  const broke = all.find((event) => event.type === "cache_break");
  assert.ok(broke !== undefined && broke.type === "cache_break");
  assert.equal(broke.payload.classification, "planned");
  assert.equal(
    broke.payload.classification === "planned" ? broke.payload.reason : null,
    "compaction",
  );
});

test("the old bytes stay durable; only the active Lineage changes", async (t) => {
  // Nothing is deleted. That is what separates this from rewriting history.
  const root = await workspace(t, "durable");
  const id = sessionId("2");
  await runSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "First question.",
    turns: [answer("First answer.", "r1")],
    clock: fixedClock,
    eventIds: eventIds("a"),
  });
  const before = await events(root, id);
  const userBlobs = before.filter((event) => event.type === "user_committed").length;

  await recordCompaction({
    workspaceRoot: root,
    sessionId: id,
    summary: "Summary of the first exchange.",
    replacedPromptTokens: 512_000,
    clock: fixedClock,
    eventIds: eventIds("b"),
  });

  const after = await events(root, id);
  assert.equal(
    after.filter((event) => event.type === "user_committed").length,
    userBlobs,
  );
  assert.equal(after.length > before.length, true);
  for (const [index, event] of before.entries()) {
    assert.equal(after[index]?.id, event.id);
  }
});

test("the summary is pending until the new Lineage has a turn of its own", async (t) => {
  const root = await workspace(t, "pending");
  const id = sessionId("3");
  await runSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "Do the work.",
    turns: [answer("Done.", "r1")],
    clock: fixedClock,
    eventIds: eventIds("a"),
  });
  assert.equal(await pendingCompactionSummary(root, id), null);

  const summary = "calc.py was fixed; tests pass.";
  await recordCompaction({
    workspaceRoot: root,
    sessionId: id,
    summary,
    replacedPromptTokens: 512_000,
    clock: fixedClock,
    eventIds: eventIds("b"),
  });
  assert.equal(await pendingCompactionSummary(root, id), summary);

  await continueSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: `Here is where the previous conversation left off.\n\n${summary}\n\n---\n\nCarry on.`,
    turns: [answer("Carrying on.", "r2")],
    clock: fixedClock,
    eventIds: eventIds("c"),
  });
  // Once it is in the prefix it must not be prepended again.
  assert.equal(await pendingCompactionSummary(root, id), null);
});

test("the next turn starts a fresh prefix on the new Lineage", async (t) => {
  const root = await workspace(t, "prefix");
  const id = sessionId("4");
  await runSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "First.",
    turns: [answer("A1.", "r1")],
    clock: fixedClock,
    eventIds: eventIds("a"),
  });
  const compacted = await recordCompaction({
    workspaceRoot: root,
    sessionId: id,
    summary: "Everything so far.",
    replacedPromptTokens: 512_000,
    clock: fixedClock,
    eventIds: eventIds("b"),
  });
  await continueSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "Second.",
    turns: [answer("A2.", "r2")],
    clock: fixedClock,
    eventIds: eventIds("c"),
  });

  const all = await events(root, id);
  const runsOnNew = all.filter(
    (event) => event.type === "run_started" && event.lineageId === compacted.toLineageId,
  );
  assert.equal(runsOnNew.length, 1);
  // A Lineage's first Run is a user turn, not a continuation of the old one.
  assert.equal(
    runsOnNew[0]?.type === "run_started" ? runsOnNew[0].payload.cause : null,
    "user",
  );
});
