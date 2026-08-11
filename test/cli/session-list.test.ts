import assert from "node:assert/strict";
import test from "node:test";

import { sessionListRows } from "../../src/cli/sessions.js";
import type { SessionSummary } from "../../src/cli/sessions.js";
import type { SessionId } from "../../src/journal/types.js";

const WIDE = 100;

function summary(
  suffix: string,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return Object.freeze({
    sessionId: `ses_${suffix.repeat(32).slice(0, 32)}` as SessionId,
    title: "fix the failing case",
    cwd: null,
    turns: 3,
    lastActivityAt: "2026-08-11T15:00:00.000Z",
    state: "completed",
    ...overrides,
  }) as SessionSummary;
}

test("every session is one row, and the current one is marked", () => {
  const current = summary("a");
  const rows = sessionListRows(
    [current, summary("b")],
    current.sessionId,
    WIDE,
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map(({ current: isCurrent }) => isCurrent),
    [true, false],
  );
  assert.equal(
    rows[0]?.text,
    `ses_${"a".repeat(32)}  completed    3 turns   fix the failing case`,
  );
});

test("nothing is marked when the session has not started", () => {
  const rows = sessionListRows([summary("a"), summary("b")], null, WIDE);
  assert.deepEqual(
    rows.map(({ current }) => current),
    [false, false],
  );
});

test("a row never outgrows the room it was given", () => {
  // A session id alone is 36 columns, so the title and then the turn count have
  // to give way rather than wrapping the row onto a second line.
  const long = summary("a", {
    title: "make the compaction threshold reachable and the flags with it",
  });
  for (const room of [120, 100, 80, 70, 60, 50, 40]) {
    const [row] = sessionListRows([long], null, room);
    assert.ok(row !== undefined);
    assert.ok(
      row.text.length <= Math.max(room, 36 + 2 + 11),
      `${String(row.text.length)} columns in room ${String(room)}`,
    );
    // The identity and the state are what the row is for; they never go.
    assert.match(row.text, /^ses_a+ {2}completed/u);
  }
});

test("a session with no inline prompt still says something", () => {
  const [row] = sessionListRows([summary("a", { title: null })], null, WIDE);
  assert.match(row?.text ?? "", /\(no inline prompt\)$/u);
});

test("one turn is not one turns", () => {
  const [one] = sessionListRows([summary("a", { turns: 1 })], null, WIDE);
  const [two] = sessionListRows([summary("b", { turns: 2 })], null, WIDE);
  assert.match(one?.text ?? "", /1 turn {3}/u);
  assert.match(two?.text ?? "", /2 turns {2}/u);
});

test("an interrupted session is listed, and says it is interrupted", () => {
  // It is not resumable with `continue` — it needs `recover` first — so hiding
  // it would leave the reason a session is missing invisible.
  const [row] = sessionListRows(
    [summary("a", { state: "interrupted" })],
    null,
    WIDE,
  );
  assert.match(row?.text ?? "", /interrupted/u);
});
