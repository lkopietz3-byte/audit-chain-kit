import { createHash } from "node:crypto";
import * as v8 from "node:v8";
import * as vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  appendEntry,
  appendGapToStore,
  appendToStore,
  canonicalJSON,
  computeEntry,
  createChainVerifier,
  createMemoryAppendStore,
  FORMAT_VERSION,
  gapPayload,
  GENESIS_HASH,
  GENESIS_HEAD,
  MARKED_GAP_KIND,
  sha256Hex,
  splitValidPrefix,
  verifyChain,
} from "../src/index.js";
import type { AppendStore, ChainEntry, ChainVerifierOptions, ChainVerifierResult } from "../src/index.js";

/**
 * Verdict table for the store-backed API: computeEntry, the streaming
 * verifier, splitValidPrefix, the append helper and marked gaps. Written
 * before the implementation; every row states the correct verdict for one
 * input. Honest chains must pass, every bad input must be flagged.
 */

const at = (n: number): string => `2026-01-01T00:00:${String(n % 60).padStart(2, "0")}.000Z`;

interface Spec {
  readonly index: number;
  readonly prevHash: string;
  readonly payload: unknown;
  readonly createdAt?: string;
}

/** An entry with arbitrary fields, hashed honestly (what a forger who knows the format can produce). */
async function mk(spec: Spec): Promise<ChainEntry> {
  return computeEntry({ prevHash: spec.prevHash, index: spec.index, payload: spec.payload, createdAt: spec.createdAt ?? at(spec.index) });
}

async function honest(count: number): Promise<ChainEntry[]> {
  const out: ChainEntry[] = [];
  for (let i = 0; i < count; i++) {
    out.push(await mk({ index: i, prevHash: i === 0 ? GENESIS_HASH : out[i - 1]!.entryHash, payload: { n: i, text: `row ${i}` } }));
  }
  return out;
}

/** Entries 0..3, a gap record at index 7 (covers 4..6), then 8 and 9. */
async function chainWithGap(): Promise<ChainEntry[]> {
  const out = await honest(4);
  const gap = await mk({ index: 7, prevHash: out[3]!.entryHash, payload: gapPayload({ reason: "backup restore lost rows", from: 4, to: 6 }) });
  out.push(gap);
  out.push(await mk({ index: 8, prevHash: gap.entryHash, payload: { n: 8 } }));
  out.push(await mk({ index: 9, prevHash: out[5]!.entryHash, payload: { n: 9 } }));
  return out;
}

/** Streams `entries` to a verifier in pages of `pageSize` (each page's pushes are issued together, like a cursor batch). */
async function streamed(entries: readonly unknown[], pageSize: number, options?: ChainVerifierOptions): Promise<ChainVerifierResult> {
  const verifier = createChainVerifier(options);
  for (let start = 0; start < entries.length; start += pageSize) {
    await Promise.all(entries.slice(start, start + pageSize).map((entry) => verifier.push(entry)));
  }
  return verifier.finish();
}

const PAGE_SIZES = [1, 7, 1000] as const;

/** Every page size must give the same verdict. */
async function acrossPages(entries: readonly unknown[], options?: ChainVerifierOptions): Promise<ChainVerifierResult> {
  const results = await Promise.all(PAGE_SIZES.map((size) => streamed(entries, size, options)));
  for (const result of results.slice(1)) expect(result).toEqual(results[0]);
  return results[0]!;
}

const rt = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Re-links `rows` (already built honestly) after `after`, keeping each row's index and payload. */
async function rechain(rows: readonly ChainEntry[], after: ChainEntry): Promise<ChainEntry[]> {
  const out: ChainEntry[] = [];
  let prev = after;
  for (const row of rows) {
    prev = await mk({ index: row.index, prevHash: prev.entryHash, payload: row.payload });
    out.push(prev);
  }
  return out;
}

describe("verdict table: honest chains verify, streamed in pages of 1, 7 and 1000", () => {
  it("an honest chain of 25 entries is valid in every page size", async () => {
    const chain = await honest(25);
    const result = await acrossPages(chain);
    expect(result).toMatchObject({ status: "valid", valid: true, brokenAtIndex: null, reason: null, entriesChecked: 25, gaps: [] });
    expect(result.head).toEqual({ index: 24, hash: chain[24]!.entryHash });
  });

  it("an honest chain of 2,500 entries is valid in every page size", async () => {
    const chain = await honest(2500);
    const result = await acrossPages(chain);
    expect(result).toMatchObject({ valid: true, entriesChecked: 2500 });
  });

  it("an empty stream is valid with nothing checked and the genesis head", async () => {
    const result = await acrossPages([]);
    expect(result).toMatchObject({ valid: true, entriesChecked: 0, gaps: [] });
    expect(result.head).toEqual(GENESIS_HEAD);
    expect(GENESIS_HEAD).toEqual({ index: -1, hash: GENESIS_HASH });
  });

  it("entries read back from JSON text (a database round trip) are valid", async () => {
    const result = await acrossPages(rt(await honest(30)));
    expect(result.valid).toBe(true);
  });

  it("entries that are class instances (ORM rows) are valid", async () => {
    class Row {
      constructor(entry: ChainEntry) {
        Object.assign(this, entry);
      }
    }
    const rows = (await honest(10)).map((entry) => new Row(entry));
    expect((await acrossPages(rows)).valid).toBe(true);
  });

  it("computeEntry output is identical to appendEntry output for the same createdAt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(at(5)));
      const appended = await appendEntry([], { a: 1, b: [true, null] });
      const computed = await computeEntry({ prevHash: GENESIS_HASH, index: 0, payload: { b: [true, null], a: 1 }, createdAt: at(5) });
      expect(computed).toEqual(appended[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a chain built with computeEntry passes the existing verifyChain, and the reverse", async () => {
    expect(await verifyChain(await honest(12))).toMatchObject({ valid: true, entriesChecked: 12 });
    let chain: readonly ChainEntry[] = [];
    for (let i = 0; i < 6; i++) chain = await appendEntry(chain, { i });
    expect((await acrossPages(chain)).valid).toBe(true);
  });

  it("resuming from a saved head verifies the rest of the chain", async () => {
    const chain = await honest(40);
    const from = { index: 19, hash: chain[19]!.entryHash };
    for (const size of PAGE_SIZES) {
      const result = await streamed(chain.slice(20), size, { from });
      expect(result).toMatchObject({ valid: true, entriesChecked: 20 });
      expect(result.head).toEqual({ index: 39, hash: chain[39]!.entryHash });
    }
  });

  it("an explicit genesis head is the same as no from", async () => {
    const chain = await honest(5);
    expect((await streamed(chain, 3, { from: GENESIS_HEAD })).valid).toBe(true);
  });
});

describe("verdict table: tampering is caught, wherever the page boundaries fall", () => {
  it("a rewritten payload is caught at its index", async () => {
    const chain = rt(await honest(25));
    (chain[11]!.payload as Record<string, unknown>)["text"] = "edited";
    const result = await acrossPages(chain);
    expect(result).toMatchObject({ status: "broken", valid: false, brokenAtIndex: 11, entriesChecked: 11 });
    expect(result.reason).toMatch(/entry 11 content does not match its entryHash/);
    expect(result.head.index).toBe(10);
  });

  it("a rewritten createdAt is caught", async () => {
    const chain = rt(await honest(10));
    chain[4]!.createdAt = "2027-01-01T00:00:00.000Z";
    expect((await acrossPages(chain)).brokenAtIndex).toBe(4);
  });

  it("a rewritten payload with a recomputed entryHash is caught at the next entry's link", async () => {
    const chain = await honest(12);
    const forged = await mk({ index: 6, prevHash: chain[5]!.entryHash, payload: { n: "forged" } });
    const tampered = [...chain.slice(0, 6), forged, ...chain.slice(7)];
    const result = await acrossPages(tampered);
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 7 });
    expect(result.reason).toMatch(/entry 7 prevHash does not match/);
  });

  it("a reordered pair is caught", async () => {
    const chain = await honest(25);
    const swapped = [...chain];
    [swapped[5], swapped[6]] = [swapped[6]!, swapped[5]!];
    expect(await acrossPages(swapped)).toMatchObject({ valid: false, brokenAtIndex: 5 });
  });

  it("a dropped row is caught", async () => {
    const chain = await honest(25);
    const dropped = chain.filter((_, i) => i !== 9);
    const result = await acrossPages(dropped);
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 9 });
    expect(result.reason).toMatch(/removed or inserted/);
  });

  it("a dropped first row is caught", async () => {
    const chain = await honest(5);
    expect(await acrossPages(chain.slice(1))).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("a duplicated row is caught", async () => {
    const chain = await honest(25);
    const duplicated = [...chain.slice(0, 9), chain[8]!, ...chain.slice(9)];
    expect(await acrossPages(duplicated)).toMatchObject({ valid: false, brokenAtIndex: 9 });
  });

  it("a row whose index jumps but whose hash was recomputed is caught (unmarked gap)", async () => {
    const chain = await honest(6);
    const jump = await mk({ index: 9, prevHash: chain[5]!.entryHash, payload: { n: "jump" } });
    const result = await acrossPages([...chain, jump]);
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 6 });
    expect(result.reason).toMatch(/index 9; expected 6/);
  });

  it("an entry that restates an earlier index (rewind) is caught", async () => {
    const chain = await honest(6);
    const rewind = await mk({ index: 2, prevHash: chain[5]!.entryHash, payload: { n: "again" } });
    expect(await acrossPages([...chain, rewind])).toMatchObject({ valid: false, brokenAtIndex: 6 });
  });

  it("a wrong formatVersion is reported, not thrown", async () => {
    const chain = rt(await honest(3));
    (chain[1] as { formatVersion: string }).formatVersion = "other/v9";
    const result = await acrossPages(chain);
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 1 });
    expect(result.reason).toMatch(/formatVersion/);
    expect(FORMAT_VERSION).toBe("audit-chain-kit/v1");
  });

  it("non-object elements are reported at their position", async () => {
    const chain = await honest(4);
    for (const bad of [null, undefined, 7, "x", [], () => 1]) {
      expect(await acrossPages([chain[0]!, bad, chain[2]!])).toMatchObject({ valid: false, brokenAtIndex: 1 });
    }
  });
});

describe("verdict table: wrong from anchor", () => {
  it("a from hash that is not the real head is caught at the first entry", async () => {
    const chain = await honest(30);
    const wrong = { index: 19, hash: chain[18]!.entryHash };
    for (const size of PAGE_SIZES) {
      expect(await streamed(chain.slice(20), size, { from: wrong })).toMatchObject({ valid: false, brokenAtIndex: 20 });
    }
  });

  it("a from index that is off by one with the right hash is caught", async () => {
    const chain = await honest(30);
    const shifted = { index: 18, hash: chain[19]!.entryHash };
    expect(await streamed(chain.slice(20), 7, { from: shifted })).toMatchObject({ valid: false, brokenAtIndex: 19 });
  });

  it("starting mid-chain with no from is caught", async () => {
    const chain = await honest(30);
    expect(await streamed(chain.slice(20), 7)).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("a malformed from throws a TypeError", () => {
    const bad: unknown[] = [
      null,
      7,
      {},
      { index: 1 },
      { hash: "x" },
      { index: -2, hash: "x" },
      { index: 1.5, hash: "x" },
      { index: 1, hash: "" },
      { index: 1, hash: "   " },
      { index: -1, hash: "abc" },
      { index: 1, hash: 5 },
      undefined,
    ];
    for (const from of bad) {
      expect(() => createChainVerifier({ from } as unknown as ChainVerifierOptions)).toThrow(TypeError);
    }
  });

  it("an unknown option, a present-but-undefined allowMarkedGaps, and a non-object options throw", () => {
    expect(() => createChainVerifier({ allowGaps: true } as unknown as ChainVerifierOptions)).toThrow(TypeError);
    expect(() => createChainVerifier({ allowMarkedGaps: undefined } as unknown as ChainVerifierOptions)).toThrow(TypeError);
    expect(() => createChainVerifier({ allowMarkedGaps: "yes" } as unknown as ChainVerifierOptions)).toThrow(TypeError);
    expect(() => createChainVerifier(5 as unknown as ChainVerifierOptions)).toThrow(TypeError);
    expect(() => createChainVerifier([] as unknown as ChainVerifierOptions)).toThrow(TypeError);
  });
});

describe("verdict table: marked gaps", () => {
  it("a genuine gap record is accepted when allowMarkedGaps is true, and listed", async () => {
    const chain = await chainWithGap();
    const result = await acrossPages(chain, { allowMarkedGaps: true });
    expect(result).toMatchObject({ valid: true, entriesChecked: 7 });
    expect(result.gaps).toEqual([{ atIndex: 7, from: 4, to: 6, reason: "backup restore lost rows" }]);
    expect(result.head.index).toBe(9);
  });

  it("the same chain is broken at the gap record when allowMarkedGaps is false or left out", async () => {
    const chain = await chainWithGap();
    for (const options of [undefined, {}, { allowMarkedGaps: false }]) {
      const result = await acrossPages(chain, options);
      expect(result).toMatchObject({ valid: false, brokenAtIndex: 4, entriesChecked: 4, gaps: [] });
      expect(result.reason).toMatch(/gap record/);
    }
  });

  it("a forged gap record that hides a deleted row is caught when allowMarkedGaps is false", async () => {
    const chain = await honest(8);
    const forgedGap = await mk({ index: 6, prevHash: chain[4]!.entryHash, payload: gapPayload({ reason: "cleanup", from: 5, to: 5 }) });
    const tampered = [...chain.slice(0, 5), forgedGap, ...(await rechain(chain.slice(7), forgedGap))];
    expect(await acrossPages(tampered, { allowMarkedGaps: false })).toMatchObject({ valid: false, brokenAtIndex: 5 });
    // With gaps allowed, the owner chose to trust marked gaps: it passes, and the gap is listed.
    const trusting = await acrossPages(tampered, { allowMarkedGaps: true });
    expect(trusting.valid).toBe(true);
    expect(trusting.gaps).toHaveLength(1);
  });

  const lies: readonly (readonly [string, { from: number; to: number; index: number }])[] = [
    ["range starts too early (overlaps kept rows)", { from: 3, to: 6, index: 7 }],
    ["range starts too late (an unmarked hole remains)", { from: 5, to: 6, index: 7 }],
    ["range ends before the gap record (an unmarked hole remains)", { from: 4, to: 5, index: 7 }],
    ["range ends after the gap record's own position", { from: 4, to: 8, index: 7 }],
    ["range is backwards", { from: 6, to: 4, index: 7 }],
    ["range covers nothing (index is the next slot)", { from: 4, to: 3, index: 4 }],
    ["range far in the future", { from: 400, to: 600, index: 7 }],
  ];
  for (const [name, lie] of lies) {
    it(`a gap record whose range lies is caught: ${name}`, async () => {
      const base = await honest(4);
      const record = { kind: MARKED_GAP_KIND, reason: "x", from: lie.from, to: lie.to };
      const bad = await mk({ index: lie.index, prevHash: base[3]!.entryHash, payload: record });
      const result = await acrossPages([...base, bad], { allowMarkedGaps: true });
      expect(result).toMatchObject({ valid: false, brokenAtIndex: 4, entriesChecked: 4, gaps: [] });
      expect(result.reason).toMatch(/gap record/);
    });
  }

  const malformed: readonly (readonly [string, unknown])[] = [
    ["empty reason", { kind: MARKED_GAP_KIND, reason: "", from: 4, to: 6 }],
    ["blank reason", { kind: MARKED_GAP_KIND, reason: "   ", from: 4, to: 6 }],
    ["reason is a number", { kind: MARKED_GAP_KIND, reason: 5, from: 4, to: 6 }],
    ["reason is too long", { kind: MARKED_GAP_KIND, reason: "r".repeat(501), from: 4, to: 6 }],
    ["from is a string", { kind: MARKED_GAP_KIND, reason: "x", from: "4", to: 6 }],
    ["to is fractional", { kind: MARKED_GAP_KIND, reason: "x", from: 4, to: 6.5 }],
    ["to is unsafe", { kind: MARKED_GAP_KIND, reason: "x", from: 4, to: Number.MAX_SAFE_INTEGER }],
    ["an extra key rides along", { kind: MARKED_GAP_KIND, reason: "x", from: 4, to: 6, note: "hidden" }],
    ["a key is missing", { kind: MARKED_GAP_KIND, reason: "x", from: 4 }],
  ];
  for (const [name, payload] of malformed) {
    it(`a malformed gap record is a break, not an ordinary row: ${name}`, async () => {
      const base = await honest(4);
      const bad = await mk({ index: 7, prevHash: base[3]!.entryHash, payload });
      expect(await acrossPages([...base, bad], { allowMarkedGaps: true })).toMatchObject({ valid: false, brokenAtIndex: 4 });
      // Even at the next slot it must not pass as an ordinary row: the kind is reserved.
      const sameSlot = await mk({ index: 4, prevHash: base[3]!.entryHash, payload });
      expect(await acrossPages([...base, sameSlot], { allowMarkedGaps: true })).toMatchObject({ valid: false, brokenAtIndex: 4 });
    });
  }

  it("an ordinary row whose payload only looks a little like a gap passes", async () => {
    const base = await honest(3);
    const rows = [...base, await mk({ index: 3, prevHash: base[2]!.entryHash, payload: { kind: "note", from: 1, to: 2, reason: "x" } })];
    expect((await acrossPages(rows)).valid).toBe(true);
  });

  it("two gap records in a row are both accepted and listed in order", async () => {
    const base = await honest(2);
    const g1 = await mk({ index: 5, prevHash: base[1]!.entryHash, payload: gapPayload({ reason: "first", from: 2, to: 4 }) });
    const g2 = await mk({ index: 9, prevHash: g1.entryHash, payload: gapPayload({ reason: "second", from: 6, to: 8 }) });
    const result = await acrossPages([...base, g1, g2], { allowMarkedGaps: true });
    expect(result.valid).toBe(true);
    expect(result.gaps.map((g) => [g.atIndex, g.from, g.to])).toEqual([
      [5, 2, 4],
      [9, 6, 8],
    ]);
  });

  it("a chain may start with a gap record (rows 0..4 lost)", async () => {
    const g = await mk({ index: 5, prevHash: GENESIS_HASH, payload: gapPayload({ reason: "lost before first backup", from: 0, to: 4 }) });
    const next = await mk({ index: 6, prevHash: g.entryHash, payload: {} });
    expect((await acrossPages([g, next], { allowMarkedGaps: true })).valid).toBe(true);
  });

  it("a gap record directly after a from anchor must start at from.index + 1", async () => {
    const chain = await honest(10);
    const from = { index: 9, hash: chain[9]!.entryHash };
    const good = await mk({ index: 14, prevHash: from.hash, payload: gapPayload({ reason: "x", from: 10, to: 13 }) });
    const late = await mk({ index: 14, prevHash: from.hash, payload: gapPayload({ reason: "x", from: 11, to: 13 }) });
    expect((await streamed([good], 1, { from, allowMarkedGaps: true })).valid).toBe(true);
    expect((await streamed([late], 1, { from, allowMarkedGaps: true })).valid).toBe(false);
  });

  it("gapPayload refuses nonsense and returns a frozen record", () => {
    const g = gapPayload({ reason: "restored from backup", from: 3, to: 5 });
    expect(g).toEqual({ kind: MARKED_GAP_KIND, reason: "restored from backup", from: 3, to: 5 });
    expect(Object.isFrozen(g)).toBe(true);
    for (const bad of [
      { reason: "", from: 1, to: 1 },
      { reason: "x", from: -1, to: 1 },
      { reason: "x", from: 2, to: 1 },
      { reason: "x", from: 1.5, to: 2 },
      { reason: 1, from: 1, to: 2 },
      { reason: "x", from: 1, to: Number.MAX_SAFE_INTEGER },
    ]) {
      expect(() => gapPayload(bad as never)).toThrow();
    }
  });
});

describe("verdict table: limits the verifier cannot see (documented, not failures)", () => {
  it("a tail truncation verifies, and only the head comparison shows it", async () => {
    const chain = await honest(20);
    const result = await acrossPages(chain.slice(0, 12));
    expect(result.valid).toBe(true);
    expect(result.head).not.toEqual({ index: 19, hash: chain[19]!.entryHash });
  });

  it("a fully recomputed rewrite verifies, and only the head comparison shows it", async () => {
    const chain = await honest(10);
    let prev = GENESIS_HASH;
    const rewritten: ChainEntry[] = [];
    for (let i = 0; i < 10; i++) {
      const e = await mk({ index: i, prevHash: prev, payload: { n: i === 3 ? "changed" : i } });
      rewritten.push(e);
      prev = e.entryHash;
    }
    const result = await acrossPages(rewritten);
    expect(result.valid).toBe(true);
    expect(result.head.hash).not.toBe(chain[9]!.entryHash);
  });
});

describe("verdict table: append on a stale head and unavailable stores", () => {
  const clock = (): (() => string) => {
    let n = 0;
    return () => at(n++);
  };

  it("appendIfHead on a stale head returns conflict and appends nothing", async () => {
    const store = createMemoryAppendStore({ now: clock() });
    const first = await store.readHead();
    expect(first).toMatchObject({ status: "ok", head: GENESIS_HEAD });
    const a = await computeEntry({ prevHash: GENESIS_HASH, index: 0, payload: { a: 1 }, createdAt: at(0) });
    expect(await store.appendIfHead({ expectedHead: GENESIS_HEAD, entry: a })).toEqual({ status: "appended" });
    const b = await computeEntry({ prevHash: GENESIS_HASH, index: 0, payload: { b: 1 }, createdAt: at(1) });
    expect(await store.appendIfHead({ expectedHead: GENESIS_HEAD, entry: b })).toEqual({ status: "conflict" });
    expect(store.entries()).toEqual([a]);
  });

  it("two writers racing on the same head: exactly one wins first, the other retries onto the new head", async () => {
    const store = createMemoryAppendStore({ now: clock() });
    const results = await Promise.all([appendToStore(store, { who: "a" }), appendToStore(store, { who: "b" })]);
    expect(results.map((r) => r.status)).toEqual(["appended", "appended"]);
    const entries = store.entries();
    expect(entries).toHaveLength(2);
    expect((await streamed(entries, 1)).valid).toBe(true);
    expect(Math.max(...results.map((r) => (r.status === "appended" ? r.attempts : 0)))).toBe(2);
  });

  it("appendToStore retries a bounded number of times and then returns conflict", async () => {
    const inner = createMemoryAppendStore({ now: clock() });
    const staleOnly: AppendStore = {
      readHead: () => inner.readHead(),
      appendIfHead: () => Promise.resolve({ status: "conflict" }),
    };
    const outcome = await appendToStore(staleOnly, { x: 1 }, { maxAttempts: 4 });
    expect(outcome).toMatchObject({ status: "conflict", attempts: 4 });
    expect(inner.entries()).toEqual([]);
  });

  it("a head read that is stale once heals on retry", async () => {
    const inner = createMemoryAppendStore({ now: clock() });
    await appendToStore(inner, { n: 0 });
    const staleHead = await inner.readHead();
    await appendToStore(inner, { n: 1 });
    let reads = 0;
    const lagging: AppendStore = {
      readHead: () => (reads++ === 0 ? Promise.resolve(staleHead) : inner.readHead()),
      appendIfHead: (input) => inner.appendIfHead(input),
    };
    const outcome = await appendToStore(lagging, { n: 2 });
    expect(outcome).toMatchObject({ status: "appended", attempts: 2 });
    expect(inner.entries()).toHaveLength(3);
    expect((await streamed(inner.entries(), 7)).valid).toBe(true);
  });

  it("an unavailable head read fails closed: no append is attempted", async () => {
    let appends = 0;
    const down: AppendStore = {
      readHead: () => Promise.resolve({ status: "unavailable", reason: "connection refused" }),
      appendIfHead: () => {
        appends++;
        return Promise.resolve({ status: "appended" });
      },
    };
    const outcome = await appendToStore(down, { x: 1 });
    expect(outcome).toMatchObject({ status: "unavailable", attempts: 1 });
    expect(appends).toBe(0);
  });

  it("an unavailable append is not retried and is never reported as appended", async () => {
    const inner = createMemoryAppendStore({ now: clock() });
    let appends = 0;
    const flaky: AppendStore = {
      readHead: () => inner.readHead(),
      appendIfHead: () => {
        appends++;
        return Promise.resolve({ status: "unavailable", reason: "timeout" });
      },
    };
    expect(await appendToStore(flaky, { x: 1 })).toMatchObject({ status: "unavailable" });
    expect(appends).toBe(1);
  });

  it("a store that throws, rejects or returns junk is unavailable, not a crash and not a success", async () => {
    const inner = createMemoryAppendStore({ now: clock() });
    const append = (input: Parameters<AppendStore["appendIfHead"]>[0]) => inner.appendIfHead(input);
    const bad: AppendStore[] = [
      { readHead: () => Promise.reject(new Error("boom")), appendIfHead: append },
      {
        readHead: () => {
          throw new Error("sync boom");
        },
        appendIfHead: append,
      },
      { readHead: () => Promise.resolve(null as never), appendIfHead: append },
      { readHead: () => Promise.resolve({ status: "ok", head: { index: 3.5, hash: "x" }, now: at(0) }), appendIfHead: append },
      { readHead: () => Promise.resolve({ status: "ok", head: { index: -1, hash: "not-genesis" }, now: at(0) }), appendIfHead: append },
      { readHead: () => Promise.resolve({ status: "ok", head: GENESIS_HEAD, now: "" }), appendIfHead: append },
      { readHead: () => Promise.resolve({ status: "ok", head: GENESIS_HEAD, now: 5 as never }), appendIfHead: append },
      { readHead: () => inner.readHead(), appendIfHead: () => Promise.reject(new Error("boom")) },
      { readHead: () => inner.readHead(), appendIfHead: () => Promise.resolve({ status: "maybe" } as never) },
      { readHead: () => inner.readHead(), appendIfHead: () => Promise.resolve(undefined as never) },
    ];
    for (const store of bad) {
      const outcome = await appendToStore(store, { x: 1 });
      expect(outcome.status).toBe("unavailable");
    }
    expect(inner.entries()).toEqual([]);
  });

  it("the store's clock is what gets hashed, and the helper never reads Date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("1999-09-09T09:09:09.000Z"));
      const store = createMemoryAppendStore({ now: () => "2031-05-05T05:05:05.500Z" });
      const outcome = await appendToStore(store, { x: 1 });
      expect(outcome.status).toBe("appended");
      expect(store.entries()[0]!.createdAt).toBe("2031-05-05T05:05:05.500Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("appendToStore refuses a bad payload before changing anything, and bad option values", async () => {
    const store = createMemoryAppendStore({ now: clock() });
    await expect(appendToStore(store, { when: new Date() })).rejects.toThrow(TypeError);
    await expect(appendToStore(store, { f: undefined })).rejects.toThrow(TypeError);
    for (const maxAttempts of [0, -1, 1.5, 101, Number.NaN, "3"]) {
      await expect(appendToStore(store, { x: 1 }, { maxAttempts } as never)).rejects.toThrow(TypeError);
    }
    expect(store.entries()).toEqual([]);
  });

  it("appendGapToStore writes a gap record that the verifier accepts only when allowed", async () => {
    const store = createMemoryAppendStore({ now: clock() });
    await appendToStore(store, { n: 0 });
    await appendToStore(store, { n: 1 });
    const outcome = await appendGapToStore(store, { reason: "rows lost in a restore", count: 3 });
    expect(outcome.status).toBe("appended");
    await appendToStore(store, { n: 2 });
    const entries = store.entries();
    expect(entries.map((e) => e.index)).toEqual([0, 1, 5, 6]);
    expect(entries[2]!.payload).toEqual({ kind: MARKED_GAP_KIND, reason: "rows lost in a restore", from: 2, to: 4 });
    expect((await streamed(entries, 2)).valid).toBe(false);
    expect(await streamed(entries, 2, { allowMarkedGaps: true })).toMatchObject({ valid: true, gaps: [{ atIndex: 5, from: 2, to: 4 }] });
    await expect(appendGapToStore(store, { reason: "x", count: 0 })).rejects.toThrow();
  });

  it("the in-memory store refuses an entry that does not extend its head", async () => {
    const store = createMemoryAppendStore({ now: clock() });
    const stray = await computeEntry({ prevHash: "f".repeat(64), index: 0, payload: {}, createdAt: at(0) });
    await expect(store.appendIfHead({ expectedHead: GENESIS_HEAD, entry: stray })).rejects.toThrow(TypeError);
  });
});

describe("verdict table: computeEntry", () => {
  const base = { prevHash: GENESIS_HASH, index: 0, payload: { a: 1 }, createdAt: at(0) };

  it("matches the documented golden vector", async () => {
    const entry = await computeEntry({
      prevHash: GENESIS_HASH,
      index: 0,
      payload: { action: "report.created", by: "user_1" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(entry.entryHash).toBe("e2e95ac52a1f387f89f091b90d6a6caf1e2f68acffabe3b4243ed887acab76ca");
    expect(Object.isFrozen(entry)).toBe(true);
    expect(entry.formatVersion).toBe(FORMAT_VERSION);
  });

  it("createdAt is required: there is no clock default", async () => {
    const { createdAt: unused, ...rest } = base;
    void unused;
    await expect(computeEntry(rest as never)).rejects.toThrow(/createdAt/);
    await expect(computeEntry({ ...base, createdAt: undefined } as never)).rejects.toThrow(TypeError);
  });

  it("createdAt must be a non-blank string, not a Date or a number", async () => {
    for (const createdAt of [new Date(0), 0, null, "", "   ", {}]) {
      await expect(computeEntry({ ...base, createdAt } as never)).rejects.toThrow(TypeError);
    }
  });

  it("never reads the clock", async () => {
    const RealDate = Date;
    class NoClock extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) throw new Error("clock read");
        super(...(args as [number]));
      }
      static override now(): number {
        throw new Error("clock read");
      }
    }
    globalThis.Date = NoClock as unknown as DateConstructor;
    try {
      const entry = await computeEntry(base);
      expect(entry.createdAt).toBe(at(0));
    } finally {
      globalThis.Date = RealDate;
    }
  });

  it("bad prevHash and index throw", async () => {
    for (const patch of [
      { prevHash: 5 },
      { prevHash: "" },
      { prevHash: undefined },
      { index: -1 },
      { index: 1.5 },
      { index: "0" },
      { index: Number.NaN },
      { index: Number.MAX_SAFE_INTEGER + 2 },
    ]) {
      await expect(computeEntry({ ...base, ...patch } as never)).rejects.toThrow(TypeError);
    }
  });

  it("unknown keys, a non-object input and a missing payload key throw", async () => {
    await expect(computeEntry({ ...base, created_at: at(1) } as never)).rejects.toThrow(TypeError);
    await expect(computeEntry(null as never)).rejects.toThrow(TypeError);
    await expect(computeEntry(5 as never)).rejects.toThrow(TypeError);
    const { payload: unused, ...noPayload } = base;
    void unused;
    await expect(computeEntry(noPayload as never)).rejects.toThrow(TypeError);
  });

  it("a payload JSON would change is refused, as appendEntry refuses it", async () => {
    const cyc: Record<string, unknown> = {};
    cyc["self"] = cyc;
    const bad: unknown[] = [
      { d: new Date(0) },
      { u: undefined },
      { f: () => 1 },
      { n: Number.NaN },
      { m: new Map() },
      { big: 1n },
      cyc,
      {
        get g() {
          return 1;
        },
      },
      Object.create({ toJSON: () => 1 }) as unknown,
    ];
    for (const payload of bad) await expect(computeEntry({ ...base, payload })).rejects.toThrow(TypeError);
  });

  it("each input field is read exactly once, and a payload getter never runs", async () => {
    const reads: Record<string, number> = { prevHash: 0, index: 0, payload: 0, createdAt: 0 };
    const input = {};
    for (const [key, value] of Object.entries(base)) {
      Object.defineProperty(input, key, {
        enumerable: true,
        get() {
          reads[key] = (reads[key] ?? 0) + 1;
          return value;
        },
      });
    }
    await computeEntry(input as never);
    expect(reads).toEqual({ prevHash: 1, index: 1, payload: 1, createdAt: 1 });
    let ran = 0;
    const payload = {
      get g() {
        ran++;
        return 1;
      },
    };
    await expect(computeEntry({ ...base, payload })).rejects.toThrow(TypeError);
    expect(ran).toBe(0);
  });

  it("a Proxy payload whose traps throw is refused", async () => {
    const throwing = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("trap");
        },
      },
    );
    await expect(computeEntry({ ...base, payload: throwing })).rejects.toThrow(TypeError);
  });

  it("a custom canonicalizer and hasher are used, and their wrong return types throw", async () => {
    const seen: string[] = [];
    const entry = await computeEntry(base, {
      canonicalize: (v) => (seen.push("c"), JSON.stringify(v)),
      hash: async (s) => (seen.push("h"), sha256Hex(s)),
    });
    expect(seen).toEqual(["c", "h"]);
    expect(entry.entryHash).toMatch(/^[0-9a-f]{64}$/);
    await expect(computeEntry(base, { canonicalize: (() => 5) as never })).rejects.toThrow(TypeError);
    await expect(computeEntry(base, { hash: (() => Promise.resolve(5)) as never })).rejects.toThrow(TypeError);
  });

  it("large payloads work: a 5 MB string, a 300,000-element array, a 50,000-key object", async () => {
    const payloads = [
      { s: "x".repeat(5_000_000) },
      { a: Array.from({ length: 300_000 }, (_, i) => i) },
      Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`k${i}`, i])),
    ];
    for (const payload of payloads) {
      const entry = await computeEntry({ ...base, payload });
      expect((await streamed([entry], 1)).valid).toBe(true);
    }
  });

  it("nesting past the limit is refused", async () => {
    let deep: unknown = 1;
    for (let i = 0; i < 300; i++) deep = { d: deep };
    await expect(computeEntry({ ...base, payload: deep })).rejects.toThrow(TypeError);
  });
});

describe("verdict table: hostile entries pushed to the verifier", () => {
  it("a getter on an entry is reported and never run (default canonicalizer)", async () => {
    const chain = await honest(3);
    let reads = 0;
    const entry: Record<string, unknown> = { ...chain[1]! };
    Object.defineProperty(entry, "index", {
      enumerable: true,
      get() {
        reads++;
        return 1;
      },
    });
    const result = await streamed([chain[0], entry, chain[2]], 1);
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 1 });
    expect(reads).toBe(0);
  });

  it("a getter on an entry is read at most once with a custom canonicalizer", async () => {
    const chain = await honest(3);
    let reads = 0;
    const entry: Record<string, unknown> = { ...chain[1]! };
    Object.defineProperty(entry, "index", {
      enumerable: true,
      get() {
        reads++;
        return 1;
      },
    });
    const v = createChainVerifier({ canonicalize: (value) => canonicalJSON(value) });
    await v.push(chain[0]);
    await v.push(entry);
    await v.push(chain[2]);
    expect(reads).toBeLessThanOrEqual(1);
  });

  it("an entryHash getter that changes its answer is read once at most", async () => {
    const chain = await honest(2);
    let toggle = 0;
    const entry: Record<string, unknown> = { ...chain[1]! };
    Object.defineProperty(entry, "entryHash", {
      enumerable: true,
      get() {
        return toggle++ === 0 ? chain[1]!.entryHash : "0".repeat(64);
      },
    });
    const v = createChainVerifier({ canonicalize: (value) => canonicalJSON(value) });
    await v.push(chain[0]);
    await v.push(entry);
    const result = await v.finish();
    expect(toggle).toBeLessThanOrEqual(1);
    expect(result.status).not.toBe("error");
  });

  it("a Proxy whose traps throw is a reported break, not an exception", async () => {
    const chain = await honest(3);
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("ownKeys");
        },
        getOwnPropertyDescriptor() {
          throw new Error("gopd");
        },
        get() {
          throw new Error("get");
        },
        getPrototypeOf() {
          throw new Error("proto");
        },
      },
    );
    const result = await streamed([chain[0], hostile, chain[2]], 1);
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 1 });
    expect(result.reason).toMatch(/could not be read/);
  });

  it("a revoked Proxy is a reported break", async () => {
    const chain = await honest(2);
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(await streamed([chain[0], proxy], 1)).toMatchObject({ valid: false, brokenAtIndex: 1 });
  });

  it("a Proxy whose get trap counts reads sees none", async () => {
    const chain = await honest(2);
    let gets = 0;
    const proxy = new Proxy(
      { ...chain[1]! },
      {
        get(t, k) {
          gets++;
          return Reflect.get(t, k) as unknown;
        },
      },
    );
    await streamed([chain[0], proxy], 1);
    expect(gets).toBe(0);
  });

  it("an inherited toJSON on an entry or its payload is a break even when the hash matches", async () => {
    const chain = await honest(2);
    const inheritedOnEntry = Object.assign(Object.create({ toJSON: () => ({}) }) as object, chain[1]);
    expect(await streamed([chain[0], inheritedOnEntry], 1)).toMatchObject({ valid: false, brokenAtIndex: 1 });
    const payload = Object.assign(Object.create({ toJSON: () => ({}) }) as object, { n: 1 });
    const hashed = await sha256Hex(
      canonicalJSON({ formatVersion: FORMAT_VERSION, index: 1, payload: { n: 1 }, prevHash: chain[0]!.entryHash, createdAt: at(1) }),
    );
    const live = { formatVersion: FORMAT_VERSION, index: 1, payload, prevHash: chain[0]!.entryHash, createdAt: at(1), entryHash: hashed };
    expect(await streamed([chain[0], live], 1)).toMatchObject({ valid: false, brokenAtIndex: 1 });
  });

  it("a live payload that is not its own JSON form (Date, undefined, NaN, Map, function) is a break", async () => {
    const chain = await honest(1);
    const lives: unknown[] = [{ d: new Date(0) }, { u: undefined }, { n: Number.NaN }, { m: new Map() }, { f: () => 1 }];
    for (const payload of lives) {
      const record = { formatVersion: FORMAT_VERSION, index: 1, payload, prevHash: chain[0]!.entryHash, createdAt: at(1) };
      const forged = { ...record, entryHash: await sha256Hex(canonicalJSON(record)) };
      expect(await streamed([chain[0], forged], 1)).toMatchObject({ valid: false, brokenAtIndex: 1 });
    }
  });

  it("a cyclic or too-deep stored entry is a break, not an exception", async () => {
    const chain = await honest(1);
    const cyc: Record<string, unknown> = { a: 1 };
    cyc["self"] = cyc;
    const cyclic = { formatVersion: FORMAT_VERSION, index: 1, payload: cyc, prevHash: chain[0]!.entryHash, createdAt: at(1), entryHash: "ab" };
    expect(await streamed([chain[0], cyclic], 1)).toMatchObject({ valid: false, brokenAtIndex: 1 });
    let deep: unknown = 1;
    for (let i = 0; i < 400; i++) deep = { d: deep };
    const record = { formatVersion: FORMAT_VERSION, index: 1, payload: deep, prevHash: chain[0]!.entryHash, createdAt: at(1) };
    const tooDeep = { ...record, entryHash: await sha256Hex(JSON.stringify(record)) };
    expect(await streamed([chain[0], tooDeep], 1)).toMatchObject({ valid: false, brokenAtIndex: 1 });
  });

  it("an id column read back as a string (a bigint driver default) is a break, not a crash", async () => {
    const chain = rt(await honest(3));
    (chain[1] as unknown as { index: string }).index = "1";
    expect(await streamed(chain, 1)).toMatchObject({ valid: false, brokenAtIndex: 1 });
  });

  it("an entry with an extra stored field is a break (the hash covers every field)", async () => {
    const chain = rt(await honest(3));
    (chain[1] as unknown as Record<string, unknown>)["tenant"] = "t1";
    expect(await streamed(chain, 1)).toMatchObject({ valid: false, brokenAtIndex: 1 });
  });

  it("a null-prototype entry verifies", async () => {
    const chain = (await honest(3)).map((e) => Object.assign(Object.create(null) as object, e));
    expect((await streamed(chain, 1)).valid).toBe(true);
  });

  it("a payload with the reserved kind and 200,000 keys is malformed, and quickly", async () => {
    const base = await honest(2);
    const wide: Record<string, unknown> = { kind: MARKED_GAP_KIND };
    for (let i = 0; i < 200_000; i++) wide[`k${i}`] = i;
    const bad = await mk({ index: 2, prevHash: base[1]!.entryHash, payload: wide });
    const t0 = Date.now();
    expect(await streamed([...base, bad], 1, { allowMarkedGaps: true })).toMatchObject({ valid: false, brokenAtIndex: 2 });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("a getter that supplies the reserved kind is not read as a gap and is reported as a getter", async () => {
    const base = await honest(1);
    const record = { formatVersion: FORMAT_VERSION, index: 1, payload: { kind: MARKED_GAP_KIND, reason: "x", from: 1, to: 1 }, prevHash: base[0]!.entryHash, createdAt: at(1) };
    const entry = { ...record, entryHash: await sha256Hex(canonicalJSON(record)), payload: { get kind() { return MARKED_GAP_KIND; }, reason: "x", from: 1, to: 1 } };
    const result = await streamed([base[0], entry], 1, { allowMarkedGaps: true });
    expect(result.valid).toBe(false);
  });

  it("a stored 5 MB payload verifies", async () => {
    const chain = rt(await honest(1));
    const big = await mk({ index: 1, prevHash: chain[0]!.entryHash, payload: { blob: "y".repeat(5_000_000) } });
    expect((await streamed([chain[0], rt(big)], 1)).valid).toBe(true);
  });
});

describe("verdict table: verifier lifecycle and callbacks", () => {
  it("after the first break nothing more is hashed and the first break is kept", async () => {
    const chain = rt(await honest(10));
    (chain[2]!.payload as Record<string, unknown>)["text"] = "edited";
    (chain[6]!.payload as Record<string, unknown>)["text"] = "edited too";
    let hashes = 0;
    const v = createChainVerifier({ hash: (s) => (hashes++, sha256Hex(s)) });
    const results: boolean[] = [];
    for (const entry of chain) results.push(await v.push(entry));
    expect(results).toEqual([true, true, false, false, false, false, false, false, false, false]);
    expect(hashes).toBe(3);
    expect(await v.finish()).toMatchObject({ brokenAtIndex: 2, entriesChecked: 2 });
  });

  it("pushes that are not awaited are still checked in order", async () => {
    const chain = await honest(50);
    const v = createChainVerifier();
    for (const entry of chain) void v.push(entry);
    expect(await v.finish()).toMatchObject({ valid: true, entriesChecked: 50 });
  });

  it("an entry is snapshotted when push is called: mutating it afterwards changes nothing", async () => {
    const chain = rt(await honest(3));
    const v = createChainVerifier();
    void v.push(chain[0]);
    void v.push(chain[1]);
    const last = chain[2]!;
    const p = v.push(last);
    last.entryHash = "0".repeat(64);
    await p;
    expect((await v.finish()).valid).toBe(true);
  });

  it("finish is repeatable and push after finish throws", async () => {
    const v = createChainVerifier();
    await v.push((await honest(1))[0]);
    const first = await v.finish();
    expect(await v.finish()).toEqual(first);
    expect(() => v.push({})).toThrow(TypeError);
  });

  it("a hash function that throws gives status error, never a pass and never an exception", async () => {
    const chain = await honest(3);
    const v = createChainVerifier({ hash: () => Promise.reject(new Error("hsm offline")) });
    await v.push(chain[0]);
    const result = await v.finish();
    expect(result).toMatchObject({ status: "error", valid: false, brokenAtIndex: 0 });
    expect((result.error as Error).message).toBe("hsm offline");
  });

  it("a hash that resolves to a non-string and a canonicalizer that throws or returns a non-string are errors", async () => {
    const chain = await honest(2);
    const cases: ChainVerifierOptions[] = [
      { hash: (() => Promise.resolve(7)) as never },
      {
        canonicalize: () => {
          throw new Error("nope");
        },
      },
      { canonicalize: (() => 5) as never },
    ];
    for (const options of cases) {
      const v = createChainVerifier(options);
      await v.push(chain[0]);
      expect(await v.finish()).toMatchObject({ status: "error", valid: false });
    }
  });

  it("a non-function hash or canonicalize option throws at creation", () => {
    expect(() => createChainVerifier({ hash: 5 as never })).toThrow(TypeError);
    expect(() => createChainVerifier({ canonicalize: "x" as never })).toThrow(TypeError);
  });

  it("an error leaves the verifier closed: later pushes do not run", async () => {
    const chain = await honest(3);
    let calls = 0;
    const v = createChainVerifier({
      hash: () => {
        calls++;
        return Promise.reject(new Error("x"));
      },
    });
    await v.push(chain[0]);
    await v.push(chain[1]);
    await v.push(chain[2]);
    expect(calls).toBe(1);
    expect((await v.finish()).status).toBe("error");
  });
});

describe("verdict table: splitValidPrefix", () => {
  it("an honest list is all valid with nothing left over", async () => {
    const chain = await honest(12);
    const split = await splitValidPrefix(chain);
    expect(split.valid).toEqual(chain);
    expect(split.rest).toEqual([]);
    expect(split.firstBreak).toBeNull();
  });

  it("a tampered list splits at the first break and keeps everything after it in rest", async () => {
    const chain = rt(await honest(12));
    (chain[7]!.payload as Record<string, unknown>)["text"] = "edited";
    const split = await splitValidPrefix(chain);
    expect(split.valid).toEqual(chain.slice(0, 7));
    expect(split.rest).toEqual(chain.slice(7));
    expect(split.firstBreak).toMatchObject({ index: 7 });
    expect(split.firstBreak!.reason).toMatch(/entry 7/);
  });

  it("repair flow: keep the valid prefix, mark the loss with a gap record, continue", async () => {
    const chain = await honest(10);
    const damaged = [...chain.slice(0, 6), ...chain.slice(7)]; // row 6 lost
    const split = await splitValidPrefix(damaged);
    expect(split.valid).toHaveLength(6);
    expect(split.firstBreak!.index).toBe(6);
    const store = createMemoryAppendStore({ now: () => at(30), entries: split.valid });
    expect((await appendGapToStore(store, { reason: "row 6 lost", count: 1 })).status).toBe("appended");
    expect((await appendToStore(store, { after: "repair" })).status).toBe("appended");
    expect(await streamed(store.entries(), 7, { allowMarkedGaps: true })).toMatchObject({
      valid: true,
      gaps: [{ from: 6, to: 6, atIndex: 7 }],
    });
  });

  it("gap records follow allowMarkedGaps, and from works", async () => {
    const chain = await chainWithGap();
    expect((await splitValidPrefix(chain)).valid).toHaveLength(4);
    expect((await splitValidPrefix(chain, { allowMarkedGaps: true })).valid).toHaveLength(chain.length);
    const from = { index: 4, hash: "0".repeat(64) };
    expect((await splitValidPrefix(chain.slice(5), { from })).valid).toHaveLength(0);
  });

  it("a non-array fails closed with nothing valid", async () => {
    for (const notArray of [{}, null, undefined, "abc", 5, new Set([1])]) {
      const split = await splitValidPrefix(notArray as never);
      expect(split.valid).toEqual([]);
      expect(split.rest).toEqual([]);
      expect(split.firstBreak?.index).toBeNull();
    }
  });

  it("an element getter that throws breaks at that element, and a Proxy array whose length throws fails closed", async () => {
    const chain = await honest(4);
    const boom = [...chain];
    Object.defineProperty(boom, 2, {
      get() {
        throw new Error("row 2 unreadable");
      },
      enumerable: true,
    });
    const split = await splitValidPrefix(boom);
    expect(split.valid).toHaveLength(2);
    expect(split.firstBreak).toMatchObject({ index: 2 });
    const proxied = new Proxy(chain, {
      get(t, k) {
        if (k === "length") throw new Error("len");
        return Reflect.get(t, k) as unknown;
      },
    });
    expect((await splitValidPrefix(proxied)).valid).toEqual([]);
  });

  it("each element is read once", async () => {
    const chain = await honest(5);
    const reads = [0, 0, 0, 0, 0];
    const arr: unknown[] = new Array<unknown>(5);
    chain.forEach((entry, i) =>
      Object.defineProperty(arr, i, {
        enumerable: true,
        get() {
          reads[i] = (reads[i] ?? 0) + 1;
          return entry;
        },
      }),
    );
    const split = await splitValidPrefix(arr);
    expect(split.valid).toHaveLength(5);
    expect(reads).toEqual([1, 1, 1, 1, 1]);
  });

  it("a callback that throws is rethrown, not turned into a break", async () => {
    const chain = await honest(2);
    await expect(splitValidPrefix(chain, { hash: () => Promise.reject(new Error("hsm offline")) })).rejects.toThrow("hsm offline");
  });

  it("does not modify its input", async () => {
    const chain = await honest(6);
    const before = JSON.stringify(chain);
    await splitValidPrefix(chain);
    expect(JSON.stringify(chain)).toBe(before);
  });
});

describe("verdict table: scaling", () => {
  /** Builds an entry cheaply (kit canonical form, synchronous node hash), so the timing below is the verifier's own. */
  const fastEntry = (index: number, prevHash: string, payload: unknown): ChainEntry => {
    const record = { formatVersion: FORMAT_VERSION, index, payload, prevHash, createdAt: at(index) };
    return { ...record, entryHash: createHash("sha256").update(canonicalJSON(record), "utf8").digest("hex") };
  };
  const cpu = (): number => {
    const u = process.cpuUsage();
    return (u.user + u.system) / 1000;
  };

  // Generates entries lazily, so nothing but the verifier's own state is kept.
  async function streamLazily(count: number, sample?: (i: number) => void): Promise<ChainVerifierResult> {
    const verifier = createChainVerifier();
    let prev = GENESIS_HASH;
    for (let i = 0; i < count; i++) {
      const entry = fastEntry(i, prev, { n: i, note: "x".repeat(40) });
      prev = entry.entryHash;
      await verifier.push(entry);
      if (sample !== undefined) sample(i);
    }
    return verifier.finish();
  }

  it("streams 100,000 entries with bounded memory and linear time", { timeout: 180_000 }, async () => {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;

    let t0 = cpu();
    const small = await streamLazily(25_000);
    const smallMs = cpu() - t0;
    expect(small).toMatchObject({ valid: true, entriesChecked: 25_000 });

    let early = 0;
    let late = 0;
    t0 = cpu();
    const big = await streamLazily(100_000, (i) => {
      if (i === 10_000) {
        gc();
        early = process.memoryUsage().heapUsed;
      }
      if (i === 99_999) {
        gc();
        late = process.memoryUsage().heapUsed;
      }
    });
    const bigMs = cpu() - t0;
    expect(big).toMatchObject({ valid: true, entriesChecked: 100_000 });
    expect(big.head.index).toBe(99_999);
    // Four times the entries must cost well under 16 times the time (linear would be about 4).
    expect(bigMs / smallMs).toBeLessThan(8);
    // 90,000 more entries must not leave 90,000 entries' worth of memory behind.
    expect(late - early).toBeLessThan(25 * 1024 * 1024);
  });

  it("many gap records are linear in the number of gaps, not quadratic", { timeout: 120_000 }, async () => {
    const make = async (gaps: number): Promise<number> => {
      const entries: ChainEntry[] = [];
      let prev = GENESIS_HASH;
      let index = 0;
      for (let g = 0; g < gaps; g++) {
        const e = fastEntry(index + 1, prev, gapPayload({ reason: "r", from: index, to: index }));
        entries.push(e);
        prev = e.entryHash;
        index += 2;
      }
      const t0 = cpu();
      const result = await streamed(entries, 1000, { allowMarkedGaps: true });
      const elapsed = cpu() - t0;
      expect(result.gaps).toHaveLength(gaps);
      return elapsed;
    };
    const small = await make(5_000);
    const big = await make(20_000);
    expect(big / small).toBeLessThan(8);
  });
});
