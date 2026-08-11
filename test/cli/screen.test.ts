import assert from "node:assert/strict";
import test from "node:test";

import { Screen } from "../../src/cli/screen.js";
import type { Terminal } from "../../src/tui/index.js";

/**
 * A terminal that records what was drawn instead of drawing it.
 *
 * The renderer only ever talks to this interface, so the whole screen can be
 * exercised without a TTY.
 */
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

  /** Deliver a keystroke exactly as the terminal would. */
  press(data: string): void {
    assert.ok(this.#input !== null, "terminal was not started");
    this.#input(data);
  }
}

function screen(t: { after: (fn: () => void) => void }): {
  screen: Screen;
  terminal: FakeTerminal;
  drawn: () => string;
} {
  const terminal = new FakeTerminal();
  const instance = new Screen({
    workspaceRoot: process.cwd(),
    commands: [{ name: "help", description: "keys and commands" }],
    terminal,
  });
  t.after(() => {
    instance.stop();
  });
  return {
    screen: instance,
    terminal,
    drawn: () => {
      instance.renderNow();
      return terminal.written;
    },
  };
}

test("the transcript, the editor and the footer are all on screen", (t) => {
  const { screen: view, drawn } = screen(t);
  view.say("read calc.py");
  view.setLedger("$0.0001 · cache 90.00% · context 1K");
  const output = drawn();
  assert.match(output, /read calc\.py/u);
  assert.match(output, /cache 90\.00%/u);
  // The editor draws a frame, so something must separate it from the text.
  assert.match(output, /[─│╭╰┌└]/u);
});

test("streamed deltas build one block rather than one line each", (t) => {
  const { screen: view, drawn } = screen(t);
  view.stream("the answer ");
  view.stream("is 42");
  const output = drawn();
  assert.match(output, /the answer is 42/u);
});

test("a line after a stream starts a new block", (t) => {
  // Otherwise a tool line would be swallowed into the model's paragraph.
  const { screen: view, drawn } = screen(t);
  view.stream("first");
  view.say("bash npm test");
  view.stream("second");
  const output = drawn();
  assert.match(output, /first/u);
  assert.match(output, /bash npm test/u);
  assert.doesNotMatch(output, /firstsecond/u);
});

test("queued messages are visible and counted", (t) => {
  const { screen: view, drawn } = screen(t);
  view.setPending(["run the tests", "then commit"]);
  const output = drawn();
  assert.match(output, /run the tests/u);
  assert.match(output, /then commit/u);
  assert.match(output, /2 queued/u);
});

test("a long queued message is shortened to one line", (t) => {
  const { screen: view, drawn } = screen(t);
  view.setPending([`${"x".repeat(400)}\nsecond line`]);
  const output = drawn();
  assert.match(output, /…/u);
  assert.doesNotMatch(output, /second line/u);
});

test("the working indicator replaces a note, and clears again", (t) => {
  const { screen: view, terminal, drawn } = screen(t);
  view.note("Ctrl-D to exit");
  assert.match(drawn(), /Ctrl-D to exit/u);

  view.setWorking(true);
  assert.match(drawn(), /working/u);

  // A note must not overwrite the indicator while a turn is running.
  view.note("something else");
  assert.doesNotMatch(terminal.written.slice(-200), /something else/u);

  terminal.written = "";
  view.setWorking(false);
  assert.doesNotMatch(drawn(), /working/u);
});

test("Ctrl-C and Ctrl-D reach the loop, and typing reaches the editor", (t) => {
  const { screen: view, terminal } = screen(t);
  const seen: string[] = [];
  view.attach({
    onSubmit: (text) => seen.push(`submit:${text}`),
    onInterrupt: () => seen.push("interrupt"),
    onExit: () => seen.push("exit"),
  });
  view.start();

  terminal.press("\u0003");
  assert.deepEqual(seen, ["interrupt"]);

  terminal.press("\u0004");
  assert.deepEqual(seen, ["interrupt", "exit"]);

  for (const character of "hi") terminal.press(character);
  assert.equal(view.editorText, "hi");

  // Ctrl-D with text pending is a forward delete, not an exit.
  terminal.press("\u0004");
  assert.deepEqual(seen, ["interrupt", "exit"]);

  terminal.press("\r");
  assert.deepEqual(seen, ["interrupt", "exit", "submit:hi"]);
});

test("the editor keeps a history of what was sent", (t) => {
  const { screen: view, terminal } = screen(t);
  view.attach({
    onSubmit: () => {},
    onInterrupt: () => {},
    onExit: () => {},
  });
  view.start();
  view.rememberSubmission("earlier message");
  view.clearEditor();

  terminal.press("\u001b[A");
  assert.equal(view.editorText, "earlier message");
});

test("a wide character does not push a line past the terminal width", (t) => {
  // The renderer throws if a rendered line is wider than the terminal, which is
  // exactly the failure the hand-written editor had with CJK input.
  const { screen: view, drawn } = screen(t);
  view.say("测试".repeat(60));
  assert.doesNotThrow(() => drawn());
});

test("clearing the screen keeps the conversation", (t) => {
  // The transcript is a projection. Emptying it must not be a way to lose work,
  // so the ledger and the queue — which describe the Session, not the screen —
  // survive it.
  const { screen: view, drawn } = screen(t);
  view.say("read calc.py");
  view.setLedger("$0.0001 · cache 90.00% · context 1K");
  view.setPending(["run the tests"]);
  assert.match(drawn(), /read calc\.py/u);

  view.clearTranscript();
  const after = drawn();
  assert.doesNotMatch(after.slice(-400), /read calc\.py/u);
  assert.match(after, /cache 90\.00%/u);
  assert.match(after, /run the tests/u);
});

test("a stream started before a clear does not grow back into it", (t) => {
  const { screen: view, drawn } = screen(t);
  view.stream("first half ");
  view.clearTranscript();
  view.stream("second half");
  const after = drawn();
  assert.doesNotMatch(after, /first half second half/u);
  assert.match(after, /second half/u);
});

test("compacting shows its own spinner, distinct from working", (t) => {
  // Same frames so the shape is familiar, different colour and words so it is
  // obvious that this is the harness replacing the conversation rather than
  // the model answering.
  const { screen: view, terminal, drawn } = screen(t);
  view.setWorking(true);
  const working = drawn();
  assert.match(working, /working/u);
  assert.doesNotMatch(working, /compacting/u);

  terminal.written = "";
  view.setCompacting(true);
  const compacting = drawn();
  assert.match(compacting, /compacting/u);
  assert.doesNotMatch(compacting.slice(-300), / working/u);

  terminal.written = "";
  view.setCompacting(false);
  assert.doesNotMatch(drawn(), /compacting/u);
});
