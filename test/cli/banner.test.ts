import assert from "node:assert/strict";
import test from "node:test";

import { PHILOSOPHY, TAGLINE, banner } from "../../src/cli/banner.js";
import { visibleWidth } from "../../src/tui/index.js";

const CONTEXT = {
  model: "deepseek-v4-flash",
  effort: "max",
  directory: "~/Downloads/projects/SimpleDSH",
} as const;

test("the opening block is a closed box of one width", () => {
  const lines = banner(100, CONTEXT);
  const first = lines[0] ?? "";
  const last = lines[lines.length - 1] ?? "";
  assert.match(first, /^╭─+╮$/u);
  assert.match(last, /^╰─+╯$/u);
  const width = visibleWidth(first);
  for (const line of lines) {
    assert.equal(visibleWidth(line), width, `wrong width: ${line}`);
  }
});

test("the claims sit two to a row with their separators in one column", () => {
  const claims = PHILOSOPHY.split(" · ");
  const lines = banner(80, CONTEXT);
  const rows = lines.filter((line) =>
    claims.some((claim) => line.includes(claim)),
  );
  assert.equal(rows.length, 2, `expected two rows: ${rows.join(" / ")}`);
  for (const claim of claims) {
    assert.ok(
      rows.some((row) => row.includes(claim)),
      `${claim} is missing`,
    );
  }
  // The left cell is padded out so the second row's separator lands under the
  // first one. A ragged pair reads as a line that happened to wrap.
  const columns = rows.map((row) => row.indexOf("·"));
  assert.equal(columns[0], columns[1], `separators at ${columns.join(" and ")}`);
});

test("the box is as wide as what it holds, not as wide as the terminal", () => {
  // A frame drawn to column 200 is mostly empty space with a line around it.
  const wide = banner(200, CONTEXT);
  const width = visibleWidth(wide[0] ?? "");
  assert.ok(width < 70, `${String(width)} columns for a 50-column wordmark`);
  assert.deepEqual(banner(100, CONTEXT), wide, "the width should not chase the terminal");
});

test("it says what this is and what the run is pointed at", () => {
  const shown = banner(100, CONTEXT).join("\n");
  assert.ok(shown.includes(TAGLINE));
  for (const part of PHILOSOPHY.split(" · ")) assert.ok(shown.includes(part), part);
  assert.match(shown, /model\s+deepseek-v4-flash · effort max/u);
  assert.match(shown, /directory\s+~\/Downloads\/projects\/SimpleDSH/u);
});

test("a terminal too narrow for the art still gets the facts", () => {
  // The art is 50 columns wide before any inset; below that it is dropped
  // rather than wrapped into unreadable pieces.
  const lines = banner(46, CONTEXT);
  const shown = lines.join("\n");
  assert.ok(!shown.includes("|____/"), "the art should have been dropped");
  assert.match(shown, /SimpleDSH/u);
  assert.match(shown, /deepseek-v4-flash/u);
  const width = visibleWidth(lines[0] ?? "");
  assert.ok(width <= 46, `${String(width)} columns in a 46-column terminal`);
  for (const line of lines) {
    assert.equal(visibleWidth(line), width, `wrong width: ${line}`);
  }
});

test("below the box the block is plain lines, not a broken frame", () => {
  const lines = banner(30, CONTEXT);
  assert.ok(!lines.some((line) => line.includes("│")), lines.join("\n"));
  assert.match(lines.join("\n"), /deepseek-v4-flash/u);
});
