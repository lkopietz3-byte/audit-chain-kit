import { canonicalJSON } from "./canonicalize.js";
import { assertFunction, describe, describeProblem, isBlank, isIndex, isObject, isPlainObject } from "./chain.js";
import { sha256Hex } from "./hash.js";
import { findJsonProblem } from "./json-data.js";
import { FORMAT_VERSION, GENESIS_HASH } from "./types.js";
import type { Canonicalizer, ChainEntry, Hasher } from "./types.js";

/** `{ index, hash }` of the newest entry of a chain: where the next entry attaches. */
export interface ChainHead {
  /** The newest entry's `index`, or `-1` for an empty chain. */
  readonly index: number;
  /** The newest entry's `entryHash`, or {@link GENESIS_HASH} for an empty chain. */
  readonly hash: string;
}

/** The head of an empty chain: `{ index: -1, hash: GENESIS_HASH }`. */
export const GENESIS_HEAD: ChainHead = Object.freeze({ index: -1, hash: GENESIS_HASH });

/**
 * Reads `value` as a head without throwing: an object with an `index` that is
 * -1 or a non-negative safe integer and a non-blank string `hash`; `-1` goes
 * with {@link GENESIS_HASH} only. Each field is read once.
 */
export function readHead(value: unknown): ChainHead | undefined {
  if (!isObject(value)) return undefined;
  let index: unknown;
  let hash: unknown;
  try {
    index = value["index"];
    hash = value["hash"];
  } catch {
    return undefined;
  }
  if (typeof hash !== "string" || isBlank(hash)) return undefined;
  if (index === -1) return hash === GENESIS_HASH ? GENESIS_HEAD : undefined;
  if (!isIndex(index)) return undefined;
  return Object.freeze({ index, hash });
}

/** Arguments of {@link computeEntry}. */
export interface ComputeEntryInput<TPayload = unknown> {
  /** The previous entry's `entryHash`, or {@link GENESIS_HASH} for the first entry. */
  readonly prevHash: string;
  /** The entry's position. A non-negative safe integer. */
  readonly index: number;
  /** The data to record. Plain JSON data when using the default canonicalizer. */
  readonly payload: TPayload;
  /**
   * The time to record, as a string, taken from your store's clock (for
   * example the database's `now()` read while holding the lock). Hashed as the
   * exact string you pass, so store and re-read it unchanged. Required: this
   * package never reads the clock here.
   */
  readonly createdAt: string;
}

/** Optional settings of {@link computeEntry}. */
export interface ComputeEntryOptions {
  /** Must be the canonicalizer every other append and verify of this chain uses. Defaults to `canonicalJSON`. */
  readonly canonicalize?: Canonicalizer;
  /** Defaults to the Web Crypto `sha256Hex`. */
  readonly hash?: Hasher;
}

/**
 * Computes one chain entry from its parts, without needing the chain in
 * memory: `{ formatVersion, index, payload, prevHash, createdAt, entryHash }`,
 * the same entry `appendEntry` would produce. This is the function to call
 * from a store that holds the last hash and a clock (typically while holding a
 * database lock), then write the result.
 *
 * Nothing here checks that `prevHash` and `index` match your store; that is
 * what `appendIfHead` and the verifier are for. The returned entry is frozen.
 * Each field of `input` is read once.
 *
 * With the default `canonicalJSON`, the payload must be plain JSON data, with
 * the same rules as `appendEntry` (no `undefined`, `Date`, getter, `toJSON`,
 * `NaN`, cycle, or nesting past 255 levels).
 *
 * @throws TypeError for a malformed `input`, a missing, blank or non-string
 *   `createdAt` or `prevHash`, an `index` that is not a non-negative safe
 *   integer, a payload that is not plain JSON data, a canonicalizer that does
 *   not return a string or a hasher that does not resolve to one
 * @throws whatever `canonicalize` or `hash` throws
 */
export async function computeEntry<TPayload = unknown>(
  input: ComputeEntryInput<TPayload>,
  options?: ComputeEntryOptions,
): Promise<Readonly<ChainEntry<TPayload>>> {
  if (!isObject(input)) throw new TypeError(`computeEntry: expected { prevHash, index, payload, createdAt }, got ${describe(input)}`);
  for (const key of Object.keys(input)) {
    if (key !== "prevHash" && key !== "index" && key !== "payload" && key !== "createdAt") {
      throw new TypeError(`computeEntry: unknown field ${describe(key)}; the fields are prevHash, index, payload and createdAt`);
    }
  }
  if (!("payload" in input)) throw new TypeError("computeEntry: payload is missing");
  const prevHash: unknown = input["prevHash"];
  const index: unknown = input["index"];
  const payload = input["payload"];
  const createdAt: unknown = input["createdAt"];

  let canonicalize: Canonicalizer = canonicalJSON;
  let hash: Hasher = sha256Hex;
  if (options !== undefined) {
    if (!isPlainObject(options)) throw new TypeError(`computeEntry: options must be a plain object or undefined, got ${describe(options)}`);
    for (const key of Object.keys(options)) {
      if (key !== "canonicalize" && key !== "hash") {
        throw new TypeError(`computeEntry: unknown option ${describe(key)}; the options are canonicalize and hash`);
      }
    }
    const c: unknown = options.canonicalize;
    const h: unknown = options.hash;
    if (c !== undefined) {
      assertFunction("computeEntry", "options.canonicalize", c);
      canonicalize = c as Canonicalizer;
    }
    if (h !== undefined) {
      assertFunction("computeEntry", "options.hash", h);
      hash = h as Hasher;
    }
  }

  if (typeof prevHash !== "string" || prevHash === "") {
    throw new TypeError(`computeEntry: prevHash must be a non-empty string, got ${describe(prevHash)}`);
  }
  if (!isIndex(index)) throw new TypeError(`computeEntry: index must be a non-negative integer, got ${describe(index)}`);
  if (typeof createdAt !== "string" || isBlank(createdAt)) {
    throw new TypeError(
      `computeEntry: createdAt must be a non-blank string from your store's clock, got ${describe(createdAt)}; this function never reads the clock`,
    );
  }

  const record = { formatVersion: FORMAT_VERSION, index, payload, prevHash, createdAt };
  if (canonicalize === canonicalJSON) {
    const found = findJsonProblem(record);
    if (found !== undefined) {
      throw new TypeError(`computeEntry: the payload is not plain JSON data: ${describeProblem(found)}; convert it to JSON values first`);
    }
  }
  const canonical = canonicalize(record);
  if (typeof canonical !== "string") {
    throw new TypeError(`computeEntry: canonicalize must return a string (synchronously), got ${describe(canonical)}`);
  }
  const entryHash: unknown = await hash(canonical);
  if (typeof entryHash !== "string") {
    throw new TypeError(`computeEntry: hash must resolve to a string, got ${describe(entryHash)}`);
  }
  return Object.freeze({ ...record, entryHash });
}
