import assert from "node:assert/strict";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  CredentialError,
  loadDeepSeekCredentialState,
  userCredentialPath,
} from "../../src/ds/credential.js";

const SECRET = "sk-0123456789abcdef0123456789abcdef";

async function home(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-login-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function writeCredentials(homeDir: string, contents: string, mode = 0o600): string {
  const dir = join(homeDir, ".config", "dsh");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "credentials");
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
  return path;
}

function emptyProject(t: TestContext): Promise<string> {
  return home(t);
}

test("the stored path is under the user's config directory", () => {
  assert.equal(
    userCredentialPath({ HOME: "/home/someone" }),
    "/home/someone/.config/dsh/credentials",
  );
  assert.throws(() => userCredentialPath({}), CredentialError);
});

test("a stored key is used when the environment and .env have none", async (t) => {
  const homeDir = await home(t);
  const project = await emptyProject(t);
  writeCredentials(homeDir, `DEEPSEEK_API_KEY=${SECRET}\n`);

  const state = loadDeepSeekCredentialState({
    environment: { HOME: homeDir },
    projectRoot: project,
  });
  assert.equal(state.credentialPresent, true);
});

test("the process environment wins over the stored key", async (t) => {
  const homeDir = await home(t);
  const project = await emptyProject(t);
  // A key that would fail validation if it were ever read.
  writeCredentials(homeDir, "DEEPSEEK_API_KEY=\n");

  const state = loadDeepSeekCredentialState({
    environment: { HOME: homeDir, DEEPSEEK_API_KEY: SECRET },
    projectRoot: project,
  });
  assert.equal(state.credentialPresent, true);
});

test("a world-readable stored key is refused", async (t) => {
  const homeDir = await home(t);
  const project = await emptyProject(t);
  writeCredentials(homeDir, `DEEPSEEK_API_KEY=${SECRET}\n`, 0o644);

  assert.throws(
    () =>
      loadDeepSeekCredentialState({
        environment: { HOME: homeDir },
        projectRoot: project,
      }),
    (error: unknown) =>
      error instanceof CredentialError && error.code === "unsafe_file",
  );
});

test("no credential anywhere reports absent rather than throwing", async (t) => {
  const homeDir = await home(t);
  const project = await emptyProject(t);
  const state = loadDeepSeekCredentialState({
    environment: { HOME: homeDir },
    projectRoot: project,
  });
  assert.equal(state.credentialPresent, false);
});

test("a stored file without the key is rejected", async (t) => {
  const homeDir = await home(t);
  const project = await emptyProject(t);
  writeCredentials(homeDir, "# nothing here\n");

  assert.throws(
    () =>
      loadDeepSeekCredentialState({
        environment: { HOME: homeDir },
        projectRoot: project,
      }),
    CredentialError,
  );
});

test("the stored file keeps owner-only permissions", async (t) => {
  const homeDir = await home(t);
  const path = writeCredentials(homeDir, `DEEPSEEK_API_KEY=${SECRET}\n`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(homeDir, ".config", "dsh")).mode & 0o777, 0o700);
});
