import { describe, expect, it } from "vitest";
import { canonicalJSON } from "../src/index.js";

/** What a chain looks like after being stored as JSON and read back. */
const jsonRoundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("canonicalJSON: format", () => {
  it("sorts keys at every level and emits no whitespace", () => {
    expect(canonicalJSON({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("gives the same string regardless of key insertion order", () => {
    expect(canonicalJSON({ a: 1, b: { x: 1, y: 2 } })).toBe(canonicalJSON({ b: { y: 2, x: 1 }, a: 1 }));
  });

  it("sorts integer-like keys as strings, not numerically", () => {
    // JS objects enumerate integer-like keys first, in numeric order; the
    // canonical form must not inherit that engine ordering.
    expect(canonicalJSON({ 9: "nine", 10: "ten", a: 1 })).toBe('{"10":"ten","9":"nine","a":1}');
  });

  it("sorts keys by UTF-16 code units (an astral key sorts before U+FFFF)", () => {
    expect(canonicalJSON({ "￿": 1, "\u{10000}": 2 })).toBe('{"\u{10000}":2,"￿":1}');
  });

  it("keeps array order", () => {
    expect(canonicalJSON([3, 1, 2])).toBe("[3,1,2]");
  });

  it("formats numbers and strings exactly as JSON.stringify does", () => {
    expect(canonicalJSON([1, 2.5, -0, 1e21, 1e-7, "ü日本🚀", 'line\nbreak "q"', null, true])).toBe(
      '[1,2.5,0,1e+21,1e-7,"ü日本🚀","line\\nbreak \\"q\\"",null,true]',
    );
  });

  it("escapes lone surrogates instead of emitting ill-formed UTF-16", () => {
    expect(canonicalJSON("\ud800")).toBe('"\\ud800"');
    expect(canonicalJSON({ "\udc00": 1 })).toBe('{"\\udc00":1}');
  });

  it("does not normalize Unicode (precomposed and decomposed forms differ)", () => {
    expect(canonicalJSON("é")).not.toBe(canonicalJSON("é"));
  });

  it("keeps an own __proto__ key as data and does not touch Object.prototype", () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"polluted":true},"x":1}');
    expect(canonicalJSON(parsed)).toBe('{"__proto__":{"polluted":true},"x":1}');
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("accepts shared (non-cyclic) references", () => {
    const shared = { v: 1 };
    expect(canonicalJSON({ a: shared, b: shared })).toBe('{"a":{"v":1},"b":{"v":1}}');
  });

  it("does not mutate its input", () => {
    const input = { b: [2, 1], a: { d: 1, c: 2 } };
    const before = JSON.stringify(input);
    canonicalJSON(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("canonicalJSON: values outside plain JSON follow JSON.stringify", () => {
  // The invariant: hashing a value and hashing what JSON storage gives back
  // must agree, or a chain stored as JSON fails verification on reload.
  const cases: [string, unknown][] = [
    ["undefined object property", { a: 1, b: undefined }],
    ["undefined array element", [1, undefined, 3]],
    ["function and symbol values", { f: () => 1, s: Symbol("s"), a: [() => 1, Symbol("t")] }],
    ["symbol keys", { [Symbol("k")]: 1, a: 2 }],
    ["Date", { when: new Date("2020-01-02T03:04:05.000Z") }],
    ["custom toJSON", { t: { toJSON: () => ({ replaced: true }) } }],
    ["boxed primitives", { s: new String("ab"), n: new Number(3), b: new Boolean(false) }],
    ["NaN and Infinity", { a: NaN, b: Infinity, c: -Infinity }],
    ["negative zero", { z: -0 }],
    ["Map and Set", { m: new Map([[1, 2]]), s: new Set([1]) }],
    ["class instance with own fields", { p: new (class P { x = 1; y = "two"; })() }],
  ];

  for (const [label, value] of cases) {
    it(`${label}: same output before and after a JSON round trip`, () => {
      const direct = canonicalJSON(value);
      expect(direct).toBe(canonicalJSON(jsonRoundTrip(value)));
      expect(() => { JSON.parse(direct); }).not.toThrow(); // always valid JSON
    });
  }

  it("serializes a Date as its ISO string, so different Dates give different output", () => {
    expect(canonicalJSON({ when: new Date("2020-01-02T03:04:05.000Z") })).toBe(
      '{"when":"2020-01-02T03:04:05.000Z"}',
    );
    expect(canonicalJSON(new Date(0))).not.toBe(canonicalJSON(new Date(1)));
  });

  it("drops undefined object properties and turns undefined array elements into null", () => {
    expect(canonicalJSON({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJSON([1, undefined])).toBe("[1,null]");
  });
});

describe("canonicalJSON: errors", () => {
  it.each([
    ["undefined", undefined],
    ["a function", () => 1],
    ["a symbol", Symbol("s")],
  ])("throws a TypeError for a top-level value with no JSON form (%s)", (_label, value) => {
    expect(() => canonicalJSON(value)).toThrow(TypeError);
    expect(() => canonicalJSON(value)).toThrow(/no JSON representation/);
  });

  it("throws a TypeError (not a stack overflow) for a cyclic value", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    expect(() => canonicalJSON(cyclic)).toThrow(TypeError);
  });

  it("throws a TypeError for a BigInt", () => {
    expect(() => canonicalJSON({ n: 1n })).toThrow(TypeError);
  });
});

describe("canonicalJSON: seeded fuzz", () => {
  // Small deterministic PRNG (mulberry32) so failures are reproducible.
  function prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const KEYS = ["a", "b", "Z", "10", "9", "é", "é", "\u{1f680}", "￿", "__proto__", "constructor", ""];
  const STRINGS = ["", "x", "ü日本", " ", "\u0000", "\ud800", '"\\', "🚀"];

  function randomValue(rand: () => number, depth: number): unknown {
    const pick = Math.floor(rand() * (depth > 3 ? 6 : 9));
    switch (pick) {
      case 0: return null;
      case 1: return rand() < 0.5;
      case 2: return [0, -0, 1, -1.5, 1e21, 5e-324, Number.MAX_SAFE_INTEGER, NaN][Math.floor(rand() * 8)];
      case 3: return STRINGS[Math.floor(rand() * STRINGS.length)];
      case 4: return undefined;
      case 5: return new Date(Math.floor(rand() * 4e12));
      case 6:
      case 7: {
        const obj: Record<string, unknown> = {};
        const n = Math.floor(rand() * 5);
        for (let i = 0; i < n; i++) {
          Object.defineProperty(obj, KEYS[Math.floor(rand() * KEYS.length)]!, {
            value: randomValue(rand, depth + 1), enumerable: true, writable: true, configurable: true,
          });
        }
        return obj;
      }
      default: return Array.from({ length: Math.floor(rand() * 4) }, () => randomValue(rand, depth + 1));
    }
  }

  /** Same value with every object's keys re-inserted in reverse order. */
  function reverseKeyOrder(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reverseKeyOrder);
    if (value === null || typeof value !== "object" || value instanceof Date) return value;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).reverse()) {
      Object.defineProperty(out, k, {
        value: reverseKeyOrder((value as Record<string, unknown>)[k]), enumerable: true, writable: true, configurable: true,
      });
    }
    return out;
  }

  it("is order-independent, round-trip stable, and valid JSON for 500 random values", () => {
    const rand = prng(20260924);
    for (let i = 0; i < 500; i++) {
      const value = { v: randomValue(rand, 0) }; // wrap so the top level is always serializable
      const out = canonicalJSON(value);
      expect(canonicalJSON(reverseKeyOrder(value))).toBe(out);
      expect(canonicalJSON(jsonRoundTrip(value))).toBe(out);
      expect(() => { JSON.parse(out); }).not.toThrow();
    }
  });
});
