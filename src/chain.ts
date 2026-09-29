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
 * The input is read once, before the first `await`: its length, the entries
 * in it, and the last entry's `entryHash` and `index`. The returned array is
 * those entries plus the new one, so pushing to, truncating or replacing
 * entries in `chain` while the hash is pending does not change the result. A
 * hole in a sparse array becomes an `undefined` element (which `verifyChain`
 * rejects at its index). The entries themselves are shared, not copied, and
 * the payload is read by reference when it is canonicalized.
 *
 * @param chain - the existing chain, or `[]` to start one
 * @param payload - data for the new entry (see `canonicalJSON` for how non-JSON values are converted)
 * @param canonicalize - defaults to `canonicalJSON`; must be synchronous and return a string
 * @param hash - defaults to `sha256Hex` (Web Crypto); must resolve to a string
 * @throws TypeError if `chain` is not an array (or its length is not a non-negative integer), its last entry has no string `entryHash`, `canonicalize` or `hash` is not a function, or either returns the wrong type
 * @throws RangeError if the last entry's `index` is not `chain.length - 1` (for example, only the tail was passed)
 * @throws whatever `canonicalize` or `hash` throws (for example, `canonicalJSON` on a cyclic payload)
 */
export async function appendEntry<TPayload = unknown>(
  chain: readonly ChainEntry<TPayload>[],
  payload: TPayload,
  canonicalize: Canonicalizer = canonicalJSON,
  hash: Hasher = sha256Hex,
): Promise<readonly Readonly<ChainEntry<TPayload>>[]> {
  assertFunction("appendEntry", "canonicalize", canonicalize);
  assertFunction("appendEntry", "hash", hash);
  if (!isArrayValue(chain)) throw new TypeError("appendEntry: chain must be an array");

  // Everything read from the caller's input happens here, before the first await.
  const length: unknown = chain.length;
  if (!isIndex(length)) throw new TypeError(`appendEntry: chain.length must be a non-negative integer, got ${describe(length)}`);
  let prevHash = GENESIS_HASH;
  let last: unknown;
  if (length > 0) {
    last = chain[length - 1];
    if (!isObject(last)) {
      throw new TypeError(`appendEntry: the last entry (position ${length - 1}) has no string entryHash`);
    }
    const lastEntryHash: unknown = last["entryHash"];
    const lastIndex: unknown = last["index"];
    if (typeof lastEntryHash !== "string") {
      throw new TypeError(`appendEntry: the last entry (position ${length - 1}) has no string entryHash`);
    }
    if (lastIndex !== length - 1) {
      throw new RangeError(
        `appendEntry: the last entry has index ${describe(lastIndex)} but sits at position ${length - 1}; pass the whole chain`,
      );
    }
    prevHash = lastEntryHash;
  }
  const entries: unknown[] = [];
  for (let i = 0; i < length - 1; i++) entries.push(chain[i]);
  if (length > 0) entries.push(last);

  const record = {
    formatVersion: FORMAT_VERSION,
    index: length,
    payload,
    prevHash,
    createdAt: new Date().toISOString(),
  };

  const canonical = canonicalize(record);
  if (typeof canonical !== "string") {
    throw new TypeError(`appendEntry: canonicalize must return a string (synchronously), got ${describe(canonical)}`);
  }
  const entryHash: unknown = await hash(canonical);
  if (typeof entryHash !== "string") {
    throw new TypeError(`appendEntry: hash must resolve to a string, got ${describe(entryHash)}`);
  }
  const entry: Readonly<ChainEntry<TPayload>> = Object.freeze({ ...record, entryHash });

  return Object.freeze([...(entries as ChainEntry<TPayload>[]), entry]);
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
 * Snapshot semantics: the options, the anchor's `index` and `entryHash`, the
 * array's length and its entries, and each entry's own fields are read once,
 * synchronously, before the first `await`. Every decision after that,
 * including the anchor comparison, uses only that snapshot: the anchor is
 * compared with the `entryHash` that was recomputed and matched, never with a
 * value read again after an `await`. Pushing, truncating or replacing entries,
 * or editing an entry's fields or the anchor object, while a hash is pending
 * therefore cannot change the result. The result describes the chain as it was
 * when you called. The snapshot is shallow: each entry's `payload` (and any
 * other nested value) is read by reference when that entry is canonicalized,
 * so editing a payload in place during the call can still change the outcome
 * for that entry. Do not mutate a chain you are verifying, and treat a result
 * as describing the moment you called. A hole in a sparse array is an
 * invalid entry, and nothing after the first entry that is not an object is
 * read.
 *
 * Malformed input fails closed: a non-array `chain` (or one whose `length` is
 * not a non-negative integer) returns `{ valid: false }` rather than throwing.
 * Reasons built from caller values are escaped and bounded: control,
 * line-break, bidirectional and other invisible format characters appear as
 * `\uXXXX`, strings over 80 characters are cut, and objects, symbols and
 * functions are named, never serialized or converted.
 *
 * @param chain - the entries to check, in order
 * @param canonicalize - must be the canonicalizer used to append; defaults to `canonicalJSON`; must be synchronous and return a string
 * @param options - `expectedMinLength`, `anchor`, `hash` (see {@link VerifyOptions}); `undefined` or a plain object, and no other keys
 * @throws TypeError if `options` is not a plain object or has an unknown key, `expectedMinLength` or `anchor` is malformed (including an `anchor.entryHash` that is blank), `canonicalize` or `hash` is not a function, or either returns the wrong type (a caller bug, not a chain problem)
 * @throws whatever `canonicalize` or `hash` throws
 */
export async function verifyChain<TPayload = unknown>(
  chain: readonly ChainEntry<TPayload>[],
  canonicalize: Canonicalizer = canonicalJSON,
  options?: VerifyOptions,
): Promise<VerifyResult> {
  assertFunction("verifyChain", "canonicalize", canonicalize);

  // Options: each field is read exactly once.
  let hashOption: unknown;
  let minLength: unknown;
  let anchorOption: unknown;
  if (options !== undefined) {
    if (!isPlainObject(options)) {
      throw new TypeError(`verifyChain: options must be a plain object or undefined, got ${describe(options)}`);
    }
    for (const key of Object.keys(options)) {
      if (key !== "hash" && key !== "expectedMinLength" && key !== "anchor") {
        throw new TypeError(
          `verifyChain: unknown option ${describe(key)}; the options are expectedMinLength, anchor and hash`,
        );
      }
    }
    hashOption = options.hash;
    minLength = options.expectedMinLength;
    anchorOption = options.anchor;
  }
  if (hashOption !== undefined) assertFunction("verifyChain", "options.hash", hashOption);
  const hash = hashOption === undefined ? sha256Hex : (hashOption as Hasher);
  if (minLength !== undefined && !isIndex(minLength)) {
    throw new TypeError(`verifyChain: expectedMinLength must be a non-negative integer, got ${describe(minLength)}`);
  }
  const anchor = anchorOption === undefined ? undefined : snapshotAnchor(anchorOption);

  if (!isArrayValue(chain)) {
    return { valid: false, brokenAtIndex: null, reason: "chain is not an array" };
  }
  const length: unknown = chain.length;
  if (!isIndex(length)) {
    return { valid: false, brokenAtIndex: null, reason: `chain length is not a non-negative integer (got ${describe(length)})` };
  }

  // Snapshot every entry now, before the first await. The walk below uses only
  // `snapshots`, never `chain`.
  const snapshots = snapshotEntries(chain, length);

  let expectedPrev = GENESIS_HASH;
  let verifiedAnchorHash: string | undefined;
  for (let i = 0; i < snapshots.length; i++) {
    const entry = snapshots[i];

    if (entry === undefined) {
      return { valid: false, brokenAtIndex: i, reason: `entry ${i} is not an object with string prevHash and entryHash` };
    }

    if (entry.formatVersion !== FORMAT_VERSION) {
      return {
        valid: false,
        brokenAtIndex: i,
        reason:
          entry.formatVersion === undefined
            ? `entry ${i} has no formatVersion; this verifier requires ${JSON.stringify(FORMAT_VERSION)}`
            : `entry ${i} has formatVersion ${describe(entry.formatVersion)}; this verifier requires ${JSON.stringify(FORMAT_VERSION)}`,
      };
    }

    if (entry.prevHash !== expectedPrev) {
      return {
        valid: false,
        brokenAtIndex: i,
        reason: `entry ${i} prevHash does not match the preceding entry's hash (link severed, entries reordered, or an entry was removed or inserted)`,
      };
    }

    const canonical = canonicalize(entry.record);
    if (typeof canonical !== "string") {
      throw new TypeError(
        `verifyChain: canonicalize must return a string (synchronously), got ${describe(canonical)} (entry ${i})`,
      );
    }
    const recomputed: unknown = await hash(canonical);
    if (typeof recomputed !== "string") {
      throw new TypeError(`verifyChain: hash must resolve to a string, got ${describe(recomputed)} (entry ${i})`);
    }
    if (recomputed !== entry.entryHash) {
      return {
        valid: false,
        brokenAtIndex: i,
        reason: `entry ${i} content does not match its entryHash (a hashed field was changed, added, or removed after appending)`,
      };
    }

    if (entry.index !== i) {
      return {
        valid: false,
        brokenAtIndex: i,
        reason: `entry ${i} has index ${describe(entry.index)}; expected ${i}`,
      };
    }

    // `entry.entryHash` is the value that just matched the recomputed hash.
    if (anchor !== undefined && i === anchor.index) verifiedAnchorHash = entry.entryHash;
    expectedPrev = entry.entryHash;
  }

  if (minLength !== undefined && length < minLength) {
    return {
      valid: false,
      brokenAtIndex: null,
      reason: `chain has ${length} entries but expectedMinLength is ${minLength} (entries may have been deleted from the end)`,
    };
  }

  if (anchor !== undefined) {
    if (verifiedAnchorHash === undefined) {
      return {
        valid: false,
        brokenAtIndex: null,
        reason: `chain has ${length} entries, so there is no entry at anchor index ${anchor.index} (entries were deleted from the end)`,
      };
    }
    if (verifiedAnchorHash !== anchor.entryHash) {
      return {
        valid: false,
        brokenAtIndex: anchor.index,
        reason: `entry ${anchor.index} entryHash does not match the anchor (entries up to ${anchor.index} were rewritten or replaced)`,
      };
    }
  }

  return { valid: true, brokenAtIndex: null, reason: null };
}

/** One entry as it was at the call: own fields copied once, scalars pulled out. */
interface EntrySnapshot {
  readonly entryHash: string;
  readonly prevHash: string;
  readonly formatVersion: unknown;
  readonly index: unknown;
  /** The entry minus `entryHash`: a shallow copy, so `payload` is still the caller's object. */
  readonly record: Record<string, unknown>;
}

/**
 * Reads `chain[0..length)` once each. Stops after the first element that is
 * not a usable entry (recorded as `undefined`), because the walk reports that
 * index and never looks further; this also bounds the work for a huge sparse
 * array. A hole reads as `undefined`, so it is rejected like any non-object.
 */
function snapshotEntries(chain: readonly unknown[], length: number): (EntrySnapshot | undefined)[] {
  const snapshots: (EntrySnapshot | undefined)[] = [];
  for (let i = 0; i < length; i++) {
    const entry: unknown = chain[i];
    if (!isObject(entry)) {
      snapshots.push(undefined);
      break;
    }
    const { entryHash, ...record } = entry;
    const prevHash = record["prevHash"];
    if (typeof entryHash !== "string" || typeof prevHash !== "string") {
      snapshots.push(undefined);
      break;
    }
    snapshots.push({ entryHash, prevHash, formatVersion: record["formatVersion"], index: record["index"], record });
  }
  return snapshots;
}

/** Reads `index` and `entryHash` once and validates the copies. */
function snapshotAnchor(anchor: unknown): ChainAnchor {
  const index: unknown = isObject(anchor) ? anchor["index"] : undefined;
  const entryHash: unknown = isObject(anchor) ? anchor["entryHash"] : undefined;
  if (!isIndex(index) || typeof entryHash !== "string" || isBlank(entryHash)) {
    throw new TypeError("verifyChain: anchor must be { index: non-negative integer, entryHash: non-empty string }");
  }
  return { index, entryHash };
}

/** Plain boolean (not a type guard), so it does not widen a readonly array to any[]. */
function isArrayValue(value: unknown): boolean {
  return Array.isArray(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** An object literal, `Object.create(null)`, or the same from another realm; not a Map, Date, array or class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Empty, or only whitespace and Default_Ignorable_Code_Point characters (zero-width, bidi controls, fillers). */
function isBlank(value: string): boolean {
  return /^[\s\p{Default_Ignorable_Code_Point}]*$/u.test(value);
}

function assertFunction(fn: string, name: string, value: unknown): asserts value is (...args: never[]) => unknown {
  if (typeof value !== "function") throw new TypeError(`${fn}: ${name} must be a function, got ${describe(value)}`);
}

const LONGEST_STRING = 80;
const UNSAFE_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * Text for an error message or reason. Never throws and never runs caller
 * code: it looks at `typeof` only, so a BigInt, a cyclic object, a `toJSON` or
 * `toString` that throws, a null-prototype object or a revoked proxy are all
 * fine. Strings are quoted, cut at 80 characters, and every control,
 * line-break, bidirectional or other invisible format character is written as
 * `\uXXXX` (or `\u{X}`), so the text cannot forge a new line or send a
 * terminal escape.
 */
function describe(value: unknown): string {
  switch (typeof value) {
    case "string":
      return describeString(value);
    case "bigint":
      return `${value}n`;
    case "number":
    case "boolean":
    case "undefined":
      return String(value);
    case "symbol":
      return "a symbol";
    case "function":
      return "a function";
    default:
      return value === null ? "null" : "an object";
  }
}

function describeString(value: string): string {
  const shown = value.length > LONGEST_STRING ? value.slice(0, LONGEST_STRING) : value;
  const quoted = JSON.stringify(shown).replace(UNSAFE_CHARACTER, (char) => {
    const code = char.codePointAt(0)!;
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
  return value.length > LONGEST_STRING ? `${quoted}... (${value.length} characters)` : quoted;
}
