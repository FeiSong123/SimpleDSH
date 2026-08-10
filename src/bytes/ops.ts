import { createHash } from "node:crypto";

import { freezeBytes, FrozenBytes } from "./types.js";

const utf8Encoder = new TextEncoder();

export function assertUnicodeScalarString(
  value: string,
  label: string,
): void {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${label} must not contain a lone surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} must not contain a lone surrogate`);
    }
  }
}

export function utf8Bytes(value: string): FrozenBytes {
  return freezeBytes(utf8Encoder.encode(value));
}

type ByteSource = Uint8Array | FrozenBytes;

function sourceLength(source: ByteSource): number {
  return source.byteLength;
}

function copySourceInto(
  source: ByteSource,
  target: Uint8Array,
  offset: number,
): void {
  const defensive =
    source instanceof FrozenBytes ? source.copy() : Uint8Array.from(source);
  Uint8Array.prototype.set.call(target, defensive, offset);
}

function sourceCopy(source: ByteSource): Uint8Array {
  return source instanceof FrozenBytes ? source.copy() : Uint8Array.from(source);
}

export function concatBytes(parts: readonly ByteSource[]): FrozenBytes {
  let byteLength = 0;
  for (const part of parts) byteLength += sourceLength(part);

  const joined = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    copySourceInto(part, joined, offset);
    offset += sourceLength(part);
  }
  return freezeBytes(joined);
}

export function joinBytes(
  parts: readonly ByteSource[],
  separator: ByteSource,
): FrozenBytes {
  if (parts.length === 0) return freezeBytes(new Uint8Array());

  const framed = [];
  for (const [index, part] of parts.entries()) {
    if (index > 0) framed.push(separator);
    framed.push(part);
  }
  return concatBytes(framed);
}

export function sha256Hex(bytes: ByteSource): string {
  return createHash("sha256").update(sourceCopy(bytes)).digest("hex");
}

export function bytesEqual(left: ByteSource, right: ByteSource): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const leftCopy = sourceCopy(left);
  const rightCopy = sourceCopy(right);
  for (let index = 0; index < leftCopy.byteLength; index += 1) {
    if (leftCopy[index] !== rightCopy[index]) return false;
  }
  return true;
}

export function toBase64(bytes: ByteSource): string {
  return Buffer.from(sourceCopy(bytes)).toString("base64");
}

export function fromBase64(value: string): FrozenBytes {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    throw new TypeError("base64 must use canonical padded encoding");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new TypeError("base64 must round-trip canonically");
  }
  return freezeBytes(decoded);
}

export function lengthPrefix(bytes: ByteSource): FrozenBytes {
  const length = BigInt(bytes.byteLength);
  const prefix = new Uint8Array(8);
  new DataView(prefix.buffer).setBigUint64(0, length, false);
  return concatBytes([prefix, bytes]);
}
