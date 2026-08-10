import {
  deepStrictEqual,
  rejects,
  strictEqual,
} from "node:assert/strict";
import { test } from "node:test";

import { DeepSeekProtocolError } from "../../src/ds/errors.js";
import { parseDeepSeekSse } from "../../src/ds/sse.js";
import type {
  DeepSeekSemanticFragment,
  SemanticDeltaKind,
} from "../../src/ds/types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const identity = {
  id: "req_fixture_1",
  model: "deepseek-v4-flash",
  system_fingerprint: "fp_fixture",
} as const;

const validUsage = {
  prompt_tokens: 10,
  prompt_cache_hit_tokens: 3,
  prompt_cache_miss_tokens: 7,
  completion_tokens: 6,
  total_tokens: 16,
  completion_tokens_details: { reasoning_tokens: 4 },
} as const;

function dataLine(value: unknown, newline = "\n"): string {
  return `data: ${JSON.stringify(value)}${newline}`;
}

function choiceLine(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  identityOverride: Record<string, unknown> = {},
  newline = "\n",
): string {
  return dataLine(
    {
      ...identity,
      ...identityOverride,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      usage: null,
    },
    newline,
  );
}

function usageLine(
  usageOverride: Record<string, unknown> = {},
  identityOverride: Record<string, unknown> = {},
  newline = "\n",
): string {
  return dataLine(
    {
      ...identity,
      ...identityOverride,
      choices: [],
      usage: { ...validUsage, ...usageOverride },
    },
    newline,
  );
}

function terminalUsageLine(
  delta: Record<string, unknown>,
  finishReason: string,
  usageOverride: Record<string, unknown> = {},
  identityOverride: Record<string, unknown> = {},
  newline = "\n",
): string {
  return dataLine(
    {
      ...identity,
      ...identityOverride,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      usage: { ...validUsage, ...usageOverride },
    },
    newline,
  );
}

function validTextStream(newline = "\n"): string[] {
  return [
    choiceLine({ role: "assistant", reasoning_content: "推理🙂" }, null, {}, newline),
    choiceLine({ content: "你好，世界" }, null, {}, newline),
    choiceLine({ content: "", role: null }, "stop", {}, newline),
    usageLine({}, {}, newline),
    `data: [DONE]${newline}`,
  ];
}

function validToolStream(newline = "\n"): string[] {
  return [
    choiceLine({ reasoning_content: "思考" }, null, {}, newline),
    choiceLine(
      {
        content: null,
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: '{"pa' },
          },
        ],
      },
      null,
      {},
      newline,
    ),
    choiceLine(
      {
        reasoning_content: null,
        tool_calls: [
          { index: 0, function: { arguments: 'th":"文档.md"}' } },
        ],
      },
      null,
      {},
      newline,
    ),
    choiceLine({}, "tool_calls", {}, newline),
    usageLine({}, {}, newline),
    `data: [DONE]${newline}`,
  ];
}

async function* eachByte(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let index = 0; index < bytes.byteLength; index += 1) {
    yield bytes.slice(index, index + 1);
  }
}

async function* oneChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let releasePromise = (): void => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<void>((resolve) => {
    releasePromise = resolve;
  });
  return { promise, release: () => releasePromise() };
}

function parseText(text: string) {
  return parseDeepSeekSse(eachByte(encoder.encode(text)));
}

async function expectProtocolError(
  text: string,
  messagePattern: RegExp,
): Promise<void> {
  await rejects(parseText(text), (error: unknown) => {
    return (
      error instanceof DeepSeekProtocolError &&
      messagePattern.test(error.message)
    );
  });
}

test("SSE parser preserves UTF-8 split at every byte and ignores keep-alives", async () => {
  const semanticFragments: DeepSeekSemanticFragment[] = [];
  const lines = validTextStream();
  lines.splice(0, 0, ": keep-alive\n", "\n");
  lines.splice(3, 0, ": keep-alive\r\n", "\r\n");
  lines.splice(
    lines.length - 3,
    0,
    choiceLine({ reasoning_content: "", content: "", tool_calls: [] }),
  );

  const completed = await parseDeepSeekSse(
    eachByte(encoder.encode(lines.join(""))),
    {
      onSemanticDelta: (fragment) => {
        semanticFragments.push(fragment);
      },
    },
  );

  strictEqual(completed.providerRequestId, identity.id);
  strictEqual(completed.responseModel, identity.model);
  strictEqual(completed.systemFingerprint, identity.system_fingerprint);
  strictEqual(completed.reasoningContent, "推理🙂");
  strictEqual(completed.content, "你好，世界");
  strictEqual(completed.semanticDeltaCount, 2);
  deepStrictEqual(semanticFragments, [
    { kind: "reasoning", text: "推理🙂" },
    { kind: "content", text: "你好，世界" },
  ]);
  strictEqual(semanticFragments.every(Object.isFrozen), true);
  deepStrictEqual(completed.toolCalls, []);
  deepStrictEqual(completed.usage, {
    promptTokens: 10,
    promptCacheHitTokens: 3,
    promptCacheMissTokens: 7,
    completionTokens: 6,
    reasoningTokens: 4,
    rawFinishReason: "stop",
  });
  strictEqual(
    decoder.decode(completed.assistantBytes.copy()),
    '{"role":"assistant","content":"你好，世界","reasoning_content":"推理🙂"}',
  );
});

test("SSE parser accepts CRLF and exposes only complete accumulated tool calls", async () => {
  const semanticFragments: DeepSeekSemanticFragment[] = [];
  const lines = [": queued\r\n", ...validToolStream("\r\n")];

  const completed = await parseDeepSeekSse(
    eachByte(encoder.encode(lines.join(""))),
    {
      onSemanticDelta: (fragment) => {
        semanticFragments.push(fragment);
      },
    },
  );

  deepStrictEqual(semanticFragments, [
    { kind: "reasoning", text: "思考" },
    { kind: "tool_call" },
    { kind: "tool_call" },
  ]);
  strictEqual(semanticFragments.every(Object.isFrozen), true);
  deepStrictEqual(Object.keys(semanticFragments[1] ?? {}).sort(), ["kind"]);
  deepStrictEqual(Object.keys(semanticFragments[2] ?? {}).sort(), ["kind"]);
  strictEqual(completed.semanticDeltaCount, 3);
  deepStrictEqual(completed.toolCalls, [
    {
      id: "call_1",
      type: "function",
      function: { name: "read", arguments: '{"path":"文档.md"}' },
    },
  ]);
  strictEqual(
    decoder.decode(completed.assistantBytes.copy()),
    '{"role":"assistant","content":"","reasoning_content":"思考","tool_calls":[{"id":"call_1","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"文档.md\\"}"}}]}',
  );
});

test("SSE parser accepts complete usage co-located with its terminal choice", async (context) => {
  await context.test("stop", async () => {
    const lines = validTextStream();
    lines.splice(
      2,
      2,
      terminalUsageLine({ content: "", role: null }, "stop"),
    );

    const completed = await parseText(lines.join(""));

    strictEqual(completed.usage.rawFinishReason, "stop");
    strictEqual(completed.content, "你好，世界");
    strictEqual(completed.reasoningContent, "推理🙂");
    strictEqual(completed.usage.promptTokens, 10);
  });

  await context.test("tool_calls", async () => {
    const lines = validToolStream();
    lines.splice(3, 2, terminalUsageLine({}, "tool_calls"));

    const completed = await parseText(lines.join(""));

    strictEqual(completed.usage.rawFinishReason, "tool_calls");
    strictEqual(completed.toolCalls.length, 1);
    strictEqual(completed.usage.completionTokens, 6);
  });
});

test("SSE parser awaits each async semantic hook before reading or completing", async (context) => {
  const scenarios: readonly {
    readonly kind: SemanticDeltaKind;
    readonly stream: string;
  }[] = [
    { kind: "reasoning", stream: validTextStream().join("") },
    { kind: "content", stream: validTextStream().join("") },
    { kind: "tool_call", stream: validToolStream().join("") },
  ];

  for (const scenario of scenarios) {
    await context.test(scenario.kind, async () => {
      const entered = deferred();
      const release = deferred();
      const hookKinds: SemanticDeltaKind[] = [];
      let yieldedBytes = 0;
      let settled = false;

      async function* observedBytes(): AsyncGenerator<Uint8Array> {
        const bytes = encoder.encode(scenario.stream);
        for (let index = 0; index < bytes.byteLength; index += 1) {
          yieldedBytes += 1;
          yield bytes.slice(index, index + 1);
        }
      }

      const parsing = parseDeepSeekSse(observedBytes(), {
        onSemanticDelta: async (fragment) => {
          hookKinds.push(fragment.kind);
          if (fragment.kind !== scenario.kind) return;
          entered.release();
          await release.promise;
        },
      }).then(
        (completed) => {
          settled = true;
          return completed;
        },
        (error: unknown) => {
          settled = true;
          throw error;
        },
      );

      await entered.promise;
      const yieldedAtBarrier = yieldedBytes;
      await new Promise<void>((resolve) => setImmediate(resolve));
      strictEqual(settled, false);
      strictEqual(yieldedBytes, yieldedAtBarrier);

      release.release();
      const completed = await parsing;
      strictEqual(settled, true);
      strictEqual(hookKinds.includes(scenario.kind), true);
      if (scenario.kind === "reasoning") {
        strictEqual(completed.reasoningContent, "推理🙂");
      } else if (scenario.kind === "content") {
        strictEqual(completed.content, "你好，世界");
      } else {
        strictEqual(completed.toolCalls.length, 1);
        strictEqual(completed.toolCalls[0]?.function.arguments, '{"path":"文档.md"}');
      }
    });
  }
});

test("SSE parser propagates async hook rejection before staging that semantic delta", async (context) => {
  const expectedHooks: Readonly<Record<SemanticDeltaKind, readonly SemanticDeltaKind[]>> = {
    reasoning: ["reasoning"],
    content: ["reasoning", "content"],
    tool_call: ["reasoning", "tool_call"],
  };
  const scenarios: readonly {
    readonly kind: SemanticDeltaKind;
    readonly stream: string;
  }[] = [
    { kind: "reasoning", stream: validTextStream().join("") },
    { kind: "content", stream: validTextStream().join("") },
    { kind: "tool_call", stream: validToolStream().join("") },
  ];

  for (const scenario of scenarios) {
    await context.test(scenario.kind, async () => {
      const sentinel = new Error(`reject ${scenario.kind}`);
      const hookKinds: SemanticDeltaKind[] = [];
      let completed = false;
      const parsing = parseDeepSeekSse(
        eachByte(encoder.encode(scenario.stream)),
        {
          onSemanticDelta: async (fragment) => {
            hookKinds.push(fragment.kind);
            if (fragment.kind === scenario.kind) throw sentinel;
          },
        },
      ).then((value) => {
        completed = true;
        return value;
      });

      await rejects(parsing, (error: unknown) => error === sentinel);
      strictEqual(completed, false);
      deepStrictEqual(hookKinds, expectedHooks[scenario.kind]);
    });
  }
});

test("SSE parser never returns partial tool arguments from an interrupted stream", async () => {
  const partial = [
    choiceLine({ reasoning_content: "思考" }),
    choiceLine({
      tool_calls: [
        {
          index: 0,
          id: "call_partial",
          type: "function",
          function: { name: "read", arguments: '{"path":' },
        },
      ],
    }),
  ].join("");

  await expectProtocolError(partial, /stream ended without \[DONE\]/);
});

test("SSE parser rejects invalid UTF-8 and malformed JSON", async (context) => {
  await context.test("invalid UTF-8", async () => {
    const prefix = encoder.encode('data: {"bad":"');
    const suffix = encoder.encode('"}\n');
    const bytes = new Uint8Array(prefix.byteLength + 1 + suffix.byteLength);
    bytes.set(prefix, 0);
    bytes[prefix.byteLength] = 0xff;
    bytes.set(suffix, prefix.byteLength + 1);

    await rejects(
      parseDeepSeekSse(oneChunk(bytes)),
      (error: unknown) =>
        error instanceof DeepSeekProtocolError &&
        /invalid_utf8/.test(error.message),
    );
  });

  await context.test("malformed JSON", async () => {
    await expectProtocolError("data: {not-json}\n", /invalid_json/);
  });

  await context.test("unsupported SSE field", async () => {
    await expectProtocolError("event: message\n", /invalid_sse_line/);
  });
});

test("SSE parser requires exactly one complete terminal sequence", async (context) => {
  const validLines = validTextStream();

  await context.test("missing DONE", async () => {
    await expectProtocolError(
      validLines.slice(0, -1).join(""),
      /stream ended without \[DONE\]/,
    );
  });

  await context.test("missing usage", async () => {
    await expectProtocolError(
      [...validLines.slice(0, -2), validLines.at(-1) ?? ""].join(""),
      /before finish reason and complete usage/,
    );
  });

  await context.test("duplicate DONE", async () => {
    await expectProtocolError(
      [...validLines, "data: [DONE]\n"].join(""),
      /duplicate \[DONE\]/,
    );
  });

  await context.test("data after DONE", async () => {
    await expectProtocolError(
      [...validLines, choiceLine({ content: "late" })].join(""),
      /data received after \[DONE\]/,
    );
  });

  await context.test("usage after DONE", async () => {
    await expectProtocolError(
      [...validLines, usageLine()].join(""),
      /data received after \[DONE\]/,
    );
  });

  await context.test("duplicate finish reason", async () => {
    await expectProtocolError(
      [
        ...validLines.slice(0, 3),
        choiceLine({}, "stop"),
        ...validLines.slice(3),
      ].join(""),
      /choice received after finish reason/,
    );
  });

  await context.test("duplicate usage", async () => {
    await expectProtocolError(
      [
        ...validLines.slice(0, 4),
        usageLine(),
        ...validLines.slice(4),
      ].join(""),
      /duplicate complete usage/,
    );
  });

  await context.test("cross-shape duplicate usage", async () => {
    const lines = validTextStream();
    lines.splice(
      2,
      2,
      terminalUsageLine({ content: "", role: null }, "stop"),
      usageLine(),
    );
    await expectProtocolError(
      lines.join(""),
      /duplicate complete usage/,
    );
  });

  await context.test("standalone usage before finish", async () => {
    await expectProtocolError(
      [usageLine(), ...validLines].join(""),
      /usage arrived before finish reason/,
    );
  });

  await context.test("usage on a nonterminal choice", async () => {
    await expectProtocolError(
      [
        dataLine({
          ...identity,
          choices: [
            { index: 0, delta: { content: "late" }, finish_reason: null },
          ],
          usage: validUsage,
        }),
        "data: [DONE]\n",
      ].join(""),
      /usage cannot accompany a nonterminal choice/,
    );
  });

  await context.test("usage with multiple choices", async () => {
    await expectProtocolError(
      dataLine({
        ...identity,
        choices: [
          { index: 0, delta: {}, finish_reason: "stop" },
          { index: 1, delta: {}, finish_reason: "stop" },
        ],
        usage: validUsage,
      }),
      /complete usage chunk must have zero or one choice/,
    );
  });
});

test("SSE parser rejects malformed co-located usage before semantic hooks", async (context) => {
  const scenarios: readonly {
    readonly name: string;
    readonly chunk: unknown;
    readonly message: RegExp;
  }[] = [
    {
      name: "usage is not an object",
      chunk: {
        ...identity,
        choices: [
          {
            index: 0,
            delta: { content: "must-not-preview" },
            finish_reason: "stop",
          },
        ],
        usage: "invalid",
      },
      message: /complete usage must be an object/,
    },
    {
      name: "usage has multiple choices",
      chunk: {
        ...identity,
        choices: [
          {
            index: 0,
            delta: { content: "must-not-preview" },
            finish_reason: "stop",
          },
          { index: 1, delta: {}, finish_reason: "stop" },
        ],
        usage: validUsage,
      },
      message: /complete usage chunk must have zero or one choice/,
    },
  ];

  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      let hookCalls = 0;
      await rejects(
        parseDeepSeekSse(
          oneChunk(encoder.encode(dataLine(scenario.chunk))),
          {
            onSemanticDelta: () => {
              hookCalls += 1;
            },
          },
        ),
        (error: unknown) =>
          error instanceof DeepSeekProtocolError &&
          scenario.message.test(error.message),
      );
      strictEqual(hookCalls, 0);
    });
  }
});

test("SSE parser enforces stable response identity", async () => {
  const lines = validTextStream();
  lines[1] = choiceLine(
    { content: "你好，世界" },
    null,
    { model: "unexpected-model" },
  );

  await expectProtocolError(lines.join(""), /identity_mismatch/);
});

test("SSE parser rejects a non-null non-assistant delta role", async () => {
  const lines = validTextStream();
  lines[1] = choiceLine({ content: "你好，世界", role: "user" });
  await expectProtocolError(lines.join(""), /role must be assistant or null/);
});

test("SSE parser rejects incomplete tool calls and missing reasoning_content", async (context) => {
  const terminal = [
    choiceLine({}, "tool_calls"),
    usageLine(),
    "data: [DONE]\n",
  ];

  await context.test("missing reasoning_content", async () => {
    await expectProtocolError(
      [
        choiceLine({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "read", arguments: "{}" },
            },
          ],
        }),
        ...terminal,
      ].join(""),
      /missing string reasoning_content/,
    );
  });

  await context.test("incomplete tool metadata", async () => {
    await expectProtocolError(
      [
        choiceLine({ reasoning_content: "r" }),
        choiceLine({
          tool_calls: [{ index: 0, function: { arguments: "{}" } }],
        }),
        ...terminal,
      ].join(""),
      /tool call is incomplete/,
    );
  });

  await context.test("non-contiguous tool indexes", async () => {
    await expectProtocolError(
      [
        choiceLine({ reasoning_content: "r" }),
        choiceLine({
          tool_calls: [
            {
              index: 1,
              id: "call_2",
              type: "function",
              function: { name: "read", arguments: "{}" },
            },
          ],
        }),
        ...terminal,
      ].join(""),
      /indexes must be contiguous/,
    );
  });
});

test("SSE usage requires cache conservation and never double-counts reasoning", async (context) => {
  const streamWithUsage = (usageOverride: Record<string, unknown>): string => {
    const lines = validTextStream();
    lines[3] = usageLine(usageOverride);
    return lines.join("");
  };

  await context.test("cache hit plus miss must equal prompt", async () => {
    await expectProtocolError(
      streamWithUsage({ prompt_cache_miss_tokens: 8 }),
      /cache hit plus cache miss/,
    );
  });

  await context.test("co-located cache hit plus miss must equal prompt", async () => {
    const lines = validTextStream();
    lines.splice(
      2,
      2,
      terminalUsageLine(
        { content: "", role: null },
        "stop",
        { prompt_cache_miss_tokens: 8 },
      ),
    );
    await expectProtocolError(
      lines.join(""),
      /cache hit plus cache miss/,
    );
  });

  await context.test("reasoning is already part of completion total", async () => {
    await expectProtocolError(
      streamWithUsage({ total_tokens: 20 }),
      /completion tokens exactly once/,
    );
  });

  await context.test("reasoning cannot exceed completion", async () => {
    await expectProtocolError(
      streamWithUsage({
        completion_tokens_details: { reasoning_tokens: 7 },
      }),
      /reasoning tokens cannot exceed completion/,
    );
  });

  await context.test("usage counters are non-negative integers", async () => {
    await expectProtocolError(
      streamWithUsage({ prompt_tokens: -1 }),
      /non-negative integer/,
    );
  });
});
