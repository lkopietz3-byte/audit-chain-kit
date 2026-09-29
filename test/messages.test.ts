// ACK-002 and the class 3, 7, 8, 9 findings: error and reason text must never
// throw, must not carry raw control or bidi characters, and callbacks must
// return the documented type.
import { describe, expect, it, vi } from "vitest";
import { appendEntry, canonicalJSON, FORMAT_VERSION, GENESIS_HASH, sha256Hex, verifyChain } from "../src/index.js";
import type { Canonicalizer, ChainEntry, Hasher, VerifyOptions } from "../src/index.js";

type Note = { n: number | string };

const AT = "2026-01-01T00:00:00.000Z";

async function forge(fields: Record<string, unknown>, canonicalize: Canonicalizer = canonicalJSON): Promise<ChainEntry<Note>> {
  const record = { formatVersion: FORMAT_VERSION, index: 0, payload: { n: 0 }, prevHash: GENESIS_HASH, createdAt: AT, ...fields };
  return { ...record, entryHash: await sha256Hex(canonicalize(record)) };
}

/** A canonicalizer that accepts BigInt (written as "1n"); the default one throws on it, as documented. */
const bigintSafeJson: Canonicalizer = (value) =>
  JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? `${item}n` : item));

async function tail(): Promise<ChainEntry<Note>> {
  return (await appendEntry<Note>([], { n: 0 }))[0]!;
}

/** Characters that must never appear raw in a reason string. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

describe("verifyChain: a malformed formatVersion is reported, not thrown (ACK-002 / REG-01..03)", () => {
  it("REG-01: a BigInt formatVersion is an invalid entry with a reason naming formatVersion", async () => {
    const entry = await forge({ formatVersion: 1n }, bigintSafeJson);
    const result = await verifyChain([entry]);
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 0 });
    expect(result.reason).toBe(`entry 0 has formatVersion 1n; this verifier requires "${FORMAT_VERSION}"`);
  });

  it("REG-02: a cyclic formatVersion is an invalid entry", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const entry = { ...(await tail()), formatVersion: cyclic } as unknown as ChainEntry<Note>;
    const result = await verifyChain([entry]);
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 0 });
    expect(result.reason).toBe(`entry 0 has formatVersion an object; this verifier requires "${FORMAT_VERSION}"`);
  });

  it("REG-03: a formatVersion with a throwing toJSON is never serialized or called", async () => {
    const toJSON = vi.fn(() => {
      throw new Error("toJSON must not run");
    });
    const toString = vi.fn(() => {
      throw new Error("toString must not run");
    });
    const entry = { ...(await tail()), formatVersion: { toJSON, toString } } as unknown as ChainEntry<Note>;
    const result = await verifyChain([entry]);
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 0 });
    expect(result.reason).toMatch(/formatVersion an object/);
    expect(toJSON).not.toHaveBeenCalled();
    expect(toString).not.toHaveBeenCalled();
  });

  it("rejects before hashing: neither the canonicalizer nor the hasher runs for a bad version", async () => {
    const entry = { ...(await tail()), formatVersion: 1n } as unknown as ChainEntry<Note>;
    const canonicalize = vi.fn(canonicalJSON);
    const hash = vi.fn(sha256Hex);
    const result = await verifyChain([entry], canonicalize, { hash });
    expect(result.valid).toBe(false);
    expect(canonicalize).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
  });

  it.each([
    ["a number", 5, "5"],
    ["a boolean", true, "true"],
    ["null", null, "null"],
    ["a symbol", Symbol("x"), "a symbol"],
    ["a function", () => 1, "a function"],
    ["an array", ["a"], "an object"],
    ["an object with no prototype", Object.create(null) as unknown, "an object"],
    ["a string", "audit-chain-kit/v2", '"audit-chain-kit/v2"'],
  ])("describes %s safely", async (_label, formatVersion, shown) => {
    const entry = { ...(await tail()), formatVersion } as unknown as ChainEntry<Note>;
    const result = await verifyChain([entry]);
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 0 });
    expect(result.reason).toBe(`entry 0 has formatVersion ${shown}; this verifier requires "${FORMAT_VERSION}"`);
  });

  it("does not run a revoked proxy's traps when describing it", async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const entry = { ...(await tail()), formatVersion: proxy } as unknown as ChainEntry<Note>;
    const result = await verifyChain([entry]);
    expect(result.reason).toMatch(/formatVersion an object/);
  });
});

describe("verifyChain: reasons built from caller strings are escaped (class 8)", () => {
  const hostile = "v1\u001b[31m\nFORGED: entry 9 is fine\r‮⁦؜​\u0085\u009b ﻿ㅤ️\u007f";

  it("escapes control, bidi, format and line-separator characters in a string formatVersion", async () => {
    const entry = { ...(await tail()), formatVersion: hostile } as unknown as ChainEntry<Note>;
    const result = await verifyChain([entry]);
    expect(result.valid).toBe(false);
    expect(result.reason).not.toMatch(UNSAFE);
    expect(result.reason).toContain("\\u001b[31m");
    expect(result.reason).toContain("\\n");
    expect(result.reason).toContain("\\u202e");
    expect(result.reason).toContain("\\u2066");
    expect(result.reason).toContain("\\u009b");
    expect(result.reason).toContain("\\u3164");
    expect(result.reason).toContain("\\ufe0f");
  });

  it("escapes characters outside the BMP as \\u{...}", async () => {
    const entry = { ...(await tail()), formatVersion: "x\u{E0041}" } as unknown as ChainEntry<Note>;
    const result = await verifyChain([entry]);
    expect(result.reason).not.toMatch(UNSAFE);
    expect(result.reason).toContain("x\\u{e0041}");
  });

  it("keeps ordinary non-ASCII text readable", async () => {
    const entry = { ...(await tail()), formatVersion: "日本語 é" } as unknown as ChainEntry<Note>;
    expect((await verifyChain([entry])).reason).toContain('"日本語 é"');
  });

  it("escapes a string index in the index-mismatch reason", async () => {
    const entry = await forge({ index: "0‮\n" });
    const result = await verifyChain([entry]);
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 0 });
    expect(result.reason).not.toMatch(UNSAFE);
    expect(result.reason).toContain('"0\\u202e\\n"');
  });

  it("truncates a long string and says how long it was", async () => {
    const entry = { ...(await tail()), formatVersion: "a".repeat(5000) } as unknown as ChainEntry<Note>;
    const result = await verifyChain([entry]);
    expect(result.reason!.length).toBeLessThan(250);
    expect(result.reason).toContain("(5000 characters)");
  });

  it("does not truncate a string at the limit", async () => {
    const at = "b".repeat(80);
    const entry = { ...(await tail()), formatVersion: at } as unknown as ChainEntry<Note>;
    const result = await verifyChain([entry]);
    expect(result.reason).toContain(`"${at}"`);
    expect(result.reason).not.toContain("characters)");
  });
});

describe("verifyChain: index descriptions cannot throw (class 3)", () => {
  it("reports a BigInt index produced by a custom canonicalizer", async () => {
    const entry = await forge({ index: 1n }, bigintSafeJson);
    const result = await verifyChain([entry], bigintSafeJson);
    expect(result).toMatchObject({ valid: false, brokenAtIndex: 0 });
    expect(result.reason).toBe("entry 0 has index 1n; expected 0");
  });

  it("reports a missing index as undefined", async () => {
    const entry = await forge({ index: undefined });
    expect((await verifyChain([entry])).reason).toBe("entry 0 has index undefined; expected 0");
  });

  it("reports a number index", async () => {
    const entry = await forge({ index: 5 });
    expect((await verifyChain([entry])).reason).toBe("entry 0 has index 5; expected 0");
  });
});

describe("appendEntry: error text cannot throw (class 3, class 8)", () => {
  it("a last entry whose index is a null-prototype object is a RangeError, not a conversion error", async () => {
    const last = { ...(await tail()), index: Object.create(null) as unknown } as unknown as ChainEntry<Note>;
    const error = await appendEntry([last], { n: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toMatch(/has index an object but sits at position 0/);
  });

  it("escapes a string index", async () => {
    const last = { ...(await tail()), index: "0‮\u001b" } as unknown as ChainEntry<Note>;
    const error = (await appendEntry([last], { n: 1 }).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).not.toMatch(UNSAFE);
    expect(error.message).toContain('"0\\u202e\\u001b"');
  });

  it("a BigInt index is described, not thrown on", async () => {
    const last = { ...(await tail()), index: 7n } as unknown as ChainEntry<Note>;
    const error = (await appendEntry([last], { n: 1 }).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toContain("has index 7n but sits at position 0");
  });
});

describe("option errors describe bad values safely (class 3)", () => {
  it.each([
    ["a null-prototype object", Object.create(null) as unknown, "an object"],
    ["a BigInt", 3n, "3n"],
    ["a symbol", Symbol("s"), "a symbol"],
    ["NaN", Number.NaN, "NaN"],
    ["a string", "3", '"3"'],
  ])("expectedMinLength as %s throws a TypeError naming the value", async (_label, bad, shown) => {
    const options = { expectedMinLength: bad } as unknown as VerifyOptions;
    await expect(verifyChain([], undefined, options)).rejects.toThrow(
      new TypeError(`verifyChain: expectedMinLength must be a non-negative integer, got ${shown}`),
    );
  });
});

describe("verifyChain: a blank anchor hash is a caller bug (class 7)", () => {
  it.each([
    ["spaces", "   "],
    ["a tab and newline", "\t\n"],
    ["a zero-width space", "​"],
    ["bidi isolates", "⁦⁩"],
    ["an Arabic letter mark", "؜"],
    ["a byte order mark", "﻿"],
    ["a Hangul filler", "ㅤ"],
    ["a variation selector", "️"],
    ["mixed whitespace and invisibles", " ​⁧ "],
  ])("throws a TypeError for an entryHash of %s", async (_label, entryHash) => {
    const options = { anchor: { index: 0, entryHash } } as VerifyOptions;
    await expect(verifyChain([], undefined, options)).rejects.toThrow(TypeError);
  });

  it("still accepts a visible hash, including one with non-hex characters (custom hashers)", async () => {
    const entry = await tail();
    const options = { anchor: { index: 0, entryHash: entry.entryHash } } satisfies VerifyOptions;
    expect(await verifyChain([entry], undefined, options)).toEqual({ valid: true, brokenAtIndex: null, reason: null });
    await expect(verifyChain([], undefined, { anchor: { index: 0, entryHash: " x " } })).resolves.toMatchObject({
      valid: false,
    });
  });
});

describe("verifyChain and appendEntry: argument shapes (class 6, class 9)", () => {
  it.each([
    ["null", null],
    ["an array", []],
    ["a Map", new Map()],
    ["a Date", new Date(0)],
    ["a string", "anchor"],
    ["a number", 3],
    ["a function", () => undefined],
  ])("verifyChain rejects options that are %s instead of ignoring them", async (_label, options) => {
    await expect(verifyChain([], undefined, options as unknown as VerifyOptions)).rejects.toThrow(
      /verifyChain: options must be a plain object/,
    );
  });

  it("verifyChain accepts undefined, plain and null-prototype options", async () => {
    expect((await verifyChain([], undefined, undefined)).valid).toBe(true);
    expect((await verifyChain([], undefined, {})).valid).toBe(true);
    expect((await verifyChain([], undefined, Object.assign(Object.create(null) as object, { expectedMinLength: 0 }))).valid).toBe(
      true,
    );
  });

  it("verifyChain rejects an unknown option key instead of silently skipping a check (for example an anchor passed as options)", async () => {
    const entry = await tail();
    // A common mistake: passing the anchor itself where the options object belongs.
    await expect(verifyChain([entry], undefined, { index: 0, entryHash: "x" } as unknown as VerifyOptions)).rejects.toThrow(
      'verifyChain: unknown option "index"; the options are expectedMinLength, anchor and hash',
    );
    // A typo would otherwise disable the anchor check and report valid.
    await expect(verifyChain([entry], undefined, { anhcor: entry } as unknown as VerifyOptions)).rejects.toThrow(/unknown option "anhcor"/);
    await expect(verifyChain([entry], undefined, { ["a\u202e\n"]: 1 } as unknown as VerifyOptions)).rejects.toThrow(
      /unknown option "a\\u202e\\n"/,
    );
  });

  it("verifyChain accepts every documented option key together", async () => {
    const entry = await tail();
    const options = { expectedMinLength: 1, anchor: entry, hash: sha256Hex } satisfies VerifyOptions;
    expect(await verifyChain([entry], canonicalJSON, options)).toEqual({ valid: true, brokenAtIndex: null, reason: null });
  });

  it.each([
    ["hash: null", { hash: null }],
    ["hash: a string", { hash: "sha256" }],
  ])("verifyChain rejects %s", async (_label, options) => {
    await expect(verifyChain([], undefined, options as unknown as VerifyOptions)).rejects.toThrow(
      /verifyChain: options.hash must be a function/,
    );
  });

  it("verifyChain rejects a non-function canonicalize, even for an empty chain", async () => {
    await expect(verifyChain([], null as unknown as Canonicalizer)).rejects.toThrow(/verifyChain: canonicalize must be a function/);
    await expect(verifyChain([], "x" as unknown as Canonicalizer)).rejects.toThrow(TypeError);
  });

  it("appendEntry rejects a non-function canonicalize or hash", async () => {
    await expect(appendEntry([], { n: 1 }, null as unknown as Canonicalizer)).rejects.toThrow(
      /appendEntry: canonicalize must be a function/,
    );
    await expect(appendEntry([], { n: 1 }, canonicalJSON, null as unknown as Hasher)).rejects.toThrow(
      /appendEntry: hash must be a function/,
    );
  });

  it("verifyChain treats an explicit undefined canonicalize and hash as the defaults", async () => {
    const entry = await tail();
    expect((await verifyChain([entry], undefined, { hash: undefined } as unknown as VerifyOptions)).valid).toBe(true);
  });

  it("appendEntry treats explicit undefined canonicalize and hash as the defaults", async () => {
    expect(await appendEntry([], { n: 1 }, undefined, undefined)).toHaveLength(1);
  });
});

describe("callbacks must return the documented type (class 9)", () => {
  it("verifyChain: a hasher that resolves to a non-string is a TypeError, not 'tampering'", async () => {
    const entry = await tail();
    const hash = (async () => undefined) as unknown as Hasher;
    await expect(verifyChain([entry], undefined, { hash })).rejects.toThrow(
      /verifyChain: hash must resolve to a string, got undefined \(entry 0\)/,
    );
  });

  it("verifyChain: a canonicalizer that returns a Promise is a TypeError that says it must be synchronous", async () => {
    const entry = await tail();
    const canonicalize = (async (v: unknown) => canonicalJSON(v)) as unknown as Canonicalizer;
    await expect(verifyChain([entry], canonicalize)).rejects.toThrow(
      /verifyChain: canonicalize must return a string \(synchronously\), got an object \(entry 0\)/,
    );
  });

  it("appendEntry: a hasher that resolves to a non-string is a TypeError and nothing is returned", async () => {
    const hash = (async () => 42) as unknown as Hasher;
    await expect(appendEntry([], { n: 1 }, canonicalJSON, hash)).rejects.toThrow(
      /appendEntry: hash must resolve to a string, got 42/,
    );
  });

  it("appendEntry: a canonicalizer that returns a non-string is a TypeError", async () => {
    const canonicalize = (() => ({ not: "a string" })) as unknown as Canonicalizer;
    await expect(appendEntry([], { n: 1 }, canonicalize)).rejects.toThrow(
      /appendEntry: canonicalize must return a string \(synchronously\), got an object/,
    );
  });

  it("errors thrown by the callbacks themselves still propagate unchanged", async () => {
    const boom = new Error("boom");
    const entry = await tail();
    await expect(verifyChain([entry], () => { throw boom; })).rejects.toBe(boom);
    await expect(verifyChain([entry], undefined, { hash: () => Promise.reject(boom) })).rejects.toBe(boom);
    await expect(appendEntry([], { n: 1 }, () => { throw boom; })).rejects.toBe(boom);
    await expect(appendEntry([], { n: 1 }, canonicalJSON, () => Promise.reject(boom))).rejects.toBe(boom);
  });
});
