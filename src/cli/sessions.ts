import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSessionPaths } from "../journal/paths.js";

import { freezeBytes } from "../bytes/types.js";
import { storageDirectoryName } from "../journal/paths.js";
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
 * Fast structural summary, used by the Session list.
 *
 * The list is a disposable read-only projection: it only needs the first
 * inline user blob, the user-turn count, the last activity timestamp and the
 * last run state. Reading those does not require CAS verification, so this
 * path parses `log.jsonl` line by line without touching the artifact/blob/
 * snapshot/recovery stores. Any structural anomaly (mid-log parse failure,
 * missing fields) falls back to the fully verified `summarize()`; `inspect`,
 * `continue` and recovery still open the Journal with full verification, so
 * the verified semantics are unchanged where they are load-bearing.
 */

/**
 * Read the cwd fact from a session's journal (fast path: JSONL scan).
 *
 * Looks for `artifact_published` events to build an artifactId→artifactRef
 * map, then finds the first `fact_recorded` with kind "cwd" and reads the
 * CAS file at `{sessionDir}/cas/{artifactRef}`.
 */
async function readCwdArtifact(
  workspaceRoot: string,
  sessionId: SessionId,
  artifactRef: string,
): Promise<string | null> {
  try {
    const paths = createSessionPaths(workspaceRoot, sessionId);
    // artifactRef is already namespaced: "artifacts/sha256/<digest>".
    const casPath = join(paths.sessionDir, artifactRef);
    const bytes = await readFile(casPath);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function summarizeFast(
  workspaceRoot: string,
  sessionId: SessionId,
): Promise<SessionSummary | null> {
  let text: string;
  try {
    text = await readFile(
      join(
        workspaceRoot,
        storageDirectoryName(workspaceRoot),
        "sessions",
        sessionId,
        "log.jsonl",
      ),
      "utf8",
    );
  } catch {
    return null;
  }
  if (text.length === 0) return null;

  const lines = text.split("\n");
  let title: string | null = null;
  let turns = 0;
  let lastActivityAt: string | null = null;
  let lastRunId: string | undefined;
  let lastRunCompleted = false;
  let lastRunInterrupted = false;
  let sawEvent = false;
  // cwd fact resolution: track artifactRefs and the first cwd fact's artifactId
  // during this same pass, so the list needs no second read of the log.
  const artifactRefs = new Map<string, string>();
  let cwdArtifactId: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line === "") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // A torn tail (crash mid-append) is tolerated; anything earlier is
      // treated as corruption and handed back to the verified path.
      if (index === lines.length - 1) continue;
      return null;
    }
    if (typeof event !== "object" || event === null) return null;
    sawEvent = true;

    const type = event["type"];
    if (typeof event["at"] === "string") lastActivityAt = event["at"];

    if (cwdArtifactId === undefined) {
      const payload = event["payload"];
      if (typeof payload === "object" && payload !== null) {
        if (type === "artifact_published") {
          const artifactId = (payload as Record<string, unknown>)["artifactId"];
          const artifactRef = (payload as Record<string, unknown>)["artifactRef"];
          if (typeof artifactId === "string" && typeof artifactRef === "string") {
            artifactRefs.set(artifactId, artifactRef);
          }
        } else if (
          type === "fact_recorded" &&
          (payload as Record<string, unknown>)["kind"] === "cwd"
        ) {
          const artifactId = (payload as Record<string, unknown>)["artifactId"];
          if (typeof artifactId === "string") {
            cwdArtifactId = artifactId;
          }
        }
      }
    }

    if (type === "user_committed") {
      turns += 1;
      if (title !== null) continue;
      const payload = event["payload"];
      if (
        typeof payload === "object" &&
        payload !== null &&
        (payload as Record<string, unknown>)["enc"] === "b64" &&
        typeof (payload as Record<string, unknown>)["bytes"] === "string"
      ) {
        try {
          const content = viewUser(
            freezeBytes(
              Buffer.from((payload as Record<string, unknown>)["bytes"] as string, "base64"),
            ),
          ).content;
          title = titleFromUserContent(content);
        } catch {
          // keep title null; the verified path may still recover it
        }
      }
    } else if (type === "run_started") {
      if (typeof event["runId"] === "string") {
        lastRunId = event["runId"];
        lastRunCompleted = false;
        lastRunInterrupted = false;
      }
    } else if (type === "run_completed") {
      if (event["runId"] === lastRunId) lastRunCompleted = true;
    } else if (type === "run_interrupted") {
      if (event["runId"] === lastRunId) lastRunInterrupted = true;
    }
  }
  if (!sawEvent) return null;

  let cwd: string | null = null;
  if (cwdArtifactId !== undefined) {
    const artifactRef = artifactRefs.get(cwdArtifactId);
    if (artifactRef !== undefined) {
      cwd = await readCwdArtifact(workspaceRoot, sessionId, artifactRef);
    }
  }

  const state: SessionSummary["state"] =
    lastRunId === undefined
      ? "open"
      : lastRunCompleted
        ? "completed"
        : lastRunInterrupted
          ? "interrupted"
          : "open";

  return Object.freeze({
    sessionId,
    title,
    cwd,
    turns,
    lastActivityAt,
    state,
  });
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
    // A Session that cannot be replayed read-only is not listable. `flashcoder
    // inspect` still reports exactly why.
    return null;
  }
  if (events.length === 0) return null;

  let title: string | null = null;
  let turns = 0;
  let cwd: string | null = null;
  const artifactRefs = new Map<string, string>();
  let cwdArtifactId: string | undefined;
  for (const event of events) {
    if (event.type === "user_committed") {
      turns += 1;
      if (title === null) {
        const content = decodeInlineUserContent(event);
        if (content !== null) title = titleFromUserContent(content);
      }
    } else if (event.type === "artifact_published") {
      artifactRefs.set(event.payload.artifactId, event.payload.artifactRef);
    } else if (
      event.type === "fact_recorded" &&
      cwdArtifactId === undefined &&
      event.payload.kind === "cwd"
    ) {
      cwdArtifactId = event.payload.artifactId;
    }
  }
  if (cwdArtifactId !== undefined) {
    const artifactRef = artifactRefs.get(cwdArtifactId);
    if (artifactRef !== undefined) {
      cwd = await readCwdArtifact(workspaceRoot, sessionId, artifactRef);
    }
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
    cwd,
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
    entries = await readdir(
      join(workspaceRoot, storageDirectoryName(workspaceRoot), "sessions"),
    );
  } catch {
    return Object.freeze([]);
  }
  const sessionIds = entries
    .sort()
    .filter((entry) => SESSION_ID.test(entry)) as SessionId[];
  // Each session is read independently, so summarize them concurrently; the
  // result set and order are decided after the await, not by the read order.
  const summaries = (
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        // Fast structural path first; anything it cannot trust falls back to
        // the fully verified replay (same result set, same order).
        return (
          (await summarizeFast(workspaceRoot, sessionId)) ??
          (await summarize(workspaceRoot, sessionId))
        );
      }),
    )
  ).filter((summary): summary is SessionSummary => summary !== null);
  return Object.freeze(
    summaries.sort((left, right) =>
      (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? ""),
    ),
  );
}

/**
 * The Session `flashcoder continue` picks when the caller names none: the most
 * recently active one that is safe to append a new user turn to.
 *
 * Unlike the interactive list, this is a correctness path: the chosen Session
 * must actually replay, so each candidate is confirmed with the verified
 * open before it is returned.
 */
export async function mostRecentContinuableSession(
  workspaceRoot: string,
): Promise<SessionSummary | null> {
  const sessions = await listSessions(workspaceRoot);
  for (const session of sessions) {
    if (session.state !== "completed") continue;
    try {
      await openJournalReadOnly(workspaceRoot, session.sessionId);
      return session;
    } catch {
      // Structurally completed but not replayable — not safe to continue.
      continue;
    }
  }
  return null;
}

/**
 * The workspace path for one row, shortened from the left when it would
 * crowd the columns beside it. The home directory shortens to ~.
 */
function shortCwd(cwd: string | null): string {
  if (cwd === null || cwd === "") return "";
  const home = homedir();
  let shortened = cwd;
  if (home !== undefined && cwd.startsWith(home)) {
    shortened = `~${cwd.slice(home.length)}`;
  }
  const limit = 40;
  if (shortened.length > limit) {
    return `…${shortened.slice(-(limit - 1))}`;
  }
  return shortened;
}

/** `2026-08-11 15:11`, in the reader's own timezone. */
function localWhen(timestamp: string | null): string {
  if (timestamp === null) return "-".padEnd(16);
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) return "-".padEnd(16);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    ` ${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

/**
 * One unpainted row per Session, trimmed to the room available.
 *
 * The id sits on the right, where it is out of the way of the two things you
 * read a list like this for — when you were last in a Session and what you were
 * doing in it — but still copyable into `flashcoder continue`. Between them the
 * subject takes whatever room is left; the turn count is dropped before the
 * subject is squeezed under twenty columns, and the subject goes before the
 * number, the date, the state or the id do.
 */
export function sessionListRows(
  sessions: readonly SessionSummary[],
  currentSessionId: SessionId | null,
  room: number,
): readonly Readonly<{ text: string; current: boolean }>[] {
  const ordinal = Math.max(2, String(sessions.length).length);
  // number, date and state on the left; the id on the right. What is left over
  // is shared by the turn count and the subject, each with its own separator.
  const head = ordinal + 2 + 16 + 2 + 11;
  const tail = 2 + 36;
  const free = room - head - tail;
  const withTurns = free >= 2 + 8 + 2 + 20;
  const subject = withTurns ? free - 10 - 2 : free - 2;
  return Object.freeze(
    sessions.map((session, index) => {
      const turns = `${String(session.turns)} turn${session.turns === 1 ? "" : "s"}`;
      const columns = [
        String(index + 1).padStart(ordinal),
        localWhen(session.lastActivityAt),
        session.state.padEnd(11),
      ];
      if (withTurns) columns.push(turns.padEnd(8));
      const title = session.title ?? "(no inline prompt)";
      if (subject >= 8) {
        columns.push(
          (title.length > subject ? `${title.slice(0, subject - 1)}…` : title)
            .padEnd(subject),
        );
      }
      const left = columns.join("  ");
      const cwd = shortCwd(session.cwd);
      const cwdPart = cwd ? `  [${cwd}]` : "";
      return Object.freeze({
        text: `${left}  ${session.sessionId}${cwdPart}`,
        current: session.sessionId === currentSessionId,
      });
    }),
  );
}

export function formatSessionList(
  sessions: readonly SessionSummary[],
): string {
  if (sessions.length === 0) return "no sessions in this workspace\n";
  const lines = sessions.map((session) => {
    const turns = `${String(session.turns)} turn${session.turns === 1 ? "" : "s"}`;
    const title = session.title ?? "(no inline prompt)";
    const cwd = shortCwd(session.cwd);
    const cwdPart = cwd ? `  [${cwd}]` : "";
    return `${session.sessionId}  ${localWhen(session.lastActivityAt)}  ${session.state.padEnd(11)}  ${turns.padEnd(8)}  ${title}${cwdPart}`;
  });
  return `${lines.join("\n")}\n`;
}
