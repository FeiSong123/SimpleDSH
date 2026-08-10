import assert from "node:assert/strict";
import test from "node:test";

import type { FlashRegularPriceV1 } from "../../src/cost/index.js";
import type { DeepSeekUsage } from "../../src/ds/types.js";
import type { CanonicalTimestamp } from "../../src/journal/index.js";
import {
  DEFAULT_RUN_BUDGET,
  formatPicodollars,
  RunBudget,
  RunBudgetExceeded,
  type MonotonicClock,
} from "../../src/session/index.js";

const PRICE: FlashRegularPriceV1 = Object.freeze({
  id: "flash-test",
  observedFrom: "2026-01-01T00:00:00.000Z" as CanonicalTimestamp,
  verifiedAt: "2026-01-01",
  cacheHitPicodollarsPerToken: 2_800n,
  cacheMissPicodollarsPerToken: 140_000n,
  outputPicodollarsPerToken: 280_000n,
});

function usage(
  input: Readonly<{ hit?: number; miss?: number; completion?: number }>,
): DeepSeekUsage {
  const hit = input.hit ?? 0;
  const miss = input.miss ?? 0;
  return Object.freeze({
    promptTokens: hit + miss,
    promptCacheHitTokens: hit,
    promptCacheMissTokens: miss,
    completionTokens: input.completion ?? 0,
    reasoningTokens: 0,
    rawFinishReason: "stop",
  });
}

class FakeClock implements MonotonicClock {
  #now = 0;
  nowMs(): number {
    return this.#now;
  }
  advance(ms: number): void {
    this.#now += ms;
  }
}

test("the tool round limit stops the turn before the next request", () => {
  const budget = new RunBudget(
    { ...DEFAULT_RUN_BUDGET, maxToolRounds: 3 },
    PRICE,
  );
  assert.equal(budget.beforeSemanticRequest(), 1);
  assert.equal(budget.beforeSemanticRequest(), 2);
  assert.equal(budget.beforeSemanticRequest(), 3);

  assert.throws(() => budget.beforeSemanticRequest(), RunBudgetExceeded);
  assert.equal(budget.stopped?.stop, "tool_rounds");
  assert.equal(budget.signal.aborted, true);
  // The counter records what was actually spent, not the attempt that stopped.
  assert.equal(budget.usage.toolRounds, 3);
});

test("cost accumulates at the dated price and stops the next request", () => {
  const budget = new RunBudget(
    { ...DEFAULT_RUN_BUDGET, maxCostPicodollars: 1_000_000_000n },
    PRICE,
  );
  budget.beforeSemanticRequest();
  // 1000 miss + 1000 output = 140,000,000 + 280,000,000 picodollars.
  budget.recordSemanticResponse(1, usage({ miss: 1_000, completion: 1_000 }));
  assert.equal(budget.usage.costPicodollars, 420_000_000n);
  budget.beforeSemanticRequest();

  budget.recordSemanticResponse(2, usage({ miss: 5_000, completion: 1_000 }));
  assert.equal(budget.usage.costPicodollars, 1_400_000_000n);
  assert.throws(() => budget.beforeSemanticRequest(), RunBudgetExceeded);
  assert.equal(budget.stopped?.stop, "cost");
});

test("cache hits are priced fifty times cheaper than misses", () => {
  const budget = new RunBudget(DEFAULT_RUN_BUDGET, PRICE);
  budget.beforeSemanticRequest();
  budget.recordSemanticResponse(1, usage({ hit: 50_000 }));
  const hitCost = budget.usage.costPicodollars;

  const missBudget = new RunBudget(DEFAULT_RUN_BUDGET, PRICE);
  missBudget.beforeSemanticRequest();
  missBudget.recordSemanticResponse(1, usage({ miss: 1_000 }));
  assert.equal(hitCost, missBudget.usage.costPicodollars);
});

test("the wall clock limit stops a turn that is otherwise cheap", () => {
  const clock = new FakeClock();
  const budget = new RunBudget(
    { ...DEFAULT_RUN_BUDGET, maxWallMs: 60_000 },
    PRICE,
    clock,
  );
  budget.beforeSemanticRequest();
  clock.advance(59_000);
  budget.beforeSemanticRequest();

  clock.advance(1_000);
  assert.throws(() => budget.beforeSemanticRequest(), RunBudgetExceeded);
  assert.equal(budget.stopped?.stop, "wall_clock");
});

test("effects are checked too, so a long tool run cannot outlive the budget", () => {
  const clock = new FakeClock();
  const budget = new RunBudget(
    { ...DEFAULT_RUN_BUDGET, maxWallMs: 10_000 },
    PRICE,
    clock,
  );
  budget.beforeSemanticRequest();
  budget.beforeEffect();
  clock.advance(10_000);
  assert.throws(() => budget.beforeEffect(), RunBudgetExceeded);
  assert.equal(budget.stopped?.stop, "wall_clock");
});

test("the first stop is the one reported", () => {
  const budget = new RunBudget(
    { ...DEFAULT_RUN_BUDGET, maxToolRounds: 1, maxCostPicodollars: 1n },
    PRICE,
  );
  budget.beforeSemanticRequest();
  budget.recordSemanticResponse(1, usage({ miss: 1_000 }));
  assert.throws(() => budget.beforeSemanticRequest(), RunBudgetExceeded);
  // Cost is checked before the round count, and it was already over.
  assert.equal(budget.stopped?.stop, "cost");

  assert.throws(() => budget.beforeSemanticRequest(), RunBudgetExceeded);
  assert.equal(budget.stopped?.stop, "cost");
});

test("limits must be positive", () => {
  assert.throws(
    () => new RunBudget({ ...DEFAULT_RUN_BUDGET, maxToolRounds: 0 }, PRICE),
    TypeError,
  );
  assert.throws(
    () => new RunBudget({ ...DEFAULT_RUN_BUDGET, maxCostPicodollars: 0n }, PRICE),
    TypeError,
  );
  assert.throws(
    () => new RunBudget({ ...DEFAULT_RUN_BUDGET, maxWallMs: 0 }, PRICE),
    TypeError,
  );
});

test("picodollars render with exactly twelve fractional digits", () => {
  assert.equal(formatPicodollars(0n), "$0.000000000000");
  assert.equal(formatPicodollars(1_000_000_000_000n), "$1.000000000000");
  assert.equal(formatPicodollars(420_000_000n), "$0.000420000000");
  assert.equal(
    formatPicodollars(DEFAULT_RUN_BUDGET.maxCostPicodollars),
    "$1.000000000000",
  );
});

test("the default budget is bounded on all three axes", () => {
  assert.ok(DEFAULT_RUN_BUDGET.maxToolRounds > 0);
  assert.ok(DEFAULT_RUN_BUDGET.maxCostPicodollars > 0n);
  assert.ok(DEFAULT_RUN_BUDGET.maxWallMs > 0);
});
