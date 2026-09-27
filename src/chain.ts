import { canonicalJSON } from "./canonicalize.js";
import { sha256Hex } from "./hash.js";
import { FORMAT_VERSION, GENESIS_HASH } from "./types.js";
import type { Canonicalizer, ChainAnchor, ChainEntry, Hasher, VerifyOptions, VerifyResult } from "./types.js";

export { FORMAT_VERSION, GENESIS_HASH } from "./types.js";
export type {
  ChainAnchor,
  ChainEntry,
  ChainRecord,
  Canonicalizer,
  Hasher,
  VerifyOptions,
  VerifyResult,
} from "./types.js";

/**
 * Append one entry to a chain. Does not mutate `chain`; returns a new frozen
 * array (typed `readonly`) with the new frozen entry at the end. The payload object itself is
 * stored by reference and not frozen: if you mutate it afterwards, the entry
 * will fail verification.
 *
 * The new entry is
 * `{ formatVersion, index, payload, prevHash, createdAt, entryHash }` where
 * `entryHash = hash(canonicalize({ formatVersion, index, payload, prevHash, createdAt }))`,
 * `formatVersion` is always the current {@link FORMAT_VERSION}, `index =
 * chain.length`, `prevHash` is the last entry's `entryHash` (or
 * {@link GENESIS_HASH} for an empty chain) and `createdAt` is
 * `new Date().toISOString()`. `prevHash` is a field of the hashed record, so
 * with `canonicalJSON` field boundaries are unambiguous.
 *
 * Pass the whole chain. Only the last entry is inspected (the chain is not
 * re-verified), but its `index` must equal its position.
 *
 * @param chain - the existing chain, or `[]` to start one
 * @param payload - data for the new entry (see `canonicalJSON` for how non-JSON values are converted)
 * @param canonicalize - defaults to `canonicalJSON`
 * @param hash - defaults to `sha256Hex` (Web Crypto)
 * @throws TypeError if `chain` is not an array or its last entry has no string `entryHash`
 * @throws RangeError if the last entry's `index` is not `chain.length - 1` (for example, only the tail was passed)
 * @throws whatever `canonicalize` or `hash` throws (for example, `canonicalJSON` on a cyclic payload)
 */
export async function appendEntry<TPayload = unknown>(
  chain: readonly ChainEntry<TPayload>[],
  payload: TPayload,
  canonicalize: Canonicalizer = canonicalJSON,
  hash: Hasher = sha256Hex,
): Promise<readonly Readonly<ChainEntry<TPayload>>[]> {
  if (!isArrayValue(chain)) throw new TypeError("appendEntry: chain must be an array");

  let prevHash = GENESIS_HASH;
  if (chain.length > 0) {
    const last: unknown = chain[chain.length - 1];
    if (!isObject(last) || typeof last["entryHash"] !== "string") {
      throw new TypeError(`appendEntry: the last entry (position ${chain.length - 1}) has no string entryHash`);
    }
    if (last["index"] !== chain.length - 1) {
      throw new RangeError(
        `appendEntry: the last entry has index ${String(last["index"])} but sits at position ${chain.length - 1}; pass the whole chain`,
      );
    }
    prevHash = last["entryHash"];
  }

  const record = {
    formatVersion: FORMAT_VERSION,
    index: chain.length,
    payload,
    prevHash,
    createdAt: new Date().toISOString(),
  };

  const entryHash = await hash(canonicalize(record));
  const entry: Readonly<ChainEntry<TPayload>> = Object.freeze({ ...record, entryHash });

  return Object.freeze([...chain, entry]);
}

/**
 * Recompute and check every link and hash in a chain, from genesis.
 *
 * Checks, for each entry in order: it is an object with string `prevHash`
 * and `entryHash`; its `formatVersion` is exactly the current
 * {@link FORMAT_VERSION} (a missing or different value is rejected with a
 * specific reason, not thrown, and checked before the hash so a version
 * mismatch is never reported as generic content tampering); `prevHash`
 * equals the previous entry's `entryHash` (or {@link GENESIS_HASH});
 * `entryHash` equals the hash of the canonicalized entry minus `entryHash`
 * (so any added, removed or changed field fails); and `index` equals its
 * position. Then the optional `expectedMinLength` and `anchor` checks.
 * Returns the first failure found.
 *
 * What a valid result means: the chain is internally consistent. It does
 * NOT mean nobody changed it. There is no secret key, so anyone who can edit
 * the stored chain can recompute every hash after an edit, delete entries
 * from the end, or append new ones, and the result is still valid. Only an
 * `anchor` (an `entryHash` you got earlier from somewhere the writer cannot
 * change) detects that, and only for entries up to the anchor.
 *
 * Malformed input fails closed: a non-array `chain` returns
 * `{ valid: false }` rather than throwing.
 *
 * @param chain - the entries to check, in order
 * @param canonicalize - must be the canonicalizer used to append; defaults to `canonicalJSON`
 * @param options - `expectedMinLength`, `anchor`, `hash` (see {@link VerifyOptions})
 * @throws TypeError if `expectedMinLength` or `anchor` is malformed (a caller bug, not a chain problem)
 * @throws whatever `canonicalize` or `hash` throws
 */
export async function verifyChain<TPayload = unknown>(
  chain: readonly ChainEntry<TPayload>[],
  canonicalize: Canonicalizer = canonicalJSON,
  options?: VerifyOptions,
): Promise<VerifyResult> {
  const hash = options?.hash ?? sha256Hex;
  const minLength = options?.expectedMinLength;
  const anchor = options?.anchor;
  if (minLength !== undefined && !isIndex(minLength)) {
    throw new TypeError(`verifyChain: expectedMinLength must be a non-negative integer, got ${String(minLength)}`);
  }
  if (anchor !== undefined) assertAnchor(anchor);

  if (!isArrayValue(chain)) {
    return { valid: false, brokenAtIndex: null, reason: "chain is not an array" };
  }

  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < chain.length; i++) {
    const entry: unknown = chain[i];

    if (!isObject(entry) || typeof entry["entryHash"] !== "string" || typeof entry["prevHash"] !== "string") {
      return { valid: false, brokenAtIndex: i, reason: `entry ${i} is not an object with string prevHash and entryHash` };
    }

    const formatVersion = entry["formatVersion"];
    if (formatVersion !== FORMAT_VERSION) {
      return {
        valid: false,
        brokenAtIndex: i,
        reason:
          formatVersion === undefined
            ? `entry ${i} has no formatVersion; this verifier requires ${JSON.stringify(FORMAT_VERSION)}`
            : `entry ${i} has formatVersion ${JSON.stringify(formatVersion)}; this verifier requires ${JSON.stringify(FORMAT_VERSION)}`,
      };
    }

    if (entry["prevHash"] !== expectedPrev) {
      return {
        valid: false,
        brokenAtIndex: i,
        reason: `entry ${i} prevHash does not match the preceding entry's hash (link severed, entries reordered, or an entry was removed or inserted)`,
      };
    }

    const { entryHash, ...record } = entry as Record<string, unknown> & { entryHash: string };
    const recomputed = await hash(canonicalize(record));
    if (recomputed !== entryHash) {
      return {
        valid: false,
        brokenAtIndex: i,
        reason: `entry ${i} content does not match its entryHash (a hashed field was changed, added, or removed after appending)`,
      };
    }

    if (record["index"] !== i) {
      return {
        valid: false,
        brokenAtIndex: i,
        reason: `entry ${i} has index ${JSON.stringify(record["index"]) ?? "undefined"}; expected ${i}`,
      };
    }

    expectedPrev = entryHash;
  }

  if (minLength !== undefined && chain.length < minLength) {
    return {
      valid: false,
      brokenAtIndex: null,
      reason: `chain has ${chain.length} entries but expectedMinLength is ${minLength} (entries may have been deleted from the end)`,
    };
  }

  if (anchor !== undefined) {
    if (chain.length <= anchor.index) {
      return {
        valid: false,
        brokenAtIndex: null,
        reason: `chain has ${chain.length} entries, so there is no entry at anchor index ${anchor.index} (entries were deleted from the end)`,
      };
    }
    if (chain[anchor.index]!.entryHash !== anchor.entryHash) {
      return {
        valid: false,
        brokenAtIndex: anchor.index,
        reason: `entry ${anchor.index} entryHash does not match the anchor (entries up to ${anchor.index} were rewritten or replaced)`,
      };
    }
  }

  return { valid: true, brokenAtIndex: null, reason: null };
}

/** Plain boolean (not a type guard), so it does not widen a readonly array to any[]. */
function isArrayValue(value: unknown): boolean {
  return Array.isArray(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertAnchor(anchor: unknown): asserts anchor is ChainAnchor {
  if (!isObject(anchor) || !isIndex(anchor["index"]) || typeof anchor["entryHash"] !== "string" || anchor["entryHash"] === "") {
    throw new TypeError("verifyChain: anchor must be { index: non-negative integer, entryHash: non-empty string }");
  }
}
