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
  for (const line of lines) {
    assert.equal(visibleWidth(line), 100, `wrong width: ${line}`);
  }
});

test("it says what this is and what the run is pointed at", () => {
  const shown = banner(100, CONTEXT).join("\n");
  assert.ok(shown.includes(TAGLINE));
  for (const line of PHILOSOPHY) assert.ok(shown.includes(line));
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
  for (const line of lines) {
    assert.equal(visibleWidth(line), 46, `wrong width: ${line}`);
  }
});

test("below the box the block is plain lines, not a broken frame", () => {
  const lines = banner(30, CONTEXT);
  assert.ok(!lines.some((line) => line.includes("│")), lines.join("\n"));
  assert.match(lines.join("\n"), /deepseek-v4-flash/u);
});
