import type { Hasher } from "./types.js";

/**
 * Default hasher: SHA-256 through Web Crypto (`globalThis.crypto.subtle`),
 * returned as 64 lowercase hex characters. This file imports nothing at
 * runtime, so `appendEntry` and `verifyChain` need no Node built-in and no
 * npm dependency.
 *
 * The input is encoded as UTF-8 with `TextEncoder` (a lone surrogate becomes
 * U+FFFD). Gives the same digests as `sha256HexNodeFallback` (tested).
 * Checked here on Node 20, 22, 24 and 26, which expose `globalThis.crypto`
 * without flags. Any other runtime that exposes `crypto.subtle.digest`
 * should work but is not tested here.
 *
 * @throws TypeError (as a rejected promise) if `input` is not a string
 * @throws Error (as a rejected promise) if `globalThis.crypto.subtle` is
 *   missing; in that case pass `sha256HexNodeFallback` from
 *   "audit-chain-kit/hash-node-fallback".
 */
export const sha256Hex: Hasher = async (input: string): Promise<string> => {
  if (typeof input !== "string") {
    // TextEncoder would silently hash String(input) (undefined -> ""), which
    // collides with real strings and disagrees with the node:crypto fallback.
    throw new TypeError(`sha256Hex: input must be a string, got ${input === null ? "null" : typeof input}`);
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "Web Crypto (crypto.subtle) is unavailable in this environment. " +
        'Pass sha256HexNodeFallback from "audit-chain-kit/hash-node-fallback" as the hash function.',
    );
  }
  const bytes = new TextEncoder().encode(input);
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
