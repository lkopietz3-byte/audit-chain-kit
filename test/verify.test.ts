import { describe, expect, it } from "vitest";
import { appendEntry, canonicalJSON, FORMAT_VERSION, GENESIS_HASH, sha256Hex, verifyChain } from "../src/index.js";
import type { ChainEntry, VerifyOptions } from "../src/index.js";

type Note = { n: number | string };

async function chainOf(count: number): Promise<readonly ChainEntry<Note>[]> {
  let chain: readonly ChainEntry<Note>[] = [];
  for (let i = 0; i < count; i++) chain = await appendEntry<Note>(chain, { n: i });
  return chain;
}

/**
 * Build an entry by hand with correct hashes, whatever its fields say.
 * Defaults `formatVersion` to the current {@link FORMAT_VERSION} so tests
 * that forge an entry to probe something else (a bad index, a broken link)
 * don't incidentally trip the format-version check. Pass `formatVersion:
 * undefined` explicitly to build an entry with no formatVersion field at
 * all (canonicalJSON drops undefined-valued fields, same as an entry
 * hashed by pre-v1 code), or a different string to build one for another
 * format version.
 */
async function forgeEntry(record: {
  formatVersion?: unknown;
  index: unknown;
  payload: unknown;
  prevHash: string;
  createdAt: string;
}) {
  const full = { formatVersion: FORMAT_VERSION, ...record };
  return { ...full, entryHash: await sha256Hex(canonicalJSON(full)) } as unknown as ChainEntry<Note>;
}

const VALID = { valid: true, brokenAtIndex: null, reason: null };

describe("verifyChain: malformed input fails closed", () => {
  it.each([
    ["a plain object", {}],
    ["an array-like object", { length: 0 }],
    ["null", null],
    ["undefined", undefined],
    ["a string", "abc"],
  ])("reports %s as invalid instead of valid or throwing", async (_label, input) => {
    const result = await verifyChain(input as unknown as readonly ChainEntry[]);
    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBeNull();
    expect(result.reason).toMatch(/not an array/);
  });

  it.each([
    ["null", null],
    ["a number", 7],
    ["a hole", undefined],
  ])("reports an entry that is %s as invalid at its index", async (_label, bad) => {
    const chain = [...(await chainOf(1)), bad] as unknown as readonly ChainEntry<Note>[];
    const result = await verifyChain(chain);
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 1 });
  });

  it("reports an extra field on an entry as a content mismatch with a clear reason", async () => {
    const [e0] = await chainOf(1);
    const result = await verifyChain([{ ...e0!, approved: true } as ChainEntry<Note>]);
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 0 });
    expect(result.reason).toMatch(/changed, added, or removed/);
  });

  it("reports an extra own __proto__ key on an entry as a content mismatch", async () => {
    const [e0] = await chainOf(1);
    const withProto = JSON.parse(JSON.stringify(e0).replace("{", '{"__proto__":{"admin":true},')) as ChainEntry<Note>;
    expect(await verifyChain([withProto])).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("reports an uppercase entryHash as a mismatch (hashes are lowercase hex)", async () => {
    const [e0] = await chainOf(1);
    const upper = { ...e0!, entryHash: e0!.entryHash.toUpperCase() };
    expect((await verifyChain([upper])).valid).toBe(false);
  });
});

describe("verifyChain: index must equal position", () => {
  it("rejects an entry whose hashes are valid but whose index is not its position", async () => {
    const forged = await forgeEntry({ index: 5, payload: { n: 0 }, prevHash: GENESIS_HASH, createdAt: "2026-01-01T00:00:00.000Z" });
    const result = await verifyChain([forged]);
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 0 });
    expect(result.reason).toMatch(/index 5/);
  });

  it("rejects a string index even when it hashes correctly", async () => {
    const forged = await forgeEntry({ index: "0", payload: { n: 0 }, prevHash: GENESIS_HASH, createdAt: "2026-01-01T00:00:00.000Z" });
    expect(await verifyChain([forged])).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });
});

describe("verifyChain: formatVersion", () => {
  it("rejects an entry hashed with no formatVersion field (pre-v1 format) without throwing", async () => {
    const preV1 = await forgeEntry({
      formatVersion: undefined,
      index: 0,
      payload: { n: 0 },
      prevHash: GENESIS_HASH,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const result = await verifyChain([preV1]);
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 0 });
    expect(result.reason).toMatch(/no formatVersion/);
  });

  it("rejects an entry with a different (but internally self-consistent) formatVersion, without throwing", async () => {
    const otherVersion = await forgeEntry({
      formatVersion: "audit-chain-kit/v2",
      index: 0,
      payload: { n: 0 },
      prevHash: GENESIS_HASH,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const result = await verifyChain([otherVersion]);
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 0 });
    expect(result.reason).toMatch(/formatVersion "audit-chain-kit\/v2"/);
    expect(result.reason).toMatch(new RegExp(FORMAT_VERSION.replace(/\//, "\\/")));
  });

  it("accepts entries appendEntry actually stamps", async () => {
    const chain = await chainOf(2);
    for (const e of chain) expect(e.formatVersion).toBe(FORMAT_VERSION);
    expect(await verifyChain(chain)).toEqual(VALID);
  });
});

describe("verifyChain: other tamper modes", () => {
  it("detects a duplicated last entry", async () => {
    const chain = await chainOf(3);
    expect(await verifyChain([...chain, chain[2]!])).toMatchObject({ valid: false, brokenAtIndex: 3 });
  });

  it("detects a duplicated first entry", async () => {
    const chain = await chainOf(2);
    expect(await verifyChain([chain[0]!, chain[0]!, chain[1]!])).toMatchObject({ valid: false, brokenAtIndex: 1 });
  });

  it("detects a correctly hashed entry inserted in the middle", async () => {
    const chain = await chainOf(3);
    const inserted = await forgeEntry({ index: 1, payload: { n: "inserted" }, prevHash: chain[0]!.entryHash, createdAt: chain[0]!.createdAt });
    const result = await verifyChain([chain[0]!, inserted, chain[1]!, chain[2]!]);
    // The inserted entry itself is well formed; its successor no longer links.
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 2 });
    expect(result.reason).toMatch(/prevHash/);
  });

  it("detects a changed index, prevHash, or createdAt field (not just payload)", async () => {
    const chain = await chainOf(2);
    for (const change of [{ createdAt: "1999-01-01T00:00:00.000Z" }]) {
      const tampered = [chain[0]!, { ...chain[1]!, ...change }];
      expect(await verifyChain(tampered)).toMatchObject({ valid: false, brokenAtIndex: 1 });
    }
    const badPrev = [{ ...chain[0]!, prevHash: "f".repeat(64) }];
    expect(await verifyChain(badPrev)).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("cannot see a rewrite: anyone can recompute the whole chain (no key)", async () => {
    // Honest-limit test: this is WHY an anchor is needed.
    const original = await chainOf(3);
    let rewritten: readonly ChainEntry<Note>[] = [];
    for (const e of original) rewritten = await appendEntry<Note>(rewritten, e.index === 1 ? { n: "EDITED" } : e.payload);
    expect(await verifyChain(rewritten)).toEqual(VALID);
  });
});

describe("verifyChain: expectedMinLength", () => {
  it("accepts a chain at, and above, the expected length; rejects one below it", async () => {
    const chain = await chainOf(3);
    expect(await verifyChain(chain, undefined, { expectedMinLength: 2 })).toEqual(VALID);
    expect(await verifyChain(chain, undefined, { expectedMinLength: 3 })).toEqual(VALID);
    const below = await verifyChain(chain, undefined, { expectedMinLength: 4 });
    expect(below).toMatchObject({ valid: false, brokenAtIndex: null });
    expect(below.reason).toMatch(/expectedMinLength is 4/);
  });

  it("accepts expectedMinLength 0 for an empty chain", async () => {
    expect(await verifyChain([], undefined, { expectedMinLength: 0 })).toEqual(VALID);
  });

  it("is defeated by truncating and then appending new entries (anyone can append)", async () => {
    const chain = await chainOf(3);
    let forged: readonly ChainEntry<Note>[] = chain.slice(0, 1);
    forged = await appendEntry<Note>(forged, { n: "FAKE" });
    forged = await appendEntry<Note>(forged, { n: "FAKE" });
    expect(await verifyChain(forged, undefined, { expectedMinLength: 3 })).toEqual(VALID);
  });

  it.each([NaN, -1, 1.5, Infinity, "3", null])("throws a TypeError for expectedMinLength %s", async (bad) => {
    const chain = await chainOf(1);
    const options = { expectedMinLength: bad } as unknown as VerifyOptions;
    await expect(verifyChain(chain, undefined, options)).rejects.toThrow(TypeError);
  });
});

describe("verifyChain: anchor", () => {
  it("accepts a chain that still contains the anchored entry (at the end, middle, or start)", async () => {
    const chain = await chainOf(4);
    for (const i of [3, 1, 0]) {
      expect(await verifyChain(chain, undefined, { anchor: chain[i]! })).toEqual(VALID);
    }
  });

  it("accepts entries appended after the anchor was taken", async () => {
    const chain = await chainOf(2);
    const anchor = { index: chain[1]!.index, entryHash: chain[1]!.entryHash };
    const longer = await appendEntry<Note>(chain, { n: "later" });
    expect(await verifyChain(longer, undefined, { anchor })).toEqual(VALID);
  });

  it("does not protect entries after the anchor (honest limit)", async () => {
    const chain = await chainOf(3);
    let rewritten: readonly ChainEntry<Note>[] = chain.slice(0, 2);
    rewritten = await appendEntry<Note>(rewritten, { n: "EDITED" }); // replaces entry 2
    expect(await verifyChain(rewritten, undefined, { anchor: chain[1]! })).toEqual(VALID);
  });

  it("catches truncate-then-append, which expectedMinLength misses", async () => {
    const chain = await chainOf(3);
    let forged: readonly ChainEntry<Note>[] = chain.slice(0, 1);
    forged = await appendEntry<Note>(forged, { n: "FAKE" });
    forged = await appendEntry<Note>(forged, { n: "FAKE" });
    const result = await verifyChain(forged, undefined, { expectedMinLength: 3, anchor: chain[2]! });
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 2 });
    expect(result.reason).toMatch(/anchor/);
  });

  it("catches a full rewrite from genesis", async () => {
    const original = await chainOf(3);
    let rewritten: readonly ChainEntry<Note>[] = [];
    for (const e of original) rewritten = await appendEntry<Note>(rewritten, e.index === 1 ? { n: "EDITED" } : e.payload);
    expect(await verifyChain(rewritten, undefined, { anchor: original[2]! })).toMatchObject({ valid: false, brokenAtIndex: 2 });
  });

  it("catches truncation below the anchor", async () => {
    const chain = await chainOf(3);
    const result = await verifyChain(chain.slice(0, 2), undefined, { anchor: chain[2]! });
    expect(result).toMatchObject({ valid: false, brokenAtIndex: null });
    expect(result.reason).toMatch(/no entry at anchor index 2/);
  });

  it.each([
    ["a negative index", { index: -1, entryHash: GENESIS_HASH }],
    ["a fractional index", { index: 0.5, entryHash: GENESIS_HASH }],
    ["a string index", { index: "0", entryHash: GENESIS_HASH }],
    ["a missing entryHash", { index: 0 }],
    ["an empty entryHash", { index: 0, entryHash: "" }],
    ["null", null],
  ])("throws a TypeError for an anchor with %s", async (_label, anchor) => {
    const chain = await chainOf(1);
    const options = { anchor } as unknown as VerifyOptions;
    await expect(verifyChain(chain, undefined, options)).rejects.toThrow(TypeError);
  });
});

describe("appendEntry: input checks", () => {
  it("refuses a chain whose last entry's index is not its position (a partial chain)", async () => {
    const chain = await chainOf(2);
    await expect(appendEntry<Note>([chain[1]!], { n: 2 })).rejects.toThrow(RangeError);
  });

  it("refuses a non-array chain", async () => {
    await expect(appendEntry({} as unknown as readonly ChainEntry[], { n: 0 })).rejects.toThrow(TypeError);
  });

  it("refuses a chain whose last entry has no entryHash", async () => {
    const broken = [{ index: 0, payload: {}, prevHash: GENESIS_HASH, createdAt: "x" }] as unknown as readonly ChainEntry[];
    await expect(appendEntry(broken, { n: 1 })).rejects.toThrow(TypeError);
  });

  it("appends to an empty chain and to a full chain", async () => {
    const chain = await chainOf(2);
    const next = await appendEntry<Note>(chain, { n: 2 });
    expect(next[2]).toMatchObject({ index: 2, prevHash: chain[1]!.entryHash });
    expect(await verifyChain(next)).toEqual(VALID);
  });
});
