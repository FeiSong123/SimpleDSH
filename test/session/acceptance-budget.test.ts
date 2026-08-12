import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { INLINE_BLOB_LIMIT } from "../../src/blob/index.js";
import { materializeAssistant } from "../../src/bytes/assistant.js";
import { DEEPSEEK_MODEL } from "../../src/bytes/request.js";
import { DeepSeekTransportError } from "../../src/ds/transport.js";
import type {
  CompletedDeepSeekResponse,
  DeepSeekUsage,
  ToolCall,
} from "../../src/ds/types.js";
import {
  openJournalReadOnly,
  type AnyVerifiedJournalEvent,
  type CanonicalTimestamp,
  type EventId,
  type EventIdentitySource,
  type SessionId,
  type VerifiedJournalEvent,
} from "../../src/journal/index.js";
import {
  runSessionFixture,
  SessionAcceptanceBudgetError,
  SessionInterruptedError,
  type SessionAcceptanceBudget,
  type SessionFixtureTurn,
} from "../../src/session/index.js";
import {
  EvaluatorTaskBudget,
  type EvaluatorTaskBudgetSpec,
  type MonotonicTimerDriver,
} from "../tasks/task-budget.js";

const FIXED_AT = "2026-08-05T09:00:00.000Z" as CanonicalTimestamp;
const fixedClock = Object.freeze({ now: () => FIXED_AT });

class FixedMonotonicTimer implements MonotonicTimerDriver {
  now = 1_000;

  readonly nowMilliseconds = (): number => this.now;
  readonly setTimer = (_callback: () => void, _delayMilliseconds: number): number => 1;
  readonly clearTimer = (_handle: unknown): void => undefined;
}

function sessionId(fill: string): SessionId {
  return `ses_${fill.repeat(32)}` as SessionId;
}

function eventIds(fill: string): EventIdentitySource {
  let counter = 0;
  return Object.freeze({
    nextEventId: () => {
      counter += 1;
      const suffix = counter.toString(16);
      return `evt_${fill}${suffix.padStart(31, "0")}` as EventId;
    },
  });
}

async function workspace(t: TestContext, label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `flashcoder-budget-${label}-`));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

function budgetSpec(
  overrides: Partial<EvaluatorTaskBudgetSpec> = {},
): EvaluatorTaskBudgetSpec {
  const promptTokenCap = overrides.promptTokenCap ?? 1_000;
  const completionTokenCap = overrides.completionTokenCap ?? 1_000;
  const cacheMissPicodollarsPerToken =
    overrides.cacheMissPicodollarsPerToken ?? 140_000n;
  const outputPicodollarsPerToken =
    overrides.outputPicodollarsPerToken ?? 280_000n;
  return Object.freeze({
    taskId: "session-budget-fixture",
    maxSemanticRequests: 2,
    maxPhysicalAttempts: 3,
    maxTaskWidePreSemanticRetries: 1,
    baseWallMilliseconds: 60_000,
    retryExtensionMilliseconds: 60_000,
    totalWallMilliseconds: 120_000,
    promptTokenCap,
    completionTokenCap,
    maxPromptTokensPerResponse: 1_000_000,
    maxCompletionTokensPerResponse: 65_536,
    cacheMissPicodollarsPerToken,
    outputPicodollarsPerToken,
    costCapPicodollars:
      BigInt(promptTokenCap) * cacheMissPicodollarsPerToken +
      BigInt(completionTokenCap) * outputPicodollarsPerToken,
    maxCostOvershootPicodollars: 200_000_000_000n,
    ...overrides,
  });
}

function budget(
  overrides: Partial<EvaluatorTaskBudgetSpec> = {},
): EvaluatorTaskBudget {
  return new EvaluatorTaskBudget(
    budgetSpec(overrides),
    new FixedMonotonicTimer(),
  );
}

function usage(overrides: Partial<DeepSeekUsage> = {}): DeepSeekUsage {
  return Object.freeze({
    promptTokens: 12,
    promptCacheHitTokens: 2,
    promptCacheMissTokens: 10,
    completionTokens: 4,
    reasoningTokens: 1,
    rawFinishReason: "stop",
    ...overrides,
  });
}

function toolCall(
  id: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
): ToolCall {
  return Object.freeze({
    id,
    type: "function" as const,
    function: Object.freeze({ name, arguments: JSON.stringify(args) }),
  });
}

function completedResponse(input: Readonly<{
  id: string;
  content?: string;
  reasoning?: string;
  toolCalls?: readonly ToolCall[];
  usage?: DeepSeekUsage;
}>): CompletedDeepSeekResponse {
  const toolCalls = Object.freeze([...(input.toolCalls ?? [])]);
  const content = input.content ?? "completed";
  const reasoningContent = input.reasoning ?? "fixture reasoning";
  return Object.freeze({
    assistantBytes: materializeAssistant({
      content,
      reasoningContent,
      toolCalls,
    }),
    content,
    reasoningContent,
    toolCalls,
    usage: input.usage ?? usage({
      rawFinishReason: toolCalls.length === 0 ? "stop" : "tool_calls",
    }),
    providerRequestId: input.id,
    responseModel: DEEPSEEK_MODEL,
    systemFingerprint: null,
    semanticDeltaCount: 1,
  });
}

function success(response: CompletedDeepSeekResponse): SessionFixtureTurn {
  return Object.freeze({ kind: "success" as const, response });
}

function retryablePreSemanticFailure(): SessionFixtureTurn {
  return Object.freeze({
    kind: "interrupted" as const,
    failure: new DeepSeekTransportError("transport", "FIXTURE_RESET"),
    semanticState: "pre_semantic" as const,
    decision: Object.freeze({
      retry: true,
      delayMs: 0,
      retryClass: "transport_unknown" as const,
      integritySelfCheck: false,
    }),
  });
}

async function replay(
  root: string,
  id: SessionId,
): Promise<readonly AnyVerifiedJournalEvent[]> {
  return (await openJournalReadOnly(root, id)).replay.events;
}

function eventsOf<Type extends AnyVerifiedJournalEvent["type"]>(
  events: readonly AnyVerifiedJournalEvent[],
  type: Type,
): readonly Extract<AnyVerifiedJournalEvent, { readonly type: Type }>[] {
  return events.filter(
    (event): event is Extract<AnyVerifiedJournalEvent, { readonly type: Type }> =>
      event.type === type,
  );
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(access(path));
}

test("semantic cap stops before creating a later Snapshot or request attempt", async (t) => {
  const root = await workspace(t, "semantic-cap");
  const id = sessionId("1");
  await writeFile(join(root, "source.txt"), "source\n", "utf8");
  const evaluator = budget({ maxSemanticRequests: 1, maxPhysicalAttempts: 2 });
  const first = completedResponse({
    id: "semantic-cap-first",
    content: "",
    toolCalls: [toolCall("call_semantic_cap_read", "read", { path: "source.txt" })],
  });

  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Read once, but do not exceed one semantic request.",
      turns: [success(first)],
      acceptanceBudget: evaluator,
      clock: fixedClock,
      eventIds: eventIds("1"),
    }),
    (error: unknown) => {
      assert.ok(
        error instanceof SessionAcceptanceBudgetError,
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
      return true;
    },
  );

  const report = evaluator.report();
  assert.deepEqual(report.outcome, {
    status: "non_pass",
    reason: "semantic_request_cap",
    phase: "snapshot",
    detail: "semantic request cap reached before Snapshot/send",
  });
  const events = await replay(root, id);
  assert.equal(eventsOf(events, "request_snapshot_stored").length, 1);
  assert.equal(eventsOf(events, "request_attempt_started").length, 1);
  assert.equal(eventsOf(events, "assistant_committed").length, 1);
  assert.equal(events.at(-1)?.type, "run_interrupted");
});

test("physical cap rejects a retry before its request_attempt_started event and response", async (t) => {
  const root = await workspace(t, "physical-cap");
  const id = sessionId("2");
  const evaluator = budget({
    maxSemanticRequests: 1,
    maxPhysicalAttempts: 1,
    maxTaskWidePreSemanticRetries: 1,
  });
  const unreachable = completedResponse({
    id: "physical-cap-unreachable",
    content: "must not be consumed",
  });

  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Retry once only if the physical budget permits it.",
      turns: [retryablePreSemanticFailure(), success(unreachable)],
      acceptanceBudget: evaluator,
      clock: fixedClock,
      eventIds: eventIds("2"),
    }),
    (error: unknown) => {
      assert.ok(
        error instanceof SessionAcceptanceBudgetError,
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
      return true;
    },
  );

  const report = evaluator.report();
  assert.equal(report.semanticRequests, 1);
  assert.equal(report.physicalAttempts, 1);
  assert.equal(report.preSemanticRetries, 0);
  assert.deepEqual(report.outcome, {
    status: "non_pass",
    reason: "physical_attempt_cap",
    phase: "attempt",
    detail: "physical attempt cap reached before provider send",
  });
  const events = await replay(root, id);
  assert.equal(eventsOf(events, "request_snapshot_stored").length, 1);
  assert.equal(eventsOf(events, "request_attempt_started").length, 1);
  assert.equal(eventsOf(events, "request_interrupted").length, 1);
  assert.equal(eventsOf(events, "assistant_committed").length, 0);
  assert.equal(
    events.some(
      (event) =>
        event.type === "assistant_committed" &&
        event.payload.providerRequestId === unreachable.providerRequestId,
    ),
    false,
  );
});

test("one pre-semantic retry reuses one Snapshot and records two physical attempts", async (t) => {
  const root = await workspace(t, "one-retry");
  const id = sessionId("3");
  const evaluator = budget({
    maxSemanticRequests: 1,
    maxPhysicalAttempts: 2,
    maxTaskWidePreSemanticRetries: 1,
  });
  const response = completedResponse({ id: "one-retry-success" });

  const result = await runSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "Finish after a single pre-semantic retry.",
    turns: [retryablePreSemanticFailure(), success(response)],
    acceptanceBudget: evaluator,
    clock: fixedClock,
    eventIds: eventIds("3"),
  });
  const report = evaluator.finishPass();
  const events = await replay(root, id);
  const snapshots = eventsOf(events, "request_snapshot_stored");
  const attempts = eventsOf(events, "request_attempt_started");
  const interruptions = eventsOf(events, "request_interrupted");

  assert.equal(result.requestCount, 1);
  assert.equal(snapshots.length, 1);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map((event) => event.payload.ordinal), [1, 2]);
  assert.deepEqual(
    attempts.map((event) => event.payload.requestSnapshotId),
    [snapshots[0]?.payload.requestSnapshotId, snapshots[0]?.payload.requestSnapshotId],
  );
  assert.equal(interruptions.length, 1);
  assert.equal(interruptions[0]?.payload.semanticState, "pre_semantic");
  assert.equal(eventsOf(events, "assistant_committed").length, 1);
  assert.equal(report.semanticRequests, 1);
  assert.equal(report.physicalAttempts, 2);
  assert.equal(report.preSemanticRetries, 1);
});

test("completed provider usage is accounted exactly once before assistant durability fails", async (t) => {
  const root = await workspace(t, "usage-before-assistant-fault");
  const id = sessionId("4");
  const evaluator = budget({ maxSemanticRequests: 1, maxPhysicalAttempts: 1 });
  const responseUsage = usage({
    promptTokens: 33,
    promptCacheHitTokens: 3,
    promptCacheMissTokens: 30,
    completionTokens: 7,
    reasoningTokens: 2,
  });
  const response = completedResponse({
    id: "usage-before-assistant-fault",
    content: "x".repeat(INLINE_BLOB_LIMIT + 1),
    usage: responseUsage,
  });
  let casPublications = 0;

  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Account the completed response before its assistant CAS fault.",
      turns: [success(response)],
      acceptanceBudget: evaluator,
      clock: fixedClock,
      eventIds: eventIds("4"),
      persistenceControls: {
        fault: (point) => {
          if (point !== "cas.after_temp_sync") return;
          casPublications += 1;
          if (casPublications === 4) {
            throw new Error("injected assistant CAS failure");
          }
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof SessionInterruptedError);
      assert.equal(error.reason, "durability_failure");
      return true;
    },
  );

  const report = evaluator.report();
  assert.equal(report.semanticRequests, 1);
  assert.equal(report.physicalAttempts, 1);
  assert.equal(report.promptTokens, responseUsage.promptTokens);
  assert.equal(report.completionTokens, responseUsage.completionTokens);
  assert.equal(
    report.costPicodollars,
    (
      BigInt(responseUsage.promptTokens) * evaluator.spec.cacheMissPicodollarsPerToken +
      BigInt(responseUsage.completionTokens) * evaluator.spec.outputPicodollarsPerToken
    ).toString(),
  );
  const events = await replay(root, id);
  assert.equal(eventsOf(events, "request_attempt_started").length, 1);
  assert.equal(eventsOf(events, "assistant_committed").length, 0);
  assert.equal(eventsOf(events, "request_interrupted").length, 1);
});

test("an exact token ceiling permits assistant durability but no T2 effect", async (t) => {
  const root = await workspace(t, "exact-ceiling");
  const id = sessionId("5");
  const target = join(root, "must-not-exist.txt");
  const responseUsage = usage();
  const evaluator = budget({
    maxSemanticRequests: 1,
    maxPhysicalAttempts: 1,
    promptTokenCap: responseUsage.promptTokens,
    completionTokenCap: 100,
  });
  const response = completedResponse({
    id: "exact-ceiling-tool-call",
    content: "",
    toolCalls: [
      toolCall("call_exact_ceiling_write", "write", {
        path: "must-not-exist.txt",
        content: "forbidden after ceiling\n",
      }),
    ],
    usage: responseUsage,
  });

  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Do not execute a tool after reaching the exact prompt ceiling.",
      turns: [success(response)],
      acceptanceBudget: evaluator,
      clock: fixedClock,
      eventIds: eventIds("5"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof SessionAcceptanceBudgetError);
      return true;
    },
  );

  await assertMissing(target);
  const report = evaluator.report();
  assert.deepEqual(report.outcome, {
    status: "non_pass",
    reason: "prompt_token_cap",
    phase: "effect",
    detail: "prompt token ceiling reached before later Snapshot/send/effect",
  });
  const events = await replay(root, id);
  assert.equal(eventsOf(events, "assistant_committed").length, 1);
  assert.equal(eventsOf(events, "permission_decided").length, 1);
  assert.equal(eventsOf(events, "effect_prepared").length, 0);
  assert.equal(eventsOf(events, "effect_completed").length, 0);
  assert.equal(eventsOf(events, "tool_result_committed").length, 0);
});

class SecondEffectStopBudget implements SessionAcceptanceBudget {
  readonly #controller = new AbortController();
  readonly signal = this.#controller.signal;
  semanticRequests = 0;
  physicalAttempts = 0;
  usageRecords = 0;
  effectChecks = 0;

  beforeSemanticRequest(): number {
    this.semanticRequests += 1;
    return this.semanticRequests;
  }

  beforePhysicalAttempt(_semanticRequestOrdinal: number): void {
    this.physicalAttempts += 1;
  }

  recordPreSemanticFailure(_semanticRequestOrdinal: number): void {
    return;
  }

  recordSemanticResponse(
    _semanticRequestOrdinal: number,
    _usage: DeepSeekUsage,
  ): void {
    this.usageRecords += 1;
  }

  beforeEffect(): void {
    this.effectChecks += 1;
    if (this.effectChecks !== 2) return;
    this.#controller.abort("second_effect_budget_stop");
    throw new Error("second effect is outside the evaluator budget");
  }
}

test("sequential T2 calls gate independently and reject only the second effect", async (t) => {
  const root = await workspace(t, "sequential-effects");
  const id = sessionId("6");
  const evaluator = new SecondEffectStopBudget();
  const response = completedResponse({
    id: "sequential-effects",
    content: "",
    toolCalls: [
      toolCall("call_first_budget_write", "write", {
        path: "first.txt",
        content: "first committed\n",
      }),
      toolCall("call_second_budget_write", "write", {
        path: "second.txt",
        content: "second must not run\n",
      }),
    ],
  });

  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Execute only the first mutation permitted by the budget.",
      turns: [success(response)],
      acceptanceBudget: evaluator,
      clock: fixedClock,
      eventIds: eventIds("6"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof SessionAcceptanceBudgetError);
      return true;
    },
  );

  assert.equal(await readFile(join(root, "first.txt"), "utf8"), "first committed\n");
  await assertMissing(join(root, "second.txt"));
  assert.equal(evaluator.semanticRequests, 1);
  assert.equal(evaluator.physicalAttempts, 1);
  assert.equal(evaluator.usageRecords, 1);
  assert.equal(evaluator.effectChecks, 2);
  assert.equal(evaluator.signal.aborted, true);
  const events = await replay(root, id);
  assert.equal(eventsOf(events, "permission_decided").length, 2);
  assert.equal(eventsOf(events, "effect_prepared").length, 1);
  assert.equal(eventsOf(events, "effect_completed").length, 1);
  assert.equal(eventsOf(events, "tool_result_committed").length, 1);
  assert.equal(events.at(-1)?.type, "run_interrupted");
});

class PassiveSignalBudget implements SessionAcceptanceBudget {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  calls = 0;

  beforeSemanticRequest(): number {
    this.calls += 1;
    return this.calls;
  }

  beforePhysicalAttempt(_semanticRequestOrdinal: number): void {
    this.calls += 1;
  }

  recordPreSemanticFailure(_semanticRequestOrdinal: number): void {
    this.calls += 1;
  }

  recordSemanticResponse(
    _semanticRequestOrdinal: number,
    _usage: DeepSeekUsage,
  ): void {
    this.calls += 1;
  }

  beforeEffect(): void {
    this.calls += 1;
  }
}

test("either evaluator or operator abort propagates before Snapshot/send", async (t) => {
  const cases = ["evaluator", "operator"] as const;
  for (const [index, source] of cases.entries()) {
    await t.test(source, async (inner) => {
      const root = await workspace(inner, `abort-${source}`);
      const id = sessionId(index === 0 ? "7" : "8");
      const evaluator = new PassiveSignalBudget();
      const operator = new AbortController();
      if (source === "evaluator") evaluator.controller.abort("budget deadline");
      else operator.abort("operator cancellation");
      let beforeSendCount = 0;

      await assert.rejects(
        runSessionFixture({
          workspaceRoot: root,
          sessionId: id,
          userInput: `Stop for the ${source} signal.`,
          turns: [success(completedResponse({ id: `abort-${source}` }))],
          acceptanceBudget: evaluator,
          signal: operator.signal,
          onBeforeSend: () => {
            beforeSendCount += 1;
          },
          clock: fixedClock,
          eventIds: eventIds(index === 0 ? "7" : "8"),
        }),
        (error: unknown) => {
          assert.ok(error instanceof SessionInterruptedError);
          assert.equal(error.reason, "cancelled");
          return true;
        },
      );

      assert.equal(evaluator.calls, 0);
      assert.equal(beforeSendCount, 0);
      const events = await replay(root, id);
      assert.equal(eventsOf(events, "request_snapshot_stored").length, 0);
      assert.equal(eventsOf(events, "request_attempt_started").length, 0);
      const interrupted = events.at(-1) as
        | VerifiedJournalEvent<"run_interrupted">
        | undefined;
      assert.equal(interrupted?.type, "run_interrupted");
      assert.equal(interrupted?.payload.reason, "cancelled");
    });
  }
});

test("evaluator report counters reconcile exactly with durable Journal facts", async (t) => {
  const root = await workspace(t, "report-journal");
  const id = sessionId("9");
  await writeFile(join(root, "source.txt"), "durable source\n", "utf8");
  const evaluator = budget({
    maxSemanticRequests: 2,
    maxPhysicalAttempts: 3,
    cacheMissPicodollarsPerToken: 2n,
    outputPicodollarsPerToken: 3n,
    costCapPicodollars: 1_000_000n,
  });
  const first = completedResponse({
    id: "report-journal-first",
    content: "",
    toolCalls: [toolCall("call_report_read", "read", { path: "source.txt" })],
  });
  const second = completedResponse({
    id: "report-journal-second",
    content: "done",
  });

  const result = await runSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "Read the fixture and then finish.",
    turns: [success(first), success(second)],
    acceptanceBudget: evaluator,
    clock: fixedClock,
    eventIds: eventIds("9"),
  });
  const report = evaluator.finishPass();
  const events = await replay(root, id);
  const snapshots = eventsOf(events, "request_snapshot_stored");
  const attempts = eventsOf(events, "request_attempt_started");
  const assistants = eventsOf(events, "assistant_committed");
  const preSemanticInterruptions = eventsOf(events, "request_interrupted").filter(
    (event) => event.payload.semanticState === "pre_semantic",
  );
  const durablePromptTokens = assistants.reduce(
    (sum, event) => sum + event.payload.usage.promptTokens,
    0,
  );
  const durableCompletionTokens = assistants.reduce(
    (sum, event) => sum + event.payload.usage.completionTokens,
    0,
  );

  assert.equal(result.requestCount, 2);
  assert.equal(report.outcome.status, "pass");
  assert.equal(report.semanticRequests, snapshots.length);
  assert.equal(report.physicalAttempts, attempts.length);
  assert.equal(report.preSemanticRetries, preSemanticInterruptions.length);
  assert.equal(report.promptTokens, durablePromptTokens);
  assert.equal(report.completionTokens, durableCompletionTokens);
  assert.equal(
    report.costPicodollars,
    (
      BigInt(durablePromptTokens) * evaluator.spec.cacheMissPicodollarsPerToken +
      BigInt(durableCompletionTokens) * evaluator.spec.outputPicodollarsPerToken
    ).toString(),
  );
  assert.equal(assistants.length, 2);
  assert.equal(events.at(-1)?.type, "run_completed");
});
