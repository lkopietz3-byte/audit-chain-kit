import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { appendEntry, canonicalJSON, FORMAT_VERSION, GENESIS_HASH, sha256Hex, verifyChain } from "../src/index.js";
import type { ChainEntry, VerifyOptions } from "../src/index.js";

/**
 * Verdict regression table. Each named case states the correct verdict for
 * one input. The "fix" groups pin the defects found in the 2026-10-10 hunt;
 * the "guard" groups pin behavior that must not change.
 */

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const rt = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function build(payloads: readonly unknown[]): Promise<readonly ChainEntry[]> {
  let chain: readonly ChainEntry[] = [];
  for (const payload of payloads) chain = await appendEntry(chain, payload);
  return chain;
}

/** A live entry whose hash was computed from the JSON form of `record` (as canonicalJSON does). */
async function forgeLive(record: Record<string, unknown>): Promise<Record<string, unknown>> {
  const full = { formatVersion: FORMAT_VERSION, index: 0, prevHash: GENESIS_HASH, createdAt: CREATED_AT, ...record };
  return { ...full, entryHash: await sha256Hex(canonicalJSON(full)) };
}

const VALID_SHAPE = { valid: true, brokenAtIndex: null, reason: null };

describe("verdict table: options that are present but undefined (fail-open)", () => {
  it("anchor: undefined is a TypeError, not a skipped check", async () => {
    const original = await build([{ a: 1 }, { a: 2 }, { a: 3 }]);
    const rewritten = await build([{ a: 1 }, { a: "X" }, { a: 3 }]);
    const options = { anchor: undefined } as unknown as VerifyOptions;
    await expect(verifyChain(rewritten, undefined, options)).rejects.toThrow(TypeError);
    await expect(verifyChain(original.slice(0, 1), undefined, options)).rejects.toThrow(/anchor/);
  });

  it("expectedMinLength: undefined is a TypeError, not a skipped check", async () => {
    const chain = await build([{ a: 1 }, { a: 2 }, { a: 3 }]);
    const options = { expectedMinLength: undefined } as unknown as VerifyOptions;
    await expect(verifyChain(chain.slice(0, 1), undefined, options)).rejects.toThrow(TypeError);
    await expect(verifyChain(chain.slice(0, 1), undefined, options)).rejects.toThrow(/expectedMinLength/);
  });

  it("a non-enumerable anchor: undefined is also a TypeError", async () => {
    const chain = await build([{ a: 1 }]);
    const options = Object.defineProperty({}, "anchor", { value: undefined, enumerable: false }) as VerifyOptions;
    await expect(verifyChain(chain, undefined, options)).rejects.toThrow(TypeError);
  });

  it("guard: the keys left out entirely are fine", async () => {
    const chain = await build([{ a: 1 }]);
    expect(await verifyChain(chain, undefined, {})).toMatchObject(VALID_SHAPE);
    expect(await verifyChain(chain, undefined, undefined)).toMatchObject(VALID_SHAPE);
  });

  it("guard: hash: undefined still means the default hasher", async () => {
    const chain = await build([{ a: 1 }]);
    expect(await verifyChain(chain, undefined, { hash: undefined } as unknown as VerifyOptions)).toMatchObject(VALID_SHAPE);
  });

  it("guard: an unknown option key still throws", async () => {
    const chain = await build([{ a: 1 }]);
    await expect(verifyChain(chain, undefined, { anchors: chain[0] } as unknown as VerifyOptions)).rejects.toThrow(TypeError);
  });
});

describe("verdict table: live entries and payloads that JSON does not represent faithfully", () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic["self"] = cyclic;
  class Point {
    x = 1;
  }
  const withSymbolKey = { a: 1, [Symbol("s")]: 2 };
  const withHidden = Object.defineProperty({ a: 1 }, "hidden", { value: 2, enumerable: false });
  const withGetter = Object.defineProperty({}, "a", { get: () => 1, enumerable: true });
  // eslint-disable-next-line no-sparse-arrays
  const sparse = [1, , 3];
  const arrayWithExtra = Object.assign([1, 2], { note: "x" });
  const badPayloads: [string, unknown][] = [
    ["a Date (toJSON)", new Date(0)],
    ["an object with an own toJSON function", { toJSON: () => ({ a: 1 }), a: 1 }],
    ["a function field", { a: 1, f: () => 1 }],
    ["an undefined field", { a: 1, u: undefined }],
    ["an undefined array element", [1, undefined]],
    ["a symbol value", { a: Symbol("s") }],
    ["a symbol-keyed field", withSymbolKey],
    ["a non-enumerable field", withHidden],
    ["a getter", withGetter],
    ["NaN", { n: Number.NaN }],
    ["Infinity", { n: Number.POSITIVE_INFINITY }],
    ["a Map", new Map([["a", 1]])],
    ["a Set", new Set([1])],
    ["a class instance", new Point()],
    ["a boxed string", new String("a")],
    ["a sparse array", sparse],
    ["an array with an extra property", arrayWithExtra],
    ["a cyclic object", cyclic],
    ["a BigInt", { n: 1n }],
  ];

  describe.each(badPayloads)("%s", (_label, payload) => {
    it("appendEntry refuses it with a TypeError", async () => {
      await expect(appendEntry([], payload)).rejects.toThrow(TypeError);
    });

    it("a live entry holding it is valid: false, not a false pass", async () => {
      // Hash the record with a lenient serializer, so the stored hash is the one an older version produced.
      const lenient = (v: unknown): string => {
        try {
          return canonicalJSON(v);
        } catch {
          return "unhashable";
        }
      };
      const record = { formatVersion: FORMAT_VERSION, index: 0, payload, prevHash: GENESIS_HASH, createdAt: CREATED_AT };
      const entry = { ...record, entryHash: await sha256Hex(lenient(record)) } as unknown as ChainEntry;
      const result = await verifyChain([entry]);
      expect(result).toMatchObject({ valid: false, brokenAtIndex: 0 });
      expect(result.reason).toMatch(/^entry 0 /);
    });
  });

  it("the JSON round trip of an entry holding a Date payload verifies (the JSON-text pipeline is unchanged)", async () => {
    const live = (await forgeLive({ payload: new Date(0) })) as unknown as ChainEntry;
    expect(await verifyChain(rt([live]))).toMatchObject(VALID_SHAPE);
  });

  it("the JSON round trip of an entry holding NaN verifies as null (unchanged)", async () => {
    const live = (await forgeLive({ payload: { n: Number.NaN } })) as unknown as ChainEntry;
    expect(await verifyChain(rt([live]))).toMatchObject(VALID_SHAPE);
  });

  it("an extra undefined field on an entry is valid: false", async () => {
    const live = { ...(await forgeLive({ payload: { a: 1 } })), extra: undefined } as unknown as ChainEntry;
    expect(await verifyChain([live])).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("an extra function field on an entry is valid: false", async () => {
    const live = { ...(await forgeLive({ payload: { a: 1 } })), extra: () => 1 } as unknown as ChainEntry;
    expect(await verifyChain([live])).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("an extra symbol-keyed field on an entry is valid: false", async () => {
    const live = { ...(await forgeLive({ payload: { a: 1 } })), [Symbol("extra")]: 1 } as unknown as ChainEntry;
    expect(await verifyChain([live])).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("an extra non-enumerable field on an entry is valid: false", async () => {
    const live = Object.defineProperty(await forgeLive({ payload: { a: 1 } }), "extra", { value: "x", enumerable: false });
    expect(await verifyChain([live as unknown as ChainEntry])).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("a revoked proxy entry is valid: false, not a thrown TypeError", async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(await verifyChain([proxy as unknown as ChainEntry])).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("an entry whose getter throws is valid: false, not a thrown error", async () => {
    const entry = {
      get entryHash(): string {
        throw new Error("boom");
      },
    };
    expect(await verifyChain([entry as unknown as ChainEntry])).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("a first failure earlier in the chain still wins over a later unfaithful entry", async () => {
    const chain = await build([{ a: 1 }, { a: 2 }]);
    const bad = rt(chain);
    bad[0]!.payload = { a: "changed" };
    const later = { ...(await forgeLive({ index: 1, prevHash: chain[0]!.entryHash, payload: new Date(0) })) } as unknown as ChainEntry;
    expect(await verifyChain([bad[0]!, later])).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("guard: plain nested data, null-prototype objects, -0, unicode and empty containers are accepted", async () => {
    const proto = Object.assign(Object.create(null) as object, { k: "v" });
    const chain = await build([
      { a: [1, 2.5, -0, 1e21, true, null, "ü日本\u{1f680}", "\ud800"], b: { c: {} }, d: [], e: proto },
      "just a string",
      7,
      null,
      [],
    ]);
    expect(await verifyChain(chain)).toMatchObject({ valid: true, entriesChecked: 5 });
    expect(await verifyChain(rt(chain))).toMatchObject({ valid: true, entriesChecked: 5 });
  });

  it("appendEntry refuses a payload of undefined (the field would vanish from the hashed JSON)", async () => {
    await expect(appendEntry([], undefined)).rejects.toThrow(TypeError);
  });

  it("guard: a custom canonicalizer is not second-guessed", async () => {
    const custom = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? `${x}n` : x));
    const chain = await appendEntry([], { n: 1n, d: new Date(0) }, custom);
    expect(await verifyChain(chain, custom)).toMatchObject(VALID_SHAPE);
  });
});

describe("verdict table: deep nesting", () => {
  function nested(levels: number): unknown {
    let value: unknown = "leaf";
    for (let i = 0; i < levels; i++) value = [value];
    return value;
  }
  function nestedObject(levels: number): unknown {
    let value: unknown = "leaf";
    for (let i = 0; i < levels; i++) value = { k: value };
    return value;
  }

  it("appendEntry with a 100,000-level payload is a clear TypeError, not a stack overflow", async () => {
    const error = await appendEntry([], nested(100_000)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/call stack/i);
    expect((error as Error).message).toMatch(/nested|depth/i);
  });

  it("verifyChain of a parsed 20,000-level payload is valid: false with a reason naming the depth", async () => {
    const chain = rt(await build([{ a: 1 }, { a: 2 }]));
    chain[1]!.payload = JSON.parse("[".repeat(20_000) + "]".repeat(20_000));
    const result = await verifyChain(chain);
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 1 });
    expect(result.reason).toMatch(/nested|depth/i);
  });

  it("verifyChain of a live 100,000-level payload is valid: false, not a RangeError", async () => {
    const chain = rt(await build([{ a: 1 }]));
    chain[0]!.payload = nestedObject(100_000);
    expect(await verifyChain(chain)).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("canonicalJSON itself throws a RangeError that names the limit, not the call stack", () => {
    expect(() => canonicalJSON(nested(100_000))).toThrow(/nested deeper than/);
  });

  it("guard: a payload 100 levels deep appends, verifies and survives a JSON round trip", async () => {
    const chain = await build([nested(100), nestedObject(100)]);
    expect(await verifyChain(chain)).toMatchObject({ valid: true, entriesChecked: 2 });
    expect(await verifyChain(rt(chain))).toMatchObject({ valid: true, entriesChecked: 2 });
  });

  it("guard: a payload at the documented limit (255 levels) works and 256 does not", async () => {
    const chain = await build([nested(255)]);
    expect(await verifyChain(rt(chain))).toMatchObject({ valid: true });
    await expect(appendEntry([], nested(256))).rejects.toThrow(TypeError);
  });
});

describe("verdict table: entriesChecked and the empty chain", () => {
  it("an empty chain says 0 entries were checked", async () => {
    expect(await verifyChain([])).toEqual({ valid: true, brokenAtIndex: null, reason: null, entriesChecked: 0 });
  });

  it("a valid chain of n entries says n", async () => {
    const chain = await build([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(await verifyChain(chain)).toEqual({ ...VALID_SHAPE, entriesChecked: 3 });
  });

  it("a failure counts only the entries verified before it", async () => {
    const chain = rt(await build([{ a: 1 }, { a: 2 }, { a: 3 }]));
    chain[2]!.payload = { a: "x" };
    expect(await verifyChain(chain)).toMatchObject({ valid: false, brokenAtIndex: 2, entriesChecked: 2 });
  });

  it("a non-array chain checked 0 entries", async () => {
    expect(await verifyChain({} as unknown as readonly ChainEntry[])).toMatchObject({ valid: false, entriesChecked: 0 });
  });

  it("an empty chain still fails expectedMinLength 1 and any anchor", async () => {
    expect(await verifyChain([], undefined, { expectedMinLength: 1 })).toMatchObject({ valid: false, entriesChecked: 0 });
    expect(await verifyChain([], undefined, { anchor: { index: 0, entryHash: "ab" } })).toMatchObject({
      valid: false,
      entriesChecked: 0,
    });
  });

  it("a length failure reports all the entries that were walked", async () => {
    const chain = await build([{ a: 1 }, { a: 2 }]);
    expect(await verifyChain(chain, undefined, { expectedMinLength: 3 })).toMatchObject({ valid: false, entriesChecked: 2 });
  });
});

describe("verdict table: visually blank characters in reason text", () => {
  async function reasonFor(formatVersion: string): Promise<string> {
    const chain = rt(await build([{ a: 1 }]));
    chain[0]!.formatVersion = formatVersion;
    return (await verifyChain(chain)).reason ?? "";
  }

  it.each([
    ["U+2800 Braille blank", "⠀", "\\u2800"],
    ["U+00A0 no-break space", " ", "\\u00a0"],
    ["U+2003 em space", " ", "\\u2003"],
    ["U+3000 ideographic space", "　", "\\u3000"],
    ["U+202F narrow no-break space", " ", "\\u202f"],
  ])("%s is written as an escape", async (_label, char, escape) => {
    const reason = await reasonFor(`v${char}1`);
    expect(reason).toContain(`"v${escape}1"`);
    expect(reason).not.toContain(char);
  });

  it("guard: an ordinary space and ordinary text are left alone", async () => {
    expect(await reasonFor("my version")).toContain('"my version"');
  });

  it("an anchor.entryHash that is only U+2800 or NBSP throws like a blank one", async () => {
    const chain = await build([{ a: 1 }]);
    for (const entryHash of ["⠀", " ⠀ "]) {
      await expect(verifyChain(chain, undefined, { anchor: { index: 0, entryHash } })).rejects.toThrow(TypeError);
    }
  });
});

describe("verdict table: guards (behavior that must not change)", () => {
  it("README test vector: the documented record string hashes to the documented entryHash", async () => {
    const record =
      '{"createdAt":"2026-01-01T00:00:00.000Z","formatVersion":"audit-chain-kit/v1","index":0,"payload":{"action":"report.created","by":"user_1"},"prevHash":"0000000000000000000000000000000000000000000000000000000000000000"}';
    const expected = "e2e95ac52a1f387f89f091b90d6a6caf1e2f68acffabe3b4243ed887acab76ca";
    expect(await sha256Hex(record)).toBe(expected);
    expect(createHash("sha256").update(record).digest("hex")).toBe(expected);
    const entry = await forgeLive({ payload: { by: "user_1", action: "report.created" } });
    expect(entry["entryHash"]).toBe(expected);
    expect(await verifyChain([entry as unknown as ChainEntry])).toMatchObject(VALID_SHAPE);
  });

  it("chains of length 1 and 2 verify live and after a JSON round trip", async () => {
    for (const n of [1, 2]) {
      const chain = await build(Array.from({ length: n }, (_v, i) => ({ n: i })));
      expect(await verifyChain(chain)).toMatchObject({ valid: true, entriesChecked: n });
      expect(await verifyChain(rt(chain))).toMatchObject({ valid: true, entriesChecked: n });
    }
  });

  it("unicode payloads verify after a JSON round trip", async () => {
    const chain = await build([{ s: "é é 日本語 \u{1f680} \ud800  " }, { "ключ": "значение" }]);
    expect(await verifyChain(rt(chain))).toMatchObject(VALID_SHAPE);
  });

  it("key order never changes the verdict", async () => {
    const chain = rt(await build([{ b: 1, a: { d: 1, c: 2 } }]));
    chain[0]!.payload = { a: { c: 2, d: 1 }, b: 1 };
    expect(await verifyChain(chain)).toMatchObject(VALID_SHAPE);
  });

  it("an anchor at every index of a valid chain passes, and a wrong hash fails at its index", async () => {
    const chain = await build([{ a: 1 }, { a: 2 }, { a: 3 }]);
    for (const entry of chain) expect(await verifyChain(rt(chain), undefined, { anchor: entry })).toMatchObject(VALID_SHAPE);
    const wrong = { index: 1, entryHash: chain[2]!.entryHash };
    expect(await verifyChain(chain, undefined, { anchor: wrong })).toMatchObject({ valid: false, brokenAtIndex: 1 });
  });

  it("truncation: expectedMinLength and anchor both catch a cut chain", async () => {
    const chain = await build([{ a: 1 }, { a: 2 }, { a: 3 }]);
    const cut = chain.slice(0, 2);
    expect(await verifyChain(cut, undefined, { expectedMinLength: 3 })).toMatchObject({ valid: false, brokenAtIndex: null });
    expect(await verifyChain(cut, undefined, { anchor: chain[2]! })).toMatchObject({ valid: false, brokenAtIndex: null });
    expect(await verifyChain(cut)).toMatchObject(VALID_SHAPE);
  });

  it("a rewrite is caught by the anchor and missed without it (documented)", async () => {
    const original = await build([{ a: 1 }, { a: 2 }]);
    const rewritten = await build([{ a: 1 }, { a: "X" }]);
    expect(await verifyChain(rewritten)).toMatchObject(VALID_SHAPE);
    expect(await verifyChain(rewritten, undefined, { anchor: original[1]! })).toMatchObject({ valid: false, brokenAtIndex: 1 });
  });

  it("an edited field, a deleted middle entry, a duplicate and a swap are each detected", async () => {
    const chain = await build([{ a: 1 }, { a: 2 }, { a: 3 }]);
    const edited = rt(chain);
    edited[1]!.payload = { a: 99 };
    expect(await verifyChain(edited)).toMatchObject({ valid: false, brokenAtIndex: 1 });
    expect(await verifyChain([chain[0]!, chain[2]!])).toMatchObject({ valid: false, brokenAtIndex: 1 });
    expect(await verifyChain([chain[0]!, chain[1]!, chain[1]!])).toMatchObject({ valid: false, brokenAtIndex: 2 });
    expect(await verifyChain([chain[0]!, chain[2]!, chain[1]!])).toMatchObject({ valid: false, brokenAtIndex: 1 });
  });

  it("a missing or wrong formatVersion, a changed prevHash and a changed index are each detected", async () => {
    const chain = await build([{ a: 1 }, { a: 2 }]);
    const noVersion = rt(chain) as unknown as Record<string, unknown>[];
    delete noVersion[0]!["formatVersion"];
    expect(await verifyChain(noVersion as unknown as ChainEntry[])).toMatchObject({ valid: false, brokenAtIndex: 0 });
    const prev = rt(chain);
    prev[1]!.prevHash = "f".repeat(64);
    expect(await verifyChain(prev)).toMatchObject({ valid: false, brokenAtIndex: 1 });
    const idx = rt(chain);
    idx[1]!.index = 5;
    expect(await verifyChain(idx)).toMatchObject({ valid: false, brokenAtIndex: 1 });
  });

  it("an extra field added to a stored entry is detected", async () => {
    const chain = rt(await build([{ a: 1 }])) as unknown as Record<string, unknown>[];
    chain[0]!["extra"] = 1;
    expect(await verifyChain(chain as unknown as ChainEntry[])).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("a custom hasher works in both directions and a mismatched one fails", async () => {
    const fake = (s: string): Promise<string> => Promise.resolve(createHash("sha512").update(s).digest("hex"));
    const chain = await appendEntry([], { a: 1 }, canonicalJSON, fake);
    expect(await verifyChain(chain, undefined, { hash: fake })).toMatchObject(VALID_SHAPE);
    expect(await verifyChain(chain)).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("malformed chains and options still fail closed or throw as before", async () => {
    expect(await verifyChain(null as unknown as readonly ChainEntry[])).toMatchObject({ valid: false, brokenAtIndex: null });
    expect(await verifyChain([null as unknown as ChainEntry])).toMatchObject({ valid: false, brokenAtIndex: 0 });
    await expect(verifyChain([], undefined, [] as unknown as VerifyOptions)).rejects.toThrow(TypeError);
    await expect(verifyChain([], undefined, { expectedMinLength: -1 })).rejects.toThrow(TypeError);
  });

  it("appendEntry output is frozen, linked and unchanged in shape", async () => {
    const chain = await build([{ a: 1 }, { a: 2 }]);
    expect(Object.isFrozen(chain)).toBe(true);
    expect(Object.isFrozen(chain[1])).toBe(true);
    expect(chain[1]!.prevHash).toBe(chain[0]!.entryHash);
    expect(Object.keys(chain[1]!).sort()).toEqual(["createdAt", "entryHash", "formatVersion", "index", "payload", "prevHash"]);
  });
});

describe("verdict table: entries loaded as class instances", () => {
  class Row {
    constructor(fields: object) {
      Object.assign(this, fields);
    }
    describe(): string {
      return "a method on the prototype";
    }
  }

  it("guard: a class-instance entry with plain own fields verifies (the hash covers a copy of the own fields)", async () => {
    const chain = await build([{ a: 1 }, { a: 2 }]);
    const rows = chain.map((entry) => new Row(entry) as unknown as ChainEntry);
    expect(await verifyChain(rows)).toMatchObject({ valid: true, entriesChecked: 2 });
  });

  it("a class-instance entry with an own non-JSON field is still valid: false", async () => {
    const entry = (await build([{ a: 1 }]))[0]!;
    const row = new Row({ ...entry, loadedAt: new Date(0) }) as unknown as ChainEntry;
    expect(await verifyChain([row])).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("a payload that is a class instance is still refused", async () => {
    await expect(appendEntry([], new Row({ a: 1 }))).rejects.toThrow(TypeError);
  });
});

describe("verdict table: probes added after trying to break the fixes", () => {
  function nested(levels: number): unknown {
    let value: unknown = "leaf";
    for (let i = 0; i < levels; i++) value = [value];
    return value;
  }

  it("canonicalJSON accepts exactly 256 levels and refuses 257 with a clear RangeError", () => {
    expect(() => canonicalJSON(nested(256))).not.toThrow();
    expect(() => canonicalJSON(nested(257))).toThrow(RangeError);
    expect(() => canonicalJSON(nested(257))).toThrow(/nested deeper than 256 levels/);
  });

  it("a wrapped canonicalJSON still gets a verdict for a deep stored chain, not a thrown RangeError", async () => {
    const chain = rt(await build([{ a: 1 }]));
    chain[0]!.payload = JSON.parse("[".repeat(5000) + "]".repeat(5000));
    const wrapped = (value: unknown): string => canonicalJSON(value);
    expect(await verifyChain(chain, wrapped)).toMatchObject({ valid: false, brokenAtIndex: 0, entriesChecked: 0 });
  });

  it("a stored 1e999 where null was hashed is valid: false (it parses to Infinity)", async () => {
    const chain = await build([{ n: null }]);
    const edited = JSON.parse(JSON.stringify(chain).replace('"n":null', '"n":1e999')) as ChainEntry[];
    expect(await verifyChain(edited)).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("reason text escapes a hostile key in the path", async () => {
    const entry = (await forgeLive({ payload: { ["bad⠀‮key"]: new Date(0) } })) as unknown as ChainEntry;
    const reason = (await verifyChain([entry])).reason ?? "";
    expect(reason).toContain('["bad\\u2800\\u202ekey"]');
    expect(reason).not.toMatch(/[⠀‮]/);
  });

  it("a hash mismatch is reported before a JSON-faithfulness problem on the same entry", async () => {
    const chain = await build([{ a: 1 }]);
    const edited = { ...chain[0]!, payload: { a: 2, extra: undefined } } as unknown as ChainEntry;
    const result = await verifyChain([edited]);
    expect(result.reason).toMatch(/does not match its entryHash/);
  });

  it("shared references that are not cycles are accepted", async () => {
    const shared = { x: 1 };
    const chain = await build([{ a: shared, b: shared, c: [shared, shared] }]);
    expect(await verifyChain(rt(chain))).toMatchObject({ valid: true, entriesChecked: 1 });
  });

  it("a stored -0 where 0 was hashed still verifies (documented: verification is over parsed values)", async () => {
    const chain = await build([{ n: 0 }]);
    const edited = JSON.parse(JSON.stringify(chain).replace('"n":0', '"n":-0')) as ChainEntry[];
    expect(await verifyChain(edited)).toMatchObject(VALID_SHAPE);
  });

  it("a stored duplicate key (last one wins) still verifies (documented)", async () => {
    const chain = await build([{ by: "user_1" }]);
    const text = JSON.stringify(chain).replace('"payload":{"by":"user_1"}', '"payload":{"by":"user_2","by":"user_1"}');
    expect(await verifyChain(JSON.parse(text) as ChainEntry[])).toMatchObject(VALID_SHAPE);
  });

  it("a stored integer past 2^53 is read back rounded, so a different literal verifies (documented)", async () => {
    const chain = await build([{ n: Number("9007199254740993") }]);
    const text = JSON.stringify(chain);
    expect(text).toContain("9007199254740992");
    expect(await verifyChain(JSON.parse(text.replace("9007199254740992", "9007199254740993")) as ChainEntry[])).toMatchObject(
      VALID_SHAPE,
    );
  });
});

describe("verdict table: review round (inherited hooks, serialization throws, [[Get]] during inspection)", () => {
  async function liveEntry(payload: unknown): Promise<ChainEntry> {
    // Hash the JSON form with a lenient serializer, as an older version would have.
    return (await forgeLive({ payload })) as unknown as ChainEntry;
  }
  const hook = (): unknown => ({ a: 1 });

  it("a payload whose null-prototype parent carries toJSON is refused by appendEntry", async () => {
    const parent = Object.assign(Object.create(null) as object, { toJSON: hook });
    await expect(appendEntry([], Object.setPrototypeOf({ a: 2 }, parent))).rejects.toThrow(TypeError);
  });

  it("changing a field that an inherited toJSON hides is valid: false, even with the original anchor", async () => {
    const parent = Object.assign(Object.create(null) as object, { toJSON: hook });
    const payload = Object.setPrototypeOf({ a: 2 }, parent) as { a: number };
    const entry = await liveEntry(payload);
    const anchor = { index: 0, entryHash: entry.entryHash };
    payload.a = 3;
    expect(await verifyChain([entry], undefined, { anchor })).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("a payload with a two-level prototype chain is refused even without a hook", async () => {
    const parent = Object.create(Object.create(null) as object) as object;
    await expect(appendEntry([], Object.setPrototypeOf({ a: 1 }, parent))).rejects.toThrow(TypeError);
  });

  it("a root class-instance entry whose prototype chain defines toJSON is valid: false", async () => {
    class Row {
      toJSON(): unknown {
        return { hidden: true };
      }
    }
    const entry = (await build([{ a: 1 }]))[0]!;
    const row = Object.assign(new Row(), entry) as unknown as ChainEntry;
    expect(await verifyChain([row])).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("an array whose toJSON is a getter is refused without the getter running", async () => {
    let reads = 0;
    const array = Object.defineProperty([1, 2], "toJSON", {
      get: () => (reads++, undefined),
      enumerable: false,
    });
    await expect(appendEntry([], array)).rejects.toThrow(TypeError);
    expect(reads).toBe(0);
  });

  it("an array whose prototype defines a toJSON getter is refused without the getter running", async () => {
    let reads = 0;
    class Hooked extends Array<number> {
      get toJSON(): undefined {
        reads++;
        return undefined;
      }
    }
    await expect(appendEntry([], Hooked.from([1, 2]))).rejects.toThrow(TypeError);
    expect(reads).toBe(0);
  });

  it("inspecting an array behind a Proxy never uses [[Get]]", async () => {
    const gets: (string | symbol)[] = [];
    const proxy = new Proxy(Object.assign([1, 2], { note: "extra" }), {
      get(target, key, receiver): unknown {
        gets.push(key);
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    await expect(appendEntry([], proxy)).rejects.toThrow(TypeError);
    expect(gets).toEqual([]);
  });

  it("{ first: undefined, later: 1n } in a live entry is valid: false, not a thrown TypeError", async () => {
    const lenient = (value: unknown): string => JSON.stringify(value, (_k, x: unknown) => (typeof x === "bigint" ? `${x}n` : x));
    const record = { formatVersion: FORMAT_VERSION, index: 0, payload: { first: undefined, later: 1n }, prevHash: GENESIS_HASH, createdAt: CREATED_AT };
    const entry = { ...record, entryHash: await sha256Hex(lenient(record)) } as unknown as ChainEntry;
    expect(await verifyChain([entry])).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("a nested throwing getter is valid: false, not a thrown error", async () => {
    const payload = Object.defineProperty({}, "x", {
      enumerable: true,
      get(): never {
        throw new Error("boom");
      },
    });
    const entry = { ...(await liveEntry({})), payload } as ChainEntry;
    expect(await verifyChain([entry])).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("a nested revoked proxy is valid: false, not a thrown error", async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const entry = { ...(await liveEntry({})), payload: { p: proxy } } as ChainEntry;
    expect(await verifyChain([entry])).toMatchObject({ valid: false, brokenAtIndex: 0 });
  });

  it("an error thrown by a CUSTOM canonicalizer still propagates", async () => {
    const chain = await build([{ a: 1 }]);
    const failing = (): string => {
      throw new RangeError("custom canonicalizer failed");
    };
    await expect(verifyChain(chain, failing)).rejects.toThrow("custom canonicalizer failed");
  });

  it("entry fields that are getters are not invoked by verifyChain", async () => {
    const chain = await build([{ a: 1 }]);
    let reads = 0;
    const live = { ...chain[0]! } as Record<string, unknown>;
    const payload = live["payload"];
    delete live["payload"];
    Object.defineProperty(live, "payload", { enumerable: true, get: () => (reads++, payload) });
    expect(await verifyChain([live as unknown as ChainEntry])).toMatchObject({ valid: false, brokenAtIndex: 0 });
    expect(reads).toBe(0);
  });

  it.each([
    ["a Number with its prototype removed", () => Object.setPrototypeOf(new Number(5), null) as object],
    ["a String with its prototype removed", () => Object.setPrototypeOf(new String("ab"), null) as object],
    ["a Date with its prototype removed", () => Object.setPrototypeOf(new Date(0), null) as object],
    ["a Map with its prototype removed", () => Object.setPrototypeOf(new Map([["a", 1]]), null) as object],
    ["a Set with its prototype removed", () => Object.setPrototypeOf(new Set([1]), null) as object],
    ["a RegExp with its prototype removed", () => Object.setPrototypeOf(/a/, null) as object],
    ["a Uint8Array with its prototype removed", () => Object.setPrototypeOf(new Uint8Array(2), null) as object],
  ])("%s is refused: its internal data is not in the JSON form", async (_label, make) => {
    await expect(appendEntry([], make())).rejects.toThrow(TypeError);
  });

  it("a boxed Number with an own valueOf is refused without running it", async () => {
    let calls = 0;
    const boxed = Object.assign(new Number(1), { valueOf: () => (calls++, 2) });
    await expect(appendEntry([], boxed)).rejects.toThrow(TypeError);
    expect(calls).toBe(0);
  });

  it("guard: an Object.prototype-like parent from another realm is still accepted", async () => {
    const { runInNewContext } = await import("node:vm");
    const foreign = runInNewContext("({ a: 1, b: [1, { c: 2 }] })") as unknown;
    const chain = await build([foreign]);
    expect(await verifyChain(rt(chain))).toMatchObject({ valid: true, entriesChecked: 1 });
    expect(await verifyChain(chain)).toMatchObject({ valid: true, entriesChecked: 1 });
  });
});

describe("verdict table: second review round (cost on the common path, bounded paths)", () => {
  const cpuMs = async (work: () => Promise<unknown>): Promise<number> => {
    const before = process.cpuUsage();
    await work();
    const used = process.cpuUsage(before);
    return (used.user + used.system) / 1000;
  };

  it("verifying 2,000 small entries with the inspection costs about as much as without it", async () => {
    const chain: ChainEntry[] = [];
    let prevHash = GENESIS_HASH;
    for (let index = 0; index < 2000; index++) {
      const record = { formatVersion: FORMAT_VERSION, index, payload: { n: index, tags: ["a", { b: null }], s: "x", e: {} }, prevHash, createdAt: CREATED_AT };
      const entryHash = createHash("sha256").update(canonicalJSON(record)).digest("hex");
      chain.push({ ...record, entryHash });
      prevHash = entryHash;
    }
    // A wrapper is a custom canonicalizer, so it skips the inspection: same hashing and serializing work.
    const uninspected = (value: unknown): string => canonicalJSON(value);
    const best = async (canonicalize?: (value: unknown) => string): Promise<number> => {
      let fastest = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 7; run++) {
        fastest = Math.min(
          fastest,
          await cpuMs(async () => {
            expect((await verifyChain(chain, canonicalize)).valid).toBe(true);
          }),
        );
      }
      return fastest;
    };
    await best(uninspected); // warm up
    const without = await best(uninspected);
    const withInspection = await best();
    // Relative, not absolute, so a loaded machine does not make it flaky. The brand probing in the
    // previous revision made this ratio about 13, so 3 leaves room for noise and still catches it.
    expect(withInspection).toBeLessThan(without * 3 + 20);
  }, 120_000);

  it("a payload key of 100,000 characters does not put the whole key in the reason (verify)", async () => {
    const key = "a".repeat(100_000);
    const entry = (await forgeLive({ payload: { [key]: new Date(0) } })) as unknown as ChainEntry;
    const reason = (await verifyChain([entry])).reason ?? "";
    expect(reason).toMatch(/^entry 0 is not plain JSON data/);
    expect(reason.length).toBeLessThan(600);
  });

  it("a payload key of 100,000 characters does not put the whole key in the error (append)", async () => {
    const key = "a".repeat(100_000);
    const error = await appendEntry([], { [key]: new Date(0) }).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message.length).toBeLessThan(600);
  });

  it("a deep path of long keys stays bounded", async () => {
    let payload: unknown = new Date(0);
    for (let i = 0; i < 100; i++) payload = { [`k${i}`.padEnd(70, "x")]: payload };
    const entry = (await forgeLive({ payload })) as unknown as ChainEntry;
    const reason = (await verifyChain([entry])).reason ?? "";
    expect(reason.length).toBeLessThan(600);
    await expect(appendEntry([], payload)).rejects.toSatisfy((e: Error) => e.message.length < 600);
  });

  it("guard: a short path is still spelled out in full", async () => {
    const entry = (await forgeLive({ payload: { meta: { list: [1, new Date(0)] } } })) as unknown as ChainEntry;
    expect((await verifyChain([entry])).reason).toContain("payload.meta.list[1]");
  });

  it("guard: a Date whose prototype was set to Object.prototype is still refused", async () => {
    await expect(appendEntry([], Object.setPrototypeOf(new Date(0), Object.prototype))).rejects.toThrow(TypeError);
  });

  it("guard: boxed values and typed arrays with Object.prototype as prototype are still refused", async () => {
    for (const exotic of [new Number(1), new String("a"), new Boolean(true), new Uint8Array(1), /a/, new DataView(new ArrayBuffer(1))]) {
      await expect(appendEntry([], Object.setPrototypeOf(exotic, Object.prototype))).rejects.toThrow(TypeError);
    }
  });
});

describe("verdict table: memory does not grow with width (child process, 128 MB heap)", () => {
  /** Compiles src/ to a temp folder and runs `script` there under a capped heap, so a heap blow-up kills the child, not the test run. */
  function runCapped(script: string): { status: number | null; stdout: string; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), "audit-chain-kit-heap-"));
    try {
      const sourceDir = fileURLToPath(new URL("../src/", import.meta.url));
      for (const name of readdirSync(sourceDir).filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))) {
        const output = ts.transpileModule(readFileSync(join(sourceDir, name), "utf8"), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        });
        writeFileSync(join(dir, name.replace(/\.ts$/, ".js")), output.outputText);
      }
      writeFileSync(join(dir, "package.json"), '{"type":"module"}');
      writeFileSync(join(dir, "run.mjs"), script);
      const result = spawnSync(process.execPath, ["--max-old-space-size=128", "run.mjs"], { cwd: dir, encoding: "utf8", timeout: 100_000 });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.each([
    ["canonicalJSON", 'import { canonicalJSON } from "./index.js"; console.log(canonicalJSON(Array(1_500_000).fill(0)).length);', "3000001"],
    [
      "appendEntry",
      'import { appendEntry } from "./index.js"; const c = await appendEntry([], Array(1_500_000).fill(0)); console.log(c.length);',
      "1",
    ],
    [
      "verifyChain",
      'import { appendEntry, verifyChain } from "./index.js"; const c = await appendEntry([], Array(1_500_000).fill(0)); console.log((await verifyChain(JSON.parse(JSON.stringify(c)))).valid);',
      "true",
    ],
  ])("%s handles a 1,500,000-element array", (_name, script, expected) => {
    const result = runCapped(script);
    expect(result.stderr).not.toMatch(/heap out of memory/i);
    expect(result.stdout.trim()).toBe(expected);
    expect(result.status).toBe(0);
  }, 120_000);
});

describe("verdict table: arrays above the large-array threshold are still checked", () => {
  const big = (): number[] => Array.from({ length: 60_000 }, (_v, i) => i);

  it("accepts a dense 60,000-element array", async () => {
    expect(await verifyChain(await build([big()]))).toMatchObject({ valid: true, entriesChecked: 1 });
  });

  it.each([
    ["an extra enumerable property", () => Object.assign(big(), { note: "x" })],
    ["a symbol-keyed property", () => Object.assign(big(), { [Symbol("s")]: 1 })],
    ["a hole", () => { const a = big(); Reflect.deleteProperty(a, 30_000); return a; }],
    ["an accessor element", () => Object.defineProperty(big(), 5, { get: () => 5, enumerable: true })],
  ])("refuses %s", async (_label, make) => {
    await expect(appendEntry([], make())).rejects.toThrow(TypeError);
  });
});
