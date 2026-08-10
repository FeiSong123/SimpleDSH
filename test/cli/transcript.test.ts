import assert from "node:assert/strict";
import test from "node:test";

import { duration, money, tokens } from "../../src/cli/theme.js";
import { formatToolActivity } from "../../src/cli/transcript.js";
import type { ToolActivity } from "../../src/session/index.js";

function activity(over: Partial<ToolActivity>): ToolActivity {
  return {
    phase: "settled",
    name: "read",
    arguments: "{}",
    ...over,
  } as ToolActivity;
}

test("a tool line names the tool and its subject", () => {
  // Without this the user sees the model's words but not its actions, which is
  // what made the first hand-written UI unusable.
  const line = formatToolActivity(
    activity({ name: "read", arguments: '{"path":"src/a.ts"}' }),
  );
  assert.match(line, /read/u);
  assert.match(line, /src\/a\.ts/u);
});

test("bash shows the command, not the path", () => {
  const line = formatToolActivity(
    activity({ name: "bash", arguments: '{"command":"npm test"}' }),
  );
  assert.match(line, /npm test/u);
});

test("only the first line of a multi-line command is shown", () => {
  const line = formatToolActivity(
    activity({ name: "bash", arguments: '{"command":"one\\ntwo\\nthree"}' }),
  );
  assert.match(line, /one/u);
  assert.doesNotMatch(line, /two/u);
});

test("a long subject is truncated", () => {
  const line = formatToolActivity(
    activity({ name: "bash", arguments: `{"command":"${"x".repeat(200)}"}` }),
  );
  assert.ok(line.length < 200);
  assert.match(line, /…/u);
});

test("a failure shows its code, a success does not", () => {
  const failed = formatToolActivity(
    activity({
      name: "edit",
      arguments: '{"path":"a.ts"}',
      status: "failed",
      code: "edit_no_match",
    }),
  );
  assert.match(failed, /edit_no_match/u);

  const ok = formatToolActivity(
    activity({ name: "edit", arguments: '{"path":"a.ts"}', status: "succeeded" }),
  );
  assert.doesNotMatch(ok, /succeeded/u);
});

test("unparseable arguments still produce a line", () => {
  // The arguments come from the model; a renderer must not throw on them.
  for (const bad of ["not json", "", "[]", "null"]) {
    const line = formatToolActivity(activity({ name: "bash", arguments: bad }));
    assert.match(line, /bash/u);
  }
});

test("money reads like money", () => {
  assert.equal(money("0"), "$0");
  assert.equal(money("0.000139675200"), "$0.0001");
  assert.equal(money("1.500000000000"), "$1.50");
});

test("duration and token counts stay short", () => {
  assert.equal(duration(450), "450ms");
  assert.equal(duration(1700), "1.7s");
  assert.equal(duration(95_000), "1m35s");
  assert.equal(tokens(833), "833");
  assert.equal(tokens(15_400), "15K");
  assert.equal(tokens(1_250_000), "1.3M");
});
