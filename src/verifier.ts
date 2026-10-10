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
import type { GapRead, MarkedGap } from "./gap.js";
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
  /** Waits for queued pushes and returns the result. Calling it again returns the same result. */
  finish(): Promise<ChainVerifierResult>;
}

interface Snap {
  readonly entry: EntrySnapshot;
  readonly gap: GapRead;
}

interface Failure {
  readonly status: "broken" | "error";
  readonly brokenAtIndex: number;
  readonly reason: string;
  readonly error?: unknown;
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
 *   unknown key, has `from` or `allowMarkedGaps` present but undefined or
 *   malformed, or `hash` or `canonicalize` is not a function
 */
export function createChainVerifier(options?: ChainVerifierOptions): ChainVerifier {
  let fromOption: unknown;
  let gapsOption: unknown;
  let hashOption: unknown;
  let canonicalizeOption: unknown;
  if (options !== undefined) {
    if (!isPlainObject(options)) {
      throw new TypeError(`createChainVerifier: options must be a plain object or undefined, got ${describe(options)}`);
    }
    for (const key of Object.keys(options)) {
      if (key !== "from" && key !== "allowMarkedGaps" && key !== "hash" && key !== "canonicalize") {
        throw new TypeError(
          `createChainVerifier: unknown option ${describe(key)}; the options are from, allowMarkedGaps, hash and canonicalize`,
        );
      }
    }
    fromOption = options.from;
    gapsOption = options.allowMarkedGaps;
    hashOption = options.hash;
    canonicalizeOption = options.canonicalize;
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
        `entry ${pos} prevHash does not match the preceding entry's hash (link severed, entries reordered, or an entry was removed or inserted)`,
      );
    }
    const jsonProblem = entry.jsonProblem;
    if (jsonProblem !== undefined && jsonProblem.kind !== "lossy") return broken(pos, notJsonReason(pos, jsonProblem));

    let canonical: unknown;
    try {
      canonical = canonicalize(entry.record);
    } catch (error) {
      if (error instanceof NestingDepthError) {
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
        `entry ${pos} content does not match its entryHash (a hashed field was changed, added, or removed after appending)`,
      );
    }

    const gap = snap.gap;
    if (gap.kind === "none") {
      if (entry.index !== pos) return broken(pos, `entry ${pos} has index ${describe(entry.index)}; expected ${pos}`);
      if (jsonProblem !== undefined) return broken(pos, notJsonReason(pos, jsonProblem));
      prevHash = entry.entryHash;
      prevIndex = pos;
      checked++;
      return true;
    }

    if (!allowGaps) {
      return broken(
        pos,
        `entry ${pos} is a gap record (it declares entries missing), but marked gaps are not accepted here (allowMarkedGaps is not true)`,
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

  return {
    push(entry: unknown): Promise<boolean> {
      if (finished) throw new TypeError("createChainVerifier: push called after finish");
      const snap = snapshot(entry);
      const run = tail.then(() => step(snap));
      tail = run;
      return run;
    },
    finish(): Promise<ChainVerifierResult> {
      finished = true;
      finishing ??= tail.then(build);
      return finishing;
    },
  };
}

/** What {@link splitValidPrefix} returns. */
export interface SplitResult<TPayload = unknown> {
  /** The longest verified prefix, as read from the input, in order. */
  readonly valid: ChainEntry<TPayload>[];
  /** Everything from the first break on, as read from the input (empty when nothing broke). Not verified. */
  readonly rest: unknown[];
  /** The first break, or `null` when every entry verified. `index` is `null` when the input was not a readable array. */
  readonly firstBreak: { readonly index: number | null; readonly reason: string } | null;
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
 * @throws whatever your `hash` or `canonicalize` function threw, if one threw
 */
export async function splitValidPrefix<TPayload = unknown>(
  entries: readonly unknown[],
  options?: ChainVerifierOptions,
): Promise<SplitResult<TPayload>> {
  const verifier = createChainVerifier(options);
  const unreadableInput = (reason: string): SplitResult<TPayload> => ({ valid: [], rest: [], firstBreak: { index: null, reason } });
  let length: unknown;
  try {
    if (!Array.isArray(entries)) return unreadableInput("entries is not an array");
    length = entries.length;
  } catch {
    return unreadableInput("entries could not be read (a proxy or getter threw)");
  }
  if (!isIndex(length)) return unreadableInput("entries.length is not a non-negative integer");

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
      throw result.error instanceof Error ? result.error : new Error(result.reason ?? "verification failed");
    }
    const rest: unknown[] = [item];
    try {
      for (const later of Array.prototype.slice.call(entries, i + 1) as unknown[]) rest.push(later);
    } catch {
      // The remainder could not be read; rest holds only the entry that broke.
    }
    return { valid: valid as ChainEntry<TPayload>[], rest, firstBreak: { index: result.brokenAtIndex, reason: result.reason ?? "" } };
  }
  await verifier.finish();
  return { valid: valid as ChainEntry<TPayload>[], rest: [], firstBreak: null };
}
