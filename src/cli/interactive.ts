import { homedir } from "node:os";

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
import {
  COMPACTION_PROMPT,
  DEFAULT_COMPACTION_THRESHOLD_TOKENS,
  pendingCompactionSummary,
  recordCompaction,
} from "../session/compaction.js";
import {
  DEEPSEEK_MODEL,
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from "../bytes/request.js";
import type { SlashCommand } from "../tui/index.js";
import { runLogin, runLogout } from "./login.js";
import { isKnownSlashCommand } from "./slash-command.js";
import { isResumable, MAX_AUTO_RESUMES, withAutoResume } from "./resume.js";
import { banner, type RunContext } from "./banner.js";
import { Screen } from "./screen.js";
import { withTruncationContinuation } from "./truncation.js";
import { color, duration, money, tokens } from "./theme.js";
import { formatToolActivity } from "./transcript.js";

const COMMANDS: readonly SlashCommand[] = Object.freeze([
  { name: "help", description: "keys and commands" },
  { name: "clear", description: "empty the screen, keep the conversation" },
  { name: "compact", description: "replace the conversation with a summary" },
  { name: "effort", description: "how hard the model thinks" },
  { name: "login", description: "store a DeepSeek API key" },
  { name: "logout", description: "remove the stored key" },
  { name: "session", description: "show the current session id" },
  { name: "exit", description: "leave simpledsh" },
  { name: "quit", description: "leave simpledsh" },
]);

const HELP = [
  `${color.bold("Enter")}        send, or queue while a turn is running`,
  `${color.bold("Shift-Enter")}  newline (Ctrl-J where the terminal reports no modifier)`,
  `${color.bold("Ctrl-C")}       interrupt the running turn, or clear the input`,
  `${color.bold("Ctrl-D")}       exit`,
  `${color.bold("Tab")}          accept a completion`,
  `${color.bold("@")}            complete a workspace path`,
  `${color.bold("/")}            commands, including /clear to empty the screen`,
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
  #promptTokens = 0;
  #compacting = false;
  #effort: ReasoningEffort | null = null;
  readonly #limits: RunBudgetLimits;
  readonly #compactAtTokens: number;
  #cachedPrice: FlashRegularPriceV1 | null = null;

  constructor(
    workspaceRoot: string,
    existing: Readonly<{ sessionId: SessionId; started: boolean }> | null,
    limits: RunBudgetLimits,
    compactAtTokens: number = DEFAULT_COMPACTION_THRESHOLD_TOKENS,
  ) {
    this.#workspaceRoot = workspaceRoot;
    this.#screen = new Screen({ workspaceRoot, commands: COMMANDS });
    this.#sessionId = existing?.sessionId ?? null;
    this.#started = existing?.started ?? false;
    this.#limits = limits;
    this.#compactAtTokens = compactAtTokens;
  }

  /**
   * Whether the prefix has grown past the point where compacting is worth it.
   *
   * Exposed so the decision can be tested without a session that actually
   * reaches half a million tokens.
   */
  static shouldCompact(
    promptTokens: number,
    threshold: number,
    started: boolean,
  ): boolean {
    return started && threshold > 0 && promptTokens >= threshold;
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

  /**
   * What the next turn will use, before any of it has been used.
   *
   * The ledger only exists once a request has come back, and until then the
   * footer was blank — so the one moment you most need to know which model and
   * which directory you are about to spend on told you neither.
   */
  /** Model, effort and directory, with the home prefix shortened to `~`. */
  #runContext(): RunContext {
    const home = homedir();
    return {
      model: DEEPSEEK_MODEL,
      effort: this.#effort ?? DEFAULT_REASONING_EFFORT,
      directory: this.#workspaceRoot.startsWith(home)
        ? `~${this.#workspaceRoot.slice(home.length)}`
        : this.#workspaceRoot,
    };
  }

  #refreshContext(): void {
    const context = this.#runContext();
    this.#screen.setContext(
      context.model,
      `effort ${context.effort}`,
      context.directory,
    );
  }

  readonly #onStatus = (report: CostReportV1): void => {
    const active = report.lineages.find(
      ({ lineageId }) => lineageId === report.activeLineageId,
    );
    // The token count is the last value the provider reported, so it lags the
    // true current prefix. Label it as "last" rather than implying it is live.
    const observed = report.lastProviderObservedPromptTokens;
    this.#promptTokens =
      observed === null || observed === undefined ? this.#promptTokens : Number(observed);
    const context =
      observed === null || observed === undefined
        ? "context -"
        : `context ${tokens(Number(observed))}`;
    this.#screen.setLedger(
      [
        money(report.knownSessionCost.total.usd),
        `cache ${percent(active?.cacheHitRatio.basisPoints ?? null)}`,
        context,
      ].join(" · "),
    );
  };

  async #runTurn(text: string): Promise<void> {
    // Flash degrades noticeably as the prefix approaches its 1M window, so the
    // trigger is the prefix size rather than an estimate of work remaining.
    if (
      this.#sessionId !== null &&
      InteractiveSession.shouldCompact(
        this.#promptTokens,
        this.#compactAtTokens,
        this.#started,
      )
    ) {
      await this.#compact(`context reached ${tokens(this.#compactAtTokens)}`);
    }
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
      // A Lineage created by compaction has no prefix yet. Its first turn
      // carries the summary, so the work continues rather than restarting.
      const summary = this.#started
        ? await pendingCompactionSummary(this.#workspaceRoot, this.#sessionId)
        : null;
      const userInput =
        summary === null
          ? text
          : `Here is where the previous conversation left off.\n\n${summary}\n\n---\n\n${text}`;
      const input = {
        workspaceRoot: this.#workspaceRoot,
        sessionId: this.#sessionId,
        userInput,
        ...(this.#effort === null || this.#started
          ? {}
          : { reasoningEffort: this.#effort }),
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
      case "clear":
        // Display only. The Session keeps its byte prefix, so the next turn is
        // still a cache hit and nothing durable is lost.
        this.#screen.clearTranscript();
        this.#screen.say(
          color.dim(`screen cleared · ${this.#sessionId ?? "no session yet"} continues`),
        );
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
      case "compact":
        await this.#compact("asked for");
        break;
      case "effort":
        this.#screen.openSlider(
          "effort",
          REASONING_EFFORTS,
          this.#effort ?? DEFAULT_REASONING_EFFORT,
        );
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

  /**
   * Replace the conversation with a summary of itself.
   *
   * The summary is written by the model on the Lineage being replaced, so
   * reading the whole history is still a cache hit; only afterwards does a new
   * Lineage become active. Nothing durable is discarded — the old bytes stay
   * replayable, they simply stop being sent.
   */
  async #compact(cause: string, reasoningEffort?: ReasoningEffort): Promise<void> {
    if (this.#sessionId === null || !this.#started) {
      this.#screen.say(color.warn("[nothing to compact yet]"));
      return;
    }
    if (this.#compacting) return;
    this.#compacting = true;
    const before = this.#promptTokens;
    this.#screen.say(color.dim(`[compacting — ${cause}]`));
    this.#screen.setCompacting(true);
    try {
      const credential = loadDeepSeekCredential({
        projectRoot: this.#workspaceRoot,
      });
      const environmentFacts = await captureSessionEnvironment(
        this.#workspaceRoot,
      );
      const sessionId = this.#sessionId;
      const controller = new AbortController();
      this.#controller = controller;
      // The same auto-resume the ordinary turns get. A summary request that
      // dies on a broken stream is exactly the case invariant 7 allows a new
      // Run for, and without this one transient failure throws away a request
      // that has already been paid for.
      const summary = await withAutoResume(
        () =>
          continueOfficialSession({
            workspaceRoot: this.#workspaceRoot,
            sessionId,
            userInput: COMPACTION_PROMPT,
            environmentFacts,
            signal: controller.signal,
            onStatus: this.#onStatus,
            credential,
          }),
        () =>
          recoverOfficialSession({
            workspaceRoot: this.#workspaceRoot,
            sessionId,
            signal: controller.signal,
            onStatus: this.#onStatus,
            loadCredential: () =>
              loadDeepSeekCredential({ projectRoot: this.#workspaceRoot }),
          }),
        (attempt, max) =>
          this.#screen.say(
            color.dim(
              `[summary request failed; retrying (${String(attempt)}/${String(max)})]`,
            ),
          ),
      );
      if (summary.content.trim().length === 0) {
        this.#screen.say(color.warn("[compaction produced no summary; nothing changed]"));
        return;
      }
      const result = await recordCompaction({
        workspaceRoot: this.#workspaceRoot,
        sessionId: this.#sessionId,
        summary: summary.content,
        replacedPromptTokens: Math.max(before, this.#promptTokens),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      });
      // #promptTokens is refreshed by the summary request itself, so this is
      // what the model actually saw rather than a reading from a turn ago.
      this.#screen.clearTranscript();
      this.#screen.say(
        color.dim(
          `compacted · ${tokens(Math.max(before, this.#promptTokens))} → summary · ${result.toLineageId}`,
        ),
      );
      this.#screen.markdown(summary.content);
      this.#screen.blank();
    } catch (error) {
      // Nothing was written, so say so: an interrupted summary leaves the
      // Session exactly as it was, and the next turn is still a cache hit.
      this.#screen.say(color.error(`[compaction failed: ${describe(error)}]`));
      this.#screen.say(
        color.dim("  the conversation is unchanged; try /compact again"),
      );
    } finally {
      this.#screen.setCompacting(false);
      this.#controller = null;
      this.#compacting = false;
    }
  }

  /**
   * Apply a level chosen on the slider.
   *
   * Effort is part of the Cache ABI, so changing it mid-session cannot mean
   * editing the request bytes already sent. It means the conversation carries
   * on under a new Lineage: the model writes a handover note on the old one —
   * still a cache hit — and the next turn starts cold under the new setting.
   * That cost is real and stated rather than hidden.
   */
  async #chooseEffort(value: string | null): Promise<void> {
    if (value === null) return;
    const chosen = REASONING_EFFORTS.find((level) => level === value);
    if (chosen === undefined) return;
    const current = this.#effort ?? DEFAULT_REASONING_EFFORT;
    if (chosen === current) {
      this.#screen.say(color.dim(`effort stays ${chosen}`));
      return;
    }
    this.#effort = chosen;
    this.#refreshContext();
    if (!this.#started || this.#sessionId === null) {
      this.#screen.say(color.dim(`effort ${chosen}`));
      return;
    }
    this.#screen.say(
      color.dim(
        `effort ${current} → ${chosen} · the prefix restarts cold under the new setting`,
      ),
    );
    await this.#compact(`effort changed to ${chosen}`, chosen);
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
    // Only a known slash command leaves the queue; anything else starting
    // with "/" is a prompt, so absolute paths work as ordinary input.
    if (text.startsWith("/") && isKnownSlashCommand(text, COMMANDS, ["quit"])) {
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
      onPick: (value) => {
        void this.#chooseEffort(value);
      },
      onInterrupt: this.#onInterrupt,
      onExit: () => {
        this.#requestExit();
      },
    });
    // `columns` is 0, not undefined, on a terminal that never reported a size,
    // so `??` is not enough to fall back on.
    this.#screen.blank();
    for (const line of banner(process.stdout.columns || 80, this.#runContext())) {
      // A Text component of "" occupies no row, so any separator has to be
      // asked for as a spacer or the blocks come out flush.
      if (line === "") this.#screen.blank();
      else this.#screen.wide(line);
    }
    this.#screen.blank();
    this.#screen.say(color.dim("/help for keys and commands"));
    this.#refreshContext();
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
