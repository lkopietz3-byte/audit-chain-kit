import { MAX_NESTING_DEPTH } from "./canonicalize.js";

/**
 * What `appendEntry` and `verifyChain` (with the default `canonicalJSON`)
 * require of a value held in memory: it must be exactly its own JSON form, so
 * the object you hold is the object that was hashed. JSON text parsed with
 * `JSON.parse` always passes. This is about objects held in memory only.
 */

export type JsonProblemKind =
  /** A cycle: `JSON.stringify` would throw. */
  | "cycle"
  /** Deeper than {@link MAX_NESTING_DEPTH}: serializing it could overflow the stack. */
  | "depth"
  /** A BigInt: `JSON.stringify` would throw. */
  | "bigint"
  /** Anything else JSON would silently change or drop. */
  | "lossy";

export interface JsonProblem {
  readonly kind: JsonProblemKind;
  /** Keys and indices from the top value down to the offending value. */
  readonly path: readonly (string | number)[];
  /** Short description of the offending value, with no caller text in it. */
  readonly why: string;
}

/**
 * Returns the first reason `value` is not exactly its JSON form, or
 * `undefined`. Never throws and never calls a getter, `toJSON` or any other
 * caller code: it reads property descriptors, prototypes and own keys only (a
 * Proxy trap can still run, and a trap that throws is reported as a problem).
 *
 * `rootMayBeInstance` lets the outermost object have any prototype. `verifyChain`
 * hashes a copy of an entry's own enumerable fields, never the entry object, so
 * an entry loaded as a class instance (an ORM row, say) is fine as long as its
 * own fields are plain data. Everything below the root must still be plain.
 *
 * Rejected: `undefined`, functions, symbols (as values or keys), BigInt,
 * `NaN` and `±Infinity`, non-enumerable and accessor properties, array holes
 * and extra array properties, anything with a `toJSON` method, objects that
 * are not plain (Date, Map, Set, boxed primitives, class instances), cycles
 * and nesting deeper than {@link MAX_NESTING_DEPTH}. Accepted: `-0` (it
 * equals `0` and JSON writes `0`), shared references that are not cycles,
 * null-prototype objects.
 */
export function findJsonProblem(value: unknown, options: { rootMayBeInstance?: boolean } = {}): JsonProblem | undefined {
  return inspect(value, [], new Set<object>(), options.rootMayBeInstance === true);
}

/**
 * `path` is one shared stack that callers push to and pop from, so a million
 * array elements do not allocate a million paths. A problem takes a copy.
 */
function problem(kind: JsonProblemKind, path: readonly (string | number)[], why: string): JsonProblem {
  return { kind, path: [...path], why };
}

function inspect(
  value: unknown,
  path: (string | number)[],
  ancestors: Set<object>,
  rootMayBeInstance = false,
): JsonProblem | undefined {
  switch (typeof value) {
    case "string":
    case "boolean":
      return undefined;
    case "number":
      return Number.isFinite(value) ? undefined : problem("lossy", path, "a non-finite number (JSON writes it as null)");
    case "undefined":
      return problem("lossy", path, "undefined (JSON drops it)");
    case "function":
      return problem("lossy", path, "a function (JSON drops it)");
    case "symbol":
      return problem("lossy", path, "a symbol (JSON drops it)");
    case "bigint":
      return problem("bigint", path, "a BigInt (JSON cannot represent it)");
    default:
      break;
  }
  if (value === null) return undefined;
  const container = value as object;
  if (path.length >= MAX_NESTING_DEPTH) {
    return problem("depth", path, `a value nested deeper than ${MAX_NESTING_DEPTH} levels`);
  }
  if (ancestors.has(container)) return problem("cycle", path, "a cycle (the object contains itself)");
  ancestors.add(container);
  try {
    return Array.isArray(container)
      ? inspectArray(container, path, ancestors)
      : inspectObject(container, path, ancestors, rootMayBeInstance && path.length === 0);
  } catch {
    return problem("lossy", path, "a value that could not be inspected (a Proxy trap threw)");
  } finally {
    ancestors.delete(container);
  }
}

function inspectArray(array: readonly unknown[], path: (string | number)[], ancestors: Set<object>): JsonProblem | undefined {
  if (typeof (array as { toJSON?: unknown }).toJSON === "function") {
    return problem("lossy", path, "an array with a toJSON method (JSON would call it)");
  }
  const length = array.length;
  // A dense array has exactly its indices plus "length". Checking the count first
  // also stops a huge sparse array from being walked index by index.
  if (Reflect.ownKeys(array).length !== length + 1) {
    return problem("lossy", path, "an array with holes or extra properties (JSON would change it)");
  }
  for (let i = 0; i < length; i++) {
    const descriptor = Reflect.getOwnPropertyDescriptor(array, i);
    path.push(i);
    try {
      if (descriptor === undefined || !descriptor.enumerable || "get" in descriptor || "set" in descriptor) {
        return problem("lossy", path, "an array element that is a hole, hidden or a getter");
      }
      const found = inspect(descriptor.value, path, ancestors);
      if (found !== undefined) return found;
    } finally {
      path.pop();
    }
  }
  return undefined;
}

function inspectObject(
  object: object,
  path: (string | number)[],
  ancestors: Set<object>,
  anyPrototype: boolean,
): JsonProblem | undefined {
  const proto: unknown = Object.getPrototypeOf(object);
  if (!anyPrototype && proto !== null && Object.getPrototypeOf(proto) !== null) {
    return problem("lossy", path, "an object that is not plain (a Date, Map, Set, boxed primitive or class instance)");
  }
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key === "symbol") return problem("lossy", path, "an object with a symbol-keyed property (JSON drops it)");
    const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
    path.push(key);
    try {
      if (descriptor === undefined) return problem("lossy", path, "a property that could not be read");
      if ("get" in descriptor || "set" in descriptor) return problem("lossy", path, "a getter or setter (JSON would call it)");
      if (!descriptor.enumerable) return problem("lossy", path, "a non-enumerable property (JSON drops it)");
      const found = inspect(descriptor.value, path, ancestors);
      if (found !== undefined) return found;
    } finally {
      path.pop();
    }
  }
  return undefined;
}
