import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { materializeAssistant } from "../../src/bytes/assistant.js";
import { DEEPSEEK_MODEL } from "../../src/bytes/request.js";
import type { CompletedDeepSeekResponse, DeepSeekUsage } from "../../src/ds/types.js";
import type {
  CanonicalTimestamp,
  EventId,
  EventIdentitySource,
  SessionId,
} from "../../src/journal/index.js";
import {
  recoverSessionFixture,
  runSessionFixture,
  type SessionFixtureTurn,
} from "../../src/session/index.js";

const FIXED_AT = "2026-08-10T09:00:00.000Z" as CanonicalTimestamp;
const fixedClock = Object.freeze({ now: () => FIXED_AT });

function sessionId(fill: string): SessionId {
  return `ses_${fill.repeat(32)}` as SessionId;
}

function eventIds(fill: string): EventIdentitySource {
  let counter = 0;
  return Object.freeze({
    nextEventId: () => {
      counter += 1;
      return `evt_${fill}${counter.toString(16).padStart(31, "0")}` as EventId;
    },
  });
}

async function workspace(t: TestContext, label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dsh-trunc-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function usage(rawFinishReason: string): DeepSeekUsage {
  return Object.freeze({
    promptTokens: 100,
    promptCacheHitTokens: 80,
    promptCacheMissTokens: 20,
    completionTokens: 65_536,
    reasoningTokens: 65_000,
    rawFinishReason,
  });
}

/** A reply with no tool calls, ended by whatever the provider reported. */
function reply(text: string, rawFinishReason: string): SessionFixtureTurn {
  const message = Object.freeze({
    content: text,
    reasoningContent: "thinking",
    toolCalls: Object.freeze([]),
  });
  const response: CompletedDeepSeekResponse = Object.freeze({
    assistantBytes: materializeAssistant(message),
    content: message.content,
    reasoningContent: message.reasoningContent,
    toolCalls: message.toolCalls,
    usage: usage(rawFinishReason),
    providerRequestId: `req_${rawFinishReason}`,
    responseModel: DEEPSEEK_MODEL,
    systemFingerprint: null,
    semanticDeltaCount: 1,
  });
  return Object.freeze({
    kind: "success" as const,
    response,
    fragments: Object.freeze([Object.freeze({ kind: "content" as const, text })]),
  });
}

test("a reply cut off at the output limit is reported as truncated", async (t) => {
  // The whole failure this guards: the model spends its output budget thinking,
  // never emits a tool call, and the fragment it managed to write is handed
  // back as the answer because "no tool calls" was read as "the model is done".
  const root = await workspace(t, "length");
  const result = await runSessionFixture({
    workspaceRoot: root,
    sessionId: sessionId("1"),
    userInput: "Solve it.",
    turns: [reply("Phase 3 removes the comment, then the rest", "length")],
    clock: fixedClock,
    eventIds: eventIds("a"),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.truncated, true);
  // The Session is still intact: the bytes are durable and the boundary stands,
  // which is what lets the caller simply take another turn.
  assert.ok(result.commitBoundaryId.length > 0);
});

test("a reply the model chose to end is not truncated", async (t) => {
  const root = await workspace(t, "stop");
  const result = await runSessionFixture({
    workspaceRoot: root,
    sessionId: sessionId("2"),
    userInput: "Solve it.",
    turns: [reply("Done.", "stop")],
    clock: fixedClock,
    eventIds: eventIds("b"),
  });
  assert.equal(result.truncated, false);
});

test("replay reads truncation back from the durable record", async (t) => {
  // The recovery path never sees the response, so it has to read the finish
  // reason off the committed assistant event rather than recompute it.
  const root = await workspace(t, "replay");
  const id = sessionId("3");
  const first = await runSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "Solve it.",
    turns: [reply("cut off mid-", "length")],
    clock: fixedClock,
    eventIds: eventIds("c"),
  });
  assert.equal(first.truncated, true);

  const replayed = await recoverSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    turns: [],
    clock: fixedClock,
    eventIds: eventIds("d"),
  });
  assert.equal(replayed.truncated, true);
});
