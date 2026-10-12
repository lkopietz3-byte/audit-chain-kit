import { assertFunction, describe, isBlank, isIndex, isObject, isPlainObject } from "./chain.js";
import { computeEntry, GENESIS_HEAD, readHead } from "./compute.js";
import type { ChainHead } from "./compute.js";
import { gapPayload } from "./gap.js";
import type { GapPayload } from "./gap.js";
import type { Canonicalizer, ChainEntry, Hasher } from "./types.js";

/** What {@link AppendStore.readHead} answers. */
export type StoreHeadResult =
  | {
      readonly status: "ok";
      /** The newest entry, or `GENESIS_HEAD` when the log is empty. */
      readonly head: ChainHead;
      /**
       * The store's clock, read together with the head (for a database, `now()`
       * in the same query, or after taking the lock). The helper hashes this
       * exact string as the new entry's `createdAt`.
       */
      readonly now: string;
    }
  | { readonly status: "unavailable"; readonly reason?: string };

/** What {@link AppendStore.appendIfHead} answers. */
export type StoreAppendResult =
  | { readonly status: "appended" }
  /** Another writer moved the head first. Nothing was written. */
  | { readonly status: "conflict" }
  /** The store could not say whether the entry was written (timeout, outage). Nothing is assumed. */
  | { readonly status: "unavailable"; readonly reason?: string };

/**
 * What a log store must do to take part. Two operations, no more. The store,
 * not this package, owns durability, the clock and the "only if the head is
 * still this" check (see the Postgres recipe in the README).
 */
export interface AppendStore<TPayload = unknown> {
  /** Returns the current head and the store's clock reading. */
  readHead(): Promise<StoreHeadResult>;
  /**
   * Writes `entry` only if the log's head is still `expectedHead`, atomically
   * (one conditional statement, or a lock). If the head moved, return
   * `conflict` and write nothing. Return `unavailable` when you cannot tell
   * whether the write happened; the caller then does not retry on its own.
   */
  appendIfHead: (input: { readonly expectedHead: ChainHead; readonly entry: ChainEntry<TPayload> }) => Promise<StoreAppendResult>;
}

/** What {@link appendToStore} and {@link appendGapToStore} return. Only `"appended"` means the entry is in the log. */
export type AppendOutcome<TPayload = unknown> =
  | { readonly status: "appended"; readonly entry: Readonly<ChainEntry<TPayload>>; readonly attempts: number }
  /** Every attempt found the head had moved. Nothing was written. */
  | { readonly status: "conflict"; readonly attempts: number }
  /** The store failed, threw or answered nonsense. Nothing is assumed to be written; do not report success. */
  | { readonly status: "unavailable"; readonly attempts: number; readonly reason: string; readonly cause?: unknown };

/** Settings of {@link appendToStore} and {@link appendGapToStore}. */
export interface AppendToStoreOptions {
  /** Most tries (each re-reads the head). An integer from 1 to 100. Default 5. */
  readonly maxAttempts?: number;
  readonly canonicalize?: Canonicalizer;
  readonly hash?: Hasher;
}

const DEFAULT_ATTEMPTS = 5;
const MOST_ATTEMPTS = 100;

interface Planned {
  readonly index: number;
  readonly payload: unknown;
}

/**
 * Appends `payload` to the log in `store`: reads the head and the store's
 * clock, computes the entry, and writes it only if the head is still the one
 * it read. On `conflict` it re-reads and tries again, at most `maxAttempts`
 * times in all. It fails closed: if the store is unavailable, throws, or
 * returns anything it does not recognize, the result is `"unavailable"` and
 * the entry is not reported as written. It never reads `Date`.
 *
 * `payload` is read by reference on every attempt; do not change it during the
 * call.
 *
 * @throws TypeError for a malformed `store` or `options`, or a payload that is
 *   not plain JSON data (see `computeEntry`)
 * @throws whatever a custom `canonicalize` or `hash` throws
 */
export function appendToStore<TPayload = unknown>(
  store: AppendStore<TPayload>,
  payload: TPayload,
  options?: AppendToStoreOptions,
): Promise<AppendOutcome<TPayload>> {
  return run(store, (head): Planned => ({ index: head.index + 1, payload }), options, "appendToStore");
}

/**
 * Appends a marked gap record that declares the next `count` positions empty:
 * positions `head.index + 1` through `head.index + count`, with the record
 * itself at `head.index + count + 1`. Use it after a restore or an outage
 * lost rows you cannot recover, so verification can say so instead of failing
 * forever. Same retry and fail-closed behavior as {@link appendToStore}.
 *
 * The store must admit gap payloads (`AppendStore<YourPayload | GapPayload>`),
 * and the outcome's entry is typed as the gap record it is.
 *
 * @throws TypeError for a malformed `store`, `options`, `reason` or `count`
 *   (`count` is an integer of at least 1)
 */
export async function appendGapToStore<TPayload = GapPayload>(
  store: AppendStore<TPayload | GapPayload>,
  gap: { readonly reason: string; readonly count: number },
  options?: AppendToStoreOptions,
): Promise<AppendOutcome<GapPayload>> {
  if (!isObject(gap)) throw new TypeError("appendGapToStore: expected { reason, count }");
  const reason: unknown = gap["reason"];
  const count: unknown = gap["count"];
  if (!isIndex(count) || count < 1) {
    throw new TypeError(`appendGapToStore: count must be an integer of at least 1, got ${describe(count)}`);
  }
  // Checks the reason now, before any store call.
  gapPayload({ reason: reason as string, from: 0, to: 0 });
  return run<GapPayload>(
    store,
    (head): Planned => ({
      index: head.index + count + 1,
      payload: gapPayload({ reason: reason as string, from: head.index + 1, to: head.index + count }),
    }),
    options,
    "appendGapToStore",
  );
}

async function run<TPayload>(
  store: AppendStore<TPayload>,
  plan: (head: ChainHead) => Planned,
  options: AppendToStoreOptions | undefined,
  fn: string,
): Promise<AppendOutcome<TPayload>> {
  if (!isObject(store)) throw new TypeError(`${fn}: store must be an object with readHead and appendIfHead`);
  const readHeadFn: unknown = Reflect.get(store, "readHead");
  const appendFn: unknown = Reflect.get(store, "appendIfHead");
  assertFunction(fn, "store.readHead", readHeadFn);
  assertFunction(fn, "store.appendIfHead", appendFn);

  let maxAttempts = DEFAULT_ATTEMPTS;
  const entryOptions: { canonicalize?: Canonicalizer; hash?: Hasher } = {};
  if (options !== undefined) {
    if (!isPlainObject(options)) throw new TypeError(`${fn}: options must be a plain object or undefined, got ${describe(options)}`);
    for (const key of Object.keys(options)) {
      if (key !== "maxAttempts" && key !== "canonicalize" && key !== "hash") {
        throw new TypeError(`${fn}: unknown option ${describe(key)}; the options are maxAttempts, canonicalize and hash`);
      }
    }
    const attempts: unknown = options.maxAttempts;
    const canonicalize: unknown = options.canonicalize;
    const hash: unknown = options.hash;
    if (attempts !== undefined) {
      if (!Number.isInteger(attempts) || (attempts as number) < 1 || (attempts as number) > MOST_ATTEMPTS) {
        throw new TypeError(`${fn}: maxAttempts must be an integer from 1 to ${MOST_ATTEMPTS}, got ${describe(attempts)}`);
      }
      maxAttempts = attempts as number;
    }
    if (canonicalize !== undefined) {
      assertFunction(fn, "options.canonicalize", canonicalize);
      entryOptions.canonicalize = canonicalize as Canonicalizer;
    }
    if (hash !== undefined) {
      assertFunction(fn, "options.hash", hash);
      entryOptions.hash = hash as Hasher;
    }
  }

  const unavailable = (attempts: number, reason: string, cause?: unknown): AppendOutcome<TPayload> =>
    cause === undefined ? { status: "unavailable", attempts, reason } : { status: "unavailable", attempts, reason, cause };
  const said = (reason: unknown): string => (typeof reason === "string" ? `: ${describe(reason)}` : "");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 1. Head and clock. The answer is decoded inside the protected step, one read per field.
    let head: ChainHead | undefined;
    let now: unknown;
    let notOk: AppendOutcome<TPayload> | undefined;
    try {
      const read: unknown = await (readHeadFn as () => Promise<unknown>).call(store);
      const readStatus: unknown = isObject(read) ? read["status"] : undefined;
      if (readStatus === "unavailable") {
        notOk = unavailable(attempt, `the store is unavailable${said(isObject(read) ? read["reason"] : undefined)}`);
      } else if (readStatus === "ok" && isObject(read)) {
        const rawHead: unknown = read["head"];
        now = read["now"];
        head = readHead(rawHead);
      }
    } catch (error) {
      return unavailable(attempt, "the store threw or returned an unreadable answer while reading the head", error);
    }
    if (notOk !== undefined) return notOk;
    if (head === undefined || typeof now !== "string" || isBlank(now)) {
      return unavailable(attempt, "the store returned a malformed head (need { status: 'ok', head: { index, hash }, now: non-blank string })");
    }

    // 2. Compute. A bad payload or a throwing canonicalize/hash is the caller's bug and propagates.
    const planned = plan(head);
    const entry = (await computeEntry(
      { prevHash: head.hash, index: planned.index, payload: planned.payload, createdAt: now },
      entryOptions,
    )) as Readonly<ChainEntry<TPayload>>;

    // 3. Conditional write. If the answer cannot be read, the write may have committed: report unavailable, never appended.
    let status: unknown;
    let reason: unknown;
    try {
      const written: unknown = await (appendFn as (input: unknown) => Promise<unknown>).call(store, { expectedHead: head, entry });
      status = isObject(written) ? written["status"] : undefined;
      if (status === "unavailable") reason = isObject(written) ? written["reason"] : undefined;
    } catch (error) {
      return unavailable(attempt, "the store threw or returned an unreadable answer while appending (the write may or may not have happened)", error);
    }
    if (status === "appended") return { status: "appended", entry, attempts: attempt };
    if (status === "conflict") continue;
    if (status === "unavailable") return unavailable(attempt, `the store is unavailable${said(reason)}`);
    return unavailable(attempt, "the store returned an answer that is not appended, conflict or unavailable");
  }
  return { status: "conflict", attempts: maxAttempts };
}

/** An in-memory {@link AppendStore} for tests. */
export interface MemoryAppendStore<TPayload = unknown> extends AppendStore<TPayload> {
  /** A copy of the entries written so far. */
  entries(): readonly ChainEntry<TPayload>[];
}

/**
 * A reference {@link AppendStore} that keeps entries in an array. For tests
 * and examples only: it is not durable, it does not verify what you give it,
 * and its check-and-write is atomic only because it runs in one JavaScript
 * turn. Use a database for anything real.
 *
 * @param options.now - the clock, called on every `readHead`; required, so a test chooses its times
 * @param options.entries - entries to start with (not verified)
 */
export function createMemoryAppendStore<TPayload = unknown>(options: {
  readonly now: () => string;
  readonly entries?: readonly ChainEntry<TPayload>[];
}): MemoryAppendStore<TPayload> {
  if (!isObject(options)) throw new TypeError("createMemoryAppendStore: expected { now, entries? }");
  const now: unknown = options.now;
  assertFunction("createMemoryAppendStore", "now", now);
  const stored: ChainEntry<TPayload>[] = [...(options.entries ?? [])];
  const headOf = (): ChainHead => {
    const last = stored[stored.length - 1];
    return last === undefined ? GENESIS_HEAD : { index: last.index, hash: last.entryHash };
  };
  return {
    readHead(): Promise<StoreHeadResult> {
      return Promise.resolve({ status: "ok", head: headOf(), now: (now as () => string)() });
    },
    appendIfHead(input): Promise<StoreAppendResult> {
      // All checks and the write happen in this one synchronous body, so two callers cannot interleave.
      const expected = readHead(input.expectedHead);
      const current = headOf();
      if (expected === undefined) return Promise.reject(new TypeError("appendIfHead: expectedHead must be { index, hash }"));
      if (expected.index !== current.index || expected.hash !== current.hash) return Promise.resolve({ status: "conflict" });
      const entry = input.entry;
      if (!isObject(entry) || entry.prevHash !== current.hash || !isIndex(entry.index) || entry.index <= current.index) {
        return Promise.reject(
          new TypeError("appendIfHead: entry must attach to the head (prevHash equal to the head hash, index above the head index)"),
        );
      }
      stored.push(entry);
      return Promise.resolve({ status: "appended" });
    },
    entries(): readonly ChainEntry<TPayload>[] {
      return [...stored];
    },
  };
}
