import assert from "node:assert/strict";
import test from "node:test";

import { sessionListRows } from "../../src/cli/sessions.js";
import type { SessionSummary } from "../../src/cli/sessions.js";
import type { SessionId } from "../../src/journal/types.js";

const WIDE = 100;
/** Local time, so the test pins the shape rather than the reader's timezone. */
const STAMP = /^ ?\d+ {2}\d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}/u;

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

test("a row is a number, a date and what you were doing", () => {
  // Not the session id: 36 columns of hex tells two sessions apart in theory
  // and never in practice. The number is how you name one back.
  const [row] = sessionListRows([summary("a")], null, WIDE);
  assert.match(row?.text ?? "", STAMP);
  assert.doesNotMatch(row?.text ?? "", /ses_/u);
  assert.match(row?.text ?? "", /completed {4}3 turns {3}fix the failing case$/u);
});

test("the rows are numbered from one, in the order given", () => {
  const rows = sessionListRows(
    [summary("a"), summary("b"), summary("c")],
    null,
    WIDE,
  );
  assert.deepEqual(
    rows.map(({ text }) => text.trimStart().split(" ")[0]),
    ["1", "2", "3"],
  );
});

test("the current session is the marked one", () => {
  const current = summary("b");
  const rows = sessionListRows(
    [summary("a"), current, summary("c")],
    current.sessionId,
    WIDE,
  );
  assert.deepEqual(
    rows.map(({ current: isCurrent }) => isCurrent),
    [false, true, false],
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
  // The title gives way first, then the turn count; the number, the date and
  // the state are what the row is for and never go.
  const long = summary("a", {
    title: "make the compaction threshold reachable and the flags with it",
  });
  for (const room of [120, 100, 80, 60, 44, 36]) {
    const [row] = sessionListRows([long], null, room);
    assert.ok(row !== undefined);
    assert.ok(
      row.text.length <= Math.max(room, 33),
      `${String(row.text.length)} columns in room ${String(room)}`,
    );
    assert.match(row.text, STAMP);
    assert.match(row.text, /completed/u);
  }
});

test("a session with no recorded activity still gets a row", () => {
  const [row] = sessionListRows(
    [summary("a", { lastActivityAt: null })],
    null,
    WIDE,
  );
  assert.match(row?.text ?? "", /^ 1 {2}- +completed/u);
});

test("a session with no inline prompt says so", () => {
  const [row] = sessionListRows([summary("a", { title: null })], null, WIDE);
  assert.match(row?.text ?? "", /\(no inline prompt\)$/u);
});

test("one turn is not one turns", () => {
  const [one] = sessionListRows([summary("a", { turns: 1 })], null, WIDE);
  const [two] = sessionListRows([summary("b", { turns: 2 })], null, WIDE);
  assert.match(one?.text ?? "", /1 turn {4}/u);
  assert.match(two?.text ?? "", /2 turns {3}/u);
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
