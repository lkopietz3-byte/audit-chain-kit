import { isBlank, isIndex, isObject, ownDataFields } from "./chain.js";

/**
 * The `kind` of a marked-gap payload. The string is reserved: with
 * `allowMarkedGaps` the verifier reads any entry whose payload has this
 * `kind` as a gap record, and without it such an entry is a break. Do not use
 * it for ordinary rows.
 */
export const MARKED_GAP_KIND = "audit-chain-kit/gap";

/** The longest `reason` a gap record may carry, in UTF-16 code units. */
export const MAX_GAP_REASON_LENGTH = 500;

/** The payload of a gap record: an explicit, hashed statement that a range of positions holds no entries. */
export interface GapPayload {
  readonly kind: typeof MARKED_GAP_KIND;
  /** Why the entries are missing. A non-blank string of at most {@link MAX_GAP_REASON_LENGTH} characters. */
  readonly reason: string;
  /** First position with no entry. */
  readonly from: number;
  /** Last position with no entry. The gap record itself has `index` `to + 1`. */
  readonly to: number;
}

/** A gap the verifier accepted, as listed in `ChainVerifierResult.gaps`. */
export interface MarkedGap {
  /** The gap record's own `index` (always `to + 1`). */
  readonly atIndex: number;
  readonly from: number;
  readonly to: number;
  /** The reason as stored. Free text from whoever wrote the gap: escape it before showing it. */
  readonly reason: string;
}

/** Why a `reason`/`from`/`to` triple is not a usable gap range, or `undefined` if it is. */
export function gapFieldProblem(reason: unknown, from: unknown, to: unknown): string | undefined {
  if (typeof reason !== "string" || isBlank(reason)) return "reason must be a non-blank string";
  if (reason.length > MAX_GAP_REASON_LENGTH) return `reason is longer than ${MAX_GAP_REASON_LENGTH} characters`;
  if (!isIndex(from)) return "from must be a non-negative integer";
  if (!isIndex(to) || to >= Number.MAX_SAFE_INTEGER) return "to must be a non-negative safe integer below 2^53 - 1";
  if (to < from) return "to must not be less than from";
  return undefined;
}

/**
 * Builds the payload of a gap record saying positions `from` to `to`
 * (inclusive) hold no entries. Hash it with `computeEntry` at `index: to + 1`,
 * or let `appendGapToStore` do both.
 *
 * @throws TypeError if the arguments are not `{ reason, from, to }` with a
 *   usable range (see {@link GapPayload})
 */
export function gapPayload(input: { readonly reason: string; readonly from: number; readonly to: number }): Readonly<GapPayload> {
  if (!isObject(input)) throw new TypeError("gapPayload: expected { reason, from, to }");
  const reason: unknown = input["reason"];
  const from: unknown = input["from"];
  const to: unknown = input["to"];
  const problem = gapFieldProblem(reason, from, to);
  if (problem !== undefined) throw new TypeError(`gapPayload: ${problem}`);
  return Object.freeze({ kind: MARKED_GAP_KIND, reason: reason as string, from: from as number, to: to as number });
}

export type GapRead =
  | { readonly kind: "none" }
  | { readonly kind: "gap"; readonly reason: string; readonly from: number; readonly to: number }
  | { readonly kind: "malformed"; readonly why: string };

const NOT_A_GAP: GapRead = Object.freeze({ kind: "none" });

/**
 * Reads a payload as a gap record. Only own enumerable data properties are
 * looked at (no getter runs). A payload with the reserved `kind` and anything
 * other than exactly `kind`, `reason`, `from`, `to` in valid form is
 * `malformed`, never an ordinary row. May throw if the payload is a hostile Proxy.
 */
export function readGapPayload(payload: unknown): GapRead {
  if (!isObject(payload) || Array.isArray(payload)) return NOT_A_GAP;
  // The common case (an ordinary payload) costs one descriptor lookup, however many keys it has.
  const kind = Reflect.getOwnPropertyDescriptor(payload, "kind");
  if (kind === undefined || !kind.enumerable || kind.value !== MARKED_GAP_KIND) return NOT_A_GAP;
  if (Reflect.ownKeys(payload).length !== 4) {
    return { kind: "malformed", why: "its payload must have exactly kind, reason, from and to" };
  }
  const fields = ownDataFields(payload);
  if (!("reason" in fields) || !("from" in fields) || !("to" in fields) || Object.keys(fields).length !== 4) {
    return { kind: "malformed", why: "its payload must have exactly kind, reason, from and to" };
  }
  const { reason, from, to } = fields;
  const problem = gapFieldProblem(reason, from, to);
  if (problem !== undefined) return { kind: "malformed", why: problem };
  return { kind: "gap", reason: reason as string, from: from as number, to: to as number };
}
