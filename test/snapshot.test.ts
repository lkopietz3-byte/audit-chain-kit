// ACK-001 and the appendEntry race: verifyChain and appendEntry must read every
// caller-controlled value (anchor, entry scalars, array membership and length)
// once, before their first await, and decide from that snapshot only.
//
// Every race here is deterministic. A custom async hasher parks on a promise the
// test controls, the test mutates the input while that hash is pending, then
// releases the hasher. No timers, no real concurrency.
import { describe, expect, it } from "vitest";
import { appendEntry, canonicalJSON, GENESIS_HASH, sha256Hex, verifyChain } from "../src/index.js";
import type { ChainEntry, Hasher } from "../src/index.js";

type Note = { n: number | string };
type Mutable = { -readonly [K in keyof ChainEntry<Note>]: ChainEntry<Note>[K] };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Delegates to sha256Hex, but parks on the `pauseOn`th call (1-based) until `release()`. */
function pausingHasher(pauseOn: number) {
  const entered = deferred();
  const proceed = deferred();
  let calls = 0;
  const hash: Hasher = async (input) => {
    calls += 1;
    if (calls === pauseOn) {
      entered.resolve();
      await proceed.promise;
    }
    return sha256Hex(input);
  };
  return { hash, entered: entered.promise, release: proceed.resolve, calls: () => calls };
}

async function chainOf(count: number, tag = "n"): Promise<Mutable[]> {
  let chain: readonly ChainEntry<Note>[] = [];
  for (let i = 0; i < count; i++) chain = await appendEntry<Note>(chain, { n: `${tag}${i}` });
  // What a caller has after loading from storage: plain, mutable copies.
  return chain.map((e) => ({ ...e }));
}

const VALID = { valid: true, brokenAtIndex: null, reason: null };

describe("verifyChain snapshot: anchor comparison uses the hash that was verified (ACK-001 / REG-04)", () => {
  it("rejects when an entryHash is swapped to the anchored value while its own hash is pending", async () => {
    const trusted = await chainOf(1, "trusted");
    const anchor = { index: 0, entryHash: trusted[0]!.entryHash };
    const alternative = await chainOf(1, "other"); // correctly hashed, but not the anchored chain
    const gate = pausingHasher(1);

    const pending = verifyChain(alternative, undefined, { anchor, hash: gate.hash });
    await gate.entered;
    alternative[0]!.entryHash = anchor.entryHash; // forged after the content check started
    gate.release();
    const result = await pending;

    expect(result).toMatchObject({ valid: false, brokenAtIndex: 0 });
    expect(result.reason).toMatch(/anchor/);
    // The returned object no longer verifies on its own: the forgery was real.
    expect((await verifyChain(alternative)).valid).toBe(false);
  });

  it("control: the same wrong chain is rejected when nothing races", async () => {
    const trusted = await chainOf(1, "trusted");
    const alternative = await chainOf(1, "other");
    const result = await verifyChain(alternative, undefined, { anchor: trusted[0]! });
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });
});

describe("verifyChain snapshot: the anchor object is read once (ACK-001 / REG-05)", () => {
  it("rejects a wrong anchor that is replaced with the right hash while a hash is pending", async () => {
    const chain = await chainOf(2);
    const anchor = { index: 0, entryHash: "f".repeat(64) }; // wrong at call time
    const gate = pausingHasher(1);

    const pending = verifyChain(chain, undefined, { anchor, hash: gate.hash });
    await gate.entered;
    anchor.entryHash = chain[0]!.entryHash;
    gate.release();

    expect(await pending).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("accepts a right anchor whose index is changed while a hash is pending", async () => {
    const chain = await chainOf(3);
    const anchor = { index: 0, entryHash: chain[0]!.entryHash }; // right at call time
    const gate = pausingHasher(1);

    const pending = verifyChain(chain, undefined, { anchor, hash: gate.hash });
    await gate.entered;
    anchor.index = 2;
    gate.release();

    expect(await pending).toEqual(VALID);
  });

  it("reads each anchor field exactly once, even through getters", async () => {
    const chain = await chainOf(2);
    const reads = { index: 0, entryHash: 0 };
    const anchor = {
      get index() {
        reads.index += 1;
        return 1;
      },
      get entryHash() {
        reads.entryHash += 1;
        return chain[1]!.entryHash;
      },
    };
    expect(await verifyChain(chain, undefined, { anchor })).toEqual(VALID);
    expect(reads).toEqual({ index: 1, entryHash: 1 });
  });

  it("reads each option exactly once", async () => {
    const chain = await chainOf(1);
    const reads = { hash: 0, expectedMinLength: 0, anchor: 0 };
    const options = {
      get hash() {
        reads.hash += 1;
        return sha256Hex;
      },
      get expectedMinLength() {
        reads.expectedMinLength += 1;
        return 1;
      },
      get anchor() {
        reads.anchor += 1;
        return { index: 0, entryHash: chain[0]!.entryHash };
      },
    };
    expect(await verifyChain(chain, undefined, options)).toEqual(VALID);
    expect(reads).toEqual({ hash: 1, expectedMinLength: 1, anchor: 1 });
  });
});

describe("verifyChain snapshot: array membership and length are fixed at the call (ACK-001 / REG-06)", () => {
  it("does not skip a corrupt tail when the array is shortened while a hash is pending", async () => {
    const chain = await chainOf(3);
    chain[2]!.payload = { n: "TAMPERED" };
    const gate = pausingHasher(1);

    const pending = verifyChain(chain, undefined, { hash: gate.hash });
    await gate.entered;
    chain.length = 1;
    gate.release();
    const result = await pending;

    expect(result).toMatchObject({ valid: false, brokenAtIndex: 2 });
    expect(result.reason).toMatch(/entry 2 content does not match/);
  });

  it("does not skip the anchor's entry when the array is shortened while a hash is pending", async () => {
    const chain = await chainOf(3);
    const anchor = { index: 2, entryHash: chain[2]!.entryHash };
    const gate = pausingHasher(1);

    const pending = verifyChain(chain, undefined, { anchor, hash: gate.hash });
    await gate.entered;
    chain.length = 1;
    gate.release();

    expect(await pending).toEqual(VALID); // the call-time chain contained and verified the anchored entry
  });

  it("ignores an entry appended while a hash is pending (the result describes the call-time chain)", async () => {
    const chain = await chainOf(2);
    const gate = pausingHasher(1);

    const pending = verifyChain(chain, undefined, { hash: gate.hash });
    await gate.entered;
    chain.push({ garbage: true } as unknown as Mutable);
    gate.release();

    expect(await pending).toEqual(VALID);
  });

  it("uses the entry that was at each position at call time, not one swapped in later", async () => {
    const chain = await chainOf(3);
    const bad = { ...chain[1]!, payload: { n: "SWAPPED" } };
    const gate = pausingHasher(1);

    const pending = verifyChain(chain, undefined, { hash: gate.hash });
    await gate.entered;
    chain[1] = bad;
    gate.release();

    expect(await pending).toEqual(VALID);
  });

  it("uses each entry's scalars from call time (a later prevHash edit does not break or forge a link)", async () => {
    const chain = await chainOf(3);
    const gate = pausingHasher(1);

    const pending = verifyChain(chain, undefined, { hash: gate.hash });
    await gate.entered;
    chain[1]!.prevHash = "e".repeat(64);
    chain[2]!.index = 9;
    gate.release();

    expect(await pending).toEqual(VALID);
  });

  it("verifies a link, hash and index from the same captured record, so a mixed state cannot pass", async () => {
    // Entry 1 is correctly hashed but points at the wrong predecessor. If the
    // link check used a value re-read after the await, swapping prevHash to the
    // right value mid-verification would let this pass.
    const chain = await chainOf(2);
    const forged = { ...chain[1]!, prevHash: "d".repeat(64) };
    const { entryHash: _stale, ...forgedRecord } = forged;
    void _stale;
    const rehashed = { ...forged, entryHash: await sha256Hex(canonicalJSON(forgedRecord)) };
    const list: Mutable[] = [chain[0]!, rehashed];
    const gate = pausingHasher(1);

    const pending = verifyChain(list, undefined, { hash: gate.hash });
    await gate.entered;
    list[1]!.prevHash = chain[0]!.entryHash; // now the link looks right, but the hash no longer matches
    gate.release();
    const result = await pending;

    expect(result).toMatchObject({ valid: false, brokenAtIndex: 1 });
    expect(result.reason).toMatch(/prevHash/);
  });

  it("still catches a payload changed in place while an earlier hash is pending (payloads are read by reference)", async () => {
    const chain = await chainOf(2);
    const gate = pausingHasher(1);

    const pending = verifyChain(chain, undefined, { hash: gate.hash });
    await gate.entered;
    (chain[1]!.payload as { n: string }).n = "CHANGED";
    gate.release();

    expect(await pending).toMatchObject({ valid: false, brokenAtIndex: 1 });
  });

  it("a hole stops the walk at that index without visiting later entries", async () => {
    const chain = await chainOf(3);
    const sparse: unknown[] = [chain[0]!, undefined, chain[2]!];
    Reflect.deleteProperty(sparse, 1); // a real hole, not an undefined element
    expect(await verifyChain(sparse as ChainEntry<Note>[])).toMatchObject({ valid: false, brokenAtIndex: 1 });
  });

  it("does not scan a huge sparse array past the first hole", async () => {
    const sparse: unknown[] = [];
    sparse.length = 4_294_967_295;
    const started = Date.now();
    expect(await verifyChain(sparse as ChainEntry<Note>[])).toMatchObject({ valid: false, brokenAtIndex: 0 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("treats a proxied array with a non-integer length as invalid, not as an empty valid chain", async () => {
    const chain = await chainOf(1);
    for (const length of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, "1", undefined]) {
      const proxy = new Proxy(chain, {
        get: (target, key, receiver): unknown => (key === "length" ? length : Reflect.get(target, key, receiver)),
      });
      const result = await verifyChain(proxy);
      expect(result, `length ${String(length)}`).toMatchObject({ valid: false, brokenAtIndex: null });
      expect(result.reason).toMatch(/length/);
    }
  });

  it("first-failure ordering is unchanged: an earlier hash failure wins over a later structural one", async () => {
    const chain = await chainOf(3);
    chain[0]!.payload = { n: "TAMPERED" }; // hash failure at 0
    chain[1]!.prevHash = "c".repeat(64); // link failure at 1
    expect(await verifyChain(chain)).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("does not call canonicalize or hash for entries after the first bad shape", async () => {
    const chain = await chainOf(2);
    const list = [chain[0]!, 7 as unknown as Mutable, chain[1]!];
    let canonicalCalls = 0;
    const result = await verifyChain(list, (v) => {
      canonicalCalls += 1;
      return canonicalJSON(v);
    });
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 1 });
    expect(canonicalCalls).toBe(1);
  });

  it("a canonicalizer error on a later entry is not raised when an earlier entry already failed", async () => {
    const chain = await chainOf(2);
    chain[0]!.payload = { n: "TAMPERED" };
    (chain[1]!.payload as unknown) = 1n; // canonicalJSON would throw on this
    expect(await verifyChain(chain)).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });
});

describe("appendEntry snapshot: membership and last entry are captured before the await", () => {
  it("does not include an entry pushed to the input while the hash is pending", async () => {
    const chain = await chainOf(1);
    const late = (await chainOf(1, "late"))[0]!;
    const gate = pausingHasher(1);

    const pending = appendEntry<Note>(chain, { n: "new" }, canonicalJSON, gate.hash);
    await gate.entered;
    chain.push(late);
    gate.release();
    const result = await pending;

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ index: 1, prevHash: chain[0]!.entryHash });
    expect(await verifyChain(result)).toEqual(VALID);
  });

  it("does not drop entries removed from the input while the hash is pending", async () => {
    const chain = await chainOf(3);
    const originalHashes = chain.map((e) => e.entryHash);
    const gate = pausingHasher(1);

    const pending = appendEntry<Note>(chain, { n: "new" }, canonicalJSON, gate.hash);
    await gate.entered;
    chain.length = 0;
    gate.release();
    const result = await pending;

    expect(result.map((e) => e.entryHash).slice(0, 3)).toEqual(originalHashes);
    expect(result).toHaveLength(4);
    expect(await verifyChain(result)).toEqual(VALID);
  });

  it("keeps the entry that was last at call time when the input is replaced mid-hash", async () => {
    const chain = await chainOf(2);
    const original = chain[1]!;
    const gate = pausingHasher(1);

    const pending = appendEntry<Note>(chain, { n: "new" }, canonicalJSON, gate.hash);
    await gate.entered;
    chain[1] = { ...original, entryHash: "0".repeat(64) };
    gate.release();
    const result = await pending;

    expect(result[1]).toBe(original);
    expect(result[2]!.prevHash).toBe(original.entryHash);
  });

  it("reads the last entry's entryHash and index exactly once, even through getters", async () => {
    const [e0] = await chainOf(1);
    const reads = { entryHash: 0, index: 0 };
    const last = {
      ...e0!,
      get entryHash() {
        reads.entryHash += 1;
        return e0!.entryHash;
      },
      get index() {
        reads.index += 1;
        return 0;
      },
    };
    const result = await appendEntry<Note>([last], { n: 1 });
    expect(result[1]!.prevHash).toBe(e0!.entryHash);
    expect(reads).toEqual({ entryHash: 1, index: 1 });
  });

  it("reads chain.length once and copies the entries once", async () => {
    const chain = await chainOf(3);
    let lengthReads = 0;
    const proxy = new Proxy(chain, {
      get(target, key, receiver): unknown {
        if (key === "length") lengthReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const result = await appendEntry<Note>(proxy, { n: "x" });
    expect(lengthReads).toBe(1);
    expect(result).toHaveLength(4);
  });

  it("rejects a proxied array whose length is not a non-negative integer", async () => {
    const chain = await chainOf(1);
    for (const length of [Number.NaN, -1, 1.5, "1"]) {
      const proxy = new Proxy(chain, {
        get: (target, key, receiver): unknown => (key === "length" ? length : Reflect.get(target, key, receiver)),
      });
      await expect(appendEntry<Note>(proxy, { n: "x" })).rejects.toThrow(TypeError);
    }
  });

  it("a hole before the last entry is carried into the result as undefined and caught by verifyChain", async () => {
    const chain = await chainOf(2);
    // Only the last entry is inspected (documented), and its index (1) equals its position (1).
    const sparse: unknown[] = [undefined, chain[1]!];
    Reflect.deleteProperty(sparse, 0); // a real hole
    const result = await appendEntry<Note>(sparse as ChainEntry<Note>[], { n: "x" });
    expect(result).toHaveLength(3);
    expect(result[0]).toBeUndefined();
    expect(await verifyChain(result)).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("uses GENESIS_HASH for an empty chain", async () => {
    const result = await appendEntry<Note>([], { n: 0 });
    expect(result[0]!.prevHash).toBe(GENESIS_HASH);
  });
});
