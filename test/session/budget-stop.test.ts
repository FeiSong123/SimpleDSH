import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { materializeAssistant } from "../../src/bytes/assistant.js";
import { DEEPSEEK_MODEL } from "../../src/bytes/request.js";
import type { FlashRegularPriceV1 } from "../../src/cost/index.js";
import type {
  CompletedDeepSeekResponse,
  DeepSeekUsage,
  ToolCall,
} from "../../src/ds/types.js";
import {
  openJournal,
  type AnyVerifiedJournalEvent,
  type CanonicalTimestamp,
  type EventId,
  type EventIdentitySource,
  type SessionId,
} from "../../src/journal/index.js";
import {
  DEFAULT_RUN_BUDGET,
  RunBudget,
  RunBudgetExceeded,
  runSessionFixture,
  SessionAcceptanceBudgetError,
  type SessionFixtureTurn,
} from "../../src/session/index.js";

const FIXED_AT = "2026-08-07T10:00:00.000Z" as CanonicalTimestamp;
const fixedClock = Object.freeze({ now: () => FIXED_AT });

const PRICE: FlashRegularPriceV1 = Object.freeze({
  id: "flash-test",
  observedFrom: "2026-01-01T00:00:00.000Z" as CanonicalTimestamp,
  verifiedAt: "2026-01-01",
  cacheHitPicodollarsPerToken: 2_800n,
  cacheMissPicodollarsPerToken: 140_000n,
  outputPicodollarsPerToken: 280_000n,
});

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
  const root = await mkdtemp(join(tmpdir(), `dsh-budget-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function usage(): DeepSeekUsage {
  return Object.freeze({
    promptTokens: 1_000,
    promptCacheHitTokens: 900,
    promptCacheMissTokens: 100,
    completionTokens: 50,
    reasoningTokens: 10,
    rawFinishReason: "tool_calls",
  });
}

/** A model that never stops asking to read the same file. */
function endlessReadTurn(ordinal: number): SessionFixtureTurn {
  const call: ToolCall = Object.freeze({
    id: `call_read_${String(ordinal)}`,
    type: "function" as const,
    function: Object.freeze({
      name: "read",
      arguments: JSON.stringify({ path: "loop.txt" }),
    }),
  });
  const materialization = Object.freeze({
    content: "",
    reasoningContent: "Checking once more.",
    toolCalls: Object.freeze([call]),
  });
  const response: CompletedDeepSeekResponse = Object.freeze({
    assistantBytes: materializeAssistant(materialization),
    content: materialization.content,
    reasoningContent: materialization.reasoningContent,
    toolCalls: materialization.toolCalls,
    usage: usage(),
    providerRequestId: `loop-${String(ordinal)}`,
    responseModel: DEEPSEEK_MODEL,
    systemFingerprint: null,
    semanticDeltaCount: 1,
  });
  return Object.freeze({
    kind: "success" as const,
    response,
    fragments: Object.freeze([Object.freeze({ kind: "tool_call" as const })]),
  });
}

async function eventsOf(
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

test("a model stuck in a tool loop is stopped by the cost limit", async (t) => {
  // Rounds are not capped; what ends a runaway is the money it spends.
  const root = await workspace(t, "cost");
  const id = sessionId("2");
  await writeFile(join(root, "loop.txt"), "body\n", "utf8");
  // Each response costs 900*2800 + 100*140000 + 50*280000 = 30,520,000.
  const budget = new RunBudget(
    {
      ...DEFAULT_RUN_BUDGET,
      maxCostPicodollars: 70_000_000n,
    },
    PRICE,
  );

  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Look at loop.txt.",
      turns: Array.from({ length: 40 }, (_, index) => endlessReadTurn(index)),
      clock: fixedClock,
      eventIds: eventIds("b"),
      acceptanceBudget: budget,
    }),
    (error: unknown) =>
      error instanceof SessionAcceptanceBudgetError ||
      error instanceof RunBudgetExceeded,
  );

  assert.equal(budget.stopped?.stop, "cost");
  // Two responses stay under 70,000,000; the third check refuses to send.
  assert.equal(budget.usage.toolRounds, 3);
  assert.equal(budget.usage.costPicodollars, 91_560_000n);

  // The Journal is intact and closed: the Run ends with an interruption, not a
  // half-written turn.
  const events = await eventsOf(root, id);
  assert.equal(
    events.filter((event) => event.type === "assistant_committed").length,
    3,
  );
  assert.equal(
    events.filter((event) => event.type === "run_interrupted").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "run_completed").length,
    0,
  );
});

test("a turn inside the budget still completes normally", async (t) => {
  const root = await workspace(t, "within");
  const id = sessionId("3");
  await writeFile(join(root, "loop.txt"), "body\n", "utf8");
  const finalTurn: SessionFixtureTurn = Object.freeze({
    kind: "success" as const,
    response: Object.freeze({
      assistantBytes: materializeAssistant({
        content: "Done.",
        reasoningContent: "Enough.",
        toolCalls: Object.freeze([]),
      }),
      content: "Done.",
      reasoningContent: "Enough.",
      toolCalls: Object.freeze([]),
      usage: Object.freeze({ ...usage(), rawFinishReason: "stop" }),
      providerRequestId: "final",
      responseModel: DEEPSEEK_MODEL,
      systemFingerprint: null,
      semanticDeltaCount: 1,
    }),
    fragments: Object.freeze([
      Object.freeze({ kind: "content" as const, text: "Done." }),
    ]),
  });
  const budget = new RunBudget(
    { ...DEFAULT_RUN_BUDGET },
    PRICE,
  );

  const result = await runSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "Look at loop.txt.",
    turns: [endlessReadTurn(0), finalTurn],
    clock: fixedClock,
    eventIds: eventIds("c"),
    acceptanceBudget: budget,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.content, "Done.");
  assert.equal(budget.stopped, null);
  assert.equal(budget.usage.toolRounds, 2);
});
