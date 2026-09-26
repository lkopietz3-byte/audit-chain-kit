import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/index.js";
import { sha256HexNodeFallback } from "../src/hash-node-fallback.js";
import type { Hasher } from "../src/index.js";

const HASHERS: [string, Hasher][] = [
  ["sha256Hex (Web Crypto)", sha256Hex],
  ["sha256HexNodeFallback (node:crypto)", sha256HexNodeFallback],
];

// FIPS 180-2 / NIST test vectors.
const KNOWN: [string, string][] = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  [
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  ],
];

describe.each(HASHERS)("%s", (_name, hash) => {
  it.each(KNOWN)("matches the published SHA-256 vector for %j", async (input, expected) => {
    expect(await hash(input)).toBe(expected);
  });

  it("returns 64 lowercase hex characters", async () => {
    expect(await hash("x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("encodes non-ASCII input as UTF-8", async () => {
    // Expected values from: printf '<input>' | shasum -a 256
    expect(await hash("\u00e9")).toBe("4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c");
    expect(await hash("ü日本語🚀")).toBe("34008c524d684e384bbf2c608aec494b6331c7021f5907a3607c7b755cba7b89");
  });

  it.each([undefined, null, 123, { a: 1 }, ["a"]])("rejects non-string input %j with a TypeError", async (bad) => {
    // Called through `unknown` on purpose: this is what untyped JS callers can do.
    await expect((hash as (input: unknown) => Promise<string>)(bad)).rejects.toThrow(TypeError);
  });
});

describe("Web Crypto and node:crypto hashers agree", () => {
  const inputs = [
    "",
    "abc",
    "\u00e9",
    "e\u0301",
    "ü日本語🚀",
    "\u0000\u2028\u2029",
    "\ud800", // lone high surrogate
    "\udc00x", // lone low surrogate
    "\ufffd",
    "a".repeat(100_000),
    '{"createdAt":"2026-01-01T00:00:00.000Z","index":0,"payload":{"note":"ü"},"prevHash":"00"}',
  ];

  it.each(inputs.map((s) => [JSON.stringify(s).slice(0, 40), s]))("same digest for %s", async (_label, input) => {
    expect(await sha256Hex(input)).toBe(await sha256HexNodeFallback(input));
  });

  it("both replace a lone surrogate with U+FFFD before hashing (so they collide)", async () => {
    // Documented limit: only reachable with a custom canonicalizer, because
    // canonicalJSON escapes lone surrogates as \udXXX text.
    expect(await sha256Hex("\ud800")).toBe(await sha256Hex("\ufffd"));
    expect(await sha256HexNodeFallback("\ud800")).toBe(await sha256HexNodeFallback("\ufffd"));
  });
});
