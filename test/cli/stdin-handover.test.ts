import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { readSecretFromStream } from "../../src/cli/login.js";

/** Minimal stand-in for process.stdin's TTY surface. */
class FakeTty extends EventEmitter {
  isTTY = true;
  isRaw = false;
  rawCalls: boolean[] = [];
  resumed = 0;

  setRawMode(value: boolean): this {
    this.isRaw = value;
    this.rawCalls.push(value);
    return this;
  }
  resume(): this {
    this.resumed += 1;
    return this;
  }
  pause(): this {
    return this;
  }
  /** Present so a regression that calls it is visible rather than silent. */
  setEncoding(): this {
    throw new Error("setEncoding would switch shared stdin to string mode");
  }
}

function write(): string[] {
  return [];
}

test("the secret prompt reads Buffers and never changes stream encoding", async () => {
  const tty = new FakeTty();
  const out = write();
  const promise = readSecretFromStream(
    tty as never,
    (text) => out.push(text),
    "KEY=",
  );
  // Split across chunks, the way a paste arrives.
  tty.emit("data", Buffer.from("sk-abc"));
  tty.emit("data", Buffer.from("def\r"));

  assert.equal(await promise, "sk-abcdef");
  // The prompt and the closing newline, never the secret itself.
  assert.equal(out.join(""), "KEY=\n");
});

test("a multi-byte character split across chunks survives", async () => {
  const tty = new FakeTty();
  const promise = readSecretFromStream(tty as never, () => undefined, "KEY=");
  const bytes = Buffer.from("秘密");
  tty.emit("data", bytes.subarray(0, 2));
  tty.emit("data", bytes.subarray(2));
  tty.emit("data", Buffer.from("\r"));
  assert.equal(await promise, "秘密");
});

test("backspace deletes a whole code point", async () => {
  const tty = new FakeTty();
  const promise = readSecretFromStream(tty as never, () => undefined, "KEY=");
  tty.emit("data", Buffer.from("ab秘"));
  tty.emit("data", Buffer.from(""));
  tty.emit("data", Buffer.from("\r"));
  assert.equal(await promise, "ab");
});

test("Ctrl-C cancels instead of returning a partial secret", async () => {
  const tty = new FakeTty();
  const promise = readSecretFromStream(tty as never, () => undefined, "KEY=");
  tty.emit("data", Buffer.from("sk-partial"));
  tty.emit("data", Buffer.from(""));
  await assert.rejects(promise, /cancelled/u);
});

test("raw mode is restored only when the caller did not already own it", async () => {
  const owned = new FakeTty();
  owned.isRaw = true;
  const ownedPromise = readSecretFromStream(owned as never, () => undefined, "K=");
  owned.emit("data", Buffer.from("x\r"));
  await ownedPromise;
  // The interactive loop already had raw mode; leaving it on keeps the editor
  // working after /login returns.
  assert.equal(owned.isRaw, true);

  const fresh = new FakeTty();
  const freshPromise = readSecretFromStream(fresh as never, () => undefined, "K=");
  fresh.emit("data", Buffer.from("x\r"));
  await freshPromise;
  assert.equal(fresh.isRaw, false);
});

test("the data listener is removed when the prompt finishes", async () => {
  const tty = new FakeTty();
  const promise = readSecretFromStream(tty as never, () => undefined, "K=");
  assert.equal(tty.listenerCount("data"), 1);
  tty.emit("data", Buffer.from("x\r"));
  await promise;
  assert.equal(tty.listenerCount("data"), 0);
});
