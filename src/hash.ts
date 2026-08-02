import type { Hasher } from "./types.js";

/**
 * Default hasher: SHA-256 via the Web Crypto API (`globalThis.crypto.subtle`)
 * ONLY. No `node:crypto`, no npm dependency, no import of any kind. This is
 * what makes `verifyChain` runnable by a third party — a browser tab with
 * this one file pasted in, or a `<script type="module">` with zero installs
 * — who does not trust your server, your database, or your npm registry
 * account, and wants to recompute the chain themselves.
 *
 * Web Crypto's `subtle.digest` is Promise-based in every environment (there
 * is no synchronous digest API), so this — and therefore `appendEntry` and
 * `verifyChain` — are async.
 *
 * Works unmodified in: every modern browser, Deno, Bun, Cloudflare Workers,
 * and Node 19+ (Node exposes Web Crypto as a global since v19; no `--experimental`
 * flag needed since Node 20). If you must support a runtime older than that
 * and have no polyfill, see `hash-node-fallback.ts` — the one other file in
 * this package, and the only one that imports a Node built-in.
 */
export const sha256Hex: Hasher = async (input: string): Promise<string> => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "Web Crypto (crypto.subtle) is unavailable in this environment. " +
        "Pass a Node fallback hasher as the `hash` option — see hash-node-fallback.ts " +
        "(sha256HexNodeFallback) for a runtime that doesn't expose globalThis.crypto.",
    );
  }
  const bytes = new TextEncoder().encode(input);
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
