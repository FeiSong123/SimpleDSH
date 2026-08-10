import {
  fromBase64,
  sha256Hex,
  toBase64,
} from "../bytes/ops.js";
import { freezeBytes, FrozenBytes } from "../bytes/types.js";
import {
  createBlobCas,
  type FixedCas,
} from "../artifact/internal-cas.js";
import type { BlobRef as ArtifactBlobRef } from "../artifact/types.js";
import type { PersistenceTestControls } from "../journal/faults.js";
import type {
  BlobPayload,
  BlobRef,
  BlobRole,
  Sha256,
} from "../journal/types.js";
import {
  advanceBlobPrefix,
  assertBlobPosition,
  freezeBlobBytes,
  INLINE_BLOB_LIMIT,
  type BlobPosition,
} from "./prefix.js";

const LOAD_RANGE_BYTES = 32_768;

export { advanceBlobPrefix, INLINE_BLOB_LIMIT } from "./prefix.js";
export type { BlobPosition } from "./prefix.js";

export interface BlobStore {
  publish<Role extends BlobRole>(
    role: Role,
    bytes: Uint8Array | FrozenBytes,
    position: BlobPosition,
  ): Promise<BlobPayload<Role>>;
  load<Role extends BlobRole>(
    payload: BlobPayload<Role>,
    position: BlobPosition,
  ): Promise<FrozenBytes>;
}

async function loadExternal(
  cas: FixedCas<ArtifactBlobRef>,
  ref: ArtifactBlobRef,
  expectedCount: number,
): Promise<FrozenBytes> {
  const verified = await cas.verifyObject(ref);
  if (verified.byteCount !== expectedCount) {
    throw new TypeError("External Blob byte count does not match its event");
  }
  const bytes = new Uint8Array(expectedCount);
  let offset = 0;
  while (offset < expectedCount) {
    const range = await cas.readVerifiedRange(ref, {
      offset,
      maxBytes: Math.min(LOAD_RANGE_BYTES, expectedCount - offset),
    });
    if (range.byteCount === 0) {
      throw new TypeError("External Blob read made no progress");
    }
    bytes.set(range.bytes.copy(), offset);
    offset += range.byteCount;
  }
  return freezeBytes(bytes);
}

class BlobStoreImplementation implements BlobStore {
  readonly #cas: FixedCas<ArtifactBlobRef>;

  constructor(cas: FixedCas<ArtifactBlobRef>) {
    this.#cas = cas;
  }

  async publish<Role extends BlobRole>(
    role: Role,
    source: Uint8Array | FrozenBytes,
    position: BlobPosition,
  ): Promise<BlobPayload<Role>> {
    if (role !== "user" && role !== "assistant" && role !== "tool") {
      throw new TypeError("Blob role is invalid");
    }
    assertBlobPosition(position);
    const bytes = freezeBlobBytes(source);
    const byteHash = `sha256:${sha256Hex(bytes)}` as Sha256;
    const chainHash = advanceBlobPrefix(bytes, position);
    if (bytes.byteLength <= INLINE_BLOB_LIMIT) {
      return Object.freeze({
        role,
        enc: "b64",
        bytes: toBase64(bytes),
        byteCount: bytes.byteLength,
        byteHash,
        blobIndex: position.blobIndex,
        chainHash,
      });
    }
    const published = await this.#cas.publishBytes(bytes);
    if (published.hash !== byteHash || published.byteCount !== bytes.byteLength) {
      throw new TypeError("External Blob publication changed its bytes");
    }
    return Object.freeze({
      role,
      enc: "ref",
      blobRef: published.ref as BlobRef,
      byteCount: bytes.byteLength,
      byteHash,
      blobIndex: position.blobIndex,
      chainHash,
    });
  }

  async load<Role extends BlobRole>(
    payload: BlobPayload<Role>,
    position: BlobPosition,
  ): Promise<FrozenBytes> {
    assertBlobPosition(position);
    if (
      payload.blobIndex !== position.blobIndex ||
      !Number.isSafeInteger(payload.byteCount) ||
      payload.byteCount < 0
    ) {
      throw new TypeError("Blob event position or byte count is invalid");
    }
    let bytes: FrozenBytes;
    if (payload.enc === "b64") {
      if (payload.byteCount > INLINE_BLOB_LIMIT) {
        throw new TypeError("Large Blob cannot be inline");
      }
      bytes = fromBase64(payload.bytes);
    } else {
      if (payload.byteCount <= INLINE_BLOB_LIMIT) {
        throw new TypeError("Small Blob must be inline");
      }
      const expectedRef = `blobs/sha256/${payload.byteHash.slice("sha256:".length)}`;
      if (payload.blobRef !== expectedRef) {
        throw new TypeError("External Blob ref does not match its hash");
      }
      bytes = await loadExternal(
        this.#cas,
        payload.blobRef as ArtifactBlobRef,
        payload.byteCount,
      );
    }
    if (
      bytes.byteLength !== payload.byteCount ||
      `sha256:${sha256Hex(bytes)}` !== payload.byteHash ||
      advanceBlobPrefix(bytes, position) !== payload.chainHash
    ) {
      throw new TypeError("Blob bytes or prefix chain do not match the event");
    }
    return freezeBytes(bytes.copy());
  }
}

export async function createBlobStore(
  sessionDir: string,
  controls?: PersistenceTestControls,
): Promise<BlobStore> {
  return new BlobStoreImplementation(await createBlobCas(sessionDir, controls));
}
