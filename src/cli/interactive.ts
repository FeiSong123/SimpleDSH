import {
  loadPackagedFlashPriceBookV1,
  selectFlashRegularPriceV1,
  type CostReportV1,
  type FlashRegularPriceV1,
} from "../cost/index.js";
import { loadDeepSeekCredential } from "../ds/credential.js";
import type { DeepSeekSemanticFragment } from "../ds/types.js";
import {
  newSessionId,
  type CanonicalTimestamp,
  type SessionId,
} from "../journal/index.js";
import {
  captureSessionEnvironment,
  continueOfficialSession,
  formatPicodollars,
  recoverOfficialSession,
  runOfficialSession,
  RunBudget,
  RunBudgetExceeded,
  SessionInterruptedError,
  type ToolActivity,
  type RunBudgetLimits,
} from "../session/index.js";
import type { SlashCommand } from "../tui/index.js";
import { runLogin, runLogout } from "./login.js";
import { isResumable, MAX_AUTO_RESUMES } from "./resume.js";
import { Screen } from "./screen.js";
import { withTruncationContinuation } from "./truncation.js";
import { color, duration, money, tokens } from "./theme.js";
import { formatToolActivity } from "./transcript.js";

const COMMANDS: readonly SlashCommand[] = Object.freeze([
  { name: "help", description: "keys and commands" },
  { name: "login", description: "store a DeepSeek API key" },
  { name: "logout", description: "remove the stored key" },
  { name: "session", description: "show the current session id" },
  { name: "exit", description: "leave simpledsh" },
]);

const HELP = [
  `${color.bold("Enter")}        send, or queue while a turn is running`,
  `${color.bold("Shift-Enter")}  newline (Ctrl-J where the terminal reports no modifier)`,
  `${color.bold("Ctrl-C")}       interrupt the running turn, or clear the input`,
  `${color.bold("Ctrl-D")}       exit`,
  `${color.bold("Tab")}          accept a completion`,
  `${color.bold("@")}            complete a workspace path`,
  `${color.bold("/")}            commands`,
  `${color.bold("Up/Down")}      earlier messages`,
].join("\n");

interface PendingTurn {
  readonly text: string;
}

/** Basis points arrive as a decimal string so the ledger never uses floats. */
function percent(basisPoints: string | null): string {
  if (basisPoints === null) return "-";
  const value = BigInt(basisPoints);
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}%`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/**
 * Drives the interactive loop.
 *
 * This layer decides when a turn starts, what goes on the Screen and when the
 * loop ends. Every durable fact still goes through the Session Kernel.
 */
export class InteractiveSession {
  readonly #workspaceRoot: string;
  readonly #screen: Screen;
  readonly #queue: PendingTurn[] = [];
  #sessionId: SessionId | null;
  #started: boolean;
  #running = false;
  #controller: AbortController | null = null;
  #exiting = false;
  #wake: (() => void) | null = null;
  #toolCount = 0;
  #exitHintShown = false;
  readonly #limits: RunBudgetLimits;
  #cachedPrice: FlashRegularPriceV1 | null = null;

  constructor(
    workspaceRoot: string,
    existing: Readonly<{ sessionId: SessionId; started: boolean }> | null,
    limits: RunBudgetLimits,
  ) {
    this.#workspaceRoot = workspaceRoot;
    this.#screen = new Screen({ workspaceRoot, commands: COMMANDS });
    this.#sessionId = existing?.sessionId ?? null;
    this.#started = existing?.started ?? false;
    this.#limits = limits;
  }

  /** The packaged dated price, loaded once and reused for every turn. */
  async #price(): Promise<FlashRegularPriceV1> {
    if (this.#cachedPrice !== null) return this.#cachedPrice;
    const book = await loadPackagedFlashPriceBookV1();
    const now = new Date().toISOString().replace(/\.\d+Z$/u, ".000Z");
    const price = selectFlashRegularPriceV1(book, now as CanonicalTimestamp);
    if (price === null) {
      throw new Error("no packaged price covers the current date");
    }
    this.#cachedPrice = price;
    return price;
  }

  readonly #preview = (fragment: DeepSeekSemanticFragment): void => {
    // Only the answer. Thinking mode is always on, so reasoning deltas arrive
    // for every turn; showing them buries the reply under the model talking to
    // itself. They stay in the Journal either way.
    if (fragment.kind !== "content") return;
    this.#screen.stream(fragment.text);
  };

  readonly #onTool = (activity: ToolActivity): void => {
    if (activity.phase !== "settled") return;
    this.#toolCount += 1;
    this.#screen.say(formatToolActivity(activity));
  };

  readonly #onStatus = (report: CostReportV1): void => {
    const active = report.lineages.find(
      ({ lineageId }) => lineageId === report.activeLineageId,
    );
    // The token count is the last value the provider reported, so it lags the
    // true current prefix. Label it as "last" rather than implying it is live.
    const observed = report.lastProviderObservedPromptTokens;
    const context =
      observed === null || observed === undefined
        ? "context -"
        : `context ${tokens(Number(observed))}`;
    this.#screen.setLedger(
      color.dim(
        [
          money(report.knownSessionCost.total.usd),
          `cache ${percent(active?.cacheHitRatio.basisPoints ?? null)}`,
          context,
        ].join(" · "),
      ),
    );
  };

  async #runTurn(text: string): Promise<void> {
    this.#running = true;
    this.#toolCount = 0;
    this.#controller = new AbortController();
    this.#screen.say(color.prompt(`> ${text.split("\n").join("\n  ")}`));
    this.#screen.setWorking(true);
    let budget: RunBudget | null = null;
    try {
      const credential = loadDeepSeekCredential({
        projectRoot: this.#workspaceRoot,
      });
      const environmentFacts = await captureSessionEnvironment(
        this.#workspaceRoot,
      );
      if (this.#sessionId === null) this.#sessionId = newSessionId();
      budget = new RunBudget(this.#limits, await this.#price());
      const input = {
        workspaceRoot: this.#workspaceRoot,
        sessionId: this.#sessionId,
        userInput: text,
        environmentFacts,
        signal: this.#controller.signal,
        onPreview: this.#preview,
        onStatus: this.#onStatus,
        onToolActivity: this.#onTool,
        acceptanceBudget: budget,
        credential,
      } as const;
      const first = this.#started
        ? await continueOfficialSession(input)
        : await runOfficialSession(input);
      this.#started = true;
      await withTruncationContinuation(
        first,
        (userInput) => continueOfficialSession({ ...input, userInput }),
        (attempt, max) =>
          this.#screen.say(
            color.dim(
              `[the reply hit the output limit; continuing (${String(attempt)}/${String(max)})]`,
            ),
          ),
      );
    } catch (error) {
      // A turn that stops early is a durable fact, not a crash: the Journal
      // already recorded why, and the next turn continues from the last safe
      // boundary.
      this.#started = this.#started || this.#sessionId !== null;
      const stopped = budget?.stopped ?? null;
      if (stopped !== null) {
        this.#reportStop(stopped, this.#sessionId);
      } else if (
        isResumable(error) &&
        this.#sessionId !== null &&
        !this.#controller.signal.aborted
      ) {
        await this.#autoRecover(this.#sessionId);
      } else {
        this.#reportStop(error, this.#sessionId);
      }
    } finally {
      this.#screen.setWorking(false);
      if (budget !== null) this.#reportUsage(budget);
      this.#screen.blank();
      this.#running = false;
      this.#controller = null;
    }
  }

  /**
   * The fixed built-in commands. Everything else typed at the prompt is a
   * message to the model, so these need a prefix that a prompt would not use.
   */
  async #command(text: string): Promise<void> {
    const [name] = text.slice(1).split(/\s+/u);
    switch (name) {
      case "help":
        this.#screen.say(HELP);
        break;
      case "login":
        // Reading a secret needs the raw terminal, so hand the screen back for
        // the duration rather than nesting two readers on one stdin.
        await this.#screen.suspended(async () => {
          try {
            await runLogin((line) => {
              this.#screen.say(color.ok(line.trimEnd()));
            });
          } catch (error) {
            this.#screen.say(color.error(`[login failed: ${describe(error)}]`));
          }
        });
        break;
      case "logout":
        try {
          runLogout((line) => {
            this.#screen.say(color.ok(line.trimEnd()));
          });
        } catch (error) {
          this.#screen.say(color.error(`[logout failed: ${describe(error)}]`));
        }
        break;
      case "session":
        this.#screen.say(
          color.dim(`session ${this.#sessionId ?? "not started"}`),
        );
        break;
      case "exit":
      case "quit":
        this.#requestExit();
        break;
      default:
        this.#screen.say(color.warn(`[unknown command ${text}; try /help]`));
    }
  }

  #reportUsage(budget: RunBudget): void {
    const usage = budget.usage;
    if (usage.toolRounds === 0) return;
    const parts = [
      `${String(usage.toolRounds)} step${usage.toolRounds === 1 ? "" : "s"}`,
      ...(this.#toolCount === 0
        ? []
        : [`${String(this.#toolCount)} tool${this.#toolCount === 1 ? "" : "s"}`]),
      money(formatPicodollars(usage.costPicodollars).slice(1)),
      duration(usage.elapsedMs),
    ];
    this.#screen.say(color.dim(parts.join(" · ")));
  }

  #reportStop(error: unknown, sessionId: SessionId | null): void {
    if (error instanceof RunBudgetExceeded) {
      this.#screen.say(
        color.warn(`[stopped by the turn budget: ${error.detail}]`),
      );
      this.#screen.say(
        color.dim("  the session is intact; send another message to go on"),
      );
      return;
    }
    const reason =
      error instanceof SessionInterruptedError ? error.reason : describe(error);
    this.#screen.say(color.error(`[interrupted: ${reason}]`));
    if (sessionId !== null) {
      this.#screen.say(color.dim(`  recover with: simpledsh recover ${sessionId}`));
    }
  }

  /**
   * A stream that breaks after the model started producing output cannot be
   * replayed into the same Run — invariant 7 forbids it. Creating a *new* Run
   * from the last safe Commit Boundary is allowed, and is exactly what
   * `simpledsh recover` does, so do that here instead of dropping the user out.
   */
  async #autoRecover(sessionId: SessionId): Promise<void> {
    for (let attempt = 1; attempt <= MAX_AUTO_RESUMES; attempt += 1) {
      if (this.#controller?.signal.aborted === true) return;
      this.#screen.say(
        color.dim(
          `[resuming from the last safe boundary (${String(attempt)}/${String(MAX_AUTO_RESUMES)})]`,
        ),
      );
      try {
        const result = await recoverOfficialSession({
          workspaceRoot: this.#workspaceRoot,
          sessionId,
          ...(this.#controller === null
            ? {}
            : { signal: this.#controller.signal }),
          onPreview: this.#preview,
          onStatus: this.#onStatus,
          onToolActivity: this.#onTool,
          loadCredential: () =>
            loadDeepSeekCredential({ projectRoot: this.#workspaceRoot }),
        });
        if (result.status !== "completed") {
          this.#screen.say(color.warn(`[turn ended: ${result.status}]`));
        }
        return;
      } catch (error) {
        if (!isResumable(error)) {
          this.#reportStop(error, sessionId);
          return;
        }
      }
    }
    this.#screen.say(
      color.warn(
        `[still failing after ${String(MAX_AUTO_RESUMES)} attempts; run simpledsh recover ${sessionId} when ready]`,
      ),
    );
  }

  #requestExit(): void {
    if (this.#running) {
      this.#screen.note("a turn is running — Ctrl-C first");
      return;
    }
    this.#exiting = true;
    this.#wake?.();
  }

  /**
   * Ctrl-C, in the order a person expects: stop the work, else drop what was
   * typed, else drop what is queued, else say how to leave.
   */
  readonly #onInterrupt = (): void => {
    if (this.#running) {
      this.#controller?.abort();
      return;
    }
    if (this.#screen.editorText.length > 0) {
      this.#screen.clearEditor();
      this.#screen.note("");
      return;
    }
    if (this.#queue.length > 0) {
      this.#queue.length = 0;
      this.#screen.setPending([]);
      this.#screen.note("queue cleared");
      return;
    }
    if (!this.#exitHintShown) {
      this.#exitHintShown = true;
      this.#screen.note("Ctrl-D to exit, /help for commands");
    }
  };

  readonly #onSubmit = (raw: string): void => {
    const text = raw.trim();
    this.#screen.clearEditor();
    this.#screen.note("");
    if (text.length === 0) return;
    this.#screen.rememberSubmission(text);
    if (text.startsWith("/")) {
      void this.#command(text);
      return;
    }
    this.#queue.push(Object.freeze({ text }));
    this.#screen.setPending(this.#queue.map(({ text: queued }) => queued));
    this.#wake?.();
  };

  async run(): Promise<void> {
    if (process.stdin.isTTY !== true) {
      throw new Error("interactive mode needs a TTY");
    }
    this.#screen.attach({
      onSubmit: this.#onSubmit,
      onInterrupt: this.#onInterrupt,
      onExit: () => {
        this.#requestExit();
      },
    });
    this.#screen.say(
      `${color.bold("simpledsh")} ${color.dim("— a simple harness for DeepSeek · /help")}`,
    );
    if (this.#sessionId !== null && this.#started) {
      this.#screen.say(color.dim(`continuing ${this.#sessionId}`));
    }
    this.#screen.blank();
    this.#screen.start();

    try {
      while (!this.#exiting) {
        const next = this.#queue.shift();
        if (next === undefined) {
          await new Promise<void>((resolveWake) => {
            this.#wake = () => {
              this.#wake = null;
              resolveWake();
            };
          });
          continue;
        }
        this.#screen.setPending(this.#queue.map(({ text }) => text));
        await this.#runTurn(next.text);
      }
    } finally {
      this.#screen.stop();
      if (this.#sessionId !== null) {
        process.stderr.write(`simpledsh: session_id=${this.#sessionId}\n`);
      }
    }
  }
}
