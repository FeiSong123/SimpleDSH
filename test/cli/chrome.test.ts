import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { Screen } from "../../src/cli/screen.js";
import type { Terminal } from "../../src/tui/index.js";

class FakeTerminal implements Terminal {
  written = "";
  columns = 60;
  rows = 24;
  kittyProtocolActive = false;
  #input: ((data: string) => void) | null = null;

  start(onInput: (data: string) => void): void {
    this.#input = onInput;
  }
  stop(): void {
    this.#input = null;
  }
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.written += data;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  press(data: string): void {
    assert.ok(this.#input !== null, "terminal was not started");
    this.#input(data);
  }
}

const ESC = String.fromCharCode(27);
/** Rendered output as the eye sees it: no colours, no hyperlinks, no motion. */
function plain(row: string): string {
  return row
    .replace(new RegExp(`${ESC}\\][^\\u0007${ESC}]*(\\u0007|${ESC}\\\\)`, "gu"), "")
    .replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "gu"), "")
    .replace(new RegExp(`${ESC}.`, "gu"), "")
    .trimEnd();
}

function screen(t: TestContext): {
  view: Screen;
  terminal: FakeTerminal;
  drawn: () => string;
} {
  const terminal = new FakeTerminal();
  const view = new Screen({
    workspaceRoot: process.cwd(),
    commands: [],
    terminal,
  });
  t.after(() => view.stop());
  view.attach({
    onSubmit: () => {},
    onPick: () => {},
    onInterrupt: () => {},
    onExit: () => {},
  });
  view.start();
  return {
    view,
    terminal,
    drawn: () => {
      terminal.written = "";
      view.renderNow();
      return terminal.written;
    },
  };
}

test("the input sits in a closed box with a prompt marker", (t) => {
  const { drawn } = screen(t);
  const shown = drawn();
  assert.match(shown, /╭─+╮/u);
  assert.match(shown, /╰─+╯/u);
  assert.match(shown, /│ >/u);
});

test("the box holds its width when the line wraps", (t) => {
  // The bars live in padding the editor already reserved, so a wrapped line
  // must not push the right-hand bar off the edge.
  const { terminal, drawn } = screen(t);
  for (const character of "x".repeat(120)) terminal.press(character);
  const rows = drawn()
    .split("\n")
    .filter((row) => row.includes("│"));
  assert.ok(rows.length >= 2, "expected the text to wrap inside the box");
  for (const row of rows) {
    const bars = [...row].filter((character) => character === "│").length;
    assert.equal(bars, 2, `row had ${String(bars)} bars: ${row}`);
  }
});

test("the footer names the model and directory before any request", (t) => {
  // The moment you most need to know what you are about to spend on is before
  // the first turn, which is exactly when the cost ledger is still empty.
  const { view, drawn } = screen(t);
  view.setContext("deepseek-v4-flash", "effort max", "~/work");
  assert.match(drawn(), /deepseek-v4-flash · effort max · ~\/work/u);
});

test("the ledger joins the context rather than replacing it", (t) => {
  const { view, drawn } = screen(t);
  view.setContext("deepseek-v4-flash", "effort max", "~/work");
  view.setLedger("$0.0002 · cache 84% · context 12K");
  const shown = drawn();
  assert.match(shown, /deepseek-v4-flash/u);
  assert.match(shown, /\$0\.0002/u);
});

function footerRow(
  columns: number,
  t: TestContext,
): { text: string; rows: number } {
  const { view, terminal, drawn } = screen(t);
  terminal.columns = columns;
  view.setContext(
    "deepseek-v4-flash",
    "effort max",
    "~/Downloads/projects/SimpleDSH",
  );
  view.setLedger("$0.0000 · cache 83.90% · context 1K");
  const rows = drawn()
    .split("\n")
    .map(plain)
    .filter((row) => row.includes("deepseek-v4-flash"));
  return { text: rows[0] ?? "", rows: rows.length };
}

test("a wide terminal shows the model, the effort and the whole path", (t) => {
  const { text, rows } = footerRow(110, t);
  assert.equal(rows, 1, "the footer wrapped");
  assert.ok(text.length <= 110, `${String(text.length)} columns`);
  assert.match(text, /deepseek-v4-flash · effort max · ~\/Downloads\/projects\/SimpleDSH/u);
  assert.match(text, /cache 83\.90%/u);
});

test("a narrow terminal gives up the path rather than wrapping", (t) => {
  // Wrapping would cost a row of transcript on every render, and the effort is
  // the fact that changes what the next turn does.
  const { text, rows } = footerRow(78, t);
  assert.equal(rows, 1, "the footer wrapped");
  assert.ok(text.length <= 78, `${String(text.length)} columns`);
  assert.match(text, /deepseek-v4-flash · effort max/u);
  assert.doesNotMatch(text, /Downloads/u);
  assert.match(text, /cache 83\.90%/u);
});
