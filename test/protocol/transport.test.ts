import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import test from "node:test";

import { buildDeepSeekRequestSnapshot } from "../../src/bytes/request.js";
import { ACTIVE_SYSTEM_MESSAGE_BYTES } from "../../src/bytes/system.js";
import { loadDeepSeekCredential } from "../../src/ds/credential.js";
import type { DeepSeekRetryDecision } from "../../src/ds/errors.js";
import {
  DEEPSEEK_CONNECT_TIMEOUT_MS,
  DEEPSEEK_SEMANTIC_IDLE_TIMEOUT_MS,
  DEEPSEEK_TTFB_TIMEOUT_MS,
  DeepSeekDurabilityError,
  DeepSeekTransportError,
  runDeepSeekTransportFixtureAttempt,
  runDeepSeekTransportFixtureWithRetry,
  type DeepSeekHttpsRequestFunction,
  type DeepSeekTimerDriver,
} from "../../src/ds/transport.js";

const fixtureKey = "sk-fixture-transport-02";

class ManualTimers implements DeepSeekTimerDriver {
  private nextHandle = 1;
  private readonly pending = new Map<
    number,
    { readonly callback: () => void; readonly delayMs: number }
  >();

  readonly set = (callback: () => void, delayMs: number): unknown => {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.pending.set(handle, { callback, delayMs });
    return handle;
  };

  readonly clear = (handle: unknown): void => {
    if (typeof handle === "number") this.pending.delete(handle);
  };

  delays(): readonly number[] {
    return [...this.pending.values()].map((entry) => entry.delayMs);
  }

  fireFirst(delayMs: number): void {
    const entry = [...this.pending.entries()].find(
      ([, candidate]) => candidate.delayMs === delayMs,
    );
    assert.notEqual(entry, undefined, `missing timer ${delayMs}`);
    if (entry === undefined) return;
    this.pending.delete(entry[0]);
    entry[1].callback();
  }
}

interface ResponsePlan {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly chunks?: Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
  readonly start?: boolean;
}

interface RequestCapture {
  readonly options: HttpsRequestOptions;
  readonly bodyParts: Uint8Array[];
  request: FakeRequest;
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
    this.capture.bodyParts.push(Uint8Array.from(chunk));
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
      this.callback(response as IncomingMessage);
    });
  }

  destroy(error?: Error): this {
    this.destroyed = true;
    this.response?.destroy(error);
    return this;
  }
}

function fakeRequestSequence(
  plans: readonly ResponsePlan[],
  captures: RequestCapture[],
): DeepSeekHttpsRequestFunction {
  let index = 0;
  return (options, callback) => {
    const plan = plans[index];
    assert.notEqual(plan, undefined, "unexpected request attempt");
    index += 1;
    const capture = {
      options,
      bodyParts: [],
    } as unknown as RequestCapture;
    const request = new FakeRequest(capture, plan ?? { status: 599 }, callback);
    capture.request = request;
    captures.push(capture);
    return request as unknown as ClientRequest;
  };
}

function completedSse(content = "ok"): Uint8Array {
  const encoder = new TextEncoder();
  const lines = [
    {
      id: "req_fixture",
      model: "deepseek-v4-flash",
      system_fingerprint: "fp_fixture",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", reasoning_content: "reason" },
          finish_reason: null,
        },
      ],
      usage: null,
    },
    {
      id: "req_fixture",
      model: "deepseek-v4-flash",
      system_fingerprint: "fp_fixture",
      choices: [
        { index: 0, delta: { content }, finish_reason: null },
      ],
      usage: null,
    },
    {
      id: "req_fixture",
      model: "deepseek-v4-flash",
      system_fingerprint: "fp_fixture",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: null,
    },
    {
      id: "req_fixture",
      model: "deepseek-v4-flash",
      system_fingerprint: "fp_fixture",
      choices: [],
      usage: {
        prompt_tokens: 12,
        prompt_cache_hit_tokens: 10,
        prompt_cache_miss_tokens: 2,
        completion_tokens: 5,
        total_tokens: 17,
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    },
  ].map((value) => `data: ${JSON.stringify(value)}\n\n`);
  return encoder.encode(`${lines.join("")}data: [DONE]\n\n`);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 30; count += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}

test("backend sends exact snapshot only to official endpoint with redacted metadata", async () => {
  const snapshot = buildDeepSeekRequestSnapshot([ACTIVE_SYSTEM_MESSAGE_BYTES]);
  const credential = loadDeepSeekCredential({
    environment: { DEEPSEEK_API_KEY: fixtureKey },
  });
  const captures: RequestCapture[] = [];
  const metadata: unknown[] = [];
  const result = await runDeepSeekTransportFixtureAttempt(snapshot, credential, {
    requestFunction: fakeRequestSequence(
      [
        {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
          chunks: [completedSse()],
        },
      ],
      captures,
    ),
    timerDriver: new ManualTimers(),
    onRequestMetadata: (value) => metadata.push(value),
  });

  const capture = captures[0];
  assert.notEqual(capture, undefined);
  assert.equal(capture?.options.protocol, "https:");
  assert.equal(capture?.options.hostname, "api.deepseek.com");
  assert.equal(capture?.options.port, 443);
  assert.equal(capture?.options.path, "/chat/completions");
  assert.equal(capture?.options.method, "POST");
  assert.deepEqual(capture?.bodyParts, [snapshot.body.copy()]);
  assert.equal(result.content, "ok");
  assert.equal(JSON.stringify(metadata).includes(fixtureKey), false);
  assert.match(JSON.stringify(metadata), /\[REDACTED\]/u);
});

test("offline local HTTP fixture exercises the concrete Node stream seam", async (t) => {
  const snapshot = buildDeepSeekRequestSnapshot([ACTIVE_SYSTEM_MESSAGE_BYTES]);
  let receivedBody = new Uint8Array();
  const server = createServer((request, response) => {
    const parts: Uint8Array[] = [];
    request.on("data", (part: Buffer) => parts.push(Uint8Array.from(part)));
    request.on("end", () => {
      const byteLength = parts.reduce((total, part) => total + part.byteLength, 0);
      receivedBody = new Uint8Array(byteLength);
      let offset = 0;
      for (const part of parts) {
        receivedBody.set(part, offset);
        offset += part.byteLength;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const payload = completedSse("local-node-stream");
      for (let index = 0; index < payload.byteLength; index += 7) {
        response.write(payload.subarray(index, index + 7));
      }
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  );
  const address = server.address() as AddressInfo;
  const requestFunction: DeepSeekHttpsRequestFunction = (official, callback) =>
    httpRequest(
      {
        hostname: "127.0.0.1",
        port: address.port,
        method: official.method,
        path: "/fixture",
        headers: official.headers,
      },
      callback,
    );

  const result = await runDeepSeekTransportFixtureAttempt(
    snapshot,
    loadDeepSeekCredential({ environment: { DEEPSEEK_API_KEY: fixtureKey } }),
    { requestFunction },
  );
  assert.equal(result.content, "local-node-stream");
  assert.deepEqual(receivedBody, snapshot.body.copy());
});

test("SSE keep-alive does not reset absolute TTFB timeout", async () => {
  const timers = new ManualTimers();
  const captures: RequestCapture[] = [];
  async function* hanging(): AsyncIterable<Uint8Array> {
    yield new TextEncoder().encode(": keep-alive\n\n");
    await new Promise<never>(() => undefined);
  }
  const pending = runDeepSeekTransportFixtureAttempt(
    buildDeepSeekRequestSnapshot([ACTIVE_SYSTEM_MESSAGE_BYTES]),
    loadDeepSeekCredential({ environment: { DEEPSEEK_API_KEY: fixtureKey } }),
    {
      requestFunction: fakeRequestSequence(
        [
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            chunks: hanging(),
          },
        ],
        captures,
      ),
      timerDriver: timers,
    },
  );
  await waitUntil(() => timers.delays().includes(DEEPSEEK_TTFB_TIMEOUT_MS));
  timers.fireFirst(DEEPSEEK_TTFB_TIMEOUT_MS);
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof DeepSeekTransportError &&
      error.kind === "timeout" &&
      error.code === "TTFB_TIMEOUT",
  );
  assert.equal(captures[0]?.request.destroyed, true);
});

test("semantic delta arms idle timeout and keep-alive cannot reset it", async () => {
  const timers = new ManualTimers();
  const captures: RequestCapture[] = [];
  async function* hanging(): AsyncIterable<Uint8Array> {
    const first = {
      id: "req_idle",
      model: "deepseek-v4-flash",
      system_fingerprint: null,
      choices: [
        {
          index: 0,
          delta: { reasoning_content: "started" },
          finish_reason: null,
        },
      ],
      usage: null,
    };
    yield new TextEncoder().encode(`data: ${JSON.stringify(first)}\n\n`);
    yield new TextEncoder().encode(": keep-alive\n\n");
    await new Promise<never>(() => undefined);
  }
  const pending = runDeepSeekTransportFixtureAttempt(
    buildDeepSeekRequestSnapshot([ACTIVE_SYSTEM_MESSAGE_BYTES]),
    loadDeepSeekCredential({ environment: { DEEPSEEK_API_KEY: fixtureKey } }),
    {
      requestFunction: fakeRequestSequence(
        [
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            chunks: hanging(),
          },
        ],
        captures,
      ),
      timerDriver: timers,
    },
  );
  await waitUntil(() =>
    timers.delays().includes(DEEPSEEK_SEMANTIC_IDLE_TIMEOUT_MS),
  );
  assert.equal(timers.delays().includes(DEEPSEEK_TTFB_TIMEOUT_MS), false);
  timers.fireFirst(DEEPSEEK_SEMANTIC_IDLE_TIMEOUT_MS);
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof DeepSeekTransportError &&
      error.code === "SEMANTIC_IDLE_TIMEOUT",
  );
});

test("connect timeout and AbortSignal actively destroy the request", async () => {
  for (const mode of ["timeout", "abort"] as const) {
    const timers = new ManualTimers();
    const captures: RequestCapture[] = [];
    const controller = new AbortController();
    const pending = runDeepSeekTransportFixtureAttempt(
      buildDeepSeekRequestSnapshot([ACTIVE_SYSTEM_MESSAGE_BYTES]),
      loadDeepSeekCredential({ environment: { DEEPSEEK_API_KEY: fixtureKey } }),
      {
        requestFunction: fakeRequestSequence(
          [{ status: 200, start: false }],
          captures,
        ),
        timerDriver: timers,
        signal: controller.signal,
      },
    );
    await waitUntil(() => captures.length === 1);
    if (mode === "timeout") timers.fireFirst(DEEPSEEK_CONNECT_TIMEOUT_MS);
    else controller.abort();
    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof DeepSeekTransportError &&
        error.kind === (mode === "timeout" ? "timeout" : "cancelled"),
    );
    assert.equal(captures[0]?.request.destroyed, true);
  }
});

test("retry reuses the identical snapshot after pre-semantic 503", async () => {
  const timers = new ManualTimers();
  const captures: RequestCapture[] = [];
  const snapshots: unknown[] = [];
  const interruptions: DeepSeekRetryDecision[] = [];
  const snapshot = buildDeepSeekRequestSnapshot([ACTIVE_SYSTEM_MESSAGE_BYTES]);
  const pending = runDeepSeekTransportFixtureWithRetry(
    snapshot,
    loadDeepSeekCredential({ environment: { DEEPSEEK_API_KEY: fixtureKey } }),
    {
      requestFunction: fakeRequestSequence(
        [
          { status: 503, headers: { "retry-after": "0" } },
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            chunks: [completedSse("retried")],
          },
        ],
        captures,
      ),
      timerDriver: timers,
      lifecycle: {
        beforeAttempt: async (_attempt, value) => {
          const attemptedMutation = value.body.copy();
          attemptedMutation[0] = attemptedMutation[0] === 0 ? 1 : 0;
          snapshots.push(value);
        },
        afterInterrupted: async (_attempt, _failure, _state, decision) => {
          interruptions.push(decision);
        },
        onSemanticStarted: async () => undefined,
      },
    },
  );
  await waitUntil(() => timers.delays().includes(500));
  timers.fireFirst(500);
  const result = await pending;
  assert.equal(result.content, "retried");
  assert.deepEqual(snapshots, [snapshot, snapshot]);
  assert.equal(captures.length, 2);
  assert.deepEqual(captures[0]?.bodyParts, [snapshot.body.copy()]);
  assert.deepEqual(captures[1]?.bodyParts, [snapshot.body.copy()]);
  assert.equal(interruptions[0]?.retry, true);
});

test("post-semantic delta stream interruption fails closed without retry", async () => {
  const timers = new ManualTimers();
  const captures: RequestCapture[] = [];
  const states: string[] = [];
  async function* interrupted(): AsyncIterable<Uint8Array> {
    const first = {
      id: "req_interrupted",
      model: "deepseek-v4-flash",
      system_fingerprint: "fp_fixture",
      choices: [
        {
          index: 0,
          delta: { content: "visible" },
          finish_reason: null,
        },
      ],
      usage: null,
    };
    yield new TextEncoder().encode(`data: ${JSON.stringify(first)}\n\n`);
    throw Object.assign(new Error("fixture reset"), { code: "ECONNRESET" });
  }
  await assert.rejects(
    runDeepSeekTransportFixtureWithRetry(
      buildDeepSeekRequestSnapshot([ACTIVE_SYSTEM_MESSAGE_BYTES]),
      loadDeepSeekCredential({ environment: { DEEPSEEK_API_KEY: fixtureKey } }),
      {
        requestFunction: fakeRequestSequence(
          [
            {
              status: 200,
              headers: { "content-type": "text/event-stream" },
              chunks: interrupted(),
            },
          ],
          captures,
        ),
        timerDriver: timers,
        lifecycle: {
          beforeAttempt: async () => undefined,
          afterInterrupted: async (_attempt, _failure, state, decision) => {
            states.push(`${state}:${String(decision.retry)}`);
          },
          onSemanticStarted: async () => undefined,
        },
      },
    ),
    (error: unknown) =>
      error instanceof DeepSeekTransportError && error.code === "STREAM_FAILURE",
  );
  assert.deepEqual(states, ["post_semantic:false"]);
  assert.equal(captures.length, 1);
});

test("first semantic fragment waits for its durability barrier before preview", async () => {
  const captures: RequestCapture[] = [];
  const order: string[] = [];
  const previews: unknown[] = [];
  let releaseBarrier: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  let completed = false;
  const pending = runDeepSeekTransportFixtureWithRetry(
    buildDeepSeekRequestSnapshot([ACTIVE_SYSTEM_MESSAGE_BYTES]),
    loadDeepSeekCredential({ environment: { DEEPSEEK_API_KEY: fixtureKey } }),
    {
      requestFunction: fakeRequestSequence(
        [
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            chunks: [completedSse("barrier-ok")],
          },
        ],
        captures,
      ),
      timerDriver: new ManualTimers(),
      lifecycle: {
        beforeAttempt: async () => {
          order.push("before");
        },
        onSemanticStarted: async () => {
          order.push("barrier");
          await barrier;
          order.push("barrier-acknowledged");
        },
        afterInterrupted: async () => {
          assert.fail("successful attempt must not be interrupted");
        },
      },
      onSemanticDelta: (fragment) => {
        assert.equal(Object.isFrozen(fragment), true);
        previews.push(fragment);
        order.push(`preview:${fragment.kind}`);
      },
    },
  ).then((result) => {
    completed = true;
    return result;
  });

  await waitUntil(() => order.includes("barrier"));
  assert.equal(completed, false);
  assert.deepEqual(previews, []);
  assert.deepEqual(order, ["before", "barrier"]);

  releaseBarrier?.();
  const result = await pending;
  assert.equal(result.content, "barrier-ok");
  assert.deepEqual(previews, [
    { kind: "reasoning", text: "reason" },
    { kind: "content", text: "barrier-ok" },
  ]);
  assert.deepEqual(order, [
    "before",
    "barrier",
    "barrier-acknowledged",
    "preview:reasoning",
    "preview:content",
  ]);
});

test("rejected semantic durability barrier is sanitized unknown and never retries", async () => {
  const captures: RequestCapture[] = [];
  const previews: unknown[] = [];
  const terminalStates: unknown[] = [];
  let observed: unknown;
  try {
    await runDeepSeekTransportFixtureWithRetry(
      buildDeepSeekRequestSnapshot([ACTIVE_SYSTEM_MESSAGE_BYTES]),
      loadDeepSeekCredential({ environment: { DEEPSEEK_API_KEY: fixtureKey } }),
      {
        requestFunction: fakeRequestSequence(
          [
            {
              status: 200,
              headers: { "content-type": "text/event-stream" },
              chunks: [completedSse()],
            },
          ],
          captures,
        ),
        timerDriver: new ManualTimers(),
        lifecycle: {
          beforeAttempt: async () => undefined,
          onSemanticStarted: async () => {
            throw new Error(`durability fixture rejection ${fixtureKey}`);
          },
          afterInterrupted: async (attempt, failure, state, decision) => {
            terminalStates.push({ attempt, failure, state, decision });
          },
        },
        onSemanticDelta: (fragment) => {
          previews.push(fragment);
        },
      },
    );
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof DeepSeekDurabilityError);
  assert.equal(observed.cause, undefined);
  assert.equal(String(observed).includes(fixtureKey), false);
  assert.equal(JSON.stringify(observed).includes(fixtureKey), false);
  assert.deepEqual(previews, []);
  assert.equal(terminalStates.length, 1);
  assert.deepEqual(terminalStates[0], {
    attempt: 1,
    failure: observed,
    state: "unknown",
    decision: {
      retry: false,
      delayMs: null,
      retryClass: "unknown",
      integritySelfCheck: false,
    },
  });
  assert.equal(captures.length, 1);
});

test("preview metadata and retry notification observers fail independently", async () => {
  const timers = new ManualTimers();
  const captures: RequestCapture[] = [];
  let metadataCalls = 0;
  let previewCalls = 0;
  let retryNotificationCalls = 0;
  let semanticBarriers = 0;
  const pending = runDeepSeekTransportFixtureWithRetry(
    buildDeepSeekRequestSnapshot([ACTIVE_SYSTEM_MESSAGE_BYTES]),
    loadDeepSeekCredential({ environment: { DEEPSEEK_API_KEY: fixtureKey } }),
    {
      requestFunction: fakeRequestSequence(
        [
          { status: 503, headers: { "retry-after": "0" } },
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            chunks: [completedSse("observer-safe")],
          },
        ],
        captures,
      ),
      timerDriver: timers,
      lifecycle: {
        beforeAttempt: async () => undefined,
        afterInterrupted: async () => undefined,
        onSemanticStarted: async () => {
          semanticBarriers += 1;
        },
        onRetryScheduled: () => {
          retryNotificationCalls += 1;
          throw new Error("retry observer fixture failure");
        },
      },
      onRequestMetadata: () => {
        metadataCalls += 1;
        throw new Error("metadata observer fixture failure");
      },
      onSemanticDelta: async () => {
        previewCalls += 1;
        throw new Error("preview observer fixture failure");
      },
    },
  );

  await waitUntil(() => timers.delays().includes(500));
  timers.fireFirst(500);
  const result = await pending;
  assert.equal(result.content, "observer-safe");
  assert.equal(captures.length, 2);
  assert.equal(metadataCalls, 1);
  assert.equal(retryNotificationCalls, 1);
  assert.equal(previewCalls, 1);
  assert.equal(semanticBarriers, 1);
});

test("a never-settling preview observer cannot delay or reclassify success", async () => {
  const timers = new ManualTimers();
  const captures: RequestCapture[] = [];
  let releasePreview = (): void => {
    throw new Error("preview gate was not initialized");
  };
  const previewGate = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  let previewCalls = 0;
  let semanticBarriers = 0;
  let interruptions = 0;
  let resultContent: string | undefined;
  let failure: unknown;

  const pending = runDeepSeekTransportFixtureWithRetry(
    buildDeepSeekRequestSnapshot([ACTIVE_SYSTEM_MESSAGE_BYTES]),
    loadDeepSeekCredential({ environment: { DEEPSEEK_API_KEY: fixtureKey } }),
    {
      requestFunction: fakeRequestSequence(
        [
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            chunks: [completedSse("observer-must-not-block")],
          },
        ],
        captures,
      ),
      timerDriver: timers,
      lifecycle: {
        beforeAttempt: async () => undefined,
        afterInterrupted: async () => {
          interruptions += 1;
        },
        onSemanticStarted: async () => {
          semanticBarriers += 1;
        },
      },
      onSemanticDelta: () => {
        previewCalls += 1;
        return previewGate;
      },
    },
  );
  const observed = pending.then(
    (result) => {
      resultContent = result.content;
    },
    (error: unknown) => {
      failure = error;
    },
  );

  try {
    await waitUntil(() => previewCalls === 1);
    await waitUntil(() => resultContent !== undefined || failure !== undefined);
    assert.equal(failure, undefined);
    assert.equal(resultContent, "observer-must-not-block");
    assert.equal(previewCalls, 1);
    assert.equal(semanticBarriers, 1);
    assert.equal(interruptions, 0);
    assert.equal(captures.length, 1);
    assert.deepEqual(timers.delays(), []);
  } finally {
    releasePreview();
    await observed;
  }
});

test("abort during retry delay creates no fake next attempt", async () => {
  const timers = new ManualTimers();
  const captures: RequestCapture[] = [];
  const controller = new AbortController();
  const attempts: number[] = [];
  const interruptions: number[] = [];
  const retryNotifications: number[] = [];
  const pending = runDeepSeekTransportFixtureWithRetry(
    buildDeepSeekRequestSnapshot([ACTIVE_SYSTEM_MESSAGE_BYTES]),
    loadDeepSeekCredential({ environment: { DEEPSEEK_API_KEY: fixtureKey } }),
    {
      requestFunction: fakeRequestSequence(
        [
          { status: 503, headers: { "retry-after": "0" } },
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            chunks: [completedSse("must-not-send")],
          },
        ],
        captures,
      ),
      timerDriver: timers,
      signal: controller.signal,
      lifecycle: {
        beforeAttempt: async (attempt) => {
          attempts.push(attempt);
        },
        afterInterrupted: async (attempt) => {
          interruptions.push(attempt);
        },
        onSemanticStarted: async () => undefined,
        onRetryScheduled: (attempt) => retryNotifications.push(attempt),
      },
    },
  );

  await waitUntil(
    () => timers.delays().includes(500) && interruptions.length === 1,
  );
  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof DeepSeekTransportError &&
      error.kind === "cancelled" &&
      error.code === "ABORTED",
  );
  assert.deepEqual(attempts, [1]);
  assert.deepEqual(interruptions, [1]);
  assert.deepEqual(retryNotifications, [1]);
  assert.equal(captures.length, 1);
});

test("successful transport resolution wins over a later abort", async () => {
  const captures: RequestCapture[] = [];
  const controller = new AbortController();
  let interruptions = 0;
  const result = await runDeepSeekTransportFixtureWithRetry(
    buildDeepSeekRequestSnapshot([ACTIVE_SYSTEM_MESSAGE_BYTES]),
    loadDeepSeekCredential({ environment: { DEEPSEEK_API_KEY: fixtureKey } }),
    {
      requestFunction: fakeRequestSequence(
        [
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            chunks: [completedSse("winner")],
          },
        ],
        captures,
      ),
      timerDriver: new ManualTimers(),
      signal: controller.signal,
      lifecycle: {
        beforeAttempt: async () => undefined,
        afterInterrupted: async () => {
          interruptions += 1;
        },
        onSemanticStarted: async () => undefined,
      },
    },
  );

  controller.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(result.content, "winner");
  assert.equal(interruptions, 0);
  assert.equal(captures[0]?.request.destroyed, false);
});

test("transport failures never retain credential-bearing causes", async () => {
  const snapshot = buildDeepSeekRequestSnapshot([ACTIVE_SYSTEM_MESSAGE_BYTES]);
  let observed: unknown;
  try {
    await runDeepSeekTransportFixtureAttempt(
      snapshot,
      loadDeepSeekCredential({ environment: { DEEPSEEK_API_KEY: fixtureKey } }),
      {
        requestFunction: () => {
          throw new Error(`untrusted ${fixtureKey}`);
        },
      },
    );
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof DeepSeekTransportError);
  assert.equal(String(observed).includes(fixtureKey), false);
  assert.equal(JSON.stringify(observed).includes(fixtureKey), false);
  assert.equal((observed as Error).cause, undefined);
});
