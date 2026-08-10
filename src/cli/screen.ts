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
import { color, editorTheme, markdownTheme } from "./theme.js";

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const ESCAPE = "\u001b";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 90;

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
  #working = false;
  #spinner: NodeJS.Timeout | null = null;
  #spinnerFrame = 0;
  #detachInput: (() => void) | null = null;

  constructor(options: ScreenOptions) {
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

  /** A transient line above the editor. Replaced by the working indicator. */
  note(text: string): void {
    if (this.#working) return;
    this.#status.setText(text.length === 0 ? "" : color.dim(text));
    this.#tui.requestRender();
  }

  setWorking(working: boolean): void {
    if (working === this.#working) return;
    this.#working = working;
    if (!working) {
      if (this.#spinner !== null) clearInterval(this.#spinner);
      this.#spinner = null;
      this.#status.setText("");
      this.#tui.requestRender();
      return;
    }
    this.#spinnerFrame = 0;
    const tick = (): void => {
      this.#status.setText(
        `${color.tool(SPINNER[this.#spinnerFrame] ?? "")} ${color.dim("working — Ctrl-C to interrupt")}`,
      );
      this.#spinnerFrame = (this.#spinnerFrame + 1) % SPINNER.length;
      this.#tui.requestRender();
    };
    tick();
    this.#spinner = setInterval(tick, SPINNER_INTERVAL_MS);
    this.#spinner.unref();
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
      if (data === CTRL_C) {
        handlers.onInterrupt();
        return { consume: true };
      }
      if (data === CTRL_D && this.#editor.getText().length === 0) {
        handlers.onExit();
        return { consume: true };
      }
      // Escape stops a turn, but only when the editor is not using it to close
      // its own completion list.
      if (
        data === ESCAPE &&
        this.#working &&
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
