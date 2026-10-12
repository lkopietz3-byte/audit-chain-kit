import { describe, isIndex, isObject, isPlainObject, ownDataFields } from "./chain.js";
import type { ChainEntry } from "./types.js";

/** Settings of {@link readStoredEntry}. */
export interface ReadStoredEntryOptions {
  /**
   * Refuse a 64-character hex hash written in upper case (the default, `true`).
   * The format writes lower-case hex and the case is part of the hashed text,
   * so an upper-cased hash is never the same value. Set `false` only if your
   * custom hash function legitimately produces upper-case digests.
   */
  readonly lowercaseHexHashes?: boolean;
}

/** What {@link readStoredEntry} returns. */
export type StoredEntryResult =
  | { readonly ok: true; readonly entry: ChainEntry }
  | {
      readonly ok: false;
      /** The field that could not be read as stored, or `null` for the row as a whole. */
      readonly field: string | null;
      /** What was wrong and, where it is a known storage round-trip problem, how to store the field instead. */
      readonly reason: string;
    };

const refuse = (field: string | null, reason: string): StoredEntryResult => ({ ok: false, field, reason });

/** At most 16 digits fit a safe integer, so a longer digit string is refused before it is converted. */
const DECIMAL = /^(?:0|[1-9][0-9]{0,15})$/;
const HEX_DIGEST = /^[0-9a-fA-F]{64}$/;

/**
 * Reads one database row as a chain entry, converting only forms that are
 * exactly the value that was hashed, and refusing everything else with a
 * reason. It never accepts a different value as equal: it does not parse,
 * reformat or guess timestamps, change the case of a hash, or parse JSON text.
 *
 * The row needs the entry's field names (`formatVersion`, `index`, `payload`,
 * `prevHash`, `createdAt`, `entryHash`); alias your columns in the query and
 * select the constant version, for example
 * `'audit-chain-kit/v1' as "formatVersion"`. Other columns are ignored (they
 * were never hashed). Fields are read as plain data properties: a getter is
 * not run, and a row that cannot be read is refused, not thrown.
 *
 * Conversions:
 * - `index`: a safe non-negative integer, a bigint in that range, or a decimal
 *   string that is exactly such an integer (`"7"`, not `"07"`, `" 7"`, `"7.0"`
 *   or `"1e1"`). A bigint column read by node-postgres arrives as a string.
 * - `createdAt`: must already be a string; it is passed through untouched. A
 *   `Date` or a number is refused, because the text that was hashed cannot be
 *   recovered from it. Store `createdAt` as text.
 * - `prevHash`, `entryHash`: must be strings; upper-case 64-digit hex is
 *   refused (see {@link ReadStoredEntryOptions.lowercaseHexHashes}).
 * - `payload`: any value, including `null`, passed through as read. A JSON text
 *   column arrives as a string and is not parsed (a string is a valid payload);
 *   use a `jsonb` column, or parse it yourself.
 */
export function readStoredEntry(row: unknown, options?: ReadStoredEntryOptions): StoredEntryResult {
  let lowercaseHex = true;
  if (options !== undefined) {
    if (!isPlainObject(options)) throw new TypeError("readStoredEntry: options must be a plain object or undefined");
    for (const key of Object.keys(options)) {
      if (key !== "lowercaseHexHashes") throw new TypeError(`readStoredEntry: unknown option ${describe(key)}; the only option is lowercaseHexHashes`);
    }
    const flag: unknown = options.lowercaseHexHashes;
    if (flag !== undefined) {
      if (typeof flag !== "boolean") throw new TypeError("readStoredEntry: lowercaseHexHashes must be a boolean");
      lowercaseHex = flag;
    }
  }

  try {
    return readRow(row, lowercaseHex);
  } catch {
    // Anything the row does when inspected (a revoked Proxy, a trap that throws) is a refusal, never an exception.
    return refuse(null, "the row could not be read (a proxy or getter threw)");
  }
}

/** A Date's internal slot, checked through a captured intrinsic: throws for anything that is not a real Date. */
// eslint-disable-next-line @typescript-eslint/unbound-method -- captured once; only ever called with .call()
const dateTime = Date.prototype.getTime;
function isRealDate(value: unknown): boolean {
  try {
    dateTime.call(value);
    return true;
  } catch {
    return false;
  }
}

function readRow(row: unknown, lowercaseHex: boolean): StoredEntryResult {
  if (!isObject(row) || Array.isArray(row)) return refuse(null, "the row is not an object");
  const fields = ownDataFields(row);

  const formatVersion = fields["formatVersion"];
  if (typeof formatVersion !== "string") {
    return refuse("formatVersion", "formatVersion is missing or not a string; select the constant, for example 'audit-chain-kit/v1' as \"formatVersion\"");
  }

  const stored = fields["index"];
  let index: number;
  if (typeof stored === "number") {
    if (!isIndex(stored)) return refuse("index", `index ${describe(stored)} is not a non-negative safe integer`);
    index = stored;
  } else if (typeof stored === "bigint") {
    if (stored < 0n || stored > BigInt(Number.MAX_SAFE_INTEGER)) return refuse("index", "index is a bigint outside the safe integer range");
    index = Number(stored);
  } else if (typeof stored === "string") {
    if (!DECIMAL.test(stored)) return refuse("index", `index ${describe(stored)} is not a plain decimal integer (no sign, spaces, leading zeros, fraction or exponent)`);
    index = Number(stored);
    if (!isIndex(index)) return refuse("index", `index ${describe(stored)} is larger than the largest safe integer (2^53 - 1)`);
  } else {
    return refuse("index", `index must be an integer, a bigint or a decimal string, got ${describe(stored)}`);
  }

  if (!("payload" in fields)) return refuse("payload", "payload is missing from the row");
  const payload = fields["payload"];

  const createdAt = fields["createdAt"];
  if (typeof createdAt !== "string") {
    return refuse(
      "createdAt",
      isRealDate(createdAt)
        ? "createdAt is a Date (a timestamp column was read back as a date): the text that was hashed cannot be recovered; store createdAt as text and select that column"
        : `createdAt must be the text that was hashed, got ${describe(createdAt)}; store createdAt as text`,
    );
  }

  const hashes: Record<"prevHash" | "entryHash", string> = { prevHash: "", entryHash: "" };
  for (const name of ["prevHash", "entryHash"] as const) {
    const value = fields[name];
    if (typeof value !== "string") return refuse(name, `${name} must be a string, got ${describe(value)}`);
    if (lowercaseHex && HEX_DIGEST.test(value) && value !== value.toLowerCase()) {
      return refuse(name, `${name} is upper-case hex; the format writes lower-case hex and the case is part of the hashed text, so store and return the lower-case text`);
    }
    hashes[name] = value;
  }

  return {
    ok: true,
    entry: { formatVersion, index, payload, prevHash: hashes.prevHash, createdAt, entryHash: hashes.entryHash },
  };
}
