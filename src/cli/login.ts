import { chmodSync, mkdirSync, openSync, closeSync, writeSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { constants } from "node:fs";

import {
  credentialFromSecret,
  userCredentialPath,
} from "../ds/credential.js";
import { verifyDeepSeekCredential } from "../ds/transport.js";

/**
 * Read a secret from the terminal without echoing it.
 *
 * Raw mode is used rather than readline so the value never reaches the shell
 * history, the terminal scrollback, or any log.
 */
export function readSecretFromStream(
  input: NodeJS.ReadStream,
  emit: (text: string) => void,
  prompt: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (input.isTTY !== true) {
      reject(new Error("flashcoder login needs a terminal"));
      return;
    }
    emit(prompt);
    const hadRawMode = input.isRaw === true;
    input.setRawMode(true);
    input.resume();
    // Deliberately no setEncoding: switching the shared stdin stream to string
    // mode is permanent, and whoever owns the stream next may be decoding
    // Buffers. For the same reason a chunk may arrive already decoded — the TUI
    // sets utf8 when it starts — so accept both shapes.
    const decoder = new TextDecoder("utf-8");

    let value = "";
    const finish = (error: Error | null): void => {
      input.off("data", onData);
      if (!hadRawMode) input.setRawMode(false);
      emit("\n");
      if (error !== null) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      const text =
        typeof chunk === "string"
          ? chunk
          : decoder.decode(chunk, { stream: true });
      for (const character of text) {
        const code = character.charCodeAt(0);
        if (code === 0x03) {
          finish(new Error("cancelled"));
          return;
        }
        if (code === 0x0d || code === 0x0a) {
          finish(null);
          return;
        }
        if (code === 0x7f || code === 0x08) {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if (code < 0x20) continue;
        value += character;
      }
    };
    input.on("data", onData);
  });
}

function writeSecret(path: string, secret: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  // O_EXCL after an explicit unlink, so an existing file is replaced rather
  // than appended to or followed through a symlink.
  try {
    unlinkSync(path);
  } catch {
    // absent is the normal case
  }
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(descriptor, `DEEPSEEK_API_KEY=${secret}\n`);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
}

function toStderr(text: string): void {
  process.stderr.write(text);
}

function reportToStderr(text: string): void {
  process.stderr.write(`flashcoder: ${text}`);
}

/**
 * Prompt for a key, check it against the provider, and store it.
 *
 * `report` receives the outcome so the interactive layer can put it in the
 * transcript; the prompt itself always goes to the terminal, because the caller
 * has to hand over the raw screen for the duration either way.
 */
export async function runLogin(
  report: (text: string) => void = reportToStderr,
): Promise<void> {
  const path = userCredentialPath();
  const secret = (
    await readSecretFromStream(process.stdin, toStderr, "DEEPSEEK_API_KEY=")
  ).trim();
  if (secret.length === 0) throw new Error("no key entered");

  report("verifying...\n");
  await verifyDeepSeekCredential(credentialFromSecret(secret));
  writeSecret(path, secret);
  report(`key verified and saved to ${path} (mode 0600)\n`);
}

export function runLogout(
  report: (text: string) => void = reportToStderr,
): void {
  const path = userCredentialPath();
  try {
    unlinkSync(path);
    report(`removed ${path}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      report("no stored key\n");
      return;
    }
    throw error;
  }
}
