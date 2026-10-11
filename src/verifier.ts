import { canonicalJSON, MAX_NESTING_DEPTH, NestingDepthError } from "./canonicalize.js";
import {
  assertFunction,
  describe,
  isIndex,
  isPlainObject,
  notJsonReason,
  snapshotEntry,
  unusableEntry,
} from "./chain.js";
import type { EntrySnapshot } from "./chain.js";
import { GENESIS_HEAD, readHead } from "./compute.js";
import type { ChainHead } from "./compute.js";
import { readGapPayload } from "./gap.js";
import { readStoredEntry } from "./stored.js";
import type { GapPayload, GapRead, MarkedGap } from "./gap.js";
import { sha256Hex } from "./hash.js";
import { FORMAT_VERSION } from "./types.js";
import type { Canonicalizer, ChainEntry, Hasher } from "./types.js";

/** Settings of {@link createChainVerifier} and {@link splitValidPrefix}. */
export interface ChainVerifierOptions {
  /**
   * Where the stream starts: the entry just before the first one you will push,
   * as `{ index, hash }`. Leave it out to start from the beginning of the chain
   * (the first entry must then have `index` 0 and `prevHash` `GENESIS_HASH`). A
   * malformed value, or a key present with the value `undefined`, throws a
   * TypeError. The head only helps if you got it from somewhere the chain's
   * writer cannot change, and it vouches for nothing before it.
   */
  readonly from?: ChainHead;
  /**
   * Accept marked gap records (see `gapPayload`) as declared holes in the chain.
   * Default `false`: a gap record is then a break. Every accepted gap is listed
   * in the result. Turn it on only if you trust whoever may write gap records
   * as much as you trust the rest of the log: a gap record can hide deleted rows.
   */
  readonly allowMarkedGaps?: boolean;
  /**
   * A checkpoint you kept outside the log's writer's control, as `{ index, hash }`
   * (any entry's index and `entryHash`). The result is invalid unless the stream
   * contains an accepted entry at that index with exactly that hash, which catches a
   * fully recomputed rewrite of everything up to it and a stream that ends before
   * it. Its index must be after `from.index`. Checked at `finish`; an earlier break
   * is reported first. A malformed anchor, or the key present with the value
   * `undefined`, throws a TypeError.
   */
  readonly anchor?: ChainHead;
  /**
   * Used by `pushRow`: refuse upper-case 64-digit hex hashes (default `true`; see
   * `readStoredEntry`). Set `false` only for a custom hash function that writes
   * upper-case digests.
   */
  readonly lowercaseHexHashes?: boolean;
  /** Hash function. Defaults to the Web Crypto `sha256Hex`. Must match the one used to append. */
  readonly hash?: Hasher;
  /** Must be the canonicalizer used to append. Defaults to `canonicalJSON`. */
  readonly canonicalize?: Canonicalizer;
}

/** Outcome of a streaming verification. */
export interface ChainVerifierResult {
  /**
   * `"valid"`: every pushed entry passed. `"broken"`: positive evidence of a
   * problem, described by `brokenAtIndex` and `reason`. `"error"`: the hash or
   * canonicalize function you supplied threw or returned the wrong type, so the
   * entry could not be judged (not evidence about the chain; see `error`).
   */
  readonly status: "valid" | "broken" | "error";
  /** `status === "valid"`. */
  readonly valid: boolean;
  /**
   * The position the first failing entry should have had (the previous accepted
   * entry's `index` plus one), or `null` when valid.
   */
  readonly brokenAtIndex: number | null;
  /** Human-readable explanation, or `null` when valid. */
  readonly reason: string | null;
  /** Entries accepted before the result was decided; a gap record counts as one entry. `0` for an empty stream. */
  readonly entriesChecked: number;
  /**
   * The last accepted entry as `{ index, hash }`, or the `from` head (the
   * genesis head if none) when nothing was accepted. After a valid run, compare
   * it with a head you stored elsewhere to detect truncation or a full
   * rewrite; save it as the `from` of the next run to continue.
   */
  readonly head: ChainHead;
  /** Every marked gap that was accepted, in chain order. Grows with the number of gaps. */
  readonly gaps: readonly MarkedGap[];
  /** Present only when `status` is `"error"`: what your hash or canonicalize function threw. */
  readonly error?: unknown;
}

/** A streaming verifier: push entries in chain order, then call `finish`. */
export interface ChainVerifier {
  /**
   * Checks one entry against the entries pushed before it. The entry's own
   * fields are read (once, by property descriptor, so no getter or `toJSON`
   * runs) when you call `push`, before the first await; later edits to those
   * fields change nothing. The snapshot is shallow: the `payload` is read by
   * reference when its turn comes, so do not edit a payload while it is queued.
   * Resolves
   * `true` while the chain is intact so far and `false` once it is broken or
   * could not be checked; after that no more entries are hashed. Calls are
   * queued in order, so you may issue a page of pushes and await them
   * together, but an unawaited push keeps its entry in memory until its turn.
   *
   * @throws TypeError (synchronously) if called after `finish`
   */
  push(entry: unknown): Promise<boolean>;
  /**
   * Like `push`, for a row read from a database: the row is first read with
   * `readStoredEntry` (a decimal-string `index` and extra columns are fine). A row it
   * refuses is a break at this position, with its reason, and the row is never
   * "fixed up" into something else.
   *
   * @throws TypeError (synchronously) if called after `finish`
   */
  pushRow(row: unknown): Promise<boolean>;
  /** Waits for queued pushes and returns the result. Calling it again returns the same result. */
  finish(): Promise<ChainVerifierResult>;
}

interface Snap {
  readonly entry: EntrySnapshot;
  readonly gap: GapRead;
  /** Set when `pushRow` could not read the row as an entry. */
  readonly rowProblem?: string;
}

interface Failure {
  readonly status: "broken" | "error";
  readonly brokenAtIndex: number | null;
  readonly reason: string;
  readonly error?: unknown;
}

const KIT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TIMESTAMP_LIKE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;
const HEX_DIGEST = /^[0-9a-fA-F]{64}$/;

/**
 * A mismatch from a database round trip looks exactly like an edit. When the
 * entry carries one of the known signs of reformatting, say so after the
 * reason; otherwise say nothing, so a real edit is never dressed up as storage.
 */
function storageHint(entry: EntrySnapshot): string {
  const signs: string[] = [];
  const record = entry.record;
  if (typeof record["index"] === "string") signs.push("index is a string (a bigint column read back as text); read rows with readStoredEntry");
  const createdAt = record["createdAt"];
  if (typeof createdAt !== "string") {
    if (createdAt !== undefined) signs.push("createdAt is not a string (a timestamp column read back as a date); store it as text");
  } else if (!KIT_TIMESTAMP.test(createdAt) && TIMESTAMP_LIKE.test(createdAt)) {
    signs.push("createdAt is not in the form YYYY-MM-DDTHH:mm:ss.sssZ (a timestamp column may have reformatted the text); it must be the exact text that was hashed");
  }
  for (const [name, value] of [["entryHash", entry.entryHash], ["prevHash", record["prevHash"]]] as const) {
    if (typeof value === "string" && HEX_DIGEST.test(value) && value !== value.toLowerCase()) {
      signs.push(`${name} is upper-case hex (case is part of the hashed text)`);
    }
  }
  return signs.length === 0
    ? ""
    : `. If this log was read back from a database, this can be storage reformatting rather than an edit: ${signs.join("; ")} (see docs/CANONICAL-FORM.md, section 5)`;
}

/**
 * Creates a verifier that checks a chain one entry at a time, so a caller can
 * page through a database cursor without holding the table in memory. Memory
 * use is constant in the number of entries (it keeps the last hash, a counter
 * and the list of accepted gaps).
 *
 * Per entry it checks what `verifyChain` checks: the entry is readable, its
 * `formatVersion` is current, its `prevHash` is the previous accepted entry's
 * hash (or the `from` hash, or `GENESIS_HASH`), its `entryHash` is the hash of
 * the rest of the entry, its `index` is exactly one more than the previous
 * (and with the default canonicalizer, that the entry in memory is its own
 * JSON form). A marked gap record may instead have an `index` further ahead, if
 * `allowMarkedGaps` is true and the record's range is exact: it must declare
 * `from` equal to the next position, `to` at least `from`, and sit at `to + 1`.
 * An index jump without such a record is a break.
 *
 * A valid result means the stream is internally consistent from its start. It
 * does not say the stream is the whole chain: compare `head` with a head you
 * keep elsewhere, or you cannot see a truncated tail or a fully recomputed rewrite.
 *
 * @throws TypeError if `options` is not a plain object or undefined, has an
 *   unknown key, has `from`, `anchor` or `allowMarkedGaps` present but undefined
 *   or malformed, an `anchor` at or before `from`, or `hash` or `canonicalize`
 *   is not a function
 */
export function createChainVerifier(options?: ChainVerifierOptions): ChainVerifier {
  let fromOption: unknown;
  let gapsOption: unknown;
  let hashOption: unknown;
  let canonicalizeOption: unknown;
  let anchorOption: unknown;
  let lowercaseOption: unknown;
  if (options !== undefined) {
    if (!isPlainObject(options)) {
      throw new TypeError(`createChainVerifier: options must be a plain object or undefined, got ${describe(options)}`);
    }
    for (const key of Object.keys(options)) {
      if (
        key !== "from" &&
        key !== "allowMarkedGaps" &&
        key !== "anchor" &&
        key !== "lowercaseHexHashes" &&
        key !== "hash" &&
        key !== "canonicalize"
      ) {
        throw new TypeError(
          `createChainVerifier: unknown option ${describe(key)}; the options are from, allowMarkedGaps, anchor, lowercaseHexHashes, hash and canonicalize`,
        );
      }
    }
    fromOption = options.from;
    gapsOption = options.allowMarkedGaps;
    hashOption = options.hash;
    canonicalizeOption = options.canonicalize;
    anchorOption = options.anchor;
    lowercaseOption = options.lowercaseHexHashes;
    if (anchorOption === undefined && "anchor" in options) {
      throw new TypeError("createChainVerifier: anchor is present but undefined; leave the key out to skip the check");
    }
    if (fromOption === undefined && "from" in options) {
      throw new TypeError("createChainVerifier: from is present but undefined; leave the key out to start from the beginning");
    }
    if (gapsOption === undefined && "allowMarkedGaps" in options) {
      throw new TypeError("createChainVerifier: allowMarkedGaps is present but undefined; leave the key out or pass true or false");
    }
  }
  if (gapsOption !== undefined && typeof gapsOption !== "boolean") {
    throw new TypeError(`createChainVerifier: allowMarkedGaps must be a boolean, got ${describe(gapsOption)}`);
  }
  if (hashOption !== undefined) assertFunction("createChainVerifier", "options.hash", hashOption);
  if (canonicalizeOption !== undefined) assertFunction("createChainVerifier", "options.canonicalize", canonicalizeOption);
  let start: ChainHead = GENESIS_HEAD;
  if (fromOption !== undefined) {
    const parsed = readHead(fromOption);
    if (parsed === undefined) {
      throw new TypeError(
        "createChainVerifier: from must be { index: -1 or a non-negative integer, hash: non-empty string }, and index -1 goes with GENESIS_HASH only",
      );
    }
    start = parsed;
  }
  if (lowercaseOption !== undefined && typeof lowercaseOption !== "boolean") {
    throw new TypeError(`createChainVerifier: lowercaseHexHashes must be a boolean, got ${describe(lowercaseOption)}`);
  }
  let anchor: ChainHead | undefined;
  if (anchorOption !== undefined) {
    anchor = readHead(anchorOption);
    if (anchor === undefined || anchor.index < 0) {
      throw new TypeError("createChainVerifier: anchor must be { index: non-negative integer, hash: non-empty string }");
    }
    if (anchor.index <= start.index) {
      throw new TypeError(
        `createChainVerifier: anchor.index (${anchor.index}) must come after the starting head's index (${start.index}); an entry before the stream cannot be checked`,
      );
    }
  }
  const rowOptions = { lowercaseHexHashes: lowercaseOption !== false };
  let anchorSeen: string | undefined;
  const allowGaps = gapsOption === true;
  const hash = (hashOption ?? sha256Hex) as Hasher;
  const canonicalize = (canonicalizeOption ?? canonicalJSON) as Canonicalizer;
  const checkJson = canonicalize === canonicalJSON;

  let prevHash = start.hash;
  let prevIndex = start.index;
  let checked = 0;
  const gaps: MarkedGap[] = [];
  let failure: Failure | undefined;
  let finished = false;
  let tail: Promise<unknown> = Promise.resolve();
  let finishing: Promise<ChainVerifierResult> | undefined;

  const snapshot = (entry: unknown): Snap => {
    try {
      const taken = snapshotEntry(entry, checkJson);
      const gap: GapRead = taken.unusable === undefined ? readGapPayload(taken.record["payload"]) : { kind: "none" };
      return { entry: taken, gap };
    } catch {
      return { entry: unusableEntry("unreadable"), gap: { kind: "none" } };
    }
  };

  const broken = (position: number, reason: string): false => {
    failure = { status: "broken", brokenAtIndex: position, reason };
    return false;
  };

  const check = async (snap: Snap, pos: number): Promise<boolean> => {
    const entry = snap.entry;
    if (!Number.isSafeInteger(pos)) {
      // Past 2^53 - 1 integers repeat (2^53 + 1 is 2^53), so the position of the next entry is not well defined.
      return broken(pos, `entry position ${describe(pos)} is past the largest safe integer (2^53 - 1), so the chain cannot continue`);
    }
    if (snap.rowProblem !== undefined) return broken(pos, `entry ${pos} could not be read from its stored row: ${snap.rowProblem}`);
    if (entry.unusable !== undefined) {
      return broken(
        pos,
        entry.unusable === "unreadable"
          ? `entry ${pos} could not be read (a proxy or getter threw)`
          : `entry ${pos} is not an object with string prevHash and entryHash`,
      );
    }
    if (entry.formatVersion !== FORMAT_VERSION) {
      return broken(
        pos,
        entry.formatVersion === undefined
          ? `entry ${pos} has no formatVersion; this verifier requires ${JSON.stringify(FORMAT_VERSION)}`
          : `entry ${pos} has formatVersion ${describe(entry.formatVersion)}; this verifier requires ${JSON.stringify(FORMAT_VERSION)}`,
      );
    }
    if (entry.prevHash !== prevHash) {
      return broken(
        pos,
        `entry ${pos} prevHash does not match the preceding entry's hash (link severed, entries reordered, or an entry was removed or inserted)` +
          (HEX_DIGEST.test(entry.prevHash) && entry.prevHash !== entry.prevHash.toLowerCase()
            ? ". Its prevHash is upper-case hex; if this log was read back from a database, return the lower-case text that was stored (case is part of the hashed text)"
            : ""),
      );
    }
    const jsonProblem = entry.jsonProblem;
    if (jsonProblem !== undefined && jsonProblem.kind !== "lossy") return broken(pos, notJsonReason(pos, jsonProblem));

    let canonical: unknown;
    try {
      canonical = canonicalize(entry.record);
    } catch (error) {
      // Only the built-in canonicalizer's depth error is evidence about the entry; a custom one may fail on its own values.
      if (checkJson && error instanceof NestingDepthError) {
        return broken(pos, `entry ${pos} is nested deeper than ${MAX_NESTING_DEPTH} levels, which is not supported`);
      }
      if (checkJson) {
        return broken(
          pos,
          jsonProblem !== undefined
            ? notJsonReason(pos, jsonProblem)
            : `entry ${pos} could not be serialized to JSON (a getter, proxy or toJSON threw)`,
        );
      }
      throw error;
    }
    if (typeof canonical !== "string") throw new TypeError("canonicalize must return a string (synchronously)");
    const recomputed: unknown = await hash(canonical);
    if (typeof recomputed !== "string") throw new TypeError("hash must resolve to a string");
    if (recomputed !== entry.entryHash) {
      return broken(
        pos,
        `entry ${pos} content does not match its entryHash (a hashed field was changed, added, or removed after appending)` +
          storageHint(entry),
      );
    }

    const gap = snap.gap;
    if (gap.kind === "none") {
      if (entry.index !== pos) return broken(pos, `entry ${pos} has index ${describe(entry.index)}; expected ${pos}`);
      if (jsonProblem !== undefined) return broken(pos, notJsonReason(pos, jsonProblem));
      prevHash = entry.entryHash;
      prevIndex = pos;
      checked++;
      if (anchor !== undefined && pos === anchor.index) anchorSeen = entry.entryHash;
      return true;
    }

    if (!allowGaps) {
      const declared = gap.kind === "gap" ? ` that declares entries ${gap.from} to ${gap.to} missing` : "";
      return broken(
        pos,
        `entry ${pos} is a gap record at index ${describe(entry.index)}${declared}, but marked gaps are not accepted here (allowMarkedGaps is not true)`,
      );
    }
    if (gap.kind === "malformed") return broken(pos, `entry ${pos} is a malformed gap record: ${gap.why}`);
    if (gap.from !== pos || entry.index !== gap.to + 1) {
      return broken(
        pos,
        `entry ${pos} is a gap record whose range does not fit the chain: it declares entries ${gap.from} to ${gap.to} missing ` +
          `and has index ${describe(entry.index)}, but it must start at ${pos} and sit at index (to + 1)`,
      );
    }
    if (jsonProblem !== undefined) return broken(pos, notJsonReason(pos, jsonProblem));
    gaps.push({ atIndex: gap.to + 1, from: gap.from, to: gap.to, reason: gap.reason });
    prevHash = entry.entryHash;
    prevIndex = gap.to + 1;
    checked++;
    if (anchor !== undefined && prevIndex === anchor.index) anchorSeen = entry.entryHash;
    return true;
  };

  /** Never rejects: a throw from your hash or canonicalize function becomes status "error". */
  const step = async (snap: Snap): Promise<boolean> => {
    if (failure !== undefined) return false;
    const pos = prevIndex + 1;
    try {
      return await check(snap, pos);
    } catch (error) {
      failure = {
        status: "error",
        brokenAtIndex: pos,
        reason: `entry ${pos} could not be checked: the hash or canonicalize function you supplied threw or returned the wrong type`,
        error,
      };
      return false;
    }
  };

  const build = (): ChainVerifierResult => {
    if (failure === undefined && anchor !== undefined) {
      if (anchorSeen === undefined) {
        failure = {
          status: "broken",
          brokenAtIndex: null,
          reason: `the stream has no entry at anchor index ${anchor.index} (it ended before it, or that position falls in a gap)`,
        };
      } else if (anchorSeen !== anchor.hash) {
        failure = {
          status: "broken",
          brokenAtIndex: anchor.index,
          reason: `entry ${anchor.index} entryHash does not match the anchor (entries up to ${anchor.index} were rewritten or replaced)`,
        };
      }
    }
    const head: ChainHead = Object.freeze({ index: prevIndex, hash: prevHash });
    const list = Object.freeze([...gaps]);
    if (failure === undefined) {
      return { status: "valid", valid: true, brokenAtIndex: null, reason: null, entriesChecked: checked, head, gaps: list };
    }
    const base = {
      status: failure.status,
      valid: false,
      brokenAtIndex: failure.brokenAtIndex,
      reason: failure.reason,
      entriesChecked: checked,
      head,
      gaps: list,
    } as const;
    return failure.status === "error" ? { ...base, error: failure.error } : base;
  };

  const enqueue = (snap: Snap): Promise<boolean> => {
    const run = tail.then(() => step(snap));
    tail = run;
    return run;
  };

  return {
    push(entry: unknown): Promise<boolean> {
      if (finished) throw new TypeError("createChainVerifier: push called after finish");
      return enqueue(snapshot(entry));
    },
    pushRow(row: unknown): Promise<boolean> {
      if (finished) throw new TypeError("createChainVerifier: pushRow called after finish");
      const read = readStoredEntry(row, rowOptions);
      if (!read.ok) {
        return enqueue({ entry: unusableEntry("malformed"), gap: { kind: "none" }, rowProblem: read.reason });
      }
      return enqueue(snapshot(read.entry));
    },
    finish(): Promise<ChainVerifierResult> {
      finished = true;
      finishing ??= tail.then(build);
      return finishing;
    },
  };
}

/**
 * Stands in, inside `SplitResult.rest`, for an element that threw when it was
 * read (a getter or Proxy trap): `{ unreadable: true, arrayIndex }`, where
 * `arrayIndex` is the element's position in the input array.
 */
export interface UnreadableEntry {
  readonly unreadable: true;
  readonly arrayIndex: number;
}

const unreadableEntry = (arrayIndex: number): UnreadableEntry => Object.freeze({ unreadable: true as const, arrayIndex });

/** What {@link splitValidPrefix} returns. */
export interface SplitResult<TPayload = unknown> {
  /** The longest verified prefix, as read from the input, in order. */
  readonly valid: ChainEntry<TPayload | GapPayload>[];
  /**
   * Everything from the first break on, as read from the input, in order (empty
   * when nothing broke). Not verified. An element that could not be read is an
   * {@link UnreadableEntry}; holes in a sparse array are left out. Non-enumerable
   * index elements are included. Entries are typed as possibly gap records
   * because an accepted gap record is among them.
   */
  readonly rest: unknown[];
  /**
   * `false` when the elements after the break could not all be listed, so `rest`
   * may be shorter than the input: the array's keys could not be enumerated (a
   * Proxy trap threw) and it was too long to read index by index (more than
   * {@link MOST_INDEXES_READ} elements; the first that many are in `rest`).
   * Otherwise `true`.
   */
  readonly restComplete: boolean;
  /** The first break, or `null` when every entry verified. `index` is `null` when the input was not a readable array. */
  readonly firstBreak: { readonly index: number | null; readonly reason: string } | null;
}

/** When an array's keys cannot be listed, `rest` is filled by reading indexes one by one, up to this many. */
export const MOST_INDEXES_READ = 1_000_000;

/**
 * Appends the elements after position `after` to `rest`, in index order, one
 * read each (an unreadable one becomes an {@link UnreadableEntry}). Returns
 * false if some may be missing. With working `ownKeys` the walk follows the
 * array's own index keys (enumerable or not), so holes cost nothing; if listing
 * the keys throws, it reads indexes `after + 1` up to the length instead.
 */
function collectRest(entries: readonly unknown[], after: number, length: number, rest: unknown[]): boolean {
  const read = (position: number): void => {
    try {
      rest.push(entries[position]);
    } catch {
      rest.push(unreadableEntry(position));
    }
  };
  let keys: (string | symbol)[] | undefined;
  try {
    keys = Reflect.ownKeys(entries);
  } catch {
    keys = undefined;
  }
  if (keys === undefined) {
    // ownKeys threw: read index by index, skipping holes. If even the hole
    // check throws, read the element anyway and report recovery as incomplete.
    const stop = Math.min(length, after + 1 + MOST_INDEXES_READ);
    let complete = stop === length;
    for (let position = after + 1; position < stop; position++) {
      let present: boolean;
      try {
        present = Reflect.has(entries, position);
      } catch {
        complete = false;
        present = true;
      }
      if (present) read(position);
    }
    return complete;
  }
  const positions: number[] = [];
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const position = Number(key);
    if (Number.isSafeInteger(position) && position > after && position < 2 ** 32 - 1 && String(position) === key) positions.push(position);
  }
  positions.sort((a, b) => a - b);
  for (const position of positions) read(position);
  return true;
}

let unreadable: object | undefined;
/** A stand-in for an element that threw when read: a revoked proxy, which the verifier reports as unreadable. */
function unreadableElement(): object {
  if (unreadable === undefined) {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    unreadable = proxy;
  }
  return unreadable;
}

/**
 * Splits a list of entries (a whole chain, or the page of it after `options.from`)
 * at the first break: the longest valid prefix, the rest, and why it stopped.
 * For repair tooling: keep `valid`, decide what to do with `rest`, and mark
 * the loss with a gap record rather than editing history. Each element is read
 * once. The input is not modified, and a non-array input fails closed (nothing
 * valid, no `rest`, `firstBreak.index` null).
 *
 * @throws TypeError for bad `options`, as `createChainVerifier`
 * @throws exactly what your `hash` or `canonicalize` function threw, if one threw
 *   (the value itself, whatever its type)
 */
export async function splitValidPrefix<TPayload = unknown>(
  entries: readonly unknown[],
  options?: ChainVerifierOptions,
): Promise<SplitResult<TPayload>> {
  const verifier = createChainVerifier(options);
  // restComplete is false whenever rows might exist that could not be inspected.
  const unreadableInput = (reason: string, restComplete: boolean): SplitResult<TPayload> => ({
    valid: [],
    rest: [],
    restComplete,
    firstBreak: { index: null, reason },
  });
  let length: unknown;
  try {
    if (!Array.isArray(entries)) return unreadableInput("entries is not an array", true);
    length = entries.length;
  } catch {
    return unreadableInput("entries could not be read (a proxy or getter threw)", false);
  }
  if (!isIndex(length)) return unreadableInput("entries.length is not a non-negative integer", false);

  const valid: unknown[] = [];
  for (let i = 0; i < length; i++) {
    let item: unknown;
    try {
      item = entries[i];
    } catch {
      item = unreadableElement();
    }
    if (await verifier.push(item)) {
      valid.push(item);
      continue;
    }
    const result = await verifier.finish();
    if (result.status === "error") {
      // Exactly what the callback threw (an object, a string, a cross-realm Error), as documented.
      throw result.error;
    }
    const rest: unknown[] = [item === unreadableElement() ? unreadableEntry(i) : item];
    const complete = collectRest(entries, i, length, rest);
    return {
      valid: valid as ChainEntry<TPayload | GapPayload>[],
      rest,
      restComplete: complete,
      firstBreak: { index: result.brokenAtIndex, reason: result.reason ?? "" },
    };
  }
  await verifier.finish();
  return { valid: valid as ChainEntry<TPayload | GapPayload>[], rest: [], restComplete: true, firstBreak: null };
}
