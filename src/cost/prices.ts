import { readFile } from "node:fs/promises";

import { parse } from "smol-toml";

import { DEEPSEEK_MODEL } from "../bytes/request.js";
import type { CanonicalTimestamp } from "../journal/types.js";

const PRICE_BOOK_URL = new URL("./flash-prices-v1.toml", import.meta.url);
const TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const PRICE_ID = /^[a-z0-9][a-z0-9._@-]{0,127}$/u;
const INTEGER_ASSIGNMENT =
  /^\s*(version|multiplier|cache_hit_picodollars_per_token|cache_miss_picodollars_per_token|output_picodollars_per_token)\s*=\s*([^#]*?)(?:\s+#.*)?\s*$/u;
const DECIMAL_INTEGER = /^(?:0|[1-9][0-9]*)$/u;

export interface FlashRegularPriceV1 {
  readonly id: string;
  readonly observedFrom: CanonicalTimestamp;
  readonly verifiedAt: string;
  readonly cacheHitPicodollarsPerToken: bigint;
  readonly cacheMissPicodollarsPerToken: bigint;
  readonly outputPicodollarsPerToken: bigint;
}

export interface FlashPriceBookV1 {
  readonly version: 1;
  readonly requestModel: typeof DEEPSEEK_MODEL;
  readonly currency: "USD";
  readonly peak: Readonly<{
    readonly enabled: false;
    readonly multiplier: 2;
    readonly windows: readonly ["09:00-12:00", "14:00-18:00"];
    readonly tz: "Asia/Shanghai";
  }>;
  readonly regular: readonly FlashRegularPriceV1[];
}

function invalidPriceBook(): never {
  throw new TypeError("invalid Flash price book v1");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidPriceBook();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidPriceBook();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) invalidPriceBook();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of ownKeys as string[]) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      invalidPriceBook();
    }
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    invalidPriceBook();
  }
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) invalidPriceBook();
  return value;
}

function positiveInteger(value: unknown): bigint {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    invalidPriceBook();
  }
  return BigInt(value as number);
}

function assertIntegerLexemes(text: string): number {
  const counts = new Map<string, number>();
  for (const line of text.split(/\r?\n/u)) {
    const match = INTEGER_ASSIGNMENT.exec(line);
    if (match === null) continue;
    const field = match[1];
    const token = match[2]?.trim();
    if (field === undefined || token === undefined || !DECIMAL_INTEGER.test(token)) {
      invalidPriceBook();
    }
    counts.set(field, (counts.get(field) ?? 0) + 1);
  }
  if (counts.get("version") !== 1 || counts.get("multiplier") !== 1) {
    invalidPriceBook();
  }
  const hit = counts.get("cache_hit_picodollars_per_token") ?? 0;
  if (
    hit < 1 ||
    counts.get("cache_miss_picodollars_per_token") !== hit ||
    counts.get("output_picodollars_per_token") !== hit
  ) {
    invalidPriceBook();
  }
  return hit;
}

function canonicalTimestamp(value: unknown): CanonicalTimestamp {
  const parsed = stringValue(value);
  if (!TIMESTAMP.test(parsed)) invalidPriceBook();
  try {
    if (new Date(parsed).toISOString() !== parsed) invalidPriceBook();
  } catch {
    invalidPriceBook();
  }
  return parsed as CanonicalTimestamp;
}

function canonicalDate(value: unknown): string {
  const parsed = stringValue(value);
  if (!DATE.test(parsed)) invalidPriceBook();
  try {
    if (new Date(`${parsed}T00:00:00.000Z`).toISOString().slice(0, 10) !== parsed) {
      invalidPriceBook();
    }
  } catch {
    invalidPriceBook();
  }
  return parsed;
}

function parsePeak(value: unknown): FlashPriceBookV1["peak"] {
  const parsed = record(value);
  exactKeys(parsed, ["enabled", "multiplier", "windows", "tz"]);
  if (
    parsed["enabled"] !== false ||
    parsed["multiplier"] !== 2 ||
    parsed["tz"] !== "Asia/Shanghai" ||
    !Array.isArray(parsed["windows"]) ||
    parsed["windows"].length !== 2 ||
    parsed["windows"][0] !== "09:00-12:00" ||
    parsed["windows"][1] !== "14:00-18:00"
  ) {
    invalidPriceBook();
  }
  return Object.freeze({
    enabled: false,
    multiplier: 2,
    windows: Object.freeze(["09:00-12:00", "14:00-18:00"] as const),
    tz: "Asia/Shanghai",
  });
}

function parseRegular(value: unknown): readonly FlashRegularPriceV1[] {
  if (!Array.isArray(value) || value.length === 0) invalidPriceBook();
  const entries: FlashRegularPriceV1[] = [];
  const ids = new Set<string>();
  let previousObservedFrom: CanonicalTimestamp | undefined;

  for (const item of value) {
    const parsed = record(item);
    exactKeys(parsed, [
      "id",
      "observed_from",
      "verified_at",
      "cache_hit_picodollars_per_token",
      "cache_miss_picodollars_per_token",
      "output_picodollars_per_token",
    ]);
    const id = stringValue(parsed["id"]);
    if (!PRICE_ID.test(id) || ids.has(id)) invalidPriceBook();
    const observedFrom = canonicalTimestamp(parsed["observed_from"]);
    const verifiedAt = canonicalDate(parsed["verified_at"]);
    if (
      (previousObservedFrom !== undefined && observedFrom <= previousObservedFrom) ||
      verifiedAt < observedFrom.slice(0, 10)
    ) {
      invalidPriceBook();
    }
    ids.add(id);
    previousObservedFrom = observedFrom;
    entries.push(Object.freeze({
      id,
      observedFrom,
      verifiedAt,
      cacheHitPicodollarsPerToken: positiveInteger(
        parsed["cache_hit_picodollars_per_token"],
      ),
      cacheMissPicodollarsPerToken: positiveInteger(
        parsed["cache_miss_picodollars_per_token"],
      ),
      outputPicodollarsPerToken: positiveInteger(
        parsed["output_picodollars_per_token"],
      ),
    }));
  }

  return Object.freeze(entries);
}

export function parseFlashPriceBookV1(text: string): FlashPriceBookV1 {
  if (typeof text !== "string") invalidPriceBook();
  const regularEntryCount = assertIntegerLexemes(text);
  let value: unknown;
  try {
    value = parse(text);
  } catch {
    invalidPriceBook();
  }
  const parsed = record(value);
  exactKeys(parsed, ["version", "request_model", "currency", "peak", "regular"]);
  if (
    parsed["version"] !== 1 ||
    parsed["request_model"] !== DEEPSEEK_MODEL ||
    parsed["currency"] !== "USD"
  ) {
    invalidPriceBook();
  }
  const regular = parseRegular(parsed["regular"]);
  if (regular.length !== regularEntryCount) invalidPriceBook();
  return Object.freeze({
    version: 1,
    requestModel: DEEPSEEK_MODEL,
    currency: "USD",
    peak: parsePeak(parsed["peak"]),
    regular,
  });
}

export async function loadPackagedFlashPriceBookV1(): Promise<FlashPriceBookV1> {
  let text: string;
  try {
    text = await readFile(PRICE_BOOK_URL, "utf8");
  } catch {
    invalidPriceBook();
  }
  return parseFlashPriceBookV1(text);
}

export function selectFlashRegularPriceV1(
  priceBook: FlashPriceBookV1,
  attemptAt: CanonicalTimestamp,
): FlashRegularPriceV1 | null {
  let selected: FlashRegularPriceV1 | null = null;
  for (const entry of priceBook.regular) {
    if (entry.observedFrom > attemptAt) break;
    selected = entry;
  }
  return selected;
}
