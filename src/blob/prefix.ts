import { concatBytes, lengthPrefix, sha256Hex } from "../bytes/ops.js";
import { freezeBytes, FrozenBytes } from "../bytes/types.js";
import type { Sha256 } from "../journal/types.js";

export const INLINE_BLOB_LIMIT = 65_536;

export interface BlobPosition {
  readonly blobIndex: number;
  readonly previousChainHash: Sha256 | null;
}

export function freezeBlobBytes(
  value: Uint8Array | FrozenBytes,
): FrozenBytes {
  if (value instanceof FrozenBytes) return freezeBytes(value.copy());
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("Blob store accepts only explicit bytes");
  }
  return freezeBytes(value);
}

export function assertBlobPosition(position: BlobPosition): void {
  if (
    typeof position !== "object" ||
    position === null ||
    Reflect.ownKeys(position).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(position, "blobIndex") ||
    !Object.prototype.hasOwnProperty.call(position, "previousChainHash") ||
    !Number.isSafeInteger(position.blobIndex) ||
    position.blobIndex < 0 ||
    (position.blobIndex === 0) !== (position.previousChainHash === null) ||
    (position.previousChainHash !== null &&
      !/^sha256:[0-9a-f]{64}$/u.test(position.previousChainHash))
  ) {
    throw new TypeError("Blob position is not a continuous v1 prefix position");
  }
}

function rawDigest(hash: Sha256): Uint8Array {
  const hex = hash.slice("sha256:".length);
  const digest = new Uint8Array(32);
  for (let index = 0; index < digest.byteLength; index += 1) {
    digest[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return digest;
}

export function advanceBlobPrefix(
  bytes: Uint8Array | FrozenBytes,
  position: BlobPosition,
): Sha256 {
  assertBlobPosition(position);
  const frozen = freezeBlobBytes(bytes);
  return (
    position.previousChainHash === null
      ? `sha256:${sha256Hex(frozen)}`
      : `sha256:${sha256Hex(
          concatBytes([
            lengthPrefix(rawDigest(position.previousChainHash)),
            lengthPrefix(frozen),
          ]),
        )}`
  ) as Sha256;
}
