import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { lengthPrefix } from "../../src/bytes/ops.js";
import { freezeBytes } from "../../src/bytes/types.js";
import {
  advanceBlobPrefix,
  createBlobStore,
  INLINE_BLOB_LIMIT,
} from "../../src/blob/store.js";
import { createSnapshotStore } from "../../src/snapshot/store.js";
import type { Sha256 } from "../../src/journal/types.js";

async function sessionDirectory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "simpledsh-blob-"));
  await chmod(path, 0o700);
  t.after(async () => rm(path, { recursive: true, force: true }));
  return path;
}

test("frozen base64 Unicode blobs roundtrip exactly across the 65536-byte boundary", async (t) => {
  const store = await createBlobStore(await sessionDirectory(t), {
    maxWriteBytes: 31,
  });
  const unicode = new TextEncoder().encode("深度思考🙂\u0000字节");
  const small = new Uint8Array(INLINE_BLOB_LIMIT);
  for (let index = 0; index < small.byteLength; index += 1) {
    small[index] = unicode[index % unicode.byteLength]!;
  }
  const inline = await store.publish("user", small, {
    blobIndex: 0,
    previousChainHash: null,
  });
  assert.equal(inline.enc, "b64");
  small.fill(0);
  const restoredInline = await store.load(inline, {
    blobIndex: 0,
    previousChainHash: null,
  });
  assert.notDeepEqual(restoredInline.copy(), small);
  assert.equal(restoredInline.byteLength, INLINE_BLOB_LIMIT);

  const large = new Uint8Array(INLINE_BLOB_LIMIT + 1);
  large.fill(0xa5);
  large.set(unicode, 13);
  const expectedLarge = Uint8Array.from(large);
  const external = await store.publish("assistant", large, {
    blobIndex: 1,
    previousChainHash: inline.chainHash,
  });
  assert.equal(external.enc, "ref");
  large.fill(0);
  assert.deepEqual(
    (
      await store.load(external, {
        blobIndex: 1,
        previousChainHash: inline.chainHash,
      })
    ).copy(),
    expectedLarge,
  );
});

test("blob prefix chain uses raw digest bytes and rejects index or chain discontinuity", async (t) => {
  const store = await createBlobStore(await sessionDirectory(t));
  const firstBytes = new TextEncoder().encode("first");
  const secondBytes = new TextEncoder().encode("second");
  const first = await store.publish("user", firstBytes, {
    blobIndex: 0,
    previousChainHash: null,
  });
  const second = await store.publish("tool", secondBytes, {
    blobIndex: 1,
    previousChainHash: first.chainHash,
  });

  const rawPrevious = Buffer.from(
    first.chainHash.slice("sha256:".length),
    "hex",
  );
  const independentRaw = createHash("sha256")
    .update(lengthPrefix(rawPrevious).copy())
    .update(lengthPrefix(secondBytes).copy())
    .digest("hex");
  const wrongAscii = createHash("sha256")
    .update(lengthPrefix(new TextEncoder().encode(first.chainHash)).copy())
    .update(lengthPrefix(secondBytes).copy())
    .digest("hex");
  assert.equal(second.chainHash, `sha256:${independentRaw}`);
  assert.notEqual(independentRaw, wrongAscii);
  assert.equal(
    advanceBlobPrefix(secondBytes, {
      blobIndex: 1,
      previousChainHash: first.chainHash,
    }),
    second.chainHash,
  );

  await assert.rejects(
    store.load(second, { blobIndex: 2, previousChainHash: first.chainHash }),
  );
  await assert.rejects(
    store.load(
      { ...second, chainHash: `sha256:${"f".repeat(64)}` as Sha256 },
      { blobIndex: 1, previousChainHash: first.chainHash },
    ),
  );
  assert.throws(() =>
    advanceBlobPrefix(secondBytes, {
      blobIndex: 0,
      previousChainHash: first.chainHash,
    }),
  );
});

test("snapshot bodies are always external durable and replay byte exact", async (t) => {
  const store = await createSnapshotStore(await sessionDirectory(t), {
    maxWriteBytes: 1,
  });
  const source = new TextEncoder().encode("{}");
  const expected = Uint8Array.from(source);
  const descriptor = await store.publish(freezeBytes(source));
  source.fill(0);
  assert.match(descriptor.bodyRef, /^snapshots\/sha256\/[0-9a-f]{64}$/u);
  assert.equal(descriptor.byteCount, 2);
  await store.verify(descriptor);
  assert.deepEqual((await store.load(descriptor)).copy(), expected);
  const duplicate = await store.publish(expected);
  assert.deepEqual(duplicate, descriptor);
});
