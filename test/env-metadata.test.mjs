import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { lstatIfPresent } from "../scripts/env-metadata.mjs";

test("dangling .env symlink remains visible to metadata checks", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "simpledsh-env-metadata-"));
  const envPath = join(fixtureRoot, ".env");

  try {
    symlinkSync(join(fixtureRoot, "missing-target"), envPath);
    const info = lstatIfPresent(envPath);

    ok(info !== undefined);
    strictEqual(info.isSymbolicLink(), true);
  } finally {
    rmSync(fixtureRoot, { recursive: true });
  }
});
