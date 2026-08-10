import {
  createSnapshotCas,
  type FixedCas,
} from "../artifact/internal-cas.js";
import type {
  Sha256 as ArtifactSha256,
  SnapshotRef as ArtifactSnapshotRef,
} from "../artifact/types.js";
import { freezeBytes, FrozenBytes } from "../bytes/types.js";
import type { PersistenceTestControls } from "../journal/faults.js";
import type { Sha256, SnapshotRef } from "../journal/types.js";

const LOAD_RANGE_BYTES = 32_768;

export interface SnapshotDescriptor {
  readonly bodyRef: SnapshotRef;
  readonly bodyHash: Sha256;
  readonly byteCount: number;
}

export interface SnapshotStore {
  publish(bytes: Uint8Array | FrozenBytes): Promise<SnapshotDescriptor>;
  load(descriptor: SnapshotDescriptor): Promise<FrozenBytes>;
  verify(descriptor: SnapshotDescriptor): Promise<void>;
}

class SnapshotStoreImplementation implements SnapshotStore {
  readonly #cas: FixedCas<ArtifactSnapshotRef>;

  constructor(cas: FixedCas<ArtifactSnapshotRef>) {
    this.#cas = cas;
  }

  async publish(bytes: Uint8Array | FrozenBytes): Promise<SnapshotDescriptor> {
    if (!(bytes instanceof Uint8Array) && !(bytes instanceof FrozenBytes)) {
      throw new TypeError("Snapshot store accepts only explicit bytes");
    }
    const published = await this.#cas.publishBytes(bytes);
    return Object.freeze({
      bodyRef: published.ref as SnapshotRef,
      bodyHash: published.hash as Sha256,
      byteCount: published.byteCount,
    });
  }

  async verify(descriptor: SnapshotDescriptor): Promise<void> {
    await this.#cas.verifyObject(descriptor.bodyRef as ArtifactSnapshotRef, {
      hash: descriptor.bodyHash as ArtifactSha256,
      byteCount: descriptor.byteCount,
    });
  }

  async load(descriptor: SnapshotDescriptor): Promise<FrozenBytes> {
    await this.verify(descriptor);
    const bytes = new Uint8Array(descriptor.byteCount);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const range = await this.#cas.readVerifiedRange(
        descriptor.bodyRef as ArtifactSnapshotRef,
        {
          offset,
          maxBytes: Math.min(LOAD_RANGE_BYTES, bytes.byteLength - offset),
        },
      );
      if (range.byteCount === 0) {
        throw new TypeError("Snapshot read made no progress");
      }
      bytes.set(range.bytes.copy(), offset);
      offset += range.byteCount;
    }
    return freezeBytes(bytes);
  }
}

export async function createSnapshotStore(
  sessionDir: string,
  controls?: PersistenceTestControls,
): Promise<SnapshotStore> {
  return new SnapshotStoreImplementation(
    await createSnapshotCas(sessionDir, controls),
  );
}
