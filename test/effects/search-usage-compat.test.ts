import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import type { DeepSeekWebSearchResponse } from "../../src/ds/web-search.js";
import { createVerifiedJournalEvent, encodeVerifiedJournalEvent } from "../../src/journal/schema.js";
import { openJournalReadOnly } from "../../src/journal/open.js";
import { buildCacheAbiV2 } from "../../src/lineage/cache-abi.js";
import {
  createRuntimeFixture,
  RUNTIME_FIXTURE_SESSION_ID,
  toolCall,
  type RuntimeFixture,
} from "./runtime-fixture.js";

function webSearchFixtureResponse(): DeepSeekWebSearchResponse {
  return Object.freeze({
    searchId: "srch_compat",
    answer: "DeepSeek published the fixture headline story.",
    queries: Object.freeze(["DeepSeek fixture query"]),
    openedUrls: Object.freeze(["https://example.com/story"]),
    usage: Object.freeze({
      inputTokens: 100,
      promptCacheHitTokens: 70,
      outputTokens: 40,
      reasoningTokens: 10,
    }),
  });
}

/**
 * Rewrites the last journal record in place. The writer that produced it is
 * still open, so this is only for tests; the returned fixture must not be
 * written to again.
 */
async function rewriteLastEvent(
  fixture: RuntimeFixture,
  mutate: (event: {
    readonly type: string;
    readonly sessionId: string;
    readonly lineageId?: string;
    readonly runId?: string;
    readonly parentId?: string;
    readonly payload: Record<string, unknown>;
    readonly seq: number;
    readonly id: string;
    readonly at: string;
    readonly prevHash: string | null;
  }) => void,
): Promise<void> {
  const logPath = fixture.opened.paths.logPath;
  const text = await readFile(logPath, "utf8");
  const lines = text.trimEnd().split("\n");
  const last = JSON.parse(lines[lines.length - 1]!);
  mutate(last);
  const rebuilt = createVerifiedJournalEvent(
    {
      type: last["type"],
      sessionId: last["sessionId"],
      ...(last["lineageId"] === undefined ? {} : { lineageId: last["lineageId"] }),
      ...(last["runId"] === undefined ? {} : { runId: last["runId"] }),
      ...(last["parentId"] === undefined ? {} : { parentId: last["parentId"] }),
      payload: last["payload"],
    },
    {
      seq: last["seq"],
      id: last["id"],
      at: last["at"],
      prevHash: last["prevHash"],
    },
  );
  const encoded = Buffer.from(encodeVerifiedJournalEvent(rebuilt).copy()).toString("utf8");
  await writeFile(logPath, `${lines.slice(0, -1).join("\n")}\n${encoded}\n`);
}

test("replay accepts a successful web_search result recorded without searchUsage, as pre-search-cost writers left it", async (t) => {
  const call = toolCall(
    "call_legacy_search",
    "web_search",
    JSON.stringify({ search_query: "legacy journal" }),
  );
  const fixture = await createRuntimeFixture(t, [call], {
    cacheAbi: buildCacheAbiV2(),
    webSearch: async () => webSearchFixtureResponse(),
  });
  await fixture.runtime.execute(fixture.calls, new AbortController().signal);

  await rewriteLastEvent(fixture, (event) => {
    assert.equal(event.type, "tool_result_committed");
    delete event.payload["searchUsage"];
  });

  const reopened = await openJournalReadOnly(
    fixture.workspace,
    RUNTIME_FIXTURE_SESSION_ID,
  );
  const committed = reopened.replay.events.filter(
    (event) => event.type === "tool_result_committed",
  );
  assert.equal(committed.length, 1);
  assert.equal(committed[0]!.payload.searchUsage, undefined);
});

test("replay still rejects searchUsage on a non-web_search result", async (t) => {
  const call = toolCall("call_bash_usage", "bash", JSON.stringify({ command: "echo hi" }));
  const fixture = await createRuntimeFixture(t, [call], {
    cacheAbi: buildCacheAbiV2(),
    webSearch: async () => {
      throw new Error("unused in this fixture");
    },
  });
  await fixture.runtime.execute(fixture.calls, new AbortController().signal);

  await rewriteLastEvent(fixture, (event) => {
    assert.equal(event.type, "tool_result_committed");
    event.payload["searchUsage"] = {
      inputTokens: 1,
      promptCacheHitTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
    };
  });

  await assert.rejects(
    openJournalReadOnly(fixture.workspace, RUNTIME_FIXTURE_SESSION_ID),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "JOURNAL_REFERENCE",
  );
});
