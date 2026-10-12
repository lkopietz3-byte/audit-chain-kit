# Canonical form of an audit-chain-kit entry (format `audit-chain-kit/v1`)

This page says, byte by byte, what is hashed for one entry, so you can
recompute an `entryHash` in SQL or in another language. If this page and the
code ever disagree, that is a bug; the worked examples below are checked
against the code on every test run (`test/canonical-spec.test.ts`).

The format is fixed. A change to any rule here gets a new `formatVersion`.

## 1. The record

An entry has six fields. Five are hashed; `entryHash` is the result.

| field           | type    | meaning                                                         |
| --------------- | ------- | --------------------------------------------------------------- |
| `formatVersion` | string  | always the exact text `audit-chain-kit/v1`                      |
| `index`         | integer | position in the chain, from 0                                   |
| `payload`       | JSON    | the data you recorded                                           |
| `prevHash`      | string  | previous entry's `entryHash`, or 64 zeros (`0`) for the first   |
| `createdAt`     | string  | the time, as the text you stored (section 5)                    |

## 2. What is hashed

```
entryHash = lowercase-hex( SHA-256( UTF-8( canonical({ createdAt, formatVersion, index, payload, prevHash }) ) ) )
```

`canonical` writes the five fields as one JSON object (section 3) with the keys
in this order, which is plain sorted order: `createdAt`, `formatVersion`,
`index`, `payload`, `prevHash`. There is no trailing newline and no byte order
mark. The digest is written as 64 characters from `0-9a-f`.

## 3. The byte-level rules

`canonical(value)` writes a JSON value as text with these rules. There is no
whitespace anywhere outside strings: no spaces after `:` or `,`, no newlines.

**Literals.** `null`, `true`, `false`, in lowercase.

**Objects.** `{`, then each member as `"key":value` separated by `,`, then `}`.
Members are sorted by key, comparing keys as sequences of UTF-16 code units
(the order of JavaScript's default `sort()`), so `"10"` comes before `"9"` and
`"Z"` before `"a"`. An empty object is `{}`. Keys are written with the string
rules below. A key appears once.

**Arrays.** `[`, the elements in their original order separated by `,`, `]`.
An empty array is `[]`.

**Strings.** A string is written between double quotes. Inside:

- `"` is written `\"` and `\` is written `\\`.
- U+0008, U+0009, U+000A, U+000C, U+000D are written `\b`, `\t`, `\n`, `\f`, `\r`.
- Every other character from U+0000 to U+001F is written `\u00xx` with two
  lowercase hex digits (`\u0001`, `\u001f`).
- Everything else is written as itself, encoded as UTF-8 in the final step:
  that includes `/` (not escaped), U+007F, U+2028, U+2029, and characters
  outside the Basic Multilingual Plane (not written as surrogate pairs).
- A lone surrogate (U+D800 to U+DFFF with no partner) is written `\udxxx` in
  lowercase hex. It cannot occur in text that came from UTF-8 storage.
- No Unicode normalization is applied. `é` as one character (U+00E9) and `é`
  as `e` plus U+0301 are different strings and hash differently.

**Numbers.** Only finite numbers occur (the kit refuses `NaN` and infinities).
They are written the way ECMAScript writes a number as a string (the
`Number::toString` rule):

- The shortest digits that read back as the same 64-bit float.
- An integer has no decimal point and no exponent while it is below 10^21:
  `100`, `123456789012345680000`.
- A fraction has a leading `0` before the point and no trailing zeros:
  `0.5`, `0.000001`.
- At 10^21 and above, and below 10^-6, an exponent form is used with the sign
  always written: `1e+21`, `1e-7`, `1.5e+300`.
- Negative numbers start with `-`. Negative zero is written `0`.
- A number that does not fit a 64-bit float exactly is the float nearest to
  it, written by the rules above (`0.1+0.2` is `0.30000000000000004`, and
  `9007199254740993` is `9007199254740992`). Keep money and ids as strings or
  integers below 2^53 if exact digits matter.

**Before canonical: the payload must be plain JSON data.** The kit refuses a
payload that JSON would change on the way (`undefined`, functions, symbols,
`NaN`, `Infinity`, a `Date`, a `Map`, a `toJSON` method, getters, array holes,
cycles, nesting deeper than 255 levels inside the payload), so the object you
hold is the object that was hashed. If you reproduce the hash outside the kit,
start from JSON text that your own parser read; that is the same data.

## 4. A complete reference in a few lines (JavaScript)

The package hashes the entry as it finds it: every own field except
`entryHash`, with whatever `formatVersion` it carries. So a changed version or
an added field changes the digest (or, for a version this format does not
know, is refused outright). A reimplementation must do the same; hashing a
fixed list of five fields would accept edits the package rejects.

```js
import { createHash } from "node:crypto";

function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v); // literals, strings, numbers
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}

// Hash the entry minus entryHash: all of its own fields, not a fixed list.
function recompute(e) {
  const { entryHash, ...record } = e;
  return createHash("sha256").update(canonical(record), "utf8").digest("hex");
}

// Intact means: a version this format knows, and a matching hash. A changed
// field, an added field or another formatVersion is rejected.
function entryIsIntact(e) {
  return e.formatVersion === "audit-chain-kit/v1" && recompute(e) === e.entryHash;
}
```

This checks one entry. A chain also needs `prevHash` to equal the previous
entry's `entryHash` (or 64 zeros for the first) and `index` to equal the
position (section 6 covers gap records).

## 5. How `createdAt` is encoded

`createdAt` is a string and is hashed exactly as written: written with the
string rules above, as the fifth-field value `"createdAt":"..."`. The kit does
not parse it, normalize it or compare it with anything. `computeEntry` takes
it from the caller, so it can come from your database's clock.

The one rule that matters: store the exact text you hashed, and hash exactly
the text you stored. If you hash `2026-01-01T00:00:01.250Z` but the database
hands back `2026-01-01 00:00:01.25+00`, the entry stops verifying. Two safe
ways: keep `created_at` in a text column and write the hashed string into it,
or format the timestamp one fixed way on both sides. The kit's own
`appendEntry` writes `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC, three fractional digits,
a `Z`), and that is the recommended shape, but any non-blank string hashes.

### Storing and reading the fields back

A database can hand back a different text for a value that is equal to the one
you stored, and any difference changes the hash. These round-trip exactly:

| field           | store it as                          | read it back as                                    |
| --------------- | ------------------------------------ | -------------------------------------------------- |
| `createdAt`     | `text`, the exact string you hashed  | the same text (not `timestamptz`, not a date type) |
| `index`         | `bigint`                             | a number; a driver that returns text gives `"7"`, which is the same integer |
| `entryHash`, `prevHash` | `text`, lower-case hex       | the same lower-case text                           |
| `payload`       | `jsonb` (no U+0000 in strings) or `text` holding the JSON | the same JSON value |

Case matters: the digest is written as lower-case hex, and `prevHash` is hashed
as the text it is, so `E2E9...` and `e2e9...` are different values. A decimal
string index is the same integer as the number only if it is plain digits with
no sign, spaces, leading zeros, fraction or exponent. The package's
`readStoredEntry` converts exactly these forms and refuses everything else with
a reason; it never reformats a timestamp or changes a hash's case.

## 6. Marked gap records

A gap record is an ordinary entry whose payload is exactly these four fields:

```json
{ "kind": "audit-chain-kit/gap", "reason": "rows lost in a restore", "from": 12, "to": 15 }
```

It says the positions `from` to `to` (inclusive) hold no entries, and it sits
at `index = to + 1`. Its `prevHash` is the hash of the last entry before the
hole (position `from - 1`). Hashing it follows sections 1 to 3 like any other
entry. The verifier accepts a gap record only when asked to
(`allowMarkedGaps`), and only if `from` is the next unfilled position and
`index` is `to + 1`. `reason` is a non-blank string of at most 500 UTF-16 code
units.

## 7. Worked examples

Each block below is recomputed by `test/canonical-spec.test.ts`. The first kind
gives JSON text and the canonical text it becomes.

```example
json: {"b":1,"a":[true,null]}
canonical: {"a":[true,null],"b":1}
```

```example
json: {"10":"x","9":"y","Z":1,"a":2,"é":3}
canonical: {"10":"x","9":"y","Z":1,"a":2,"é":3}
```

```example
json: "café \"q\" \\ \/ \b\f\n\r\t \u0001 \u001f"
canonical: "café \"q\" \\ / \b\f\n\r\t \u0001 \u001f"
```

```example
json: [0, -0, 100, 0.5, 0.000001, 1e-7, 1e21, 123456789012345680000, 1.5e300, 0.1, 1e2, 12.50]
canonical: [0,0,100,0.5,0.000001,1e-7,1e+21,123456789012345680000,1.5e+300,0.1,100,12.5]
```

```example
json: {"empty_o":{},"empty_a":[],"nested":{"b":[{"d":1,"c":2}],"a":null}}
canonical: {"empty_a":[],"empty_o":{},"nested":{"a":null,"b":[{"c":2,"d":1}]}}
```

The second kind is a full record. This first one is the golden vector from the
README: the first entry of a chain.

```example-record
prevHash: 0000000000000000000000000000000000000000000000000000000000000000
index: 0
createdAt: 2026-01-01T00:00:00.000Z
payload: {"by":"user_1","action":"report.created"}
canonical: {"createdAt":"2026-01-01T00:00:00.000Z","formatVersion":"audit-chain-kit/v1","index":0,"payload":{"action":"report.created","by":"user_1"},"prevHash":"0000000000000000000000000000000000000000000000000000000000000000"}
entryHash: e2e95ac52a1f387f89f091b90d6a6caf1e2f68acffabe3b4243ed887acab76ca
```

The second entry links to the first through `prevHash`, and shows escaping,
`null`, a fraction and key sorting in a payload.

```example-record
prevHash: e2e95ac52a1f387f89f091b90d6a6caf1e2f68acffabe3b4243ed887acab76ca
index: 1
createdAt: 2026-01-01T00:00:01.250Z
payload: {"n":42,"ok":true,"note":"café \"quoted\"\n","tags":["b","a"],"none":null,"ratio":0.5}
canonical: {"createdAt":"2026-01-01T00:00:01.250Z","formatVersion":"audit-chain-kit/v1","index":1,"payload":{"n":42,"none":null,"note":"café \"quoted\"\n","ok":true,"ratio":0.5,"tags":["b","a"]},"prevHash":"e2e95ac52a1f387f89f091b90d6a6caf1e2f68acffabe3b4243ed887acab76ca"}
entryHash: d272c1399bb009105fe0c54772c116c196e20523ea1b661e405f7b733c15b3c8
```

The third shows number formatting and numeric-looking keys, and a `createdAt`
that is not the kit's usual shape (it is hashed as the text it is).

```example-record
prevHash: d272c1399bb009105fe0c54772c116c196e20523ea1b661e405f7b733c15b3c8
index: 2
createdAt: 2026-01-01 00:00:02.5+00
payload: {"big":1e21,"small":1e-7,"neg0":-0,"third":0.3333333333333333,"ten":10,"nine":9,"10":"k10","9":"k9"}
canonical: {"createdAt":"2026-01-01 00:00:02.5+00","formatVersion":"audit-chain-kit/v1","index":2,"payload":{"10":"k10","9":"k9","big":1e+21,"neg0":0,"nine":9,"small":1e-7,"ten":10,"third":0.3333333333333333},"prevHash":"d272c1399bb009105fe0c54772c116c196e20523ea1b661e405f7b733c15b3c8"}
entryHash: a80288666cb8bd44b9fa5e6c257ba2bbd5badefa6fa58b8c18af4fcf3e99c0be
```

A gap record, after the three entries above:

```example-record
prevHash: a80288666cb8bd44b9fa5e6c257ba2bbd5badefa6fa58b8c18af4fcf3e99c0be
index: 7
createdAt: 2026-01-01T00:00:09.000Z
payload: {"kind":"audit-chain-kit/gap","reason":"backup restore","from":3,"to":6}
canonical: {"createdAt":"2026-01-01T00:00:09.000Z","formatVersion":"audit-chain-kit/v1","index":7,"payload":{"from":3,"kind":"audit-chain-kit/gap","reason":"backup restore","to":6},"prevHash":"a80288666cb8bd44b9fa5e6c257ba2bbd5badefa6fa58b8c18af4fcf3e99c0be"}
entryHash: 7830caa0c9b1fd5bc6e418b84a539f52437c7edc2213a4cd30139bcd33c0ece8
```

## 8. Reproducing it in SQL (PostgreSQL)

PostgreSQL's `jsonb` is not a canonical form: it reorders keys by length and
keeps `1.0` as `1.0`, and `jsonb::text` adds spaces. So do not hash
`payload::text`. Two approaches work.

**Easiest: keep the canonical text.** Compute the canonical text in your
application (the kit's `canonicalJSON`), store it in a `text` column next to
the `jsonb` copy, and let SQL do only the hashing and the chain link:

```sql
select encode(sha256(convert_to(canonical_text, 'UTF8')), 'hex') = entry_hash as hash_ok
from audit_log;
```

**SQL only, for a flat payload of strings and integers.** Sort keys with
`COLLATE "C"` (byte order). That equals the UTF-16 order of section 3 for any
keys without characters above U+FFFF; keep payload keys to ordinary
characters. Let `to_json(text)` do the string escaping (it follows the same
rules as section 3 for `"`, `\` and control characters) and write integers
with `::text`:

```sql
select encode(sha256(convert_to(
  '{"createdAt":' || to_json(created_at_text)::text
  || ',"formatVersion":"audit-chain-kit/v1"'
  || ',"index":' || idx::text
  || ',"payload":{' || coalesce((
       select string_agg(
                to_json(t.k)::text || ':' ||
                case jsonb_typeof(t.v) when 'string' then to_json(t.v #>> '{}')::text else t.v::text end,
                ',' order by t.k collate "C")
         from jsonb_each(payload) as t(k, v)
     ), '') || '}'
  || ',"prevHash":' || to_json(prev_hash)::text || '}',
  'UTF8')), 'hex') as entry_hash_recomputed
from audit_log;
```

This sketch assumes `created_at_text` is the text you hashed, `payload` is a
flat `jsonb` object whose values are strings and integers, and nothing else
(no nested values, no fractions, no `1e3`-style numbers, no `null`s). For
anything richer, use the first approach.

## 9. What this page does not cover

- It does not say your `createdAt` is true; see "Timestamps are claims" in the
  README.
- A custom canonicalizer (an option of `appendEntry`, `verifyChain`,
  `computeEntry` and the streaming verifier) replaces section 3 entirely. This
  page describes the default one.
- Only `audit-chain-kit/v1` is described.
