import type { FlashRegularPriceV1 } from "../cost/index.js";
import type { DeepSeekUsage } from "../ds/types.js";
import type { SessionAcceptanceBudget } from "./kernel.js";

/**
 * Bounds one user turn.
 *
 * The tool loop otherwise runs until the model stops asking for tools, which
 * over a long session is an unbounded spend. These limits stop a turn at a
 * Commit Boundary and say why; they never rewrite durable facts, and the next
 * turn continues normally from the same Lineage.
 */
export interface RunBudgetLimits {
  /** Model requests in one turn. A turn needing more is almost always stuck. */
  readonly maxToolRounds: number;
  /** Worst-case spend for the turn, in integer picodollars. */
  readonly maxCostPicodollars: bigint;
  readonly maxWallMs: number;
}

export const DEFAULT_RUN_BUDGET: RunBudgetLimits = Object.freeze({
  maxToolRounds: 50,
  maxCostPicodollars: 1_000_000_000_000n, // $1.00
  maxWallMs: 30 * 60 * 1000,
});

export type RunBudgetStop =
  | "tool_rounds"
  | "cost"
  | "wall_clock";

export class RunBudgetExceeded extends Error {
  constructor(
    readonly stop: RunBudgetStop,
    readonly detail: string,
  ) {
    super(`run budget stopped the turn: ${stop} (${detail})`);
    this.name = "RunBudgetExceeded";
  }
}

export interface RunBudgetUsage {
  readonly toolRounds: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costPicodollars: bigint;
  readonly elapsedMs: number;
}

export interface MonotonicClock {
  nowMs(): number;
}

const systemClock: MonotonicClock = Object.freeze({
  nowMs: () => performance.now(),
});

/**
 * Implements the kernel's budget hooks with product defaults.
 *
 * Every check runs before the kernel does the thing it guards — before a send,
 * before an effect — so crossing a limit stops the turn instead of paying for
 * it first. Cost is accumulated from provider usage at the packaged price, in
 * integer picodollars, never floats.
 */
export class RunBudget implements SessionAcceptanceBudget {
  readonly #limits: RunBudgetLimits;
  readonly #price: FlashRegularPriceV1;
  readonly #clock: MonotonicClock;
  readonly #controller = new AbortController();
  readonly #startedMs: number;
  #toolRounds = 0;
  #promptTokens = 0;
  #completionTokens = 0;
  #costPicodollars = 0n;
  #stopped: RunBudgetExceeded | null = null;

  constructor(
    limits: RunBudgetLimits,
    price: FlashRegularPriceV1,
    clock: MonotonicClock = systemClock,
  ) {
    if (
      !Number.isSafeInteger(limits.maxToolRounds) ||
      limits.maxToolRounds <= 0 ||
      !Number.isFinite(limits.maxWallMs) ||
      limits.maxWallMs <= 0 ||
      limits.maxCostPicodollars <= 0n
    ) {
      throw new TypeError("run budget limits must be positive");
    }
    this.#limits = limits;
    this.#price = price;
    this.#clock = clock;
    this.#startedMs = clock.nowMs();
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get stopped(): RunBudgetExceeded | null {
    return this.#stopped;
  }

  get usage(): RunBudgetUsage {
    return Object.freeze({
      toolRounds: this.#toolRounds,
      promptTokens: this.#promptTokens,
      completionTokens: this.#completionTokens,
      costPicodollars: this.#costPicodollars,
      elapsedMs: this.#clock.nowMs() - this.#startedMs,
    });
  }

  #stop(stop: RunBudgetStop, detail: string): never {
    const error = new RunBudgetExceeded(stop, detail);
    this.#stopped ??= error;
    this.#controller.abort(error);
    throw error;
  }

  #checkWall(): void {
    const elapsed = this.#clock.nowMs() - this.#startedMs;
    if (elapsed >= this.#limits.maxWallMs) {
      this.#stop(
        "wall_clock",
        `${(elapsed / 1000).toFixed(1)}s of ${(this.#limits.maxWallMs / 1000).toFixed(0)}s`,
      );
    }
  }

  #checkCost(): void {
    if (this.#costPicodollars >= this.#limits.maxCostPicodollars) {
      this.#stop(
        "cost",
        `${formatPicodollars(this.#costPicodollars)} of ${formatPicodollars(this.#limits.maxCostPicodollars)}`,
      );
    }
  }

  beforeSemanticRequest(): number {
    this.#checkWall();
    this.#checkCost();
    if (this.#toolRounds >= this.#limits.maxToolRounds) {
      this.#stop(
        "tool_rounds",
        `${String(this.#toolRounds)} of ${String(this.#limits.maxToolRounds)}`,
      );
    }
    this.#toolRounds += 1;
    return this.#toolRounds;
  }

  beforePhysicalAttempt(_semanticRequestOrdinal: number): void {
    this.#checkWall();
  }

  recordPreSemanticFailure(_semanticRequestOrdinal: number): void {
    // A retried attempt costs wall clock but no tokens.
    this.#checkWall();
  }

  recordSemanticResponse(
    _semanticRequestOrdinal: number,
    usage: DeepSeekUsage,
  ): void {
    this.#promptTokens += usage.promptTokens;
    this.#completionTokens += usage.completionTokens;
    this.#costPicodollars +=
      BigInt(usage.promptCacheHitTokens) * this.#price.cacheHitPicodollarsPerToken +
      BigInt(usage.promptCacheMissTokens) * this.#price.cacheMissPicodollarsPerToken +
      BigInt(usage.completionTokens) * this.#price.outputPicodollarsPerToken;
  }

  beforeEffect(): void {
    this.#checkWall();
    this.#checkCost();
  }
}

export function formatPicodollars(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / 1_000_000_000_000n;
  const fraction = (magnitude % 1_000_000_000_000n).toString().padStart(12, "0");
  return `${negative ? "-" : ""}$${whole}.${fraction}`;
}
