import assert from "node:assert/strict";
import test from "node:test";

import { materializeAssistant } from "../../src/bytes/assistant.js";
import { sha256Hex, utf8Bytes } from "../../src/bytes/ops.js";
import { ACTIVE_SYSTEM_MESSAGE_BYTES } from "../../src/bytes/system.js";
import { materializeToolMessage } from "../../src/bytes/tool.js";
import { materializeUserMessage } from "../../src/bytes/user.js";
import {
  utf8View,
  viewAssistant,
  viewSystem,
  viewTool,
  viewUser,
} from "../../src/bytes/view.js";

test("canonical user and tool messages freeze exact provider-visible bytes", () => {
  const user = materializeUserMessage("你好🙂");
  assert.equal(utf8View(user), '{"role":"user","content":"你好🙂"}');
  assert.equal(user.byteLength, 38);
  assert.equal(
    sha256Hex(user),
    "6307657260b3df101cac4a96532f2ffc330eeea76e0078b342d11529d3c6639f",
  );
  assert.deepEqual(viewUser(user), {
    role: "user",
    content: "你好🙂",
  });

  const tool = materializeToolMessage({ toolCallId: "call_1", content: "ok🙂" });
  assert.equal(
    utf8View(tool),
    '{"role":"tool","tool_call_id":"call_1","content":"ok🙂"}',
  );
  assert.deepEqual(viewTool(tool), {
    role: "tool",
    toolCallId: "call_1",
    content: "ok🙂",
  });
});

test("role views reject semantically equal noncanonical JSON", () => {
  for (const value of [
    '{ "role":"user","content":"x"}',
    '{"content":"x","role":"user"}',
    '{"role":"user","content":"x","content":"x"}',
  ]) {
    assert.throws(() => viewUser(utf8Bytes(value)), TypeError);
  }
  for (const value of [
    '{"role":"tool","content":"ok","tool_call_id":"call_1"}',
    '{"role":"tool","tool_call_id":"","content":"ok"}',
    '{"role":"tool","tool_call_id":"call_1","content":"ok"}\n',
    '{"role":"tool","tool_call_id":"call_1","content":"\\ud800"}',
  ]) {
    assert.throws(() => viewTool(utf8Bytes(value)), TypeError);
  }
});

test("user and tool producers reject lone surrogates before a role view", () => {
  const loneSurrogates = ["\ud800", "\udbff", "\udc00", "\udfff"] as const;

  for (const content of loneSurrogates) {
    assert.throws(
      () => viewUser(materializeUserMessage(content)),
      /user content.*lone surrogate/u,
    );
    assert.throws(
      () =>
        viewTool(
          materializeToolMessage({ toolCallId: "call_1", content }),
        ),
      /tool content.*lone surrogate/u,
    );
    assert.throws(
      () =>
        viewTool(
          materializeToolMessage({ toolCallId: content, content: "ok" }),
        ),
      /tool call id.*lone surrogate/u,
    );
  }

  assert.equal(
    viewUser(materializeUserMessage("paired \ud83d\ude42")).content,
    "paired 🙂",
  );
  assert.deepEqual(
    viewTool(
      materializeToolMessage({
        toolCallId: "call_\ud83d\ude42",
        content: "paired \ud83d\ude42",
      }),
    ),
    {
      role: "tool",
      toolCallId: "call_🙂",
      content: "paired 🙂",
    },
  );
});

test("system and assistant views enforce byte-for-byte round trips", () => {
  assert.equal(viewSystem(ACTIVE_SYSTEM_MESSAGE_BYTES).role, "system");
  const assistant = materializeAssistant({
    content: "",
    reasoningContent: "reason",
    toolCalls: [],
  });
  assert.equal(viewAssistant(assistant).reasoningContent, "reason");
  assert.throws(
    () => viewAssistant(utf8Bytes(`${utf8View(assistant)}\n`)),
    TypeError,
  );
  assert.throws(
    () => viewSystem(utf8Bytes('{"content":"x","role":"system"}')),
    TypeError,
  );
  assert.throws(
    () =>
      viewAssistant(
        utf8Bytes(
          '{"role":"assistant","content":"","reasoning_content":"ok","tool_calls":[{"id":"call","type":"function","function":{"name":"read","arguments":"\\ud800"}}]}',
        ),
      ),
    TypeError,
  );
});
