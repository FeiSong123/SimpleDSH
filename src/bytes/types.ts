const constructionToken = Symbol("FrozenBytes construction");

export class FrozenBytes {
  readonly #bytes: Uint8Array;

  private constructor(source: Uint8Array, token: symbol) {
    if (token !== constructionToken || new.target !== FrozenBytes) {
      throw new TypeError("FrozenBytes must be created through copyOf");
    }
    this.#bytes = Uint8Array.from(source);
    Object.freeze(this);
  }

  static copyOf(source: Uint8Array): FrozenBytes {
    return new FrozenBytes(source, constructionToken);
  }

  get byteLength(): number {
    return this.#bytes.byteLength;
  }

  copy(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

Object.freeze(FrozenBytes.prototype);
Object.freeze(FrozenBytes);

export function freezeBytes(bytes: Uint8Array): FrozenBytes {
  return FrozenBytes.copyOf(bytes);
}
