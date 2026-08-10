import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspect } from "node:util";

import { buildDeepSeekRequestSnapshot } from "../../src/bytes/request.js";
import { ACTIVE_SYSTEM_MESSAGE_BYTES } from "../../src/bytes/system.js";
import { utf8View } from "../../src/bytes/view.js";
import {
  authorizationHeaderForDeepSeekTransport,
  CredentialError,
  loadDeepSeekCredential,
  redactDeepSeekHeaders,
} from "../../src/ds/credential.js";

const fixtureKey = "sk-fixture-never-real-02";

function temporaryProject(): string {
  return mkdtempSync(join(tmpdir(), "simpledsh-credential-"));
}

function ignoredProject(): string {
  const root = temporaryProject();
  execFileSync("git", ["init", "--quiet", root]);
  writeFileSync(join(root, ".gitignore"), ".env\n", "utf8");
  return root;
}

test("an unsafe present .env rejects startup even when process env has a key", () => {
  const root = temporaryProject();
  symlinkSync(join(root, "missing-target"), join(root, ".env"));
  assert.throws(
    () =>
      loadDeepSeekCredential({
        environment: { DEEPSEEK_API_KEY: fixtureKey },
        projectRoot: root,
      }),
    (error: unknown) =>
      error instanceof CredentialError && error.code === "unsafe_file",
  );
});

test("safe ignored mode-0600 .env loads and all object views redact", () => {
  const root = ignoredProject();
  writeFileSync(join(root, ".env"), `DEEPSEEK_API_KEY='${fixtureKey}'\n`, {
    mode: 0o600,
  });
  chmodSync(join(root, ".env"), 0o600);
  const credential = loadDeepSeekCredential({ environment: {}, projectRoot: root });
  assert.equal(String(credential), "[DeepSeekCredential REDACTED]");
  assert.equal(inspect(credential), "[DeepSeekCredential REDACTED]");
  assert.equal(JSON.stringify(credential), '"[DeepSeekCredential REDACTED]"');
});

test("credential Git hygiene subprocesses do not inherit ambient secret or trace variables", () => {
  const root = ignoredProject();
  const tracePath = join(root, "credential-git-trace.log");
  writeFileSync(join(root, ".env"), `DEEPSEEK_API_KEY=${fixtureKey}\n`, {
    mode: 0o600,
  });
  chmodSync(join(root, ".env"), 0o600);
  const previousKey = process.env["DEEPSEEK_API_KEY"];
  const previousTrace = process.env["GIT_TRACE"];
  process.env["DEEPSEEK_API_KEY"] = "synthetic-ambient-secret-marker";
  process.env["GIT_TRACE"] = tracePath;
  Object.defineProperty(Object.prototype, "GIT_TRACE", {
    configurable: true,
    enumerable: true,
    value: tracePath,
  });
  try {
    assert.doesNotThrow(() =>
      loadDeepSeekCredential({ environment: {}, projectRoot: root })
    );
  } finally {
    if (previousKey === undefined) delete process.env["DEEPSEEK_API_KEY"];
    else process.env["DEEPSEEK_API_KEY"] = previousKey;
    if (previousTrace === undefined) delete process.env["GIT_TRACE"];
    else process.env["GIT_TRACE"] = previousTrace;
    delete (Object.prototype as Record<string, unknown>)["GIT_TRACE"];
  }
  assert.equal(existsSync(tracePath), false);
});

test("present .env must be ignored while a hard link is not a launch gate", () => {
  const nonIgnored = temporaryProject();
  execFileSync("git", ["init", "--quiet", nonIgnored]);
  writeFileSync(join(nonIgnored, ".env"), `DEEPSEEK_API_KEY=${fixtureKey}\n`, {
    mode: 0o600,
  });
  assert.throws(
    () => loadDeepSeekCredential({ environment: {}, projectRoot: nonIgnored }),
    (error: unknown) =>
      error instanceof CredentialError && error.code === "tracked_file",
  );

  const linked = ignoredProject();
  writeFileSync(join(linked, ".env"), `DEEPSEEK_API_KEY=${fixtureKey}\n`, {
    mode: 0o600,
  });
  linkSync(join(linked, ".env"), join(linked, "credential-copy"));
  assert.doesNotThrow(() =>
    loadDeepSeekCredential({ environment: {}, projectRoot: linked })
  );
});

test("credential loader rejects symlink loose mode and tracked .env", () => {
  const symlinkRoot = temporaryProject();
  writeFileSync(join(symlinkRoot, "key"), `DEEPSEEK_API_KEY=${fixtureKey}\n`, {
    mode: 0o600,
  });
  symlinkSync(join(symlinkRoot, "key"), join(symlinkRoot, ".env"));
  assert.throws(
    () => loadDeepSeekCredential({ environment: {}, projectRoot: symlinkRoot }),
    (error: unknown) => error instanceof CredentialError && error.code === "unsafe_file",
  );

  const looseRoot = temporaryProject();
  writeFileSync(join(looseRoot, ".env"), `DEEPSEEK_API_KEY=${fixtureKey}\n`, {
    mode: 0o644,
  });
  chmodSync(join(looseRoot, ".env"), 0o644);
  assert.throws(
    () => loadDeepSeekCredential({ environment: {}, projectRoot: looseRoot }),
    (error: unknown) => error instanceof CredentialError && error.code === "unsafe_file",
  );

  const trackedRoot = temporaryProject();
  execFileSync("git", ["init", "--quiet", trackedRoot]);
  writeFileSync(join(trackedRoot, ".env"), `DEEPSEEK_API_KEY=${fixtureKey}\n`, {
    mode: 0o600,
  });
  chmodSync(join(trackedRoot, ".env"), 0o600);
  execFileSync("git", ["-C", trackedRoot, "add", "-f", ".env"]);
  assert.throws(
    () => loadDeepSeekCredential({ environment: {}, projectRoot: trackedRoot }),
    (error: unknown) => error instanceof CredentialError && error.code === "tracked_file",
  );
});

test("authorization is transient and diagnostics are redacted", () => {
  const credential = loadDeepSeekCredential({
    environment: { DEEPSEEK_API_KEY: fixtureKey },
  });
  const snapshot = buildDeepSeekRequestSnapshot([ACTIVE_SYSTEM_MESSAGE_BYTES]);
  const headers = {
    authorization: authorizationHeaderForDeepSeekTransport(credential),
    "content-type": "application/json",
  };
  assert.equal(utf8View(snapshot.body).includes(fixtureKey), false);
  assert.deepEqual(redactDeepSeekHeaders(headers), {
    authorization: "[REDACTED]",
    "content-type": "application/json",
  });
  assert.equal(JSON.stringify(redactDeepSeekHeaders(headers)).includes(fixtureKey), false);
});
