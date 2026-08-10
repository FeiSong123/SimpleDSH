import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { freezeBytes } from "../bytes/types.js";
import { viewUser } from "../bytes/view.js";
import { openJournalReadOnly, type SessionId } from "../journal/index.js";
import type { AnyVerifiedJournalEvent } from "../journal/index.js";

const SESSION_ID = /^ses_[0-9a-f]{32}$/u;

export interface SessionSummary {
  readonly sessionId: SessionId;
  /** First user message, trimmed to one line. `null` when it is not inline. */
  readonly title: string | null;
  /** Workspace the Session recorded as a durable fact, when it recorded one. */
  readonly cwd: string | null;
  readonly turns: number;
  readonly lastActivityAt: string | null;
  readonly state: "completed" | "interrupted" | "open";
}

/**
 * Read a listable title out of an inline user blob.
 *
 * Parsing goes through the approved `viewUser` reader, which re-materializes
 * the bytes and rejects anything that is not the canonical form. Externally
 * stored blobs are skipped rather than loaded: a Session list is not worth a
 * CAS read.
 */
function decodeInlineUserContent(
  event: AnyVerifiedJournalEvent,
): string | null {
  if (event.type !== "user_committed") return null;
  const payload = event.payload;
  if (payload.enc !== "b64") return null;
  try {
    return viewUser(freezeBytes(Buffer.from(payload.bytes, "base64"))).content;
  } catch {
    return null;
  }
}

/**
 * The user blob carries the turn's environment block after the prompt. Only the
 * prompt itself is worth showing in a list.
 */
function titleFromUserContent(content: string): string {
  const withoutEnvironment = content.split("\n\n<env>\n")[0] ?? content;
  const firstLine = withoutEnvironment.split("\n")[0]?.trim() ?? "";
  return firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine;
}

async function summarize(
  workspaceRoot: string,
  sessionId: SessionId,
): Promise<SessionSummary | null> {
  let events: readonly AnyVerifiedJournalEvent[];
  try {
    const opened = await openJournalReadOnly(workspaceRoot, sessionId);
    events = opened.replay.events;
  } catch {
    // A Session that cannot be replayed read-only is not listable. `simpledsh
    // inspect` still reports exactly why.
    return null;
  }
  if (events.length === 0) return null;

  let title: string | null = null;
  let turns = 0;
  for (const event of events) {
    if (event.type !== "user_committed") continue;
    turns += 1;
    if (title !== null) continue;
    const content = decodeInlineUserContent(event);
    if (content !== null) title = titleFromUserContent(content);
  }

  const lastRunStart = events.findLast((event) => event.type === "run_started");
  const lastRunId = lastRunStart?.runId;
  const state: SessionSummary["state"] =
    lastRunId === undefined
      ? "open"
      : events.some(
            (event) =>
              event.type === "run_completed" && event.runId === lastRunId,
          )
        ? "completed"
        : events.some(
              (event) =>
                event.type === "run_interrupted" && event.runId === lastRunId,
            )
          ? "interrupted"
          : "open";

  return Object.freeze({
    sessionId,
    title,
    cwd: null,
    turns,
    lastActivityAt: events.at(-1)?.at ?? null,
    state,
  });
}

/**
 * List every replayable Session under the workspace, most recent first.
 */
export async function listSessions(
  workspaceRoot: string,
): Promise<readonly SessionSummary[]> {
  let entries: string[];
  try {
    entries = await readdir(join(workspaceRoot, ".dsh", "sessions"));
  } catch {
    return Object.freeze([]);
  }
  const summaries: SessionSummary[] = [];
  for (const entry of entries.sort()) {
    if (!SESSION_ID.test(entry)) continue;
    const summary = await summarize(workspaceRoot, entry as SessionId);
    if (summary !== null) summaries.push(summary);
  }
  return Object.freeze(
    summaries.sort((left, right) =>
      (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? ""),
    ),
  );
}

/**
 * The Session `simpledsh continue` picks when the caller names none: the most
 * recently active one that is safe to append a new user turn to.
 */
export async function mostRecentContinuableSession(
  workspaceRoot: string,
): Promise<SessionSummary | null> {
  const sessions = await listSessions(workspaceRoot);
  return sessions.find(({ state }) => state === "completed") ?? null;
}

export function formatSessionList(
  sessions: readonly SessionSummary[],
): string {
  if (sessions.length === 0) return "no sessions in this workspace\n";
  const lines = sessions.map((session) => {
    const when = session.lastActivityAt ?? "-";
    const turns = `${String(session.turns)} turn${session.turns === 1 ? "" : "s"}`;
    const title = session.title ?? "(no inline prompt)";
    return `${session.sessionId}  ${when}  ${session.state.padEnd(11)}  ${turns.padEnd(8)}  ${title}`;
  });
  return `${lines.join("\n")}\n`;
}
