/**
 * Shared types for the append-only hash chain.
 *
 * A chain is just an array of {@link ChainEntry} objects. There is no class,
 * no hidden state, and no I/O in this package — `appendEntry` and
 * `verifyChain` are pure(ish; hashing is async) functions over plain arrays.
 * Persisting the array (to Postgres, a file, localStorage, wherever) is the
 * caller's problem; see `reference-impl/postgres-advisory-lock-append.sql`
 * for a concurrency-safe way to do that with a real database.
 */

/** The fields that are bound into an entry's hash. Everything except `entryHash` itself. */
export interface ChainRecord<TPayload = unknown> {
  /** Position of this entry in the chain, starting at 0. */
  index: number;
  /** Caller-supplied data for this entry. Hashed via `canonicalize`, so any JSON-serializable value works. */
  payload: TPayload;
  /** The previous entry's `entryHash`, or {@link GENESIS_HASH} for the first entry. */
  prevHash: string;
  /** ISO-8601 timestamp set at append time. */
  createdAt: string;
}

/** A `ChainRecord` plus the hash that binds it (and, transitively, every prior entry) together. */
export interface ChainEntry<TPayload = unknown> extends ChainRecord<TPayload> {
  /** SHA-256 hex digest of `canonicalize(record without entryHash)`. */
  entryHash: string;
}

/**
 * Deterministic serializer used as hashing input. Two calls with
 * structurally-equal values MUST return byte-identical strings, regardless
 * of property insertion order — that's what makes the hash chain verifiable
 * across independent reimplementations (e.g. a browser verifier written by
 * someone who has never seen this codebase).
 */
export type Canonicalizer = (value: unknown) => string;

/**
 * A SHA-256 hex-digest function. Async because the default implementation
 * uses `crypto.subtle.digest`, which is Promise-based by design (there is no
 * synchronous Web Crypto digest API in any environment).
 */
export type Hasher = (input: string) => Promise<string>;

/** Genesis link for the first entry in any chain — 64 hex zeros (not a real SHA-256 output). */
export const GENESIS_HASH = "0".repeat(64);

export interface VerifyOptions {
  /**
   * If the chain is expected to have at least this many entries, a shorter
   * chain is reported invalid even when every present entry's hash checks
   * out. This is the only way to catch entries deleted from the END of the
   * chain — a tail truncation leaves no broken `prevHash` pointer behind for
   * the walk to notice, since there's nothing after it to point at it.
   */
  expectedMinLength?: number;
  /** Override the hash function (e.g. to use the Node fallback). Defaults to the Web Crypto `sha256Hex`. */
  hash?: Hasher;
}

export interface VerifyResult {
  /** True iff every entry's `prevHash` chains correctly and every `entryHash` matches its recomputed hash. */
  valid: boolean;
  /**
   * Index of the first entry that failed verification, or `null` when the
   * chain is fully valid OR when the only problem found is a length
   * shortfall (see `VerifyOptions.expectedMinLength`) — a shortfall isn't a
   * broken entry at a specific index, it's an absence of entries past the
   * end of what's present.
   */
  brokenAtIndex: number | null;
  /** Human-readable explanation of the failure, or `null` when valid. */
  reason: string | null;
}
