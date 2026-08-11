import { homedir } from "node:os";
import { join } from "node:path";

import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Markdown,
  ProcessTerminal,
  Spacer,
  Text,
  TuiMainScreen,
  type Component,
  type SlashCommand,
  type Terminal,
  type TuiInputListenerResult,
} from "../tui/index.js";
import { matchesKey } from "../tui/keys.js";
import { color, editorTheme, markdownTheme } from "./theme.js";

const ENTER = "\r";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 90;

interface Activity {
  readonly label: string;
  readonly paint: (text: string) => string;
}

export interface ScreenHandlers {
  /** Enter on a non-empty line. */
  readonly onSubmit: (text: string) => void;
  /** Ctrl-C, or Escape while a turn is running. */
  readonly onInterrupt: () => void;
  /** Ctrl-D on an empty line. */
  readonly onExit: () => void;
}

export interface ScreenOptions {
  readonly workspaceRoot: string;
  readonly commands: readonly SlashCommand[];
  /** Injected by tests; the real loop uses the process terminal. */
  readonly terminal?: Terminal;
}

function firstLine(text: string, limit: number): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/**
 * Everything the interactive loop draws.
 *
 * The screen is a component tree under one differential renderer: a transcript
 * that only grows, the queue of messages waiting to be sent, a status row, the
 * editor, and a footer holding the ledger. Nothing here knows about Sessions —
 * it is told what to show.
 */
export class Screen {
  readonly #tui: TuiMainScreen;
  readonly #editor: Editor;
  readonly #transcript = new Container();
  readonly #pending = new Container();
  readonly #status = new Text("", 1, 0);
  readonly #footer = new Text("", 1, 0);
  #stream: Markdown | null = null;
  #streamText = "";
  #ledger = "";
  #queued = 0;
  #activity: Activity | null = null;
  #spinner: NodeJS.Timeout | null = null;
  #spinnerFrame = 0;
  #detachInput: (() => void) | null = null;
  readonly #commandNames: ReadonlySet<string>;

  constructor(options: ScreenOptions) {
    this.#commandNames = new Set(options.commands.map(({ name }) => `/${name}`));
    // Where the renderer writes its own diagnostics if it ever crashes. Beside
    // the credentials rather than in the workspace, which belongs to the user
    // and is usually under version control.
    this.#tui = new TuiMainScreen(
      options.terminal ?? new ProcessTerminal(),
      undefined,
      join(homedir(), ".config", "dsh", "tui"),
    );
    this.#editor = new Editor(this.#tui, editorTheme, { paddingX: 1 });
    this.#editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        [...options.commands],
        options.workspaceRoot,
      ),
    );
    this.#tui.addChild(this.#transcript);
    this.#tui.addChild(this.#pending);
    this.#tui.addChild(this.#status);
    this.#tui.addChild(this.#editor);
    this.#tui.addChild(this.#footer);
    this.#tui.setFocus(this.#editor);
  }

  /**
   * Append to the transcript.
   *
   * This also ends the open streaming block, so whatever the model says next
   * starts below the line just added rather than growing back into it.
   */
  #append(component: Component): void {
    this.#stream = null;
    this.#transcript.addChild(component);
    this.#tui.requestRender();
  }

  /** One finished line of transcript. */
  say(text: string): void {
    this.#append(new Text(text, 1, 0));
  }

  /**
   * Empty the visible transcript.
   *
   * The screen is a projection, so this discards nothing: the Session, its byte
   * prefix and every durable fact are untouched, and the next turn continues
   * exactly where this one left off. It is a way to stop scrolling past work
   * you are done reading, not a way to forget it.
   */
  clearTranscript(): void {
    this.#stream = null;
    this.#streamText = "";
    this.#transcript.clear();
    this.#tui.requestRender(true);
  }

  /** A finished block of the model's own prose, rendered as Markdown. */
  markdown(text: string): void {
    this.#append(new Markdown(text, 1, 0, markdownTheme));
  }

  blank(): void {
    this.#append(new Spacer(1));
  }

  /**
   * Extend the block the model is currently writing.
   *
   * Deltas arrive without line boundaries, so the whole block is re-rendered as
   * Markdown each time; the renderer redraws only the rows that changed.
   */
  stream(delta: string): void {
    if (this.#stream === null) {
      this.#streamText = "";
      this.#stream = new Markdown("", 1, 0, markdownTheme);
      this.#transcript.addChild(this.#stream);
    }
    this.#streamText += delta;
    this.#stream.setText(this.#streamText);
    this.#tui.requestRender();
  }

  /** Messages typed while a turn was running, shown in the order they will be sent. */
  setPending(items: readonly string[]): void {
    this.#pending.clear();
    for (const item of items) {
      this.#pending.addChild(
        new Text(color.dim(`> ${firstLine(item, 72)}`), 1, 0),
      );
    }
    this.#queued = items.length;
    this.#refreshFooter();
  }

  /** Cost, cache and context, already formatted. */
  setLedger(text: string): void {
    this.#ledger = text;
    this.#refreshFooter();
  }

  #refreshFooter(): void {
    const queued =
      this.#queued === 0 ? "" : color.dim(` · ${String(this.#queued)} queued`);
    this.#footer.setText(`${this.#ledger}${queued}`);
    this.#tui.requestRender();
  }

  /** A transient line above the editor. Replaced by whichever spinner is up. */
  note(text: string): void {
    if (this.#activity !== null) return;
    this.#status.setText(text.length === 0 ? "" : color.dim(text));
    this.#tui.requestRender();
  }

  /**
   * Turn the status row into a spinner, or clear it.
   *
   * One spinner, two meanings. Both use the same braille frames so the shape is
   * familiar; the colour is what says which one is running, because compaction
   * behaves differently — it is not the model working on your request, and
   * interrupting it leaves the conversation as it was.
   */
  #spin(activity: Activity | null): void {
    if (activity?.label === this.#activity?.label) return;
    this.#activity = activity;
    if (this.#spinner !== null) clearInterval(this.#spinner);
    this.#spinner = null;
    if (activity === null) {
      this.#status.setText("");
      this.#tui.requestRender();
      return;
    }
    this.#spinnerFrame = 0;
    const tick = (): void => {
      this.#status.setText(
        `${activity.paint(SPINNER[this.#spinnerFrame] ?? "")} ${color.dim(activity.label)}`,
      );
      this.#spinnerFrame = (this.#spinnerFrame + 1) % SPINNER.length;
      this.#tui.requestRender();
    };
    tick();
    this.#spinner = setInterval(tick, SPINNER_INTERVAL_MS);
    this.#spinner.unref();
  }

  setWorking(working: boolean): void {
    this.#spin(
      working
        ? { label: "working — Ctrl-C to interrupt", paint: color.tool }
        : null,
    );
  }

  /** The model is writing the handover note that replaces the conversation. */
  setCompacting(compacting: boolean): void {
    this.#spin(
      compacting
        ? { label: "compacting — writing a summary of this conversation", paint: color.compact }
        : null,
    );
  }

  get editorText(): string {
    return this.#editor.getText();
  }

  clearEditor(): void {
    this.#editor.setText("");
  }

  rememberSubmission(text: string): void {
    this.#editor.addToHistory(text);
  }

  /**
   * Keys the loop owns rather than the editor.
   *
   * They are taken before the focused component sees them, so Ctrl-C reaches a
   * running turn while the editor holds focus. Everything else falls through.
   */
  attach(handlers: ScreenHandlers): void {
    this.#editor.onSubmit = (text) => {
      handlers.onSubmit(text);
    };
    const listener = (data: string): TuiInputListenerResult => {
      // The terminal may deliver Ctrl-C/Ctrl-D as the raw control character,
      // a Kitty CSI-u sequence, or an xterm modifyOtherKeys sequence depending
      // on keyboard-protocol negotiation; match all encodings.
      if (matchesKey(data, "ctrl+c")) {
        handlers.onInterrupt();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+d") && this.#editor.getText().length === 0) {
        handlers.onExit();
        return { consume: true };
      }
      // A finished command should run, not complete to itself. The completion
      // list is still open on the exact match the user just typed, and Enter
      // belongs to it first, so `/compact` + Enter silently did nothing until a
      // second Enter arrived.
      if (
        data === ENTER &&
        this.#editor.isShowingAutocomplete() &&
        this.#commandNames.has(this.#editor.getText().trim())
      ) {
        handlers.onSubmit(this.#editor.getText().trim());
        return { consume: true };
      }
      // Escape stops a turn, but only when the editor is not using it to close
      // its own completion list.
      if (
        matchesKey(data, "escape") &&
        this.#activity !== null &&
        !this.#editor.isShowingAutocomplete()
      ) {
        handlers.onInterrupt();
        return { consume: true };
      }
      return undefined;
    };
    this.#detachInput = this.#tui.addInputListener(listener);
  }

  start(): void {
    this.#tui.start();
  }

  stop(): void {
    this.setWorking(false);
    this.#detachInput?.();
    this.#detachInput = null;
    this.#tui.stop();
  }

  /**
   * Give the terminal back to a nested prompt and take it again afterwards.
   *
   * The redraw is forced: whatever the nested prompt wrote is in no component,
   * so the differential state no longer describes the screen.
   */
  async suspended(action: () => Promise<void>): Promise<void> {
    // A plain stop leaves the cursor on a fresh line below the last rendered
    // row, so the nested prompt does not start glued to the editor's border.
    this.#tui.stop();
    try {
      await action();
    } finally {
      this.#tui.start();
      this.#tui.requestRender(true);
    }
  }

  /** Draw immediately rather than on the next frame. Used by tests. */
  renderNow(): void {
    this.#tui.renderNow();
  }
}
