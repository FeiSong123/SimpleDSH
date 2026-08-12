import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { bytesEqual, utf8Bytes } from "../../src/bytes/ops.js";
import { viewSystem } from "../../src/bytes/view.js";
import {
  buildCacheAbiV2,
  loadCacheAbi,
  projectInstructionsFromSystemBlob,
} from "../../src/lineage/index.js";
import {
  loadProjectInstructions,
  PROJECT_INSTRUCTIONS_FILE,
  PROJECT_INSTRUCTIONS_LIMIT_BYTES,
  ProjectInstructionsError,
} from "../../src/session/project-instructions.js";

async function workspace(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flashcoder-instructions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function withInstructions(
  t: TestContext,
  contents: string,
): Promise<string> {
  const root = await workspace(t);
  await writeFile(join(root, PROJECT_INSTRUCTIONS_FILE), contents, {
    mode: 0o600,
  });
  return root;
}

test("a workspace without the file has no instructions", async (t) => {
  const root = await workspace(t);
  assert.equal(loadProjectInstructions(root), undefined);
});

test("the file is read as the frozen instruction bytes", async (t) => {
  const root = await withInstructions(t, "Run `npm run test:session`.\n");
  const loaded = loadProjectInstructions(root);
  assert.ok(loaded !== undefined);
  assert.equal(
    bytesEqual(loaded, utf8Bytes("Run `npm run test:session`.")),
    true,
  );
});

test("trailing whitespace does not change the Cache ABI", async (t) => {
  // An editor adding a newline should not open a new Lineage.
  const plain = await withInstructions(t, "Do not edit dist/.");
  const padded = await withInstructions(t, "Do not edit dist/.\n\n  \n");
  const left = buildCacheAbiV2(loadProjectInstructions(plain));
  const right = buildCacheAbiV2(loadProjectInstructions(padded));
  assert.equal(left.cacheAbiId, right.cacheAbiId);
});

test("an empty file is the same as no file", async (t) => {
  const empty = await withInstructions(t, "\n   \n");
  assert.equal(loadProjectInstructions(empty), undefined);
  assert.equal(
    buildCacheAbiV2(loadProjectInstructions(empty)).cacheAbiId,
    buildCacheAbiV2().cacheAbiId,
  );
});

test("instructions change the Cache ABI, which is the point", async (t) => {
  // Different rules are a different frozen zone, so they are a different
  // Lineage. Two workspaces never share a prefix by accident.
  const root = await withInstructions(t, "Never touch generated/.");
  const withRules = buildCacheAbiV2(loadProjectInstructions(root));
  assert.notEqual(withRules.cacheAbiId, buildCacheAbiV2().cacheAbiId);
  assert.match(viewSystem(withRules.systemBlob).content, /Never touch generated\//u);
  assert.doesNotThrow(() =>
    loadCacheAbi(withRules.manifestBytes, withRules.cacheAbiId),
  );
});

test("the frozen instructions can be read back out of the blob", async (t) => {
  // This is how an effort change carries them into the new Lineage instead of
  // reading a file that may have changed since.
  const root = await withInstructions(t, "Use tabs.\nNo default exports.");
  const original = loadProjectInstructions(root);
  const abi = buildCacheAbiV2(original);
  const recovered = projectInstructionsFromSystemBlob(abi.systemBlob);
  assert.ok(original !== undefined && recovered !== undefined);
  assert.equal(bytesEqual(recovered, original), true);
  assert.equal(
    buildCacheAbiV2(recovered, "low").cacheAbiId,
    buildCacheAbiV2(original, "low").cacheAbiId,
  );
});

test("a blob with no instructions reports none", () => {
  assert.equal(
    projectInstructionsFromSystemBlob(buildCacheAbiV2().systemBlob),
    undefined,
  );
});

test("a file too large to freeze fails rather than being cut", async (t) => {
  // Half a rule can say the opposite of the whole rule.
  const root = await withInstructions(
    t,
    "x".repeat(PROJECT_INSTRUCTIONS_LIMIT_BYTES + 1),
  );
  assert.throws(
    () => loadProjectInstructions(root),
    (error: unknown) =>
      error instanceof ProjectInstructionsError && error.reason === "too_large",
  );
});

test("bytes that are not UTF-8 fail rather than being replaced", async (t) => {
  const root = await workspace(t);
  await writeFile(
    join(root, PROJECT_INSTRUCTIONS_FILE),
    Buffer.from([0x41, 0xff, 0x42]),
    { mode: 0o600 },
  );
  assert.throws(
    () => loadProjectInstructions(root),
    (error: unknown) =>
      error instanceof ProjectInstructionsError && error.reason === "not_utf8",
  );
});

test("a directory in its place is an error, not an absence", async (t) => {
  const root = await workspace(t);
  await mkdir(join(root, PROJECT_INSTRUCTIONS_FILE));
  assert.throws(
    () => loadProjectInstructions(root),
    (error: unknown) =>
      error instanceof ProjectInstructionsError && error.reason === "not_a_file",
  );
});

test("a symlink to a real file is followed", async (t) => {
  // Documentation, not a credential: sharing one file across repositories is a
  // reasonable thing to want.
  const root = await workspace(t);
  const shared = join(root, "shared-rules.md");
  await writeFile(shared, "Shared rule.", { mode: 0o600 });
  await symlink(shared, join(root, PROJECT_INSTRUCTIONS_FILE));
  const loaded = loadProjectInstructions(root);
  assert.ok(loaded !== undefined);
  assert.equal(bytesEqual(loaded, utf8Bytes("Shared rule.")), true);
});

test("a dangling symlink is an error, not an absence", async (t) => {
  const root = await workspace(t);
  await symlink(join(root, "gone.md"), join(root, PROJECT_INSTRUCTIONS_FILE));
  assert.throws(() => loadProjectInstructions(root), ProjectInstructionsError);
});
