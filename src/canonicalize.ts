import type { Canonicalizer } from "./types.js";

/**
 * Default canonicalizer: recursive key-sorted JSON. Object keys are sorted
 * at every level so the same logical value always serializes to the same
 * bytes, regardless of property insertion order. This is what makes hashing
 * meaningful — two callers (or two languages: this TypeScript verifier and
 * a SQL/Python/Go reimplementation) must agree byte-for-byte on what a
 * given record hashes to, or the chain isn't independently verifiable.
 *
 * Overridable: pass your own `Canonicalizer` to `appendEntry`/`verifyChain`
 * if you need different semantics (e.g. a schema-aware canonical form). If
 * you do, the SAME canonicalizer must be used for every append and every
 * verify of a given chain — mixing canonicalizers breaks the chain.
 */
export const canonicalJSON: Canonicalizer = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJSON((value as Record<string, unknown>)[k])}`)
    .join(",");
  return `{${body}}`;
};
