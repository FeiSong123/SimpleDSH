import { utf8Bytes } from "../bytes/ops.js";
import { DEEPSEEK_MODEL } from "../bytes/request.js";
import type { FrozenBytes } from "../bytes/types.js";
import type {
  AnyVerifiedJournalEvent,
  AttemptId,
  CanonicalTimestamp,
  EffectId,
  EventId,
  LineageId,
  RequestSnapshotId,
  RunId,
  SessionId,
  Sha256,
} from "../journal/types.js";
import {
  selectFlashRegularPriceV1,
  type FlashPriceBookV1,
  type FlashRegularPriceV1,
} from "./prices.js";

const PICODOLLARS_PER_DOLLAR = 1_000_000_000_000n;
const BASIS_POINTS = 10_000n;

const REQUEST_OUTCOMES = Object.freeze([
  "http_error",
  "transport_error",
  "timeout",
  "cancelled",
  "protocol_error",
  "durability_error",
] as const);
const SEMANTIC_STATES = Object.freeze([
  "pre_semantic",
  "post_semantic",
  "semantic_state_unknown",
] as const);
const RUN_INTERRUPTION_REASONS = Object.freeze([
  "request_failed",
  "semantic_interrupted",
  "effect_indeterminate",
  "integrity_violation",
  "cancelled",
  "durability_failure",
] as const);

type RequestOutcome = (typeof REQUEST_OUTCOMES)[number];
type SemanticState = (typeof SEMANTIC_STATES)[number];
type RunInterruptionReason = (typeof RUN_INTERRUPTION_REASONS)[number];
type EffectState =
  | "prepared"
  | "completed"
  | "indeterminate"
  | "reconciled_completed"
  | "reconciled_proven_not_executed";

interface MutableUsage {
  promptTokens: bigint;
  promptCacheHitTokens: bigint;
  promptCacheMissTokens: bigint;
  completionTokens: bigint;
  reasoningTokens: bigint;
}

interface MutableCost {
  cacheHitPicodollars: bigint;
  cacheMissPicodollars: bigint;
  outputPicodollars: bigint;
}

interface AttemptState {
  readonly attemptId: AttemptId;
  readonly requestSnapshotId: RequestSnapshotId;
  readonly lineageId: LineageId;
  readonly runId: RunId;
  readonly at: CanonicalTimestamp;
  terminal: "assistant" | "interrupted" | null;
}

interface MutableLineage {
  readonly lineageId: LineageId;
  attemptCount: bigint;
  successfulRequestCount: bigint;
  pricedRequestCount: bigint;
  interruptedAttemptCount: bigint;
  openAttemptCount: bigint;
  costComplete: boolean;
  lastProviderObservedPromptTokens: bigint | null;
  readonly usage: MutableUsage;
  readonly knownCost: MutableCost;
}

export interface DecimalUsageV1 {
  readonly promptTokens: string;
  readonly promptCacheHitTokens: string;
  readonly promptCacheMissTokens: string;
  readonly completionTokens: string;
  readonly reasoningTokens: string;
}

export interface ExactRatioV1 {
  readonly numerator: string;
  readonly denominator: string;
  readonly basisPoints: string | null;
}

export interface MoneyV1 {
  readonly picodollars: string;
  readonly usd: string;
}

export interface CostSplitV1 {
  readonly cacheHit: MoneyV1;
  readonly cacheMiss: MoneyV1;
  readonly output: MoneyV1;
  readonly total: MoneyV1;
}

export interface RequestCostV1 {
  readonly eventId: EventId;
  readonly seq: number;
  readonly at: CanonicalTimestamp;
  readonly lineageId: LineageId;
  readonly runId: RunId;
  readonly attemptId: AttemptId;
  readonly requestSnapshotId: RequestSnapshotId;
  readonly requestModel: typeof DEEPSEEK_MODEL;
  readonly responseModel: string;
  readonly usage: DecimalUsageV1 & Readonly<{ readonly rawFinishReason: string }>;
  readonly cacheHitRatio: ExactRatioV1;
  readonly reasoningShare: ExactRatioV1;
  readonly pricingStatus: "priced" | "unpriced";
  readonly priceVersionId: string | null;
  readonly unpricedReason: "attempt_predates_price_book" | null;
  readonly cost: CostSplitV1 | null;
}

export interface LineageCostV1 {
  readonly lineageId: LineageId;
  readonly requestModel: typeof DEEPSEEK_MODEL;
  readonly attemptCount: string;
  readonly successfulRequestCount: string;
  readonly pricedRequestCount: string;
  readonly interruptedAttemptCount: string;
  readonly openAttemptCount: string;
  readonly usage: DecimalUsageV1;
  readonly cacheHitRatio: ExactRatioV1;
  readonly reasoningShare: ExactRatioV1;
  readonly knownCost: CostSplitV1;
  readonly costCompleteness: "complete" | "lower_bound";
  readonly lastProviderObservedPromptTokens: string | null;
}

export interface TelemetryCountV1 {
  readonly value: string;
  readonly count: string;
}

export interface CostReportV1 {
  readonly v: 1;
  readonly sessionId: SessionId;
  readonly requestModel: typeof DEEPSEEK_MODEL;
  readonly activeLineageId: LineageId | null;
  readonly requests: readonly RequestCostV1[];
  readonly lineages: readonly LineageCostV1[];
  readonly knownSessionCost: CostSplitV1;
  readonly costCompleteness: "complete" | "lower_bound";
  readonly sessionReasoningShare: ExactRatioV1;
  readonly lastProviderObservedPromptTokens: string | null;
  readonly telemetry: Readonly<{
    readonly responseModels: readonly TelemetryCountV1[];
    readonly cacheBreaks: Readonly<{
      readonly planned: string;
      readonly unplanned: string;
    }>;
    readonly http400Count: string;
    readonly http422Count: string;
    readonly requestInterruptions: Readonly<{
      readonly total: string;
      readonly byOutcome: readonly TelemetryCountV1[];
    }>;
    readonly runInterruptions: Readonly<{
      readonly total: string;
      readonly byReason: readonly TelemetryCountV1[];
    }>;
    readonly finishReasonLengthCount: string;
    readonly effectStates: Readonly<{
      readonly prepared: string;
      readonly completed: string;
      readonly indeterminate: string;
      readonly reconciledCompleted: string;
      readonly reconciledProvenNotExecuted: string;
      readonly indeterminateObserved: string;
    }>;
    readonly unpricedAttempts: Readonly<{
      readonly open: string;
      readonly interrupted: string;
      readonly bySemanticState: readonly TelemetryCountV1[];
    }>;
  }>;
  readonly unavailableMetrics: readonly [
    "queue_wait",
    "appended_tokens",
    "current_prefix_tokens",
  ];
}

function invalidProjection(): never {
  throw new TypeError("invalid verified event projection for Session cost v1");
}

function zeroUsage(): MutableUsage {
  return {
    promptTokens: 0n,
    promptCacheHitTokens: 0n,
    promptCacheMissTokens: 0n,
    completionTokens: 0n,
    reasoningTokens: 0n,
  };
}

function zeroCost(): MutableCost {
  return {
    cacheHitPicodollars: 0n,
    cacheMissPicodollars: 0n,
    outputPicodollars: 0n,
  };
}

function addUsage(target: MutableUsage, source: MutableUsage): void {
  target.promptTokens += source.promptTokens;
  target.promptCacheHitTokens += source.promptCacheHitTokens;
  target.promptCacheMissTokens += source.promptCacheMissTokens;
  target.completionTokens += source.completionTokens;
  target.reasoningTokens += source.reasoningTokens;
}

function addCost(target: MutableCost, source: MutableCost): void {
  target.cacheHitPicodollars += source.cacheHitPicodollars;
  target.cacheMissPicodollars += source.cacheMissPicodollars;
  target.outputPicodollars += source.outputPicodollars;
}

function decimalUsage(value: MutableUsage): DecimalUsageV1 {
  return Object.freeze({
    promptTokens: value.promptTokens.toString(),
    promptCacheHitTokens: value.promptCacheHitTokens.toString(),
    promptCacheMissTokens: value.promptCacheMissTokens.toString(),
    completionTokens: value.completionTokens.toString(),
    reasoningTokens: value.reasoningTokens.toString(),
  });
}

function exactRatio(numerator: bigint, denominator: bigint): ExactRatioV1 {
  if (numerator < 0n || denominator < 0n || numerator > denominator) {
    invalidProjection();
  }
  return Object.freeze({
    numerator: numerator.toString(),
    denominator: denominator.toString(),
    basisPoints:
      denominator === 0n
        ? null
        : ((numerator * BASIS_POINTS + denominator / 2n) / denominator).toString(),
  });
}

export function formatUsdPicodollarsExact(picodollars: bigint): string {
  if (picodollars < 0n) invalidProjection();
  const dollars = picodollars / PICODOLLARS_PER_DOLLAR;
  const fraction = (picodollars % PICODOLLARS_PER_DOLLAR)
    .toString()
    .padStart(12, "0");
  return `${dollars.toString()}.${fraction}`;
}

function money(picodollars: bigint): MoneyV1 {
  return Object.freeze({
    picodollars: picodollars.toString(),
    usd: formatUsdPicodollarsExact(picodollars),
  });
}

function costSplit(value: MutableCost): CostSplitV1 {
  const total =
    value.cacheHitPicodollars +
    value.cacheMissPicodollars +
    value.outputPicodollars;
  return Object.freeze({
    cacheHit: money(value.cacheHitPicodollars),
    cacheMiss: money(value.cacheMissPicodollars),
    output: money(value.outputPicodollars),
    total: money(total),
  });
}

function usageFromEvent(
  event: Extract<AnyVerifiedJournalEvent, { readonly type: "assistant_committed" }>,
): MutableUsage {
  const usage = event.payload.usage;
  const result = {
    promptTokens: BigInt(usage.promptTokens),
    promptCacheHitTokens: BigInt(usage.promptCacheHitTokens),
    promptCacheMissTokens: BigInt(usage.promptCacheMissTokens),
    completionTokens: BigInt(usage.completionTokens),
    reasoningTokens: BigInt(usage.reasoningTokens),
  };
  if (
    result.promptTokens !==
      result.promptCacheHitTokens + result.promptCacheMissTokens ||
    result.reasoningTokens > result.completionTokens
  ) {
    invalidProjection();
  }
  return result;
}

function priceUsage(
  usage: MutableUsage,
  price: FlashRegularPriceV1,
): MutableCost {
  return {
    cacheHitPicodollars:
      usage.promptCacheHitTokens * price.cacheHitPicodollarsPerToken,
    cacheMissPicodollars:
      usage.promptCacheMissTokens * price.cacheMissPicodollarsPerToken,
    outputPicodollars:
      usage.completionTokens * price.outputPicodollarsPerToken,
  };
}

function increment<Key extends string>(map: Map<Key, bigint>, key: Key): void {
  map.set(key, (map.get(key) ?? 0n) + 1n);
}

function countEntries<Key extends string>(
  map: ReadonlyMap<Key, bigint>,
  order: readonly Key[],
): readonly TelemetryCountV1[] {
  return Object.freeze(
    order.flatMap((value) => {
      const count = map.get(value) ?? 0n;
      return count === 0n
        ? []
        : [Object.freeze({ value, count: count.toString() })];
    }),
  );
}

function lexicalEntries(
  map: ReadonlyMap<string, bigint>,
): readonly TelemetryCountV1[] {
  const keys = [...map.keys()].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return countEntries(map, keys);
}

function requireScope(
  event: AnyVerifiedJournalEvent,
): Readonly<{ readonly lineageId: LineageId; readonly runId: RunId }> {
  if (event.lineageId === undefined || event.runId === undefined) {
    invalidProjection();
  }
  return { lineageId: event.lineageId, runId: event.runId };
}

function newMutableLineage(lineageId: LineageId): MutableLineage {
  return {
    lineageId,
    attemptCount: 0n,
    successfulRequestCount: 0n,
    pricedRequestCount: 0n,
    interruptedAttemptCount: 0n,
    openAttemptCount: 0n,
    costComplete: true,
    lastProviderObservedPromptTokens: null,
    usage: zeroUsage(),
    knownCost: zeroCost(),
  };
}

function finalEffectCounts(
  effects: ReadonlyMap<EffectId, EffectState>,
  indeterminateObserved: bigint,
): CostReportV1["telemetry"]["effectStates"] {
  let prepared = 0n;
  let completed = 0n;
  let indeterminate = 0n;
  let reconciledCompleted = 0n;
  let reconciledProvenNotExecuted = 0n;
  for (const state of effects.values()) {
    switch (state) {
      case "prepared":
        prepared += 1n;
        break;
      case "completed":
        completed += 1n;
        break;
      case "indeterminate":
        indeterminate += 1n;
        break;
      case "reconciled_completed":
        reconciledCompleted += 1n;
        break;
      case "reconciled_proven_not_executed":
        reconciledProvenNotExecuted += 1n;
        break;
    }
  }
  return Object.freeze({
    prepared: prepared.toString(),
    completed: completed.toString(),
    indeterminate: indeterminate.toString(),
    reconciledCompleted: reconciledCompleted.toString(),
    reconciledProvenNotExecuted: reconciledProvenNotExecuted.toString(),
    indeterminateObserved: indeterminateObserved.toString(),
  });
}

function finalizeLineage(lineage: MutableLineage): LineageCostV1 {
  return Object.freeze({
    lineageId: lineage.lineageId,
    requestModel: DEEPSEEK_MODEL,
    attemptCount: lineage.attemptCount.toString(),
    successfulRequestCount: lineage.successfulRequestCount.toString(),
    pricedRequestCount: lineage.pricedRequestCount.toString(),
    interruptedAttemptCount: lineage.interruptedAttemptCount.toString(),
    openAttemptCount: lineage.openAttemptCount.toString(),
    usage: decimalUsage(lineage.usage),
    cacheHitRatio: exactRatio(
      lineage.usage.promptCacheHitTokens,
      lineage.usage.promptTokens,
    ),
    reasoningShare: exactRatio(
      lineage.usage.reasoningTokens,
      lineage.usage.completionTokens,
    ),
    knownCost: costSplit(lineage.knownCost),
    costCompleteness: lineage.costComplete ? "complete" : "lower_bound",
    lastProviderObservedPromptTokens:
      lineage.lastProviderObservedPromptTokens?.toString() ?? null,
  });
}

export function projectSessionCostV1(
  sessionId: SessionId,
  events: readonly AnyVerifiedJournalEvent[],
  priceBook: FlashPriceBookV1,
): CostReportV1 {
  if (
    priceBook.version !== 1 ||
    priceBook.requestModel !== DEEPSEEK_MODEL ||
    priceBook.currency !== "USD" ||
    priceBook.peak.enabled !== false
  ) {
    invalidProjection();
  }

  const attempts = new Map<AttemptId, AttemptState>();
  const lineages = new Map<LineageId, MutableLineage>();
  const effects = new Map<EffectId, EffectState>();
  const responseModels = new Map<string, bigint>();
  const requestOutcomes = new Map<RequestOutcome, bigint>();
  const semanticStates = new Map<SemanticState, bigint>();
  const runInterruptionReasons = new Map<RunInterruptionReason, bigint>();
  const requests: RequestCostV1[] = [];
  const sessionUsage = zeroUsage();
  const knownSessionCost = zeroCost();
  let activeLineageId: LineageId | null = null;
  let lastProviderObservedPromptTokens: bigint | null = null;
  let sessionCostComplete = true;
  let plannedCacheBreaks = 0n;
  let unplannedCacheBreaks = 0n;
  let http400Count = 0n;
  let http422Count = 0n;
  let requestInterruptionCount = 0n;
  let runInterruptionCount = 0n;
  let finishReasonLengthCount = 0n;
  let indeterminateObserved = 0n;
  let previousHash: Sha256 | null = null;

  for (const [index, event] of events.entries()) {
    if (
      event.sessionId !== sessionId ||
      event.seq !== index + 1 ||
      event.prevHash !== previousHash ||
      (index === 0 && event.type !== "session_started")
    ) {
      invalidProjection();
    }
    previousHash = event.hash;

    switch (event.type) {
      case "lineage_started": {
        const lineageId = event.lineageId;
        if (lineageId === undefined || lineages.has(lineageId)) invalidProjection();
        lineages.set(lineageId, newMutableLineage(lineageId));
        break;
      }
      case "lineage_activated":
        if (!lineages.has(event.payload.nextLineageId)) invalidProjection();
        activeLineageId = event.payload.nextLineageId;
        break;
      case "request_attempt_started": {
        const scope = requireScope(event);
        const lineage = lineages.get(scope.lineageId);
        if (lineage === undefined || attempts.has(event.payload.attemptId)) {
          invalidProjection();
        }
        lineage.attemptCount += 1n;
        attempts.set(event.payload.attemptId, {
          attemptId: event.payload.attemptId,
          requestSnapshotId: event.payload.requestSnapshotId,
          lineageId: scope.lineageId,
          runId: scope.runId,
          at: event.at,
          terminal: null,
        });
        break;
      }
      case "assistant_committed": {
        const scope = requireScope(event);
        const attempt = attempts.get(event.payload.attemptId);
        const lineage = lineages.get(scope.lineageId);
        if (
          attempt === undefined ||
          attempt.terminal !== null ||
          attempt.lineageId !== scope.lineageId ||
          attempt.runId !== scope.runId ||
          attempt.requestSnapshotId !== event.payload.requestSnapshotId ||
          lineage === undefined
        ) {
          invalidProjection();
        }
        attempt.terminal = "assistant";
        const usage = usageFromEvent(event);
        const price = selectFlashRegularPriceV1(priceBook, attempt.at);
        const priced = price === null ? null : priceUsage(usage, price);
        lineage.successfulRequestCount += 1n;
        lineage.lastProviderObservedPromptTokens = usage.promptTokens;
        lastProviderObservedPromptTokens = usage.promptTokens;
        addUsage(lineage.usage, usage);
        addUsage(sessionUsage, usage);
        if (priced === null) {
          lineage.costComplete = false;
          sessionCostComplete = false;
        } else {
          lineage.pricedRequestCount += 1n;
          addCost(lineage.knownCost, priced);
          addCost(knownSessionCost, priced);
        }
        increment(responseModels, event.payload.responseModel);
        if (event.payload.usage.rawFinishReason === "length") {
          finishReasonLengthCount += 1n;
        }
        requests.push(Object.freeze({
          eventId: event.id,
          seq: event.seq,
          at: event.at,
          lineageId: scope.lineageId,
          runId: scope.runId,
          attemptId: event.payload.attemptId,
          requestSnapshotId: event.payload.requestSnapshotId,
          requestModel: DEEPSEEK_MODEL,
          responseModel: event.payload.responseModel,
          usage: Object.freeze({
            ...decimalUsage(usage),
            rawFinishReason: event.payload.usage.rawFinishReason,
          }),
          cacheHitRatio: exactRatio(
            usage.promptCacheHitTokens,
            usage.promptTokens,
          ),
          reasoningShare: exactRatio(
            usage.reasoningTokens,
            usage.completionTokens,
          ),
          pricingStatus: price === null ? "unpriced" : "priced",
          priceVersionId: price?.id ?? null,
          unpricedReason: price === null ? "attempt_predates_price_book" : null,
          cost: priced === null ? null : costSplit(priced),
        }));
        break;
      }
      case "request_interrupted": {
        const scope = requireScope(event);
        const attempt = attempts.get(event.payload.attemptId);
        const lineage = lineages.get(scope.lineageId);
        if (
          attempt === undefined ||
          attempt.terminal !== null ||
          attempt.lineageId !== scope.lineageId ||
          attempt.runId !== scope.runId ||
          attempt.requestSnapshotId !== event.payload.requestSnapshotId ||
          lineage === undefined
        ) {
          invalidProjection();
        }
        attempt.terminal = "interrupted";
        lineage.interruptedAttemptCount += 1n;
        lineage.costComplete = false;
        sessionCostComplete = false;
        requestInterruptionCount += 1n;
        increment(requestOutcomes, event.payload.outcome);
        increment(semanticStates, event.payload.semanticState);
        if (event.payload.status === 400) http400Count += 1n;
        if (event.payload.status === 422) http422Count += 1n;
        break;
      }
      case "run_interrupted":
        runInterruptionCount += 1n;
        increment(runInterruptionReasons, event.payload.reason);
        break;
      case "cache_break":
        if (event.payload.classification === "planned") {
          plannedCacheBreaks += 1n;
        } else {
          unplannedCacheBreaks += 1n;
        }
        break;
      case "effect_prepared":
        if (effects.has(event.payload.effectId)) invalidProjection();
        effects.set(event.payload.effectId, "prepared");
        break;
      case "effect_completed":
        if (effects.get(event.payload.effectId) !== "prepared") invalidProjection();
        effects.set(event.payload.effectId, "completed");
        break;
      case "effect_indeterminate":
        if (effects.get(event.payload.effectId) !== "prepared") invalidProjection();
        effects.set(event.payload.effectId, "indeterminate");
        indeterminateObserved += 1n;
        break;
      case "effect_reconciled":
        if (effects.get(event.payload.effectId) !== "indeterminate") {
          invalidProjection();
        }
        effects.set(
          event.payload.effectId,
          event.payload.resolution === "completed"
            ? "reconciled_completed"
            : "reconciled_proven_not_executed",
        );
        break;
      default:
        break;
    }
  }

  let openAttemptCount = 0n;
  for (const attempt of attempts.values()) {
    if (attempt.terminal !== null) continue;
    const lineage = lineages.get(attempt.lineageId);
    if (lineage === undefined) invalidProjection();
    lineage.openAttemptCount += 1n;
    lineage.costComplete = false;
    sessionCostComplete = false;
    openAttemptCount += 1n;
  }

  const lineageRows = [...lineages.values()]
    .sort((left, right) =>
      left.lineageId < right.lineageId
        ? -1
        : left.lineageId > right.lineageId
          ? 1
          : 0,
    )
    .map(finalizeLineage);

  return Object.freeze({
    v: 1,
    sessionId,
    requestModel: DEEPSEEK_MODEL,
    activeLineageId,
    requests: Object.freeze(requests),
    lineages: Object.freeze(lineageRows),
    knownSessionCost: costSplit(knownSessionCost),
    costCompleteness: sessionCostComplete ? "complete" : "lower_bound",
    sessionReasoningShare: exactRatio(
      sessionUsage.reasoningTokens,
      sessionUsage.completionTokens,
    ),
    lastProviderObservedPromptTokens:
      lastProviderObservedPromptTokens?.toString() ?? null,
    telemetry: Object.freeze({
      responseModels: lexicalEntries(responseModels),
      cacheBreaks: Object.freeze({
        planned: plannedCacheBreaks.toString(),
        unplanned: unplannedCacheBreaks.toString(),
      }),
      http400Count: http400Count.toString(),
      http422Count: http422Count.toString(),
      requestInterruptions: Object.freeze({
        total: requestInterruptionCount.toString(),
        byOutcome: countEntries(requestOutcomes, REQUEST_OUTCOMES),
      }),
      runInterruptions: Object.freeze({
        total: runInterruptionCount.toString(),
        byReason: countEntries(runInterruptionReasons, RUN_INTERRUPTION_REASONS),
      }),
      finishReasonLengthCount: finishReasonLengthCount.toString(),
      effectStates: finalEffectCounts(effects, indeterminateObserved),
      unpricedAttempts: Object.freeze({
        open: openAttemptCount.toString(),
        interrupted: requestInterruptionCount.toString(),
        bySemanticState: countEntries(semanticStates, SEMANTIC_STATES),
      }),
    }),
    unavailableMetrics: Object.freeze([
      "queue_wait",
      "appended_tokens",
      "current_prefix_tokens",
    ] as const),
  });
}

export function encodeCostReportV1(report: CostReportV1): FrozenBytes {
  return utf8Bytes(JSON.stringify(report));
}
