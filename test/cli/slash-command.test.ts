import assert from "node:assert/strict";
import test from "node:test";

import { isKnownSlashCommand } from "../../src/cli/slash-command.js";
import type { SlashCommand } from "../../src/tui/index.js";

const COMMANDS: readonly SlashCommand[] = Object.freeze([
  { name: "help", description: "keys and commands" },
  { name: "clear", description: "empty the screen" },
  { name: "compact", description: "summarize the conversation" },
  { name: "session", description: "show the session id" },
  { name: "exit", description: "leave flashcoder" },
]);
const ALIASES = Object.freeze(["quit"] as const);

test("slash commands are recognized by their first token", () => {
  for (const text of ["/help", "/clear", "/compact", "/session", "/exit", "/quit"]) {
    assert.equal(isKnownSlashCommand(text, COMMANDS, ALIASES), true, text);
  }
  assert.equal(isKnownSlashCommand("/session abc123", COMMANDS, ALIASES), true);
  assert.equal(isKnownSlashCommand("/help extra words here", COMMANDS, ALIASES), true);
});

test("absolute paths and path-prefixed sentences stay prompts", () => {
  for (const text of [
    "/tmp/report.pdf",
    "/tmp/report.pdf please review this",
    "/etc/hosts",
    "/opt/app/config.json",
    "/Users/me/Downloads/notes.md",
  ]) {
    assert.equal(isKnownSlashCommand(text, COMMANDS, ALIASES), false, text);
  }
});

test("unknown or malformed command-like input stays a prompt", () => {
  for (const text of ["/", "/compactt", "/helpme", "/ QUIT", "not a command"]) {
    assert.equal(isKnownSlashCommand(text, COMMANDS, ALIASES), false, text);
  }
  assert.equal(isKnownSlashCommand("", COMMANDS, ALIASES), false);
  assert.equal(isKnownSlashCommand("/", [], []), false);
});
