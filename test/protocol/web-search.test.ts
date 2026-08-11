import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ClientRequest } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { credentialFromSecret } from "../../src/ds/credential.js";
import { DeepSeekHttpError, DeepSeekProtocolError } from "../../src/ds/errors.js";
import { DeepSeekTransportError } from "../../src/ds/transport.js";
import {
  runDeepSeekWebSearch,
  DEEPSEEK_WEB_SEARCH_ENDPOINT,
  type DeepSeekWebSearchHttpsRequestFunction,
} from "../../src/ds/web-search.js";

interface ResponsePlan {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly chunks?: Iterable<Uint8Array>;
  readonly start?: boolean;
}

interface RequestCapture {
  options: Record<string, unknown>;
  body: string;
}

class FakeRequest extends EventEmitter {
  destroyed = false;
  private response: Readable | undefined;

  constructor(
    private readonly capture: RequestCapture,
    private readonly plan: ResponsePlan,
    private readonly callback: (response: IncomingMessage) => void,
  ) {
    super();
  }

  write(chunk: Uint8Array): boolean {
    this.capture.body = Buffer.concat([
      Buffer.from(this.capture.body),
      Buffer.from(chunk),
    ]).toString("utf8");
    return true;
  }

  end(): void {
    if (this.plan.start === false) return;
    queueMicrotask(() => {
      if (this.destroyed) return;
      const socket = Object.assign(new EventEmitter(), { connecting: false });
      this.emit("socket", socket);
      const response = Readable.from(this.plan.chunks ?? []);
      Object.assign(response, {
        statusCode: this.plan.status,
        headers: this.plan.headers ?? {},
      });
      this.response = response;
      this.callback(response as unknown as IncomingMessage);
    });
  }

  destroy(error?: Error): this {
    this.destroyed = true;
    this.response?.destroy(error);
    return this;
  }
}

function fakeRequest(
  plan: ResponsePlan,
  capture: RequestCapture,
): DeepSeekWebSearchHttpsRequestFunction {
  return (options, callback) => {
    capture.options = options as unknown as Record<string, unknown>;
    return new FakeRequest(capture, plan, callback) as unknown as ClientRequest;
  };
}

function searchResponseJson(): string {
  return JSON.stringify({
    id: "resp_web_search_test",
    object: "response",
    created_at: 1786438749,
    status: "completed",
    error: null,
    output: [
      {
        type: "reasoning",
        id: "rsn_1",
        status: "completed",
        content: [{ type: "reasoning_text", text: "The user wants current facts." }],
        summary: [],
      },
      {
        type: "web_search_call",
        id: "call_00_abc",
        status: "completed",
        action: {
          type: "search",
          queries: [
            "DeepSeek latest news",
            "DeepSeek 2026",
            "ws_call_id=call_00_abc",
          ],
        },
      },
      {
        type: "web_search_call",
        id: "call_01_def",
        status: "completed",
        action: { type: "open_page", url: "https://news.example.com/deepseek" },
      },
      {
        type: "web_search_call",
        id: "call_02_ghi",
        status: "failed",
        action: { type: "open_page", url: "#ws_call_id=call_02_ghi" },
      },
      {
        type: "web_search_call",
        id: "call_03_jkl",
        status: "completed",
        action: {
          type: "open_page",
          url: "https://news.example.com/story#ws_call_id=call_03_jkl",
        },
      },
      {
        type: "message",
        id: "msg_commentary",
        status: "completed",
        content: [
          { type: "output_text", text: "I will search for the latest DeepSeek news.", annotations: [], logprobs: [] },
        ],
        phase: "commentary",
        role: "assistant",
      },
      {
        type: "message",
        id: "msg_final",
        status: "completed",
        content: [
          { type: "output_text", text: "DeepSeek released ", annotations: [], logprobs: [] },
          { type: "output_text", text: "V4-Flash in July 2026.", annotations: [], logprobs: [] },
        ],
        phase: "final_answer",
        role: "assistant",
      },
    ],
    usage: {
      input_tokens: 2902,
      input_tokens_details: { cached_tokens: 512 },
      output_tokens: 378,
      output_tokens_details: { reasoning_tokens: 97 },
      total_tokens: 3280,
    },
  });
}

test("web search posts the query to the official Responses API with the web_search tool", async () => {
  const capture: RequestCapture = { options: {}, body: "" };
  const result = await runDeepSeekWebSearch({
    credential: credentialFromSecret("sk-test-secret"),
    searchQuery: "DeepSeek latest news",
    searchLocale: "en-US",
    requestFunction: fakeRequest(
      { status: 200, chunks: [new TextEncoder().encode(searchResponseJson())] },
      capture,
    ),
  });

  assert.equal(capture.options["method"], "POST");
  assert.equal(capture.options["hostname"], "api.deepseek.com");
  assert.equal(capture.options["path"], "/responses");
  assert.equal(
    (capture.options["headers"] as Record<string, string>)["authorization"],
    "Bearer sk-test-secret",
  );
  const body = JSON.parse(capture.body);
  assert.equal(body.model, "deepseek-v4-flash");
  assert.deepEqual(body.tools, [{ type: "web_search" }]);
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.stream, false);
  assert.deepEqual(body.input, [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "DeepSeek latest news" }],
    },
  ]);
  assert.match(body.instructions as string, /locale: en-US/u);

  assert.equal(result.searchId, "resp_web_search_test");
  assert.equal(result.answer, "DeepSeek released V4-Flash in July 2026.");
  assert.deepEqual(result.queries, ["DeepSeek latest news", "DeepSeek 2026"]);
  assert.deepEqual(result.openedUrls, [
    "https://news.example.com/deepseek",
    "https://news.example.com/story",
  ]);
  assert.deepEqual(result.usage, {
    inputTokens: 2902,
    outputTokens: 378,
    reasoningTokens: 97,
  });
});

test("web search omits the locale from instructions when none was requested", async () => {
  const capture: RequestCapture = { options: {}, body: "" };
  await runDeepSeekWebSearch({
    credential: credentialFromSecret("sk-test-secret"),
    searchQuery: "news",
    requestFunction: fakeRequest(
      { status: 200, chunks: [new TextEncoder().encode(searchResponseJson())] },
      capture,
    ),
  });
  const body = JSON.parse(capture.body);
  assert.equal(
    (body.instructions as string).includes("locale: en-US"),
    false,
  );
});

test("web search rejects non-200 responses with the HTTP status", async () => {
  await assert.rejects(
    runDeepSeekWebSearch({
      credential: credentialFromSecret("sk-test-secret"),
      searchQuery: "news",
      requestFunction: fakeRequest({ status: 429 }, { options: {}, body: "" }),
    }),
    (error: unknown) =>
      error instanceof DeepSeekHttpError && error.status === 429,
  );
});

test("web search rejects malformed or invalid response bodies", async () => {
  const cases: readonly string[] = [
    "not json",
    JSON.stringify({}),
    JSON.stringify({ id: "x" }),
    JSON.stringify({ id: "x", output: [{ type: "web_search_call" }] }),
    JSON.stringify({ id: "x", output: [], usage: {} }),
    JSON.stringify({
      id: "x",
      output: [{ type: "message", content: [{ type: "output_text", text: 1 }] }],
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
    JSON.stringify({ id: "x", output: [], usage: { input_tokens: -1, output_tokens: 0 } }),
  ];
  for (const body of cases) {
    await assert.rejects(
      runDeepSeekWebSearch({
        credential: credentialFromSecret("sk-test-secret"),
        searchQuery: "news",
        requestFunction: fakeRequest(
          { status: 200, chunks: [new TextEncoder().encode(body)] },
          { options: {}, body: "" },
        ),
      }),
      (error: unknown) => error instanceof DeepSeekProtocolError,
      body,
    );
  }
});

test("web search rejects invalid query and locale arguments before any request", async () => {
  await assert.rejects(
    async () => {
      runDeepSeekWebSearch({
        credential: credentialFromSecret("sk-test-secret"),
        searchQuery: "",
        requestFunction: fakeRequest({ status: 200 }, { options: {}, body: "" }),
      });
    },
    TypeError,
  );
  await assert.rejects(
    async () => {
      runDeepSeekWebSearch({
        credential: credentialFromSecret("sk-test-secret"),
        searchQuery: "news",
        searchLocale: "not a locale!",
        requestFunction: fakeRequest({ status: 200 }, { options: {}, body: "" }),
      });
    },
    TypeError,
  );
});

test("web search aborts in-flight requests as cancelled", async () => {
  const controller = new AbortController();
  const pending = runDeepSeekWebSearch({
    credential: credentialFromSecret("sk-test-secret"),
    searchQuery: "news",
    signal: controller.signal,
    requestFunction: fakeRequest(
      { status: 200, start: false, chunks: [] },
      { options: {}, body: "" },
    ),
  });
  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof DeepSeekTransportError && error.kind === "cancelled",
  );
});

test("web search endpoint constant is the official Responses API path", () => {
  assert.equal(
    DEEPSEEK_WEB_SEARCH_ENDPOINT,
    "https://api.deepseek.com/responses",
  );
});
