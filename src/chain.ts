import { canonicalJSON, MAX_NESTING_DEPTH, NestingDepthError } from "./canonicalize.js";
import { sha256Hex } from "./hash.js";
import { findJsonProblem } from "./json-data.js";
import type { JsonProblem } from "./json-data.js";
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
 * With the default `canonicalJSON`, the payload must be plain JSON data held
 * in memory exactly as JSON would store it: no `undefined`, functions,
 * symbols, `NaN`/`Infinity`, `toJSON` (so no `Date`), `Map`/`Set`, class
 * instances, getters, non-enumerable properties, array holes, cycles, or
 * nesting deeper than 255 levels. Otherwise the object you hold would not be
 * the object that was hashed, and `verifyChain` could not tell them apart.
 * Convert such values first (for example `date.toISOString()`). A custom
 * `canonicalize` is not checked.
 *
 * @param payload - data for the new entry (plain JSON data when using the default canonicalizer)
 * @param canonicalize - defaults to `canonicalJSON`; must be synchronous and return a string
 * @param hash - defaults to `sha256Hex` (Web Crypto); must resolve to a string
 * @throws TypeError if `chain` is not an array (or its length is not a non-negative integer), its last entry has no string `entryHash`, `canonicalize` or `hash` is not a function, either returns the wrong type, or (default canonicalizer only) the payload is not plain JSON data
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
    const lastEntryHash: unknown = isObject(last) ? last["entryHash"] : undefined;
    const lastIndex: unknown = isObject(last) ? last["index"] : undefined;
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

  if (canonicalize === canonicalJSON) {
    const found = findJsonProblem(record);
    if (found !== undefined) {
      throw new TypeError(
        `appendEntry: the payload is not plain JSON data: ${describeProblem(found)}; convert it to JSON values first`,
      );
    }
  }

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
 * Returns the first failure found, with `entriesChecked`: how many entries
 * passed every per-entry check before the result was decided (an empty chain
 * is `valid: true` with `entriesChecked: 0`).
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
 * With the default `canonicalJSON`, each entry must also be exactly its JSON
 * form in memory (the same rule `appendEntry` applies to payloads, applied to
 * the whole entry; the entry object itself may be a class instance, such as an
 * ORM row, if its own fields are plain data): an entry that holds a `Date`, `undefined`, a function, a
 * symbol, `NaN`, a getter, a non-enumerable or symbol-keyed field, a cycle or
 * nesting deeper than 255 levels in the payload is reported invalid at its
 * index instead of being verified as something it is not. A parsed JSON text
 * always passes this check. A custom `canonicalize` is not checked.
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
 * @throws TypeError if `options` is not a plain object or has an unknown key, `expectedMinLength` or `anchor` is present but `undefined` or malformed (including an `anchor.entryHash` that is blank), `canonicalize` or `hash` is not a function, or either returns the wrong type (a caller bug, not a chain problem)
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
    // A key that is present but undefined (for example, a lookup that found
    // nothing) would otherwise skip the check it was meant to switch on.
    if (minLength === undefined && "expectedMinLength" in options) {
      throw new TypeError("verifyChain: expectedMinLength is present but undefined; leave the key out to skip the check");
    }
    if (anchorOption === undefined && "anchor" in options) {
      throw new TypeError("verifyChain: anchor is present but undefined; leave the key out to skip the check");
    }
  }
  if (hashOption !== undefined) assertFunction("verifyChain", "options.hash", hashOption);
  const hash = hashOption === undefined ? sha256Hex : (hashOption as Hasher);
  if (minLength !== undefined && !isIndex(minLength)) {
    throw new TypeError(`verifyChain: expectedMinLength must be a non-negative integer, got ${describe(minLength)}`);
  }
  const anchor = anchorOption === undefined ? undefined : snapshotAnchor(anchorOption);

  let length: unknown;
  try {
    if (!isArrayValue(chain)) {
      return { valid: false, brokenAtIndex: null, reason: "chain is not an array", entriesChecked: 0 };
    }
    length = chain.length;
  } catch {
    return { valid: false, brokenAtIndex: null, reason: "chain could not be read (a proxy or getter threw)", entriesChecked: 0 };
  }
  if (!isIndex(length)) {
    return {
      valid: false,
      brokenAtIndex: null,
      reason: `chain length is not a non-negative integer (got ${describe(length)})`,
      entriesChecked: 0,
    };
  }

  // Snapshot every entry now, before the first await. The walk below uses only
  // `snapshots`, never `chain`.
  const checkJson = canonicalize === canonicalJSON;
  const snapshots = snapshotEntries(chain, length, checkJson);
  let checked = 0;
  const invalid = (brokenAtIndex: number | null, reason: string): VerifyResult => ({
    valid: false,
    brokenAtIndex,
    reason,
    entriesChecked: checked,
  });

  let expectedPrev = GENESIS_HASH;
  let verifiedAnchorHash: string | undefined;
  for (let i = 0; i < snapshots.length; i++) {
    const entry = snapshots[i]!;

    if (entry.unusable !== undefined) {
      return invalid(
        i,
        entry.unusable === "unreadable"
          ? `entry ${i} could not be read (a proxy or getter threw)`
          : `entry ${i} is not an object with string prevHash and entryHash`,
      );
    }

    if (entry.formatVersion !== FORMAT_VERSION) {
      return invalid(
        i,
        entry.formatVersion === undefined
          ? `entry ${i} has no formatVersion; this verifier requires ${JSON.stringify(FORMAT_VERSION)}`
          : `entry ${i} has formatVersion ${describe(entry.formatVersion)}; this verifier requires ${JSON.stringify(FORMAT_VERSION)}`,
      );
    }

    if (entry.prevHash !== expectedPrev) {
      return invalid(
        i,
        `entry ${i} prevHash does not match the preceding entry's hash (link severed, entries reordered, or an entry was removed or inserted)`,
      );
    }

    // A cycle, a BigInt or a runaway depth would make canonicalJSON throw (or
    // overflow the stack), so these are reported here. Every other difference
    // between the live entry and its JSON form is reported after the hash and
    // index checks, so a tampered entry still gets the more specific reason.
    const jsonProblem = entry.jsonProblem;
    if (jsonProblem !== undefined && jsonProblem.kind !== "lossy") {
      return invalid(i, notJsonReason(i, jsonProblem));
    }

    let canonical: unknown;
    try {
      canonical = canonicalize(entry.record);
    } catch (error) {
      if (error instanceof NestingDepthError) {
        return invalid(i, `entry ${i} is nested deeper than ${MAX_NESTING_DEPTH} levels, which is not supported`);
      }
      // With the default canonicalizer a throw means the entry cannot be
      // serialized (a BigInt after an undefined field, a getter or proxy that
      // throws): malformed data, not a caller bug. A custom canonicalizer's
      // errors still propagate.
      if (checkJson) {
        return invalid(
          i,
          jsonProblem !== undefined
            ? notJsonReason(i, jsonProblem)
            : `entry ${i} could not be serialized to JSON (a getter, proxy or toJSON threw)`,
        );
      }
      throw error;
    }
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
      return invalid(
        i,
        `entry ${i} content does not match its entryHash (a hashed field was changed, added, or removed after appending)`,
      );
    }

    if (entry.index !== i) {
      return invalid(i, `entry ${i} has index ${describe(entry.index)}; expected ${i}`);
    }

    if (jsonProblem !== undefined) return invalid(i, notJsonReason(i, jsonProblem));

    // `entry.entryHash` is the value that just matched the recomputed hash.
    if (anchor !== undefined && i === anchor.index) verifiedAnchorHash = entry.entryHash;
    expectedPrev = entry.entryHash;
    checked = i + 1;
  }

  if (minLength !== undefined && length < minLength) {
    return invalid(
      null,
      `chain has ${length} entries but expectedMinLength is ${minLength} (entries may have been deleted from the end)`,
    );
  }

  if (anchor !== undefined) {
    if (verifiedAnchorHash === undefined) {
      return invalid(
        null,
        `chain has ${length} entries, so there is no entry at anchor index ${anchor.index} (entries were deleted from the end)`,
      );
    }
    if (verifiedAnchorHash !== anchor.entryHash) {
      return invalid(
        anchor.index,
        `entry ${anchor.index} entryHash does not match the anchor (entries up to ${anchor.index} were rewritten or replaced)`,
      );
    }
  }

  return { valid: true, brokenAtIndex: null, reason: null, entriesChecked: checked };
}

/** One entry as it was at the call: own fields copied once, scalars pulled out. */
export interface EntrySnapshot {
  /** Set when the element is not a usable entry; the other fields are then empty and the walk stops here. */
  readonly unusable: "malformed" | "unreadable" | undefined;
  readonly entryHash: string;
  readonly prevHash: string;
  readonly formatVersion: unknown;
  readonly index: unknown;
  /** The entry minus `entryHash`: a shallow copy, so `payload` is still the caller's object. */
  readonly record: Record<string, unknown>;
  /** With the default canonicalizer: the first way the live entry differs from its JSON form, if any. */
  readonly jsonProblem: JsonProblem | undefined;
}

export function unusableEntry(reason: "malformed" | "unreadable"): EntrySnapshot {
  return { unusable: reason, entryHash: "", prevHash: "", formatVersion: undefined, index: undefined, record: {}, jsonProblem: undefined };
}

/**
 * Reads `chain[0..length)` once each. Stops after the first element that is
 * not a usable entry (recorded as unusable), because the walk reports that
 * index and never looks further; this also bounds the work for a huge sparse
 * array. A hole reads as `undefined`, so it is rejected like any non-object.
 * An element that cannot be read at all (a revoked proxy, a getter that
 * throws) is unusable too, never an exception.
 */
function snapshotEntries(chain: readonly unknown[], length: number, checkJson: boolean): EntrySnapshot[] {
  const snapshots: EntrySnapshot[] = [];
  for (let i = 0; i < length; i++) {
    let snapshot: EntrySnapshot;
    try {
      snapshot = snapshotEntry(chain[i], checkJson);
    } catch {
      snapshot = unusableEntry("unreadable");
    }
    snapshots.push(snapshot);
    if (snapshot.unusable !== undefined) break;
  }
  return snapshots;
}

export function snapshotEntry(entry: unknown, checkJson: boolean): EntrySnapshot {
  if (!isObject(entry)) return unusableEntry("malformed");
  // With the default canonicalizer the fields are read as property descriptors, so no getter or
  // proxy get trap runs here; an accessor shows up as a problem and its value as undefined.
  const jsonProblem = checkJson ? findJsonProblem(entry, { rootMayBeInstance: true }) : undefined;
  const { entryHash, ...record } = checkJson ? ownDataFields(entry) : entry;
  const prevHash = record["prevHash"];
  if (typeof entryHash !== "string" || typeof prevHash !== "string") return unusableEntry("malformed");
  return {
    unusable: undefined,
    entryHash,
    prevHash,
    formatVersion: record["formatVersion"],
    index: record["index"],
    record,
    jsonProblem,
  };
}

/** A copy of an object's own enumerable string-keyed data properties, read as descriptors (no getter runs). */
export function ownDataFields(object: object): Record<string, unknown> {
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key === "symbol") continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) continue;
    copy[key] = descriptor.value;
  }
  return copy;
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

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** An object literal, `Object.create(null)`, or the same from another realm; not a Map, Date, array or class instance. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

export function isIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Empty, or only whitespace, Default_Ignorable_Code_Point characters (zero-width, bidi controls, fillers) and U+2800. */
export function isBlank(value: string): boolean {
  return /^[\s\p{Default_Ignorable_Code_Point}\u2800]*$/u.test(value);
}

export function assertFunction(fn: string, name: string, value: unknown): asserts value is (...args: never[]) => unknown {
  if (typeof value !== "function") throw new TypeError(`${fn}: ${name} must be a function, got ${describe(value)}`);
}

const LONGEST_STRING = 80;
// Controls, format and line-break characters, invisible characters, and every
// space-like character except the ASCII space: no-break and other Unicode
// spaces (\p{Zs}) and U+2800 BRAILLE PATTERN BLANK, which draw as nothing.
const UNSAFE_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]|(?! )\p{Zs}/gu;

/**
 * Text for an error message or reason. Never throws and never runs caller
 * code: it looks at `typeof` only, so a BigInt, a cyclic object, a `toJSON` or
 * `toString` that throws, a null-prototype object or a revoked proxy are all
 * fine. Strings are quoted, cut at 80 characters, and every control,
 * line-break, bidirectional or other invisible format character is written as
 * `\uXXXX` (or `\u{X}`), so the text cannot forge a new line or send a
 * terminal escape.
 */
export function describe(value: unknown): string {
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
  const quoted = JSON.stringify(value.slice(0, LONGEST_STRING)).replace(UNSAFE_CHARACTER, (char) => {
    const code = char.codePointAt(0)!;
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
  return value.length > LONGEST_STRING ? `${quoted}... (${value.length} characters)` : quoted;
}

export function notJsonReason(index: number, found: JsonProblem): string {
  return found.kind === "depth"
    ? `entry ${index} is nested deeper than ${MAX_NESTING_DEPTH} levels, which is not supported (at ${describePath(found.path)})`
    : `entry ${index} is not plain JSON data at ${describePath(found.path)}: ${found.why}, so the entry in memory is not what was hashed`;
}

/** For `appendEntry`: where and what, with the path starting inside the record. */
export function describeProblem(found: JsonProblem): string {
  return found.kind === "depth"
    ? `nested deeper than ${MAX_NESTING_DEPTH} levels (the record itself counts as one) at ${describePath(found.path)}`
    : `${found.why} at ${describePath(found.path)}`;
}

const PLAIN_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const LONGEST_PATH = 200;

/**
 * `payload.meta[2]["odd key"]`. Keys that are not short simple ASCII names are
 * quoted, escaped and cut like any other caller text, and the whole path stops
 * growing past 200 characters, so a hostile key or a deep path cannot make a
 * reason or error message huge.
 */
function describePath(path: readonly (string | number)[]): string {
  if (path.length === 0) return "the entry itself";
  let text = "";
  for (const [position, part] of path.entries()) {
    if (text.length > LONGEST_PATH) return `${text}...`;
    if (typeof part === "number") text += `[${part}]`;
    else if (part.length <= LONGEST_STRING && PLAIN_KEY.test(part)) text += position === 0 ? part : `.${part}`;
    else text += `[${describeString(part)}]`;
  }
  return text;
}
