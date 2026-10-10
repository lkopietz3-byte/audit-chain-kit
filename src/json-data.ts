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
 * `undefined`. Never throws and never runs a getter, `toJSON`, `valueOf` or any
 * other caller code: it reads only property descriptors (own, and along the
 * prototype chain), prototypes and own keys, never `value[key]` (a Proxy trap
 * can still run, and a trap that throws is reported as a problem).
 *
 * `rootMayBeInstance` lets the outermost object have any prototype that does
 * not define `toJSON`. `verifyChain` hashes a copy of an entry's own
 * enumerable fields, never the entry object, so an entry loaded as a class
 * instance (an ORM row, say) is fine as long as its own fields are plain data
 * and nothing in its prototype chain could stand in for them. Everything below
 * the root must be plain.
 *
 * Rejected: `undefined`, functions, symbols (as values or keys), BigInt,
 * `NaN` and `±Infinity`, non-enumerable and accessor properties, array holes
 * and extra array properties, a `toJSON` anywhere on the prototype chain (data
 * or accessor), objects that are not plain (a prototype other than
 * `Object.prototype` from any realm, or null), objects with internal data JSON
 * does not see (boxed primitives, Date, Map, Set, RegExp, ArrayBuffer, typed
 * arrays, even with the prototype removed), cycles and nesting deeper than
 * {@link MAX_NESTING_DEPTH}. Accepted: `-0` (it equals `0` and JSON writes
 * `0`), shared references that are not cycles, null-prototype objects.
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

const MAX_PROTOTYPE_CHAIN = 1000;

/** Arrays longer than this are checked without listing every key (see inspectArray). */
const LARGE_ARRAY = 50_000;

/** True if any prototype of `object`, own or inherited, defines `toJSON` (read as a descriptor, so a getter is not run). */
function inheritsToJSON(object: object): boolean {
  let proto: unknown = Object.getPrototypeOf(object);
  for (let steps = 0; proto !== null; steps++) {
    // A chain this long is not a real prototype chain; treat it as a hook rather than walk forever.
    if (steps >= MAX_PROTOTYPE_CHAIN) return true;
    if (Reflect.getOwnPropertyDescriptor(proto as object, "toJSON") !== undefined) return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

function hasDataFunction(object: object, key: string): boolean {
  const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
  return descriptor !== undefined && typeof descriptor.value === "function";
}

/** `Object.prototype` of this or any other realm: one level above null, with the usual methods as data. */
function isObjectPrototypeLike(proto: object): boolean {
  return Object.getPrototypeOf(proto) === null && hasDataFunction(proto, "hasOwnProperty") && hasDataFunction(proto, "isPrototypeOf");
}

const sliceOf = (proto: object, key: string): ((this: unknown) => unknown) | undefined =>
  Reflect.getOwnPropertyDescriptor(proto, key)?.get as ((this: unknown) => unknown) | undefined;

/**
 * Intrinsics that throw a TypeError unless the object has the matching internal
 * slot, and run no caller code. Throwing is slow, so these are only the last
 * resort (see {@link hasInternalData}); the kinds that `Object.prototype.toString`
 * and `ArrayBuffer.isView` can name without throwing are not repeated here.
 */
const SLOT_PROBES: readonly ((value: object) => unknown)[] = [
  (v) => Map.prototype.has.call(v, 0),
  (v) => Set.prototype.has.call(v, 0),
  (v) => WeakMap.prototype.has.call(v, v),
  (v) => WeakSet.prototype.has.call(v, v),
  (v) => sliceOf(ArrayBuffer.prototype, "byteLength")?.call(v),
];

/**
 * True if `object` carries data that `JSON.stringify` does not see, whatever its
 * prototype says (a Date, RegExp, boxed primitive, Map, Set, typed array...).
 * Runs on an object that already passed the prototype and own-key checks, so
 * it has no own symbol keys and its prototype is null or Object.prototype-like.
 *
 * Cheap tier, for every object, never throws: a tag hook on the prototype is
 * refused; `Object.prototype.toString` names Date, RegExp, Boolean, Number,
 * String and Error by internal slot; `ArrayBuffer.isView` names typed arrays and
 * DataView.
 *
 * Slow tier, only for an object with no own keys and a prototype other than this
 * realm's `Object.prototype` (so a plain `{}` never pays for it): the throwing
 * probes for Map, Set, WeakMap, WeakSet and ArrayBuffer. Known gap: one of
 * those five whose prototype was set to this realm's `Object.prototype`, or that
 * has own enumerable properties, is not detected. Building one takes a
 * deliberate `Object.setPrototypeOf`; it is not something a parsed or ordinary
 * object can be.
 */
function hasInternalData(object: object, proto: object | null, hasOwnKeys: boolean): boolean {
  if (proto !== null && Reflect.getOwnPropertyDescriptor(proto, Symbol.toStringTag) !== undefined) return true;
  if (Object.prototype.toString.call(object) !== "[object Object]") return true;
  if (ArrayBuffer.isView(object)) return true;
  if (hasOwnKeys || proto === Object.prototype) return false;
  for (const probe of SLOT_PROBES) {
    try {
      probe(object);
      return true;
    } catch {
      // Not this kind of object.
    }
  }
  return false;
}

function inspectArray(array: readonly unknown[], path: (string | number)[], ancestors: Set<object>): JsonProblem | undefined {
  if (inheritsToJSON(array)) {
    return problem("lossy", path, "an array with a toJSON hook on its prototype chain (JSON would call it)");
  }
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(array, "length");
  const length: unknown = lengthDescriptor?.value;
  if (typeof length !== "number") return problem("lossy", path, "an array whose length could not be read");
  // A dense array has exactly its indices plus "length". Checking the count first
  // also stops a huge sparse array from being walked index by index.
  if (length <= LARGE_ARRAY) {
    if (Reflect.ownKeys(array).length !== length + 1) {
      return problem("lossy", path, "an array with holes or extra properties (JSON would change it)");
    }
  } else if (Object.keys(array).length !== length || Object.getOwnPropertySymbols(array).length !== 0) {
    // Listing every key of a very large array (one string per index) can exhaust the heap, so
    // above LARGE_ARRAY the check counts enumerable keys instead. A hole is caught by the
    // element loop below. Known gap: a non-enumerable named property on such an array.
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
  if (inheritsToJSON(object)) {
    return problem("lossy", path, "an object with a toJSON hook on its prototype chain (JSON would call it)");
  }
  const proto = Object.getPrototypeOf(object) as object | null;
  if (!anyPrototype && proto !== null && proto !== Object.prototype && !isObjectPrototypeLike(proto)) {
    return problem("lossy", path, "an object that is not plain (a Date, Map, Set, boxed primitive or class instance)");
  }
  const keys = Reflect.ownKeys(object);
  for (const key of keys) {
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
  // The root may be a class instance (an ORM row); only its own fields are used, so its internal data is moot.
  if (!anyPrototype && hasInternalData(object, proto, keys.length > 0)) {
    return problem("lossy", path, "an object with internal data JSON does not see (a Date, Map, Set, boxed primitive or similar)");
  }
  return undefined;
}
