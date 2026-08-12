import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex } from "../../src/bytes/ops.js";
import {
  CANONICAL_TOOLS_BYTES,
  SEARCH_V1_CANONICAL_TOOLS_BYTES,
  LEGACY_CANONICAL_TOOLS_BYTES,
  PREVIOUS_CANONICAL_TOOLS_BYTES,
  toolSchemaProfileForBytes,
  type ToolSchemaProfile,
} from "../../src/bytes/schemas.js";
import { utf8View } from "../../src/bytes/view.js";
import {
  READ_WHOLE_FILE,
  toolNames,
  validateToolArguments,
  validateToolArgumentsForProfile,
  validateToolCall,
} from "../../src/bytes/tool-arguments.js";
import type {
  StaticToolValidationCode,
  ToolName,
  ValidatedToolArguments,
} from "../../src/bytes/tool-arguments.js";

function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("test value is not JSON");
  return encoded;
}

function expectSuccess(
  name: ToolName,
  argumentsText: string,
): ValidatedToolArguments {
  const result = validateToolArguments(name, argumentsText);
  if (!result.ok) {
    assert.fail(`${name} unexpectedly failed with ${result.code}`);
  }
  assert.equal(result.arguments.name, name);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.arguments), true);
  assert.equal(Object.isFrozen(result.arguments.value), true);
  return result.arguments;
}

function expectFailure(
  name: string,
  argumentsText: string,
  code: StaticToolValidationCode = "invalid_arguments",
): void {
  const result = validateToolArguments(name, argumentsText);
  if (result.ok) assert.fail(`${name} unexpectedly accepted ${argumentsText}`);
  assert.equal(result.code, code);
  assert.equal(Object.isFrozen(result), true);
}

function expectProfileFailure(
  profile: ToolSchemaProfile,
  name: string,
  argumentsText: string,
  code: StaticToolValidationCode,
): void {
  const result = validateToolArgumentsForProfile(name, argumentsText, profile);
  if (result.ok) assert.fail(`${name} unexpectedly accepted ${argumentsText}`);
  assert.equal(result.code, code);
  assert.equal(Object.isFrozen(result), true);
}

function providerToolName(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    assert.fail("provider tool must be an object");
  }
  const record = value as Record<string, unknown>;
  const providerFunction = record["function"];
  if (
    typeof providerFunction !== "object" ||
    providerFunction === null ||
    Array.isArray(providerFunction)
  ) {
    assert.fail("provider function must be an object");
  }
  const name = (providerFunction as Record<string, unknown>)["name"];
  if (typeof name !== "string") assert.fail("provider tool name must be a string");
  return name;
}

test("provider-visible tool schema bytes and sorted validator order stay frozen", () => {
  assert.deepEqual(toolNames, ["bash", "edit", "read", "web_search", "write"]);
  assert.equal(Object.isFrozen(toolNames), true);
  assert.equal(CANONICAL_TOOLS_BYTES.byteLength, 2_261);
  assert.equal(
    sha256Hex(CANONICAL_TOOLS_BYTES),
    "29abc67baa34f6194be39d0aa5506eb9880569cb04461bc139845b66d85ec3dc",
  );
  // The bytes the read-v2 ABI replaced, kept loadable forever.
  assert.equal(SEARCH_V1_CANONICAL_TOOLS_BYTES.byteLength, 1_880);
  assert.equal(
    sha256Hex(SEARCH_V1_CANONICAL_TOOLS_BYTES),
    "815cf370a4250969b811ed91374889be408b14611555b9ff468693914f2c01a8",
  );
  assert.equal(PREVIOUS_CANONICAL_TOOLS_BYTES.byteLength, 1_481);
  assert.equal(
    sha256Hex(PREVIOUS_CANONICAL_TOOLS_BYTES),
    "9270ce003a52c82ebba5548286cce65f981c2ee1374b15ca07dca0b8e52f11d4",
  );
  assert.equal(LEGACY_CANONICAL_TOOLS_BYTES.byteLength, 1_190);
  assert.equal(
    sha256Hex(LEGACY_CANONICAL_TOOLS_BYTES),
    "2cab77d4184a9839e7c432d160b2edb39a0fdfa69fb8b56754d67c89765fae12",
  );
  assert.equal(toolSchemaProfileForBytes(CANONICAL_TOOLS_BYTES), "read-v2");
  assert.equal(
    toolSchemaProfileForBytes(SEARCH_V1_CANONICAL_TOOLS_BYTES),
    "search-v1",
  );
  assert.equal(
    toolSchemaProfileForBytes(PREVIOUS_CANONICAL_TOOLS_BYTES),
    "edit-v5",
  );
  assert.equal(
    toolSchemaProfileForBytes(LEGACY_CANONICAL_TOOLS_BYTES),
    "edit-v4",
  );

  const providerTools: unknown = JSON.parse(utf8View(CANONICAL_TOOLS_BYTES));
  if (!Array.isArray(providerTools)) assert.fail("provider tools must be an array");
  assert.deepEqual(providerTools.map(providerToolName), toolNames);
});

test("failure codes distinguish JSON syntax from arguments and unknown tool wins first", () => {
  for (const name of toolNames) {
    // web_search is profile-gated; the edit-v5 default below is
    // covered by its own test.
    if (name === "web_search") continue;
    expectFailure(name, "{", "invalid_json");
    const nonObjectCode = name === "edit" ? "wrong_type" : "invalid_arguments";
    expectFailure(name, "null", nonObjectCode);
    expectFailure(name, "[]", nonObjectCode);
    expectFailure(name, json("scalar"), nonObjectCode);
  }

  expectFailure("unknown", "{", "unknown_tool");
  expectFailure("unknown", json({}), "unknown_tool");
  expectFailure("", "not JSON", "unknown_tool");

  const validCall = validateToolCall({
    id: "call-validator-1",
    function: { name: "read", arguments: json({ path: "README.md" }) },
  });
  assert.deepEqual(validCall, {
    ok: true,
    toolCallId: "call-validator-1",
    arguments: {
      name: "read",
      value: { path: "README.md", offset: 0, limit: READ_WHOLE_FILE },
    },
  });
  assert.equal(Object.isFrozen(validCall), true);

  assert.deepEqual(
    validateToolCall({
      id: "call-validator-2",
      function: { name: "read", arguments: "{" },
    }),
    { ok: false, toolCallId: "call-validator-2", code: "invalid_json" },
  );
  assert.deepEqual(
    validateToolCall({
      id: "call-validator-3",
      function: { name: "missing", arguments: "{" },
    }),
    { ok: false, toolCallId: "call-validator-3", code: "unknown_tool" },
  );
  assert.throws(
    () =>
      validateToolCall({
        id: "",
        function: { name: "missing", arguments: "{" },
      }),
    /tool call id/u,
  );
});

test("read validator closes keys, applies defaults, and enforces integer bounds", () => {
  assert.deepEqual(expectSuccess("read", json({ path: "目录/🙂.txt" })), {
    name: "read",
    value: { path: "目录/🙂.txt", offset: 0, limit: READ_WHOLE_FILE },
  });
  assert.deepEqual(
    expectSuccess(
      "read",
      json({
        limit: 2_000,
        path: "file.txt",
        offset: Number.MAX_SAFE_INTEGER,
      }),
    ),
    {
      name: "read",
      value: {
        path: "file.txt",
        offset: Number.MAX_SAFE_INTEGER,
        limit: 2_000,
      },
    },
  );
  assert.deepEqual(
    expectSuccess("read", json({ path: "file.txt", offset: 0, limit: 1 })),
    {
      name: "read",
      value: { path: "file.txt", offset: 0, limit: 1 },
    },
  );

  for (const value of [
    {},
    { offset: 0 },
    { path: "file.txt", extra: true },
    { path: "file.txt", offset: 0, limit: 1, extra: true },
  ]) {
    expectFailure("read", json(value));
  }
  for (const offset of [
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    "0",
    null,
  ]) {
    expectFailure("read", json({ path: "file.txt", offset }));
  }
  for (const limit of [
    -1,
    0,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
    null,
  ]) {
    expectFailure("read", json({ path: "file.txt", limit }));
  }
  // A large explicit limit is accepted. There is no declared ceiling, and once
  // an absent limit means the whole file, a cap on an explicit one only made
  // asking for five thousand lines fail while asking for all of them worked.
  assert.deepEqual(
    expectSuccess("read", json({ path: "file.txt", limit: 5_000 })),
    { name: "read", value: { path: "file.txt", offset: 0, limit: 5_000 } },
  );
  for (const path of ["", "a\0b", "\ud800", "\udfff", 1, null]) {
    expectFailure("read", json({ path }));
  }
});

test("write validator requires exact keys while allowing empty scalar content", () => {
  assert.deepEqual(
    expectSuccess("write", '{"content":"","path":"目录/🙂.txt"}'),
    {
      name: "write",
      value: { path: "目录/🙂.txt", content: "" },
    },
  );
  assert.deepEqual(
    expectSuccess("write", json({ path: "file.txt", content: "内容🙂" })),
    {
      name: "write",
      value: { path: "file.txt", content: "内容🙂" },
    },
  );

  for (const value of [
    {},
    { path: "file.txt" },
    { content: "content" },
    { path: "file.txt", content: "content", extra: false },
  ]) {
    expectFailure("write", json(value));
  }
  for (const path of ["", "a\0b", "\ud800", "\udfff", 1, null]) {
    expectFailure("write", json({ path, content: "content" }));
  }
  for (const content of ["a\0b", "\ud800", "\udfff", 1, null]) {
    expectFailure("write", json({ path: "file.txt", content }));
  }
});

test("edit-v5 validator defaults replace_all and returns closed precedence codes", () => {
  assert.deepEqual(
    expectSuccess(
      "edit",
      json({
        path: "目录/🙂.txt",
        old_string: "old🙂",
        new_string: "",
        replace_all: false,
      }),
    ),
    {
      name: "edit",
      value: {
        path: "目录/🙂.txt",
        oldString: "old🙂",
        newString: "",
        replaceAll: false,
      },
    },
  );
  assert.deepEqual(
    expectSuccess(
      "edit",
      json({
        path: "file.txt",
        old_string: "old",
        new_string: "new",
      }),
    ),
    {
      name: "edit",
      value: {
        path: "file.txt",
        oldString: "old",
        newString: "new",
        replaceAll: false,
      },
    },
  );

  const base = {
    path: "file.txt",
    old_string: "old",
    new_string: "new",
    replace_all: true,
  };
  expectFailure("edit", json({}), "missing_required_field");
  expectFailure(
    "edit",
    json({ ...base, old_string: undefined }),
    "missing_required_field",
  );
  expectFailure("edit", json({ ...base, extra: true }), "unknown_field");
  expectFailure(
    "edit",
    json({ path: 1, extra: true }),
    "unknown_field",
  );
  expectFailure("edit", "null", "wrong_type");
  for (const path of ["", "a\0b", "\ud800", "\udfff", 1, null]) {
    expectFailure("edit", json({ ...base, path }), "wrong_type");
  }
  for (const old_string of ["", "a\0b", "\ud800", "\udfff", 1, null]) {
    expectFailure("edit", json({ ...base, old_string }), "wrong_type");
  }
  for (const new_string of ["a\0b", "\ud800", "\udfff", 1, null]) {
    expectFailure("edit", json({ ...base, new_string }), "wrong_type");
  }
  for (const replace_all of [0, 1, "true", null]) {
    expectFailure("edit", json({ ...base, replace_all }), "wrong_type");
  }
});

test("edit-v4 validator remains exact and never upgrades missing replace_all", () => {
  const omitted = json({
    path: "file.txt",
    old_string: "old",
    new_string: "new",
  });
  expectProfileFailure("edit-v4", "edit", omitted, "invalid_arguments");
  const accepted = validateToolArgumentsForProfile(
    "edit",
    json({
      path: "file.txt",
      old_string: "old",
      new_string: "new",
      replace_all: false,
    }),
    "edit-v4",
  );
  assert.deepEqual(accepted, {
    ok: true,
    arguments: {
      name: "edit",
      value: {
        path: "file.txt",
        oldString: "old",
        newString: "new",
        replaceAll: false,
      },
    },
  });
  for (const nonObject of ["null", "[]", json("scalar")]) {
    expectProfileFailure(
      "edit-v4",
      "edit",
      nonObject,
      "invalid_arguments",
    );
  }
});

test("bash validator closes keys, defaults timeout, and accepts only finite 0 < t <= 600", () => {
  assert.deepEqual(expectSuccess("bash", json({ command: "pwd🙂" })), {
    name: "bash",
    value: { command: "pwd🙂", timeoutSeconds: 120 },
  });
  assert.deepEqual(
    expectSuccess("bash", json({ timeout: 0.25, command: "pwd" })),
    {
      name: "bash",
      value: { command: "pwd", timeoutSeconds: 0.25 },
    },
  );
  assert.deepEqual(
    expectSuccess("bash", json({ command: "pwd", timeout: 600 })),
    {
      name: "bash",
      value: { command: "pwd", timeoutSeconds: 600 },
    },
  );

  for (const value of [
    {},
    { timeout: 1 },
    { command: "pwd", extra: true },
  ]) {
    expectFailure("bash", json(value));
  }
  for (const command of ["", "a\0b", "\ud800", "\udfff", 1, null]) {
    expectFailure("bash", json({ command }));
  }
  for (const timeout of [-1, 0, 600.000_001, "1", null]) {
    expectFailure("bash", json({ command: "pwd", timeout }));
  }
  expectFailure("bash", '{"command":"pwd","timeout":1e309}');
});

test("web_search validator is search-v1 only and closes query and locale", () => {
  const searchSuccess = (argumentsText: string): ValidatedToolArguments => {
    const result = validateToolArgumentsForProfile(
      "web_search",
      argumentsText,
      "search-v1",
    );
    if (!result.ok) assert.fail(`web_search unexpectedly failed with ${result.code}`);
    assert.equal(result.arguments.name, "web_search");
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.arguments), true);
    assert.equal(Object.isFrozen(result.arguments.value), true);
    return result.arguments;
  };
  const searchFailure = (
    argumentsText: string,
    code: StaticToolValidationCode = "invalid_arguments",
  ): void => {
    const result = validateToolArgumentsForProfile(
      "web_search",
      argumentsText,
      "search-v1",
    );
    if (result.ok) assert.fail(`web_search unexpectedly accepted ${argumentsText}`);
    assert.equal(result.code, code);
  };

  // Only the active search-v1 tools ABI declares the tool.
  for (const profile of ["edit-v5", "edit-v4"] as const) {
    assert.deepEqual(
      validateToolArgumentsForProfile(
        "web_search",
        json({ search_query: "news" }),
        profile,
      ),
      { ok: false, code: "unknown_tool" },
    );
  }

  assert.deepEqual(searchSuccess(json({ search_query: "DeepSeek 最新消息" })), {
    name: "web_search",
    value: { searchQuery: "DeepSeek 最新消息", searchLocale: "" },
  });
  assert.deepEqual(
    searchSuccess(json({ search_query: "news", search_locale: "zh-CN" })),
    {
      name: "web_search",
      value: { searchQuery: "news", searchLocale: "zh-CN" },
    },
  );

  for (const value of [
    {},
    { search_locale: "en-US" },
    { search_query: "news", extra: true },
    { search_query: "news", search_locale: "en-US", extra: true },
  ]) {
    searchFailure(json(value));
  }
  for (const query of ["", "a\0b", "\ud800", "\udfff", 1, null, true]) {
    searchFailure(json({ search_query: query }));
  }
  for (const locale of ["", "a\0b", "\ud800", 1, null, true]) {
    searchFailure(json({ search_query: "news", search_locale: locale }));
  }
  searchFailure("{\"search_query\":\"news\"", "invalid_json");
  searchFailure("null", "invalid_arguments");
});
