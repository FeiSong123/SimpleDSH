import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { Screen } from "../../src/cli/screen.js";
import type { Terminal } from "../../src/tui/index.js";

const RIGHT = "\u001b[C";
const LEFT = "\u001b[D";
const ESCAPE = "\u001b";
const ENTER = "\r";

class FakeTerminal implements Terminal {
  written = "";
  columns = 80;
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

function slider(t: TestContext): {
  view: Screen;
  terminal: FakeTerminal;
  picked: Array<string | null>;
  sent: string[];
  drawn: () => string;
} {
  const terminal = new FakeTerminal();
  const view = new Screen({
    workspaceRoot: process.cwd(),
    commands: [{ name: "effort", description: "how hard the model thinks" }],
    terminal,
  });
  t.after(() => view.stop());
  const picked: Array<string | null> = [];
  const sent: string[] = [];
  view.attach({
    onSubmit: (text) => sent.push(text),
    onPick: (value) => picked.push(value),
    onInterrupt: () => {},
    onExit: () => {},
  });
  view.start();
  return {
    view,
    terminal,
    picked,
    sent,
    drawn: () => {
      view.renderNow();
      return terminal.written;
    },
  };
}

test("every stop is drawn, with the current one marked", (t) => {
  const { view, drawn } = slider(t);
  view.openSlider("effort", ["low", "high", "max"], "high");
  const shown = drawn();
  for (const stop of ["low", "high", "max"]) assert.match(shown, new RegExp(stop, "u"));
  assert.match(shown, /▲/u);
});

test("the arrows move it and Enter picks what is under the mark", (t) => {
  const { view, terminal, picked } = slider(t);
  view.openSlider("effort", ["low", "high", "max"], "high");
  terminal.press(RIGHT);
  terminal.press(ENTER);
  assert.deepEqual(picked, ["max"]);
});

test("it stops at both ends rather than wrapping", (t) => {
  // Wrapping from max back to low would make a slip a quiet downgrade.
  const { view, terminal, picked } = slider(t);
  view.openSlider("effort", ["low", "high", "max"], "low");
  for (let step = 0; step < 5; step += 1) terminal.press(LEFT);
  terminal.press(ENTER);
  assert.deepEqual(picked, ["low"]);

  view.openSlider("effort", ["low", "high", "max"], "max");
  for (let step = 0; step < 5; step += 1) terminal.press(RIGHT);
  terminal.press(ENTER);
  assert.deepEqual(picked, ["low", "max"]);
});

test("letting go of an arrow does not move it again", (t) => {
  // The negotiated Kitty flags report key releases as well as presses, and an
  // input listener sees them before the TUI filters them out.
  const { view, terminal, picked } = slider(t);
  view.openSlider("effort", ["low", "high", "max"], "low");
  terminal.press("\u001b[1;1C");
  terminal.press("\u001b[1;1:3C");
  terminal.press(ENTER);
  assert.deepEqual(picked, ["high"]);
});

test("escape chooses nothing", (t) => {
  const { view, terminal, picked } = slider(t);
  view.openSlider("effort", ["low", "high", "max"], "high");
  terminal.press(ESCAPE);
  assert.deepEqual(picked, [null]);
});

test("a line in progress survives the slider", (t) => {
  // The slider owns the arrows and Enter while it is up, so it must not edit
  // or submit whatever was being typed.
  const { view, terminal, sent } = slider(t);
  for (const character of "half a thought") terminal.press(character);
  view.openSlider("effort", ["low", "high", "max"], "high");
  terminal.press(RIGHT);
  terminal.press(ENTER);
  assert.equal(view.editorText, "half a thought");
  assert.deepEqual(sent, []);
});
