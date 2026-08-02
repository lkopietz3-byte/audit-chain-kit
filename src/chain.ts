import { canonicalJSON } from "./canonicalize.js";
import { sha256Hex } from "./hash.js";
import { GENESIS_HASH } from "./types.js";
import type { Canonicalizer, ChainEntry, Hasher, VerifyOptions, VerifyResult } from "./types.js";

export { GENESIS_HASH } from "./types.js";
export type { ChainEntry, ChainRecord, Canonicalizer, Hasher, VerifyOptions, VerifyResult } from "./types.js";

/**
 * Append one entry to a hash chain. Pure function: does not mutate `chain`,
 * returns a new (frozen) array with the new entry on the end.
 *
 * `entryHash = hash(canonicalize({ index, payload, prevHash, createdAt }))`
 * — `prevHash` is a FIELD of the hashed record (not string-concatenated
 * separately), so it's bound into the hash the same way every other field
 * is. This is the same shape used by both source implementations this
 * package was distilled from (`forensic-report-tool`'s `audit.ts` and
 * `cruise-almanac`'s `_audit-log.js`), and it's the well-established
 * pattern shared by essentially every hash-chained-log project — see the
 * README for what is, and isn't, novel here.
 *
 * @param chain - the existing chain (or `[]` for a brand-new one)
 * @param payload - caller data for the new entry; any JSON-serializable value
 * @param canonicalize - defaults to `canonicalJSON` (recursive key-sorted JSON)
 * @param hash - defaults to `sha256Hex` (Web Crypto). Override for the Node fallback or in tests.
 */
export async function appendEntry<TPayload = unknown>(
  chain: readonly ChainEntry<TPayload>[],
  payload: TPayload,
  canonicalize: Canonicalizer = canonicalJSON,
  hash: Hasher = sha256Hex,
): Promise<ChainEntry<TPayload>[]> {
  const prevHash = chain.length > 0 ? chain[chain.length - 1]!.entryHash : GENESIS_HASH;

  const record = {
    index: chain.length,
    payload,
    prevHash,
    createdAt: new Date().toISOString(),
  };

  const entryHash = await hash(canonicalize(record));
  const entry: ChainEntry<TPayload> = Object.freeze({ ...record, entryHash });

  return Object.freeze([...chain, entry]) as ChainEntry<TPayload>[];
}

/**
 * The third-party verifier. Walks the whole chain from genesis, independently
 * recomputing every hash — no trust in whoever produced the `chain` array is
 * required, only in this function's own (auditable, dependency-free) logic.
 *
 * Detects:
 * - a MUTATED payload (or any field): the entry's stored `entryHash` no
 *   longer matches the hash recomputed from its current content.
 * - a SEVERED link: an entry's `prevHash` doesn't equal the previous entry's
 *   `entryHash` (tampering broke the pointer, or the entries are out of order).
 * - an entry SPLICED OUT of the middle: the same severed-link check catches
 *   this too — removing entry N leaves entry N+1's `prevHash` pointing at a
 *   hash that's no longer the preceding array element's `entryHash`.
 * - entries DELETED FROM THE END: unlike a middle splice, a tail deletion
 *   leaves no broken pointer for the walk to find (there's nothing after it
 *   to notice). Pass `expectedMinLength` if you know how long the chain
 *   should be (e.g. from a separately-stored count) and want that checked too.
 *
 * This proves the presented chain is internally consistent and unaltered
 * since it was hashed — it does NOT prove nobody with write access ever
 * rewrote the chain from genesis. Tamper-evident, not tamper-proof.
 *
 * Uses Web Crypto by default (see `hash.ts`) — no import, no npm install,
 * runs in a browser tab someone pastes this into. Async throughout because
 * `crypto.subtle.digest` is async.
 */
export async function verifyChain<TPayload = unknown>(
  chain: readonly ChainEntry<TPayload>[],
  canonicalize: Canonicalizer = canonicalJSON,
  options?: VerifyOptions,
): Promise<VerifyResult> {
  const hash = options?.hash ?? sha256Hex;

  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i]!;

    if (typeof entry?.entryHash !== "string" || typeof entry?.prevHash !== "string") {
      return { valid: false, brokenAtIndex: i, reason: `entry ${i} is missing its hash fields` };
    }

    if (entry.prevHash !== expectedPrev) {
      return {
        valid: false,
        brokenAtIndex: i,
        reason: `entry ${i} prevHash does not match the preceding entry's hash (link severed, entries reordered, or an entry was removed)`,
      };
    }

    const { entryHash, ...record } = entry;
    const recomputed = await hash(canonicalize(record));
    if (recomputed !== entryHash) {
      return {
        valid: false,
        brokenAtIndex: i,
        reason: `entry ${i} content does not match its entryHash (payload was mutated after appending)`,
      };
    }

    expectedPrev = entryHash;
  }

  if (options?.expectedMinLength != null && chain.length < options.expectedMinLength) {
    return {
      valid: false,
      brokenAtIndex: null,
      reason: `chain has ${chain.length} entries but expectedMinLength is ${options.expectedMinLength} — entries may have been deleted from the end of the chain`,
    };
  }

  return { valid: true, brokenAtIndex: null, reason: null };
}
