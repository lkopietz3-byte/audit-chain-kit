import { createHash } from "node:crypto";
import type { Hasher } from "./types.js";

/**
 * SHA-256 through `node:crypto`, returned as 64 lowercase hex characters, for
 * a Node-like runtime without `globalThis.crypto.subtle`. Same output as
 * `sha256Hex` for every string, including non-ASCII and lone surrogates (a
 * lone surrogate becomes U+FFFD during UTF-8 encoding; tested). This is the
 * only module in the package that imports a Node built-in, and the main entry
 * point never imports it, so bundles that do not import this subpath never
 * pull in `node:crypto`.
 *
 * You do not need it on Node 20 or later, where the default `sha256Hex`
 * works. Import it explicitly and pass it as the hash function, for
 * `appendEntry` and again for `verifyChain` (a chain must be verified with the
 * hasher it was appended with):
 *
 * ```ts
 * import { appendEntry, canonicalJSON, verifyChain } from "audit-chain-kit";
 * import { sha256HexNodeFallback } from "audit-chain-kit/hash-node-fallback";
 * const chain = await appendEntry([], { a: 1 }, canonicalJSON, sha256HexNodeFallback);
 * await verifyChain(chain, undefined, { hash: sha256HexNodeFallback });
 * ```
 *
 * @param input - the string to hash (encoded as UTF-8)
 * @returns a promise for the lowercase hex digest
 * @throws TypeError (as a rejected promise) if `input` is not a string
 */
// Not `async`: there is nothing to await. The Promise executor still turns a
// synchronous throw from `createHash` into a rejection, matching `sha256Hex`.
export const sha256HexNodeFallback: Hasher = (input: string): Promise<string> =>
  new Promise((resolve) => {
    if (typeof input !== "string") {
      throw new TypeError(
        `sha256HexNodeFallback: input must be a string, got ${input === null ? "null" : typeof input}`,
      );
    }
    resolve(createHash("sha256").update(input, "utf8").digest("hex"));
  });
