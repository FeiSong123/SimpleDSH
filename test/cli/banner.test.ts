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

test("the philosophy line folds at its separators, never mid-phrase", () => {
  // At 80 columns it does not fit on one row; breaking anywhere else would
  // split a phrase and read as an accident.
  const rows = banner(80, CONTEXT).filter((line) => line.includes("DeepSeek-native"));
  assert.equal(rows.length, 1, "expected one row to start the line");
  const shown = banner(80, CONTEXT)
    .map((line) => line.replace(/[│╭╮╰╯─]/gu, "").trim())
    .filter((line) => line.length > 0);
  const folded = shown.filter((line) => PHILOSOPHY.includes(line));
  assert.ok(folded.length >= 2, `expected a fold: ${folded.join(" / ")}`);
  assert.equal(folded.join(" · "), PHILOSOPHY);
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
