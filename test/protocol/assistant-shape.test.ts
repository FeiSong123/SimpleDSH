import assert from "node:assert/strict";
import test from "node:test";

import { materializeAssistant } from "../../src/bytes/assistant.js";
import { freezeBytes } from "../../src/bytes/types.js";
import { viewAssistant } from "../../src/bytes/view.js";
import type { ToolCall } from "../../src/ds/types.js";

const CALL: ToolCall = Object.freeze({
  id: "call_1",
  type: "function" as const,
  function: Object.freeze({ name: "read", arguments: '{"path":"a.txt"}' }),
});

function text(bytes: ReturnType<typeof materializeAssistant>): string {
  return new TextDecoder().decode(bytes.copy());
}

test("a turn without tool calls omits the field entirely", () => {
  // DeepSeek rejects an empty array with
  // "Invalid 'messages[N].tool_calls': empty array", and no retry can fix it.
  const bytes = materializeAssistant({
    content: "hello",
    reasoningContent: "thinking",
    toolCalls: [],
  });
  assert.equal(
    text(bytes),
    '{"role":"assistant","content":"hello","reasoning_content":"thinking"}',
  );
  assert.ok(!text(bytes).includes("tool_calls"));
});

test("a turn with tool calls keeps the field and its order", () => {
  const bytes = materializeAssistant({
    content: "",
    reasoningContent: "calling",
    toolCalls: [CALL],
  });
  assert.equal(
    text(bytes),
    '{"role":"assistant","content":"","reasoning_content":"calling",' +
      '"tool_calls":[{"id":"call_1","type":"function","function":' +
      '{"name":"read","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}',
  );
});

test("both shapes round-trip through the view", () => {
  for (const toolCalls of [[], [CALL]]) {
    const bytes = materializeAssistant({
      content: "c",
      reasoningContent: "r",
      toolCalls,
    });
    const view = viewAssistant(bytes);
    assert.equal(view.content, "c");
    assert.equal(view.reasoningContent, "r");
    assert.equal(view.toolCalls.length, toolCalls.length);
  }
});

test("an explicit empty array is not canonical", () => {
  // Durable bytes in this shape would reproduce the 400 on every later turn,
  // so the view must refuse them rather than replay them.
  const bytes = freezeBytes(
    new TextEncoder().encode(
      '{"role":"assistant","content":"c","reasoning_content":"r","tool_calls":[]}',
    ),
  );
  assert.throws(() => viewAssistant(bytes), TypeError);
});

test("a missing reasoning_content is still rejected", () => {
  const bytes = freezeBytes(
    new TextEncoder().encode('{"role":"assistant","content":"c"}'),
  );
  assert.throws(() => viewAssistant(bytes), TypeError);
});

test("an unexpected extra key is rejected in both shapes", () => {
  for (const extra of [
    '{"role":"assistant","content":"c","reasoning_content":"r","name":"x"}',
    '{"role":"assistant","content":"c","reasoning_content":"r","tool_calls":[{"id":"a","type":"function","function":{"name":"read","arguments":"{}"}}],"name":"x"}',
  ]) {
    const bytes = freezeBytes(new TextEncoder().encode(extra));
    assert.throws(() => viewAssistant(bytes), TypeError);
  }
});
