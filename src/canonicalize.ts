import type { Canonicalizer } from "./types.js";

/**
 * The most levels of nested objects and arrays `canonicalJSON` accepts, the
 * outermost container counting as level 1. `appendEntry` and `verifyChain`
 * hash the whole record, so inside a payload the limit is one less (255
 * levels): the record itself is level 1. A fixed limit, not the engine's
 * stack size, so a chain that verifies on one machine verifies on every
 * other.
 */
export const MAX_NESTING_DEPTH = 256;

/** Thrown by {@link canonicalJSON} for a value nested deeper than {@link MAX_NESTING_DEPTH}. */
export class NestingDepthError extends RangeError {
  constructor() {
    super(`canonicalJSON: value is nested deeper than ${MAX_NESTING_DEPTH} levels`);
    this.name = "RangeError";
  }
}

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
 * @throws RangeError if the value is nested deeper than 256 levels of objects
 *   and arrays (a clear message, never the engine's stack-overflow error).
 *
 * You can pass your own {@link Canonicalizer} to `appendEntry` and
 * `verifyChain`. If you do, use the same one for every append and every
 * verify of a chain; mixing canonicalizers makes valid entries fail.
 */
export const canonicalJSON: Canonicalizer = (value: unknown): string => {
  let json: string | undefined;
  let parsed: JsonValue;
  try {
    json = JSON.stringify(value);
    // JSON.stringify returns undefined for these at runtime, although its
    // declared return type is string.
    if (json === undefined) {
      throw new TypeError(`canonicalJSON: a top-level ${typeof value} value has no JSON representation`);
    }
    parsed = JSON.parse(json) as JsonValue;
  } catch (error) {
    throw isStackOverflow(error) ? new NestingDepthError() : error;
  }
  assertShallowEnough(parsed);
  return serialize(parsed);
};

function isStackOverflow(error: unknown): boolean {
  return error instanceof RangeError && /call stack/i.test(error.message);
}

/** Iterative, so measuring a hostile value cannot itself overflow the stack. */
function assertShallowEnough(root: JsonValue): void {
  const pending: [JsonValue, number][] = [[root, 1]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [value, depth] = next;
    if (value === null || typeof value !== "object") continue;
    if (depth > MAX_NESTING_DEPTH) throw new NestingDepthError();
    for (const child of Array.isArray(value) ? value : Object.values(value)) pending.push([child, depth + 1]);
  }
}

function serialize(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(value[k]!)}`).join(",")}}`;
}
