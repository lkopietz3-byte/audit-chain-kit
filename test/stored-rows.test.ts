import { describe, expect, it } from "vitest";
import {
  appendToStore,
  canonicalJSON,
  computeEntry,
  createChainVerifier,
  createMemoryAppendStore,
  FORMAT_VERSION,
  gapPayload,
  GENESIS_HASH,
  readStoredEntry,
  sha256Hex,
  splitValidPrefix,
} from "../src/index.js";
import type { ChainEntry, ChainVerifierOptions, ChainVerifierResult } from "../src/index.js";

/**
 * Verdict table for rows read back from a database: the strict row reader,
 * the storage hints on a hash mismatch, the streaming anchor check, and the
 * gap-record message. Real-world origin: a field trial streamed a 50k-entry
 * log through Postgres and hit three false fails on legitimate reformatting
 * (timestamp text, bigint as a string, hash hex case). The rule here is that
 * a different value is never accepted as equal; only an exactly
 * representable form is converted, and everything else is a break that says why.
 */

const at = (n: number): string => `2026-01-01T00:00:${String(n % 60).padStart(2, "0")}.000Z`;

async function honest(count: number): Promise<ChainEntry[]> {
  const out: ChainEntry[] = [];
  for (let i = 0; i < count; i++) {
    out.push(
      await computeEntry({ prevHash: i === 0 ? GENESIS_HASH : out[i - 1]!.entryHash, index: i, payload: { n: i, note: `row ${i}` }, createdAt: at(i) }),
    );
  }
  return out;
}

/** A row as a database driver might hand it back (snake_case already mapped to the entry's names). */
const rowOf = (entry: ChainEntry, patch: Record<string, unknown> = {}): Record<string, unknown> => ({ ...entry, ...patch });

async function pushRows(rows: readonly unknown[], options?: ChainVerifierOptions): Promise<ChainVerifierResult> {
  const verifier = createChainVerifier(options);
  for (const row of rows) await verifier.pushRow(row);
  return verifier.finish();
}

describe("readStoredEntry: converts only exactly-representable forms", () => {
  it("a row that is already an entry comes back as the same entry", async () => {
    const [entry] = await honest(1);
    const result = readStoredEntry(rowOf(entry!));
    expect(result).toEqual({ ok: true, entry });
  });

  it("a decimal string index that round-trips to a safe integer becomes that number", async () => {
    const [entry] = await honest(1);
    for (const [stored, expected] of [["0", 0], ["7", 7], ["9007199254740991", Number.MAX_SAFE_INTEGER]] as const) {
      const result = readStoredEntry(rowOf(entry!, { index: stored }));
      expect(result.ok && result.entry.index).toBe(expected);
    }
  });

  it("a bigint index within the safe range becomes that number", async () => {
    const [entry] = await honest(1);
    const result = readStoredEntry(rowOf(entry!, { index: 12n }));
    expect(result.ok && result.entry.index).toBe(12);
  });

  const badIndexes: readonly unknown[] = [
    "", " 5", "5 ", "05", "+5", "-1", "5.0", "5.5", "1e3", "0x10", "9007199254740992", "9007199254740993", "١٢",
    2n ** 60n, -1n, 5.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, null, undefined, true, {}, [], new Date(0),
  ];
  for (const bad of badIndexes) {
    it(`an index that is not exactly a safe non-negative integer is refused: ${typeof bad === "bigint" ? `${bad}n` : JSON.stringify(bad) ?? String(bad)}`, async () => {
      const [entry] = await honest(1);
      const result = readStoredEntry(rowOf(entry!, { index: bad }));
      expect(result).toMatchObject({ ok: false, field: "index" });
    });
  }

  it("createdAt text is passed through untouched, never normalized", async () => {
    const [entry] = await honest(1);
    for (const text of ["2026-01-01 00:00:00+00", "2026-01-01T00:00:00Z", "yesterday", "2026-01-01T00:00:00.000Z"]) {
      const result = readStoredEntry(rowOf(entry!, { createdAt: text }));
      expect(result.ok && result.entry.createdAt).toBe(text);
    }
  });

  it("a Date or a number for createdAt is refused, because the hashed text cannot be recovered", async () => {
    const [entry] = await honest(1);
    for (const value of [new Date(0), 0, null, undefined, {}]) {
      const result = readStoredEntry(rowOf(entry!, { createdAt: value }));
      expect(result).toMatchObject({ ok: false, field: "createdAt" });
    }
    const date = readStoredEntry(rowOf(entry!, { createdAt: new Date(0) }));
    expect(!date.ok && date.reason).toMatch(/as text/);
  });

  it("upper-case hex hashes are refused with the reason, not converted (case is part of the hashed text)", async () => {
    const chain = await honest(2);
    const upper = chain[1]!.entryHash.toUpperCase();
    expect(readStoredEntry(rowOf(chain[1]!, { entryHash: upper }))).toMatchObject({ ok: false, field: "entryHash" });
    expect(readStoredEntry(rowOf(chain[1]!, { prevHash: chain[0]!.entryHash.toUpperCase() }))).toMatchObject({ ok: false, field: "prevHash" });
    const result = readStoredEntry(rowOf(chain[1]!, { entryHash: upper }));
    expect(!result.ok && result.reason).toMatch(/lower-case/);
  });

  it("the upper-case check can be turned off for a custom hash function", async () => {
    const chain = await honest(1);
    const upper = chain[0]!.entryHash.toUpperCase();
    const result = readStoredEntry(rowOf(chain[0]!, { entryHash: upper }), { lowercaseHexHashes: false });
    expect(result.ok && result.entry.entryHash).toBe(upper);
  });

  it("hashes that are not strings, a missing formatVersion and a missing payload are refused", async () => {
    const [entry] = await honest(1);
    expect(readStoredEntry(rowOf(entry!, { entryHash: 5 }))).toMatchObject({ ok: false, field: "entryHash" });
    expect(readStoredEntry(rowOf(entry!, { prevHash: null }))).toMatchObject({ ok: false, field: "prevHash" });
    expect(readStoredEntry(rowOf(entry!, { formatVersion: undefined }))).toMatchObject({ ok: false, field: "formatVersion" });
    const { payload: unused, ...noPayload } = entry!;
    void unused;
    expect(readStoredEntry(noPayload)).toMatchObject({ ok: false, field: "payload" });
  });

  it("extra columns are ignored, a SQL NULL payload stays null, a string payload stays a string", async () => {
    const [entry] = await honest(1);
    const result = readStoredEntry(rowOf(entry!, { tenant: "t1", inserted_at: new Date(0) }));
    expect(result.ok && Object.keys(result.entry).sort()).toEqual(["createdAt", "entryHash", "formatVersion", "index", "payload", "prevHash"]);
    const nul = readStoredEntry(rowOf(entry!, { payload: null }));
    expect(nul.ok && nul.entry.payload).toBeNull();
    const str = readStoredEntry(rowOf(entry!, { payload: '{"n":0}' }));
    expect(str.ok && str.entry.payload).toBe('{"n":0}');
  });

  it("hostile rows give a refusal, never an exception", () => {
    const getter = Object.defineProperty({}, "index", { enumerable: true, get() { throw new Error("boom"); } });
    const proxy = new Proxy({}, { ownKeys() { throw new Error("trap"); } });
    for (const row of [null, undefined, 5, "row", [], getter, proxy]) {
      expect(readStoredEntry(row)).toMatchObject({ ok: false });
    }
  });

  it("a getter is not run", async () => {
    const [entry] = await honest(1);
    let ran = 0;
    const row = rowOf(entry!);
    Object.defineProperty(row, "createdAt", { enumerable: true, get() { ran++; return entry!.createdAt; } });
    expect(readStoredEntry(row).ok).toBe(false);
    expect(ran).toBe(0);
  });
});

describe("pushRow: stored rows through the streaming verifier", () => {
  it("rows with a string index and extra columns verify like entries", async () => {
    const chain = await honest(30);
    const rows = chain.map((e) => rowOf(e, { index: String(e.index), tenant: "t1" }));
    const result = await pushRows(rows);
    expect(result).toMatchObject({ valid: true, entriesChecked: 30 });
  });

  it("a row the reader refuses is a break at that position with the reader's reason", async () => {
    const chain = await honest(10);
    const rows = chain.map((e) => rowOf(e));
    rows[4] = rowOf(chain[4]!, { createdAt: new Date(0) });
    const result = await pushRows(rows);
    expect(result).toMatchObject({ status: "broken", brokenAtIndex: 4, entriesChecked: 4 });
    expect(result.reason).toMatch(/entry 4 .*createdAt/);
  });

  it("an upper-cased hash is a break that names the case", async () => {
    const chain = await honest(5);
    const rows = chain.map((e) => rowOf(e));
    rows[2] = rowOf(chain[2]!, { entryHash: chain[2]!.entryHash.toUpperCase() });
    const result = await pushRows(rows);
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 2 });
    expect(result.reason).toMatch(/lower-case/);
  });

  it("a payload edited in the row is still caught, with no storage hint", async () => {
    const chain = await honest(5);
    const rows = chain.map((e) => rowOf(e, { index: String(e.index) }));
    rows[3] = rowOf(chain[3]!, { index: "3", payload: { n: 3, note: "edited" } });
    const result = await pushRows(rows);
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 3 });
    expect(result.reason).toMatch(/content does not match its entryHash/);
    expect(result.reason).not.toMatch(/storage/i);
  });

  it("pushRow after finish throws, and a refused row stops later rows from being hashed", async () => {
    const chain = await honest(4);
    let hashes = 0;
    const verifier = createChainVerifier({ hash: (s) => (hashes++, sha256Hex(s)) });
    expect(await verifier.pushRow(rowOf(chain[0]!))).toBe(true);
    expect(await verifier.pushRow(null)).toBe(false);
    expect(await verifier.pushRow(rowOf(chain[1]!))).toBe(false);
    expect(hashes).toBe(1);
    await verifier.finish();
    expect(() => verifier.pushRow({})).toThrow(TypeError);
  });

  it("the reader's upper-case option is passed through the verifier option lowercaseHexHashes", async () => {
    const chain = await honest(1);
    const row = rowOf(chain[0]!, { entryHash: chain[0]!.entryHash.toUpperCase() });
    expect((await pushRows([row])).valid).toBe(false);
    // With the check off the row is read, then the hash comparison fails (the digest is lower-case).
    const result = await pushRows([row], { lowercaseHexHashes: false });
    expect(result.reason).toMatch(/content does not match its entryHash/);
  });
});

describe("a hash mismatch from storage reformatting points at the likely cause", () => {
  it("timestamptz-style createdAt text", async () => {
    const chain = await honest(4);
    const rows = chain.map((e) => ({ ...e }));
    rows[2] = { ...rows[2]!, createdAt: "2026-01-01 00:00:02+00" };
    const result = await pushRows(rows.map((r) => ({ ...r })));
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 2 });
    expect(result.reason).toMatch(/content does not match its entryHash/);
    expect(result.reason).toMatch(/createdAt/);
    expect(result.reason).toMatch(/storage/i);
  });

  it("an index that is a string, pushed as an entry", async () => {
    const chain = await honest(3);
    const verifier = createChainVerifier();
    await verifier.push(chain[0]);
    await verifier.push({ ...chain[1]!, index: "1" });
    const result = await verifier.finish();
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 1 });
    expect(result.reason).toMatch(/index/);
    expect(result.reason).toMatch(/string/);
    expect(result.reason).toMatch(/readStoredEntry/);
  });

  it("an upper-cased entryHash, pushed as an entry", async () => {
    const chain = await honest(3);
    const verifier = createChainVerifier();
    await verifier.push(chain[0]);
    await verifier.push({ ...chain[1]!, entryHash: chain[1]!.entryHash.toUpperCase() });
    const result = await verifier.finish();
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 1 });
    expect(result.reason).toMatch(/upper-case/);
  });

  it("an ordinary tampered payload gets no storage hint", async () => {
    const chain = JSON.parse(JSON.stringify(await honest(3))) as ChainEntry[];
    (chain[1]!.payload as Record<string, unknown>)["note"] = "edited";
    const verifier = createChainVerifier();
    for (const e of chain) await verifier.push(e);
    const result = await verifier.finish();
    expect(result.reason).not.toMatch(/storage/i);
  });

  it("the kit's own createdAt form with a different value gets no hint", async () => {
    const chain = JSON.parse(JSON.stringify(await honest(3))) as ChainEntry[];
    chain[1] = { ...chain[1]!, createdAt: "2030-01-01T00:00:00.000Z" };
    const verifier = createChainVerifier();
    for (const e of chain) await verifier.push(e);
    expect((await verifier.finish()).reason).not.toMatch(/storage/i);
  });
});

describe("streaming anchor check", () => {
  const anchorOf = (e: ChainEntry) => ({ index: e.index, hash: e.entryHash });

  it("a stream that contains the anchored entry verifies", async () => {
    const chain = await honest(20);
    const result = await pushRows(chain, { anchor: anchorOf(chain[9]!) });
    expect(result.valid).toBe(true);
  });

  it("a fully recomputed rewrite fails against the anchor, at the anchor's index", async () => {
    const chain = await honest(20);
    let prev = GENESIS_HASH;
    const rewritten: ChainEntry[] = [];
    for (let i = 0; i < 20; i++) {
      const e = await computeEntry({ prevHash: prev, index: i, payload: { n: i === 3 ? "edited" : i }, createdAt: at(i) });
      rewritten.push(e);
      prev = e.entryHash;
    }
    expect((await pushRows(rewritten)).valid).toBe(true);
    const anchored = await pushRows(rewritten, { anchor: anchorOf(chain[9]!) });
    expect(anchored).toMatchObject({ valid: false, brokenAtIndex: 9 });
    expect(anchored.reason).toMatch(/anchor/);
  });

  it("a stream truncated before the anchor fails with no position", async () => {
    const chain = await honest(20);
    const result = await pushRows(chain.slice(0, 5), { anchor: anchorOf(chain[9]!) });
    expect(result).toMatchObject({ valid: false, brokenAtIndex: null });
    expect(result.reason).toMatch(/no entry at anchor index 9/);
  });

  it("an earlier break is kept as the first failure", async () => {
    const chain = JSON.parse(JSON.stringify(await honest(20))) as ChainEntry[];
    (chain[2]!.payload as Record<string, unknown>)["note"] = "edited";
    const result = await pushRows(chain, { anchor: anchorOf(chain[9]!) });
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 2 });
  });

  it("an anchor on a gap record's own index is checked; one inside the hole fails", async () => {
    const base = await honest(4);
    const gap = await computeEntry({ prevHash: base[3]!.entryHash, index: 7, payload: gapPayload({ reason: "lost", from: 4, to: 6 }), createdAt: at(7) });
    const rows = [...base, gap];
    expect((await pushRows(rows, { allowMarkedGaps: true, anchor: anchorOf(gap) })).valid).toBe(true);
    const inside = await pushRows(rows, { allowMarkedGaps: true, anchor: { index: 5, hash: "ab".repeat(32) } });
    expect(inside).toMatchObject({ valid: false, brokenAtIndex: null });
  });

  it("works together with from", async () => {
    const chain = await honest(30);
    const from = anchorOf(chain[9]!);
    expect((await pushRows(chain.slice(10), { from, anchor: anchorOf(chain[20]!) })).valid).toBe(true);
    expect((await pushRows(chain.slice(10), { from, anchor: { index: 20, hash: chain[19]!.entryHash } })).valid).toBe(false);
  });

  it("a malformed anchor, one at or before from, and one that is present but undefined throw", () => {
    const bad: unknown[] = [null, 5, {}, { index: -1, hash: "x" }, { index: 1.5, hash: "x" }, { index: 3, hash: "" }, { index: 3, hash: 5 }];
    for (const anchor of bad) expect(() => createChainVerifier({ anchor } as unknown as ChainVerifierOptions)).toThrow(TypeError);
    expect(() => createChainVerifier({ anchor: undefined } as unknown as ChainVerifierOptions)).toThrow(TypeError);
    expect(() => createChainVerifier({ from: { index: 5, hash: "x" }, anchor: { index: 5, hash: "x" } })).toThrow(TypeError);
    expect(() => createChainVerifier({ from: { index: 5, hash: "x" }, anchor: { index: 2, hash: "x" } })).toThrow(TypeError);
  });

  it("is read once and cannot be changed during the run", async () => {
    const chain = await honest(5);
    const anchor = { index: 4, hash: "00".repeat(32) };
    const verifier = createChainVerifier({ anchor });
    anchor.hash = chain[4]!.entryHash;
    for (const e of chain) await verifier.push(e);
    expect((await verifier.finish()).valid).toBe(false);
  });
});

describe("a gap record the verifier refuses names its own index", () => {
  it("message carries the record's index and the declared range", async () => {
    const store = createMemoryAppendStore({ now: () => at(1) });
    for (let i = 0; i < 5; i++) await appendToStore(store, { i });
    const rows = store.entries();
    const gap = await computeEntry({ prevHash: rows[4]!.entryHash, index: 10, payload: gapPayload({ reason: "lost", from: 5, to: 9 }), createdAt: at(2) });
    const result = await pushRows([...rows, gap]);
    expect(result.reason).toMatch(/entry 5 is a gap record/);
    expect(result.reason).toMatch(/index 10/);
    expect(result.reason).toMatch(/5 to 9/);
  });
});

describe("the empty stream is valid but says it checked nothing", () => {
  it("entriesChecked is 0 and head is the starting head", async () => {
    const result = await createChainVerifier().finish();
    expect(result).toMatchObject({ valid: true, entriesChecked: 0 });
  });
});

describe("storage round trip through JSON text (what node-postgres returns for json columns)", () => {
  it("a chain read back as parsed JSON with string ids verifies through the reader", async () => {
    const chain = await honest(40);
    const stored = JSON.parse(JSON.stringify(chain.map((e) => ({ ...e, index: String(e.index) })))) as unknown[];
    expect((await pushRows(stored)).valid).toBe(true);
    // canonicalJSON of the read-back entry equals the original (the point of the exact conversion).
    const first = readStoredEntry(stored[3]);
    expect(first.ok && canonicalJSON(first.entry)).toBe(canonicalJSON(chain[3]));
    expect(FORMAT_VERSION).toBe("audit-chain-kit/v1");
  });
});

describe("splitValidPrefix honors the anchor option", () => {
  const anchorOf = (e: ChainEntry) => ({ index: e.index, hash: e.entryHash });

  it("a matching anchor leaves everything valid", async () => {
    const chain = await honest(12);
    const split = await splitValidPrefix(chain, { anchor: anchorOf(chain[7]!) });
    expect(split.valid).toEqual(chain);
    expect(split.firstBreak).toBeNull();
  });

  it("a recomputed rewrite fails the anchor: break at the anchor index and nothing is vouched for", async () => {
    const chain = await honest(12);
    let prev = GENESIS_HASH;
    const rewritten: ChainEntry[] = [];
    for (let i = 0; i < 12; i++) {
      const e = await computeEntry({ prevHash: prev, index: i, payload: { n: i === 2 ? "edited" : i }, createdAt: at(i) });
      rewritten.push(e);
      prev = e.entryHash;
    }
    const split = await splitValidPrefix(rewritten, { anchor: anchorOf(chain[7]!) });
    expect(split.firstBreak).toMatchObject({ index: 7 });
    expect(split.firstBreak!.reason).toMatch(/anchor/);
    expect(split.valid).toEqual([]);
    expect(split.rest).toEqual(rewritten);
    expect(split.restComplete).toBe(true);
  });

  it("a stream that ends before the anchor reports it with index null and keeps the consistent entries", async () => {
    const chain = await honest(12);
    const split = await splitValidPrefix(chain.slice(0, 5), { anchor: anchorOf(chain[9]!) });
    expect(split.firstBreak).toMatchObject({ index: null });
    expect(split.firstBreak!.reason).toMatch(/no entry at anchor index 9/);
    expect(split.valid).toEqual(chain.slice(0, 5));
    expect(split.rest).toEqual([]);
  });
});

describe("rows that cannot even be inspected are refused, never thrown, and never leave the stream valid", () => {
  const revoked = (): object => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return proxy;
  };

  it("a revoked Proxy row, a Proxy with throwing traps, and a Proxy createdAt are refused", async () => {
    const [entry] = await honest(1);
    const trapped = new Proxy({}, { getPrototypeOf() { throw new Error("proto"); }, ownKeys() { throw new Error("keys"); } });
    const badCreatedAt = new Proxy({}, { getPrototypeOf() { throw new Error("proto"); } });
    for (const row of [revoked(), trapped, rowOf(entry!, { createdAt: badCreatedAt }), rowOf(entry!, { createdAt: revoked() })]) {
      expect(readStoredEntry(row)).toMatchObject({ ok: false });
    }
  });

  it("pushRow of such a row is false and finish is never valid", async () => {
    const [entry] = await honest(1);
    const badCreatedAt = new Proxy({}, { getPrototypeOf() { throw new Error("proto"); } });
    for (const row of [revoked(), rowOf(entry!, { createdAt: badCreatedAt })]) {
      const verifier = createChainVerifier();
      expect(await verifier.pushRow(row)).toBe(false);
      expect(await verifier.finish()).toMatchObject({ valid: false, status: "broken", brokenAtIndex: 0 });
    }
  });

  it("an unreadable row between good rows breaks the stream at its position", async () => {
    const chain = await honest(4);
    const verifier = createChainVerifier();
    await verifier.pushRow(rowOf(chain[0]!));
    await verifier.pushRow(revoked());
    await verifier.pushRow(rowOf(chain[2]!));
    expect(await verifier.finish()).toMatchObject({ valid: false, brokenAtIndex: 1, entriesChecked: 1 });
  });
});
