import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appendEntry, verifyChain, GENESIS_HASH } from "../src/index.js";
import type { ChainEntry } from "../src/index.js";

async function buildValidChain(): Promise<readonly ChainEntry<{ note: string }>[]> {
  let chain: readonly ChainEntry<{ note: string }>[] = [];
  chain = await appendEntry(chain, { note: "genesis event" });
  chain = await appendEntry(chain, { note: "second event" });
  chain = await appendEntry(chain, { note: "third event" });
  return chain;
}

describe("appendEntry", () => {
  it("produces a chain whose first entry points at GENESIS_HASH", async () => {
    const chain = await buildValidChain();
    expect(chain[0]!.prevHash).toBe(GENESIS_HASH);
    expect(chain).toHaveLength(3);
  });

  it("chains each entry's prevHash to the previous entry's entryHash", async () => {
    const chain = await buildValidChain();
    expect(chain[1]!.prevHash).toBe(chain[0]!.entryHash);
    expect(chain[2]!.prevHash).toBe(chain[1]!.entryHash);
  });

  it("is pure: does not mutate the input array, returns a new one", async () => {
    const original: ChainEntry<{ note: string }>[] = [];
    const next = await appendEntry(original, { note: "a" });
    expect(original).toHaveLength(0); // untouched
    expect(next).toHaveLength(1);
    expect(next).not.toBe(original);
  });

  it("returns a frozen array of frozen entries, typed readonly", async () => {
    const chain = await appendEntry([], { note: "a" });
    expect(Object.isFrozen(chain)).toBe(true);
    expect(Object.isFrozen(chain[0])).toBe(true);
    // The types must say what the runtime does: these compile only if the
    // return type is readonly (`npm run typecheck` fails otherwise).
    // @ts-expect-error the returned array is readonly, matching Object.freeze
    const asMutable: ChainEntry<{ note: string }>[] = chain;
    expect(() => asMutable.push(chain[0]!)).toThrow(TypeError);
    // @ts-expect-error entries are frozen
    expect(() => { chain[0]!.index = 9; }).toThrow(TypeError);
  });

  it("does not copy or freeze the payload: mutating it afterwards breaks verification", async () => {
    const payload = { note: "a" };
    const chain = await appendEntry([], payload);
    expect(chain[0]!.payload).toBe(payload);
    expect(Object.isFrozen(payload)).toBe(false);
    payload.note = "changed later";
    expect((await verifyChain(chain)).valid).toBe(false);
  });

  it("is deterministic: same payload sequence (with a fixed clock) hashes identically", async () => {
    // Pin createdAt so both runs hash identical records. Only Date is faked;
    // timers and microtasks stay real so Web Crypto promises still resolve.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const a = await appendEntry(await appendEntry([], { x: 1 }), { x: 2 });
      const b = await appendEntry(await appendEntry([], { x: 1 }), { x: 2 });
      expect(a[1]!.createdAt).toBe("2026-01-01T00:00:00.000Z");
      expect(a[1]!.entryHash).toBe(b[1]!.entryHash);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("verifyChain — valid chain", () => {
  it("reports valid: true for a freshly appended chain", async () => {
    const chain = await buildValidChain();
    const result = await verifyChain(chain);
    expect(result).toEqual({ valid: true, brokenAtIndex: null, reason: null });
  });

  it("reports valid: true for an empty chain", async () => {
    const result = await verifyChain([]);
    expect(result.valid).toBe(true);
  });
});

describe("verifyChain — mutated payload", () => {
  it("detects a mutated payload and reports the correct brokenAtIndex", async () => {
    const chain = await buildValidChain();
    const tampered = chain.map((e, i) =>
      i === 1 ? { ...e, payload: { note: "TAMPERED" } } : e,
    ) as ChainEntry<{ note: string }>[];

    const result = await verifyChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(1);
    expect(result.reason).toMatch(/entryHash/);
  });

  it("flags the tampered index, not a later one, when only one entry is mutated", async () => {
    const chain = await buildValidChain();
    const tampered = chain.map((e, i) =>
      i === 2 ? { ...e, payload: { note: "TAMPERED" } } : e,
    ) as ChainEntry<{ note: string }>[];

    const result = await verifyChain(tampered);
    expect(result.brokenAtIndex).toBe(2);
  });
});

describe("verifyChain — persistence round trip", () => {
  const jsonRoundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  it("still verifies after a JSON round trip when a payload has undefined fields", async () => {
    type Payload = { note: string; optional?: string | undefined; list?: (number | undefined)[] };
    let chain = await appendEntry<Payload>([], { note: "a", optional: undefined });
    chain = await appendEntry<Payload>(chain, { note: "b", list: [1, undefined, 3] });
    expect(await verifyChain(jsonRoundTrip(chain))).toEqual({ valid: true, brokenAtIndex: null, reason: null });
  });

  it("still verifies after a JSON round trip when a payload holds a Date", async () => {
    const chain = await appendEntry([], { at: new Date("2020-01-02T03:04:05.000Z") });
    expect((await verifyChain(jsonRoundTrip(chain))).valid).toBe(true);
  });

  it("detects a changed Date inside a payload", async () => {
    const chain = await appendEntry([], { at: new Date("2020-01-02T03:04:05.000Z") });
    const tampered = [{ ...chain[0]!, payload: { at: new Date("1999-01-01T00:00:00.000Z") } }];
    const result = await verifyChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(0);
  });
});

describe("verifyChain — severed / spliced-out entry", () => {
  it("detects a middle entry spliced out via a broken prevHash pointer", async () => {
    const chain = await buildValidChain(); // [0,1,2]
    const spliced = [chain[0]!, chain[2]!]; // remove index 1

    const result = await verifyChain(spliced);
    expect(result.valid).toBe(false);
    // chain[2] (now at array position 1) still points at chain[1]'s old
    // entryHash, which no longer immediately precedes it.
    expect(result.brokenAtIndex).toBe(1);
    expect(result.reason).toMatch(/prevHash/);
  });

  it("detects a severed link even when entries are just reordered", async () => {
    const chain = await buildValidChain();
    const reordered = [chain[1]!, chain[0]!, chain[2]!];
    const result = await verifyChain(reordered);
    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(0);
  });
});

describe("verifyChain — tail deletion via expectedMinLength", () => {
  it("passes the structural walk but fails expectedMinLength when the last entry is dropped", async () => {
    const chain = await buildValidChain(); // 3 entries
    const truncated = chain.slice(0, 2); // drop the last one — no broken pointer results

    const withoutExpectation = await verifyChain(truncated);
    expect(withoutExpectation.valid).toBe(true); // structurally consistent, but incomplete

    const withExpectation = await verifyChain(truncated, undefined, { expectedMinLength: 3 });
    expect(withExpectation.valid).toBe(false);
    expect(withExpectation.brokenAtIndex).toBeNull();
    expect(withExpectation.reason).toMatch(/expectedMinLength/);
  });

  it("passes when the chain meets expectedMinLength", async () => {
    const chain = await buildValidChain();
    const result = await verifyChain(chain, undefined, { expectedMinLength: 3 });
    expect(result.valid).toBe(true);
  });
});

describe("Web Crypto only in the core path", () => {
  // Matches an actual import/require statement, not the word "node:crypto"
  // appearing in a doc comment explaining why the file doesn't have one.
  const NODE_CRYPTO_IMPORT = /(?:from\s+["']node:crypto["']|require\(\s*["']node:crypto["']\s*\))/;

  it("hash.ts contains no node:crypto import statement", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/hash.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(NODE_CRYPTO_IMPORT);
  });

  it("chain.ts (append + verify) contains no node:crypto import statement", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/chain.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(NODE_CRYPTO_IMPORT);
  });

  it("index.ts does not re-export the Node fallback (opt-in only)", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
    // The fallback is mentioned only in a comment explaining how to reach it
    // explicitly; there must be no `export ... from ".../hash-node-fallback"`.
    expect(src).not.toMatch(/export[^;]*from\s+["']\.\/hash-node-fallback\.js["']/);
  });

  it("verifyChain resolves using only globalThis.crypto.subtle.digest", async () => {
    const chain = await buildValidChain();
    // `digest` lives on SubtleCrypto.prototype (an ordinary configurable,
    // writable method there), so spy on the prototype rather than trying to
    // reassign `crypto.subtle` itself, which is an accessor with no setter.
    const subtleProto = Object.getPrototypeOf(globalThis.crypto.subtle) as SubtleCrypto;
    const digestSpy = vi.spyOn(subtleProto, "digest");

    try {
      const result = await verifyChain(chain);
      expect(result.valid).toBe(true);
      expect(digestSpy).toHaveBeenCalled();
    } finally {
      digestSpy.mockRestore();
    }
  });

  it("sha256Hex throws a clear error when Web Crypto is unavailable", async () => {
    const { sha256Hex } = await import("../src/hash.js");
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    try {
      await expect(sha256Hex("x")).rejects.toThrow(/Web Crypto/);
    } finally {
      Object.defineProperty(globalThis, "crypto", originalDescriptor);
    }
  });
});
