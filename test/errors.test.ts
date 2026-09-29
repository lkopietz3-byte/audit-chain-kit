// Pins the wording of every error and reason, so a silent change to a message
// (or to which check produces it) fails a test.
import { describe, expect, it } from "vitest";
import { appendEntry, GENESIS_HASH, sha256Hex, verifyChain } from "../src/index.js";
import type { ChainEntry, VerifyOptions } from "../src/index.js";
import { sha256HexNodeFallback } from "../src/hash-node-fallback.js";

type Note = { n: number };

async function one(): Promise<ChainEntry<Note>> {
  return (await appendEntry<Note>([], { n: 0 }))[0]!;
}

describe("verifyChain: an entry that is not a usable object", () => {
  const shape = (i: number) => `entry ${i} is not an object with string prevHash and entryHash`;

  it.each([
    ["missing entryHash", (e: ChainEntry<Note>) => ({ ...e, entryHash: undefined })],
    ["a numeric entryHash", (e: ChainEntry<Note>) => ({ ...e, entryHash: 5 })],
    ["missing prevHash", (e: ChainEntry<Note>) => ({ ...e, prevHash: undefined })],
    ["a numeric prevHash", (e: ChainEntry<Note>) => ({ ...e, prevHash: 5 })],
    ["a String object as prevHash", (e: ChainEntry<Note>) => ({ ...e, prevHash: new String(e.prevHash) })],
    ["a Map instead of an entry", () => new Map([["entryHash", "x"]])],
    ["an array instead of an entry", () => ["x"]],
    ["null", () => null],
    ["a number", () => 7],
    ["a string", () => "entry"],
  ])("rejects %s at its index, with the shape reason", async (_label, make) => {
    const e0 = await one();
    const result = await verifyChain([e0, make(e0)] as unknown as ChainEntry<Note>[]);
    expect(result).toEqual({ valid: false, brokenAtIndex: 1, reason: shape(1) });
  });

  it("reports a bad first entry at index 0", async () => {
    expect(await verifyChain([{}] as unknown as ChainEntry<Note>[])).toEqual({ valid: false, brokenAtIndex: 0, reason: shape(0) });
  });
});

describe("verifyChain: option and anchor errors", () => {
  const ANCHOR_MESSAGE = "verifyChain: anchor must be { index: non-negative integer, entryHash: non-empty string }";

  it.each([
    ["a negative index", { index: -1, entryHash: "x" }],
    ["a fractional index", { index: 0.5, entryHash: "x" }],
    ["an unsafe integer index", { index: 2 ** 53, entryHash: "x" }],
    ["a string index", { index: "0", entryHash: "x" }],
    ["a missing entryHash", { index: 0 }],
    ["a numeric entryHash", { index: 0, entryHash: 5 }],
    ["an empty entryHash", { index: 0, entryHash: "" }],
    ["null", null],
    ["a string", "anchor"],
    ["a number", 3],
  ])("names the required anchor shape for an anchor with %s", async (_label, anchor) => {
    await expect(verifyChain([], undefined, { anchor } as unknown as VerifyOptions)).rejects.toThrow(new TypeError(ANCHOR_MESSAGE));
  });

  it("accepts index 0 and the largest safe integer as anchor indexes", async () => {
    const e0 = await one();
    expect(await verifyChain([e0], undefined, { anchor: { index: 0, entryHash: e0.entryHash } })).toEqual({
      valid: true,
      brokenAtIndex: null,
      reason: null,
    });
    expect(await verifyChain([e0], undefined, { anchor: { index: Number.MAX_SAFE_INTEGER, entryHash: "x" } })).toMatchObject({
      valid: false,
      brokenAtIndex: null,
    });
  });

  it("accepts expectedMinLength 0 and rejects the largest safe integer as too long", async () => {
    expect((await verifyChain([], undefined, { expectedMinLength: 0 })).valid).toBe(true);
    const result = await verifyChain([], undefined, { expectedMinLength: Number.MAX_SAFE_INTEGER });
    expect(result.reason).toContain(`expectedMinLength is ${Number.MAX_SAFE_INTEGER}`);
  });

  it("gives the exact reasons for too few entries and a missing anchor entry", async () => {
    const e0 = await one();
    expect(await verifyChain([e0], undefined, { expectedMinLength: 2 })).toEqual({
      valid: false,
      brokenAtIndex: null,
      reason: "chain has 1 entries but expectedMinLength is 2 (entries may have been deleted from the end)",
    });
    expect(await verifyChain([e0], undefined, { anchor: { index: 1, entryHash: "x" } })).toEqual({
      valid: false,
      brokenAtIndex: null,
      reason: "chain has 1 entries, so there is no entry at anchor index 1 (entries were deleted from the end)",
    });
    expect(await verifyChain([e0], undefined, { anchor: { index: 0, entryHash: "x" } })).toEqual({
      valid: false,
      brokenAtIndex: 0,
      reason: "entry 0 entryHash does not match the anchor (entries up to 0 were rewritten or replaced)",
    });
  });

  it("checks expectedMinLength before the anchor", async () => {
    const e0 = await one();
    const result = await verifyChain([e0], undefined, { expectedMinLength: 5, anchor: { index: 0, entryHash: "x" } });
    expect(result.reason).toMatch(/expectedMinLength/);
  });

  it("a non-array chain has the documented reason", async () => {
    expect(await verifyChain({} as unknown as ChainEntry[])).toEqual({ valid: false, brokenAtIndex: null, reason: "chain is not an array" });
  });
});

describe("appendEntry: error wording", () => {
  it("a non-array chain", async () => {
    await expect(appendEntry({} as unknown as ChainEntry[], 1)).rejects.toThrow(new TypeError("appendEntry: chain must be an array"));
  });

  it("a chain whose length is not a non-negative integer", async () => {
    const proxy = new Proxy([], { get: (t, k, r): unknown => (k === "length" ? Number.NaN : Reflect.get(t, k, r)) });
    await expect(appendEntry(proxy, 1)).rejects.toThrow(
      new TypeError("appendEntry: chain.length must be a non-negative integer, got NaN"),
    );
  });

  it.each([
    ["null", null],
    ["a number", 3],
    ["an entry with no entryHash", { index: 0 }],
    ["an entry with a numeric entryHash", { index: 0, entryHash: 4 }],
  ])("a last entry that is %s names its position", async (_label, last) => {
    await expect(appendEntry([last] as unknown as ChainEntry[], 1)).rejects.toThrow(
      new TypeError("appendEntry: the last entry (position 0) has no string entryHash"),
    );
  });

  it("a last entry at the wrong position names both indexes", async () => {
    const e0 = await one();
    await expect(appendEntry([e0, e0], { n: 1 })).rejects.toThrow(
      new RangeError("appendEntry: the last entry has index 0 but sits at position 1; pass the whole chain"),
    );
  });

  it("checks the entryHash before the index", async () => {
    await expect(appendEntry([{ index: 9, prevHash: GENESIS_HASH }] as unknown as ChainEntry[], 1)).rejects.toThrow(TypeError);
  });
});

describe("hashers: exact rejection messages", () => {
  it.each([
    ["undefined", undefined, "undefined"],
    ["null", null, "null"],
    ["a number", 5, "number"],
    ["an object", {}, "object"],
  ] as [string, unknown, string][])("both hashers say what they got for %s", async (_label, input, shown) => {
    await expect(sha256Hex(input as string)).rejects.toThrow(
      new TypeError(`sha256Hex: input must be a string, got ${shown}`),
    );
    await expect(sha256HexNodeFallback(input as string)).rejects.toThrow(
      new TypeError(`sha256HexNodeFallback: input must be a string, got ${shown}`),
    );
  });

  it("the Web Crypto error tells the caller which hasher to pass instead", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    try {
      await expect(sha256Hex("x")).rejects.toThrow(
        'Pass sha256HexNodeFallback from "audit-chain-kit/hash-node-fallback" as the hash function.',
      );
    } finally {
      Object.defineProperty(globalThis, "crypto", original);
    }
  });
});
