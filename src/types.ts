/**
 * Shared types for the hash chain.
 *
 * A chain is a plain array of {@link ChainEntry} objects. There is no class,
 * no hidden state and no I/O in this package. Storing the array (in a
 * database, a file, wherever) is up to the caller.
 */

/** The fields bound into an entry's hash: everything except `entryHash` itself. */
export interface ChainRecord<TPayload = unknown> {
  /** Position of this entry in the chain, starting at 0. `verifyChain` checks it. */
  index: number;
  /**
   * Caller-supplied data. Hashed through the canonicalizer; with the default
   * `canonicalJSON` it is converted the way `JSON.stringify` converts it.
   * Stored by reference: `appendEntry` does not copy or deep-freeze it.
   */
  payload: TPayload;
  /** The previous entry's `entryHash`, or {@link GENESIS_HASH} for the first entry. */
  prevHash: string;
  /**
   * ISO-8601 timestamp from the appending machine's clock. It is hashed, so it
   * cannot be changed later without detection, but nothing checks that it is
   * accurate or that timestamps increase along the chain.
   */
  createdAt: string;
}

/** A {@link ChainRecord} plus the hash that binds it (and, through `prevHash`, every earlier entry). */
export interface ChainEntry<TPayload = unknown> extends ChainRecord<TPayload> {
  /** Lowercase hex SHA-256 of `canonicalize(record without entryHash)` (with the default hasher). */
  entryHash: string;
}

/**
 * Deterministic serializer used as the hash input. Two calls with
 * structurally equal values must return identical strings, whatever their
 * property insertion order. The default is `canonicalJSON`.
 */
export type Canonicalizer = (value: unknown) => string;

/**
 * A SHA-256 function returning lowercase hex. The input string is encoded as
 * UTF-8 first; a lone surrogate is replaced by U+FFFD during encoding (so
 * `"\ud800"` and `"\ufffd"` hash the same). `canonicalJSON` never produces
 * lone surrogates, so this only matters for a custom canonicalizer. Async
 * because Web Crypto's `crypto.subtle.digest` is Promise-based.
 */
export type Hasher = (input: string) => Promise<string>;

/** `prevHash` of the first entry in every chain: 64 zeros (not the hash of anything). */
export const GENESIS_HASH = "0".repeat(64);

/**
 * A checkpoint of a chain: the `entryHash` of the entry at `index`. Any
 * {@link ChainEntry} has this shape, so you can save `chain[chain.length - 1]`
 * (or just its `index` and `entryHash`) as an anchor. It only helps if you
 * keep it somewhere the chain's writer cannot change.
 */
export interface ChainAnchor {
  /** Position of the anchored entry. A non-negative integer. */
  index: number;
  /** The anchored entry's `entryHash`. A non-empty string. */
  entryHash: string;
}

/** Optional checks and settings for `verifyChain`. */
export interface VerifyOptions {
  /**
   * Report the chain invalid if it has fewer entries than this. A
   * non-negative integer; anything else throws a TypeError.
   *
   * This catches entries deleted from the end only if nobody appended new
   * entries afterwards. Appending needs no secret, so someone who can edit
   * the store can truncate and re-extend to the same length. Use `anchor`
   * to detect that.
   */
  expectedMinLength?: number;
  /**
   * An `{ index, entryHash }` checkpoint obtained earlier from a source the
   * chain's writer cannot change (see {@link ChainAnchor}). The chain is
   * invalid unless it has an entry at `anchor.index` with exactly that
   * `entryHash`. This detects any rewrite of entries `0..anchor.index`,
   * including a full recomputation from genesis, and truncation below the
   * anchor. Entries after the anchor are only checked for internal
   * consistency. An invalid anchor object throws a TypeError.
   */
  anchor?: ChainAnchor;
  /** Hash function. Defaults to the Web Crypto `sha256Hex`. Must match the one used to append. */
  hash?: Hasher;
}

/** Outcome of `verifyChain`: the first problem found, or `valid: true`. */
export interface VerifyResult {
  /**
   * True only if `chain` is an array, every entry's `prevHash` links to the
   * previous entry (or {@link GENESIS_HASH}), every `entryHash` matches the
   * recomputed hash, every `index` equals the entry's position, and the
   * `expectedMinLength` and `anchor` checks (when given) pass.
   */
  valid: boolean;
  /**
   * Index of the first entry that failed, or `null` when the chain is valid
   * or when the problem is not at a specific entry (not an array, too short
   * for `expectedMinLength`, or too short to contain the anchor).
   */
  brokenAtIndex: number | null;
  /** Human-readable explanation of the failure, or `null` when valid. */
  reason: string | null;
}
