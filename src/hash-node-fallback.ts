/**
 * Node fallback hasher — the ONE file in this package that imports a
 * runtime-specific / Node built-in API (`node:crypto`). Nothing else here
 * does, and nothing in the core `appendEntry` / `verifyChain` path imports
 * this file automatically.
 *
 * You almost certainly do not need this. `sha256Hex` in `./hash.ts` (the
 * default) uses Web Crypto (`globalThis.crypto.subtle`), which every modern
 * browser AND Node 19+ already expose globally with zero imports. This file
 * exists only for a runtime old enough, or locked-down enough, that
 * `globalThis.crypto.subtle` genuinely isn't there and can't be polyfilled.
 *
 * Usage: import this explicitly and pass it as the `hash` option —
 *
 *   import { verifyChain } from "audit-chain-kit";
 *   import { sha256HexNodeFallback } from "audit-chain-kit/hash-node-fallback";
 *   await verifyChain(chain, undefined, { hash: sha256HexNodeFallback });
 *
 * It is never imported by index.ts, so a bundler targeting a Node-free
 * runtime (a browser, an edge worker) never pulls `node:crypto` in unless
 * you explicitly reach for this module.
 */
import { createHash } from "node:crypto";
import type { Hasher } from "./types.js";

export const sha256HexNodeFallback: Hasher = async (input: string): Promise<string> => {
  return createHash("sha256").update(input, "utf8").digest("hex");
};
