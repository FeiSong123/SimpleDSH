import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseFlashPriceBookV1,
  selectFlashRegularPriceV1,
} from "../../src/cost/prices.js";
import type { CanonicalTimestamp } from "../../src/journal/types.js";

const priceUrl = new URL("../../src/cost/flash-prices-v1.toml", import.meta.url);

async function canonicalText(): Promise<string> {
  return readFile(priceUrl, "utf8");
}

const FUTURE_ENTRY = `
[[regular]]
id = "deepseek-v4-flash-regular-2026-09-01"
observed_from = "2026-09-01T00:00:00.000Z"
verified_at = "2026-09-01"
cache_hit_picodollars_per_token = 3000
cache_miss_picodollars_per_token = 150000
output_picodollars_per_token = 300000
`;

test("packaged Flash price data parses to the exact integer contract", async () => {
  const book = parseFlashPriceBookV1(await canonicalText());

  assert.equal(book.version, 1);
  assert.equal(book.requestModel, "deepseek-v4-flash");
  assert.equal(book.currency, "USD");
  assert.deepEqual(book.peak, {
    enabled: false,
    multiplier: 2,
    windows: ["09:00-12:00", "14:00-18:00"],
    tz: "Asia/Shanghai",
  });
  assert.equal(book.regular.length, 1);
  assert.deepEqual(book.regular[0], {
    id: "deepseek-v4-flash-regular-2026-08-03",
    observedFrom: "2026-08-03T00:00:00.000Z",
    verifiedAt: "2026-08-05",
    cacheHitPicodollarsPerToken: 2_800n,
    cacheMissPicodollarsPerToken: 140_000n,
    outputPicodollarsPerToken: 280_000n,
  });
  assert.equal(Object.isFrozen(book), true);
  assert.equal(Object.isFrozen(book.peak), true);
  assert.equal(Object.isFrozen(book.peak.windows), true);
  assert.equal(Object.isFrozen(book.regular), true);
  assert.equal(Object.isFrozen(book.regular[0]), true);
});

test("attempt time selects the newest observed append-only price", async () => {
  const original = parseFlashPriceBookV1(await canonicalText());
  const extended = parseFlashPriceBookV1((await canonicalText()) + FUTURE_ENTRY);
  const before = "2026-08-02T23:59:59.999Z" as CanonicalTimestamp;
  const first = "2026-08-03T00:00:00.000Z" as CanonicalTimestamp;
  const historical = "2026-08-31T23:59:59.999Z" as CanonicalTimestamp;
  const future = "2026-09-01T00:00:00.000Z" as CanonicalTimestamp;

  assert.equal(selectFlashRegularPriceV1(original, before), null);
  assert.equal(selectFlashRegularPriceV1(original, first)?.id, original.regular[0]?.id);
  assert.equal(
    selectFlashRegularPriceV1(extended, historical)?.id,
    original.regular[0]?.id,
  );
  assert.equal(
    selectFlashRegularPriceV1(extended, future)?.id,
    "deepseek-v4-flash-regular-2026-09-01",
  );
});

test("Flash price parser rejects drift and non-closed data", async (context) => {
  const source = await canonicalText();
  const cases: readonly [string, string][] = [
    ["unknown field", source.replace("verified_at =", "extra = 1\nverified_at =")],
    [
      "floating price",
      source.replace(
        "cache_hit_picodollars_per_token = 2800",
        "cache_hit_picodollars_per_token = 2800.0",
      ),
    ],
    [
      "negative price",
      source.replace(
        "cache_miss_picodollars_per_token = 140000",
        "cache_miss_picodollars_per_token = -1",
      ),
    ],
    ["wrong model", source.replace("deepseek-v4-flash", "deepseek-v4-pro")],
    ["wrong currency", source.replace('currency = "USD"', 'currency = "CNY"')],
    ["enabled peak", source.replace("enabled = false", "enabled = true")],
    [
      "malformed timestamp",
      source.replace("2026-08-03T00:00:00.000Z", "2026-02-30T00:00:00.000Z"),
    ],
    ["duplicate id", source + FUTURE_ENTRY.replace("2026-09-01\"", "2026-08-03\"")],
    [
      "out-of-order entry",
      source + FUTURE_ENTRY.replaceAll("2026-09-01", "2026-08-02"),
    ],
  ];

  for (const [name, fixture] of cases) {
    await context.test(name, () => {
      assert.throws(() => parseFlashPriceBookV1(fixture), TypeError);
    });
  }
});
