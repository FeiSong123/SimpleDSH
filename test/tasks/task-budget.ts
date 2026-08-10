export interface EvaluatorTaskBudgetSpec {
  readonly taskId: string;
  readonly maxSemanticRequests: number;
  readonly maxPhysicalAttempts: number;
  readonly maxTaskWidePreSemanticRetries: number;
  readonly baseWallMilliseconds: number;
  readonly retryExtensionMilliseconds: number;
  readonly totalWallMilliseconds: number;
  readonly promptTokenCap: number;
  readonly completionTokenCap: number;
  readonly maxPromptTokensPerResponse: number;
  readonly maxCompletionTokensPerResponse: number;
  readonly cacheMissPicodollarsPerToken: bigint;
  readonly outputPicodollarsPerToken: bigint;
  readonly costCapPicodollars: bigint;
  readonly maxCostOvershootPicodollars: bigint;
}

export interface EvaluatorUsage {
  readonly promptTokens: number;
  readonly promptCacheHitTokens: number;
  readonly promptCacheMissTokens: number;
  readonly completionTokens: number;
}

export type EvaluatorBudgetPhase =
  | "snapshot"
  | "send"
  | "attempt"
  | "usage"
  | "effect"
  | "finalize"
  | "deadline";

export type EvaluatorNonPassReason =
  | "semantic_request_cap"
  | "physical_attempt_cap"
  | "physical_retry_cap"
  | "wall_clock_cap"
  | "single_response_usage_bound"
  | "prompt_token_cap"
  | "completion_token_cap"
  | "cost_cap"
  | "task_process_failed"
  | "workspace_scope_violation"
  | "verifier_failed"
  | "tier0_invariant_failed";

export type EvaluatorTaskOutcome =
  | Readonly<{ readonly status: "pending" }>
  | Readonly<{ readonly status: "pass" }>
  | Readonly<{
      readonly status: "non_pass";
      readonly reason: EvaluatorNonPassReason;
      readonly phase: EvaluatorBudgetPhase;
      readonly detail: string;
    }>;

export interface EvaluatorTaskBudgetReport {
  readonly taskId: string;
  readonly outcome: EvaluatorTaskOutcome;
  readonly semanticRequests: number;
  readonly physicalAttempts: number;
  readonly preSemanticRetries: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costPicodollars: string;
  readonly overshoot: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly costPicodollars: string;
    readonly withinOneFrozenResponse: boolean;
  };
  readonly wall: {
    readonly elapsedMilliseconds: number;
    readonly deadlineMilliseconds: number;
  };
}

export interface MonotonicTimerDriver {
  readonly nowMilliseconds: () => number;
  readonly setTimer: (callback: () => void, delayMilliseconds: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

interface ActiveSemanticRequest {
  readonly ordinal: number;
  physicalAttempts: number;
  retryReady: boolean;
}

const PICODOLLARS_PER_USD = 1_000_000_000_000n;

function invalidContract(detail: string): never {
  throw new TypeError(`Invalid task budget contract: ${detail}`);
}

function nonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) invalidContract(field);
  return value;
}

export function formatPicodollarsAsUsd(picodollars: bigint): string {
  if (picodollars < 0n) invalidContract("negative picodollars");
  return `${picodollars / PICODOLLARS_PER_USD}.${(picodollars % PICODOLLARS_PER_USD)
    .toString()
    .padStart(12, "0")}`;
}

function defaultTimerDriver(): MonotonicTimerDriver {
  return Object.freeze({
    nowMilliseconds: () => performance.now(),
    setTimer: (callback: () => void, delayMilliseconds: number) => {
      const handle = setTimeout(callback, delayMilliseconds);
      handle.unref();
      return handle;
    },
    clearTimer: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
  });
}

export class EvaluatorTaskBudgetExceeded extends Error {
  constructor(readonly outcome: Extract<EvaluatorTaskOutcome, { readonly status: "non_pass" }>) {
    super(`Acceptance task is non-PASS: ${outcome.reason}`);
    this.name = "EvaluatorTaskBudgetExceeded";
  }
}

export class EvaluatorTaskBudgetStateError extends Error {
  constructor(detail: string) {
    super(`Invalid evaluator budget state: ${detail}`);
    this.name = "EvaluatorTaskBudgetStateError";
  }
}

export class EvaluatorTaskBudget {
  readonly signal: AbortSignal;
  readonly #controller = new AbortController();
  readonly #startedAt: number;
  readonly #deadlineAt: number;
  readonly #timerHandle: unknown;
  #outcome: EvaluatorTaskOutcome = Object.freeze({ status: "pending" });
  #semanticRequests = 0;
  #physicalAttempts = 0;
  #preSemanticRetries = 0;
  #promptTokens = 0;
  #completionTokens = 0;
  #costPicodollars = 0n;
  #active: ActiveSemanticRequest | null = null;

  constructor(
    readonly spec: EvaluatorTaskBudgetSpec,
    readonly timer: MonotonicTimerDriver = defaultTimerDriver(),
  ) {
    this.signal = this.#controller.signal;
    this.#startedAt = timer.nowMilliseconds();
    if (!Number.isFinite(this.#startedAt)) invalidContract(`${spec.taskId}: monotonic start`);
    this.#deadlineAt = this.#startedAt + spec.totalWallMilliseconds;
    this.#timerHandle = timer.setTimer(() => {
      this.#markNonPass(
        "wall_clock_cap",
        "deadline",
        `monotonic deadline ${spec.totalWallMilliseconds}ms reached`,
      );
    }, spec.totalWallMilliseconds);
  }

  beforeSemanticRequest(): number {
    this.#assertContinuation("snapshot");
    if (this.#active !== null) throw new EvaluatorTaskBudgetStateError("previous semantic request is unfinished");
    if (this.#semanticRequests >= this.spec.maxSemanticRequests) {
      this.#reject("semantic_request_cap", "snapshot", "semantic request cap reached before Snapshot/send");
    }
    this.#semanticRequests += 1;
    this.#active = {
      ordinal: this.#semanticRequests,
      physicalAttempts: 0,
      retryReady: false,
    };
    return this.#semanticRequests;
  }

  beforePhysicalAttempt(semanticRequestOrdinal: number): number {
    this.#assertContinuation("send");
    const active = this.#active;
    if (active === null || active.ordinal !== semanticRequestOrdinal) {
      throw new EvaluatorTaskBudgetStateError("physical attempt does not belong to the active semantic request");
    }
    if (this.#physicalAttempts >= this.spec.maxPhysicalAttempts) {
      this.#reject("physical_attempt_cap", "attempt", "physical attempt cap reached before provider send");
    }
    if (active.physicalAttempts > 0) {
      if (!active.retryReady || this.#preSemanticRetries >= this.spec.maxTaskWidePreSemanticRetries) {
        this.#reject("physical_retry_cap", "attempt", "sole task-wide pre-semantic retry is unavailable");
      }
      this.#preSemanticRetries += 1;
      active.retryReady = false;
    }
    active.physicalAttempts += 1;
    this.#physicalAttempts += 1;
    return this.#physicalAttempts;
  }

  recordPreSemanticFailure(semanticRequestOrdinal: number): void {
    this.#assertPendingAndWall("attempt");
    const active = this.#active;
    if (
      active === null
      || active.ordinal !== semanticRequestOrdinal
      || active.physicalAttempts === 0
      || active.retryReady
    ) {
      throw new EvaluatorTaskBudgetStateError("pre-semantic failure does not follow an active physical attempt");
    }
    active.retryReady = true;
  }

  recordSemanticResponse(semanticRequestOrdinal: number, usage: EvaluatorUsage): EvaluatorTaskBudgetReport {
    if (this.#outcome.status === "pass") {
      throw new EvaluatorTaskBudgetStateError("task is already finalized");
    }
    if (
      this.#outcome.status === "pending"
      && this.timer.nowMilliseconds() >= this.#deadlineAt
    ) {
      this.#markNonPass(
        "wall_clock_cap",
        "deadline",
        `monotonic deadline ${this.spec.totalWallMilliseconds}ms reached`,
      );
    }
    const active = this.#active;
    if (
      active === null
      || active.ordinal !== semanticRequestOrdinal
      || active.physicalAttempts === 0
      || active.retryReady
    ) {
      throw new EvaluatorTaskBudgetStateError("usage does not close an active provider attempt");
    }
    const prompt = nonNegativeSafeInteger(usage.promptTokens, "usage.promptTokens");
    const hit = nonNegativeSafeInteger(usage.promptCacheHitTokens, "usage.promptCacheHitTokens");
    const miss = nonNegativeSafeInteger(usage.promptCacheMissTokens, "usage.promptCacheMissTokens");
    const completion = nonNegativeSafeInteger(usage.completionTokens, "usage.completionTokens");
    if (prompt !== hit + miss) invalidContract("usage prompt XOR/accounting invariant");

    this.#promptTokens += prompt;
    this.#completionTokens += completion;
    this.#costPicodollars +=
      BigInt(prompt) * this.spec.cacheMissPicodollarsPerToken
      + BigInt(completion) * this.spec.outputPicodollarsPerToken;
    this.#active = null;

    if (
      this.#outcome.status === "pending" &&
      (
        prompt > this.spec.maxPromptTokensPerResponse ||
        completion > this.spec.maxCompletionTokensPerResponse
      )
    ) {
      this.#markNonPass(
        "single_response_usage_bound",
        "usage",
        "provider usage exceeded the frozen one-response overshoot bound",
      );
    } else if (
      this.#outcome.status === "pending" &&
      this.#promptTokens > this.spec.promptTokenCap
    ) {
      this.#markNonPass("prompt_token_cap", "usage", "observed prompt token cap crossing");
    } else if (
      this.#outcome.status === "pending" &&
      this.#completionTokens > this.spec.completionTokenCap
    ) {
      this.#markNonPass("completion_token_cap", "usage", "observed completion token cap crossing");
    } else if (
      this.#outcome.status === "pending" &&
      this.#costPicodollars > this.spec.costCapPicodollars
    ) {
      this.#markNonPass("cost_cap", "usage", "observed conservative cost cap crossing");
    }
    return this.report();
  }

  beforeEffect(): void {
    this.#assertContinuation("effect");
  }

  finishPass(): EvaluatorTaskBudgetReport {
    this.#assertPendingAndWall("finalize");
    if (this.#active !== null) throw new EvaluatorTaskBudgetStateError("cannot PASS with an unfinished request");
    this.#outcome = Object.freeze({ status: "pass" });
    this.timer.clearTimer(this.#timerHandle);
    return this.report();
  }

  finishNonPass(
    reason: Extract<
      EvaluatorNonPassReason,
      "task_process_failed" | "workspace_scope_violation" | "verifier_failed" | "tier0_invariant_failed"
    >,
    detail: string,
  ): EvaluatorTaskBudgetReport {
    this.#markNonPass(reason, "finalize", detail);
    return this.report();
  }

  report(): EvaluatorTaskBudgetReport {
    const now = this.timer.nowMilliseconds();
    const promptOvershoot = Math.max(0, this.#promptTokens - this.spec.promptTokenCap);
    const completionOvershoot = Math.max(0, this.#completionTokens - this.spec.completionTokenCap);
    const costOvershoot = this.#costPicodollars > this.spec.costCapPicodollars
      ? this.#costPicodollars - this.spec.costCapPicodollars
      : 0n;
    return Object.freeze({
      taskId: this.spec.taskId,
      outcome: this.#outcome,
      semanticRequests: this.#semanticRequests,
      physicalAttempts: this.#physicalAttempts,
      preSemanticRetries: this.#preSemanticRetries,
      promptTokens: this.#promptTokens,
      completionTokens: this.#completionTokens,
      costPicodollars: this.#costPicodollars.toString(),
      overshoot: Object.freeze({
        promptTokens: promptOvershoot,
        completionTokens: completionOvershoot,
        costPicodollars: costOvershoot.toString(),
        withinOneFrozenResponse:
          promptOvershoot <= this.spec.maxPromptTokensPerResponse
          && completionOvershoot <= this.spec.maxCompletionTokensPerResponse
          && costOvershoot <= this.spec.maxCostOvershootPicodollars,
      }),
      wall: Object.freeze({
        elapsedMilliseconds: Math.max(0, now - this.#startedAt),
        deadlineMilliseconds: this.spec.totalWallMilliseconds,
      }),
    });
  }

  #assertContinuation(phase: "snapshot" | "send" | "effect"): void {
    this.#assertPendingAndWall(phase);
    if (this.#promptTokens >= this.spec.promptTokenCap) {
      this.#reject("prompt_token_cap", phase, "prompt token ceiling reached before later Snapshot/send/effect");
    }
    if (this.#completionTokens >= this.spec.completionTokenCap) {
      this.#reject(
        "completion_token_cap",
        phase,
        "completion token ceiling reached before later Snapshot/send/effect",
      );
    }
    if (this.#costPicodollars >= this.spec.costCapPicodollars) {
      this.#reject("cost_cap", phase, "cost ceiling reached before later Snapshot/send/effect");
    }
  }

  #assertPendingAndWall(phase: EvaluatorBudgetPhase): void {
    if (this.#outcome.status === "non_pass") throw new EvaluatorTaskBudgetExceeded(this.#outcome);
    if (this.#outcome.status === "pass") throw new EvaluatorTaskBudgetStateError("task is already finalized");
    if (this.timer.nowMilliseconds() >= this.#deadlineAt) {
      this.#reject("wall_clock_cap", phase, "monotonic wall deadline reached");
    }
  }

  #reject(reason: EvaluatorNonPassReason, phase: EvaluatorBudgetPhase, detail: string): never {
    this.#markNonPass(reason, phase, detail);
    if (this.#outcome.status !== "non_pass") throw new EvaluatorTaskBudgetStateError("non-PASS transition failed");
    throw new EvaluatorTaskBudgetExceeded(this.#outcome);
  }

  #markNonPass(reason: EvaluatorNonPassReason, phase: EvaluatorBudgetPhase, detail: string): void {
    if (this.#outcome.status !== "pending") return;
    this.#outcome = Object.freeze({ status: "non_pass", reason, phase, detail });
    this.timer.clearTimer(this.#timerHandle);
    this.#controller.abort(reason);
  }
}
