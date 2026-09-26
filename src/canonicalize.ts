import type { Canonicalizer } from "./types.js";

/** A value exactly as `JSON.parse` can return it. */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * Default canonicalizer: JSON with object keys sorted at every level and no
 * whitespace. The same logical value always gives the same string, whatever
 * order its properties were inserted in, so an independent reimplementation
 * (in any language) can recompute the same bytes and the same hashes.
 *
 * Rules, in order:
 * 1. The value is first converted exactly as `JSON.stringify` converts it:
 *    `toJSON()` is called (so a `Date` becomes its ISO string), boxed
 *    primitives are unwrapped, object properties whose value is `undefined`,
 *    a function or a symbol are dropped, those values inside arrays become
 *    `null`, `NaN` and `±Infinity` become `null`, `-0` becomes `0`, and
 *    `Map`/`Set` and other objects without own enumerable properties become `{}`.
 *    Because of this step, a value and the result of storing it as JSON and
 *    reading it back always canonicalize to the same string.
 * 2. Object keys are sorted by UTF-16 code unit (JavaScript's default
 *    `Array.prototype.sort` order), so `"10"` sorts before `"9"`. Array order
 *    is kept.
 * 3. Strings and numbers are written exactly as `JSON.stringify` writes them
 *    (lone surrogates are escaped as `\udXXX`). No Unicode normalization is
 *    applied: precomposed and decomposed forms of a character differ.
 *
 * @throws TypeError if the top-level value has no JSON form (`undefined`, a
 *   function, a symbol), if the value contains a cycle, or if it contains a
 *   `BigInt` (the last two are `JSON.stringify`'s own errors).
 *
 * You can pass your own {@link Canonicalizer} to `appendEntry` and
 * `verifyChain`. If you do, use the same one for every append and every
 * verify of a chain; mixing canonicalizers makes valid entries fail.
 */
export const canonicalJSON: Canonicalizer = (value: unknown): string => {
  const json = JSON.stringify(value);
  // JSON.stringify returns undefined for these at runtime, although its
  // declared return type is string.
  if (json === undefined) {
    throw new TypeError(`canonicalJSON: a top-level ${typeof value} value has no JSON representation`);
  }
  return serialize(JSON.parse(json) as JsonValue);
};

function serialize(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(value[k]!)}`).join(",")}}`;
}
