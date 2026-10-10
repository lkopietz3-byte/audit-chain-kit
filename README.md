# audit-chain-kit

**[Try it in your browser →](https://lkopietz3-byte.github.io/honesty-kits/#audit-chain-kit)** · Part of [honesty kits](https://github.com/lkopietz3-byte/honesty-kits), a family of small checks for the claims an AI product makes.

Build and verify SHA-256 hash chains over audit records, in TypeScript,
with zero runtime dependencies. Each entry's hash covers its content and the
previous entry's hash, and `verifyChain` recomputes every hash from the
first entry. The verifier uses only Web Crypto, so someone checking a chain
does not have to run your code or trust your server to recompute it.

MIT licensed. See [Install](#install) for supported Node versions and how to
load it from CommonJS.

## What "tamper-evident" means here

Evident to anyone who holds the chain and runs `verifyChain`. Relative to
what depends on whether they also hold an anchor:

- **Without an anchor**, `verifyChain` detects changes that were not
  followed by recomputing hashes: accidental corruption, a hand-edited
  field, a deleted, reordered, duplicated or inserted entry. It does
  **not** detect a deliberate rewrite. There is no secret key, so anyone who
  can write to the stored chain can change an entry and recompute every
  later hash, delete entries from the end, or append new ones, and the
  result verifies. A chain fully recomputed by whoever controls the store
  is undetectable.
- **With an anchor**, an `{ index, entryHash }` pair you got earlier and
  kept somewhere the writer cannot change (sent to the other party, printed
  in a signed report, stored in a separate system), `verifyChain` detects
  any change to entries `0` through `index`, including a full rewrite, and
  truncation below the anchor. Entries after the anchor are only checked
  for internal consistency.

In both cases a valid result says nothing about who wrote an entry or when:
nothing is signed, and `createdAt` is whatever the writer's clock said.

## When not to use it

- You need to prove who wrote an entry. This package does no signing.
- You need to detect a rewrite by the operator and have no way to keep an
  anchor outside the operator's control.
- Several processes append to the same chain at once and you expect this
  package to serialize them. `appendEntry` works on an in-memory array and
  does not. For a database-backed log, use `computeEntry`, `appendToStore`
  and the streaming verifier described in
  [Store-backed appends and streaming verification](#store-backed-appends-and-streaming-verification);
  the "only if the head is still this" check itself lives in your database,
  not here, and this package ships no SQL, no driver and no concurrency proof.
- You need to prove one entry is in a log without handing over the whole
  chain (inclusion proofs). This is a linear chain, not a Merkle tree, and
  `verifyChain` always walks from entry 0.

## Install

```bash
npm install audit-chain-kit
```

Or build from source: clone the repository and run
`npm install && npm run build`. The behavior described below is version 0.2.1;
[CHANGELOG.md](CHANGELOG.md) lists what changed from 0.1.1.

This is an ESM package (`"type": "module"`). ESM and CommonJS consumers work
like this:

| How you load it | Works on | Notes |
| --- | --- | --- |
| `import` (ESM) | Node 20, 22, 24, 26 | The normal way. |
| `require()` (CommonJS) | Node 20.19+ and 22.12+ (and later) | Uses Node's `require(esm)`. On an older Node, use dynamic `import()`. |
| TypeScript, `moduleResolution` `node10`, `node16`/`nodenext` or `bundler` | TypeScript 5.x | Checked by `attw` and by a consumer probe in CI. |

Node 22 and 24 (LTS) are recommended for production and Node 26 is current.
Node 20 is end-of-life: it is tested for compatibility only (CI runs the tests
and the installed-package probe on 20.19.0 and 22.12.0, the `require(esm)`
floors) and gets no upstream security fixes. `engines` in `package.json` is
`>=20`.

## Quickstart

```js
import { appendEntry, verifyChain } from "audit-chain-kit";

let chain = await appendEntry([], { action: "report.created", by: "user_1" });
chain = await appendEntry(chain, { action: "report.exported", by: "user_1" });

// Store the chain however you like. A JSON round trip is safe.
const stored = JSON.stringify(chain);

// Keep an anchor somewhere the writer of `stored` cannot change it.
const last = chain[chain.length - 1];
const anchor = { index: last.index, entryHash: last.entryHash };

console.log(await verifyChain(JSON.parse(stored), undefined, { anchor }));
// { valid: true, brokenAtIndex: null, reason: null, entriesChecked: 2 }

const tampered = JSON.parse(stored);
tampered[0].payload.by = "user_2";
console.log(await verifyChain(tampered, undefined, { anchor }));
// { valid: false, brokenAtIndex: 0,
//   reason: 'entry 0 content does not match its entryHash (a hashed field was changed, added, or removed after appending)',
//   entriesChecked: 0 }
```

## How an entry is hashed

Each entry is `{ formatVersion, index, payload, prevHash, createdAt, entryHash }`, where

```
entryHash = lowercase hex SHA-256 of the UTF-8 bytes of
            canonicalJSON({ createdAt, formatVersion, index, payload, prevHash })
```

`formatVersion` is always the fixed string `"audit-chain-kit/v1"`, exported
as `FORMAT_VERSION` so you can compare against it. It exists
so a future change to the record shape or the canonicalizer gets a new tag
instead of silently producing hashes that look like this format but
aren't, and so this package's `entryHash` can never be mistaken for some
other hash-chain library's digest of the same bytes. `verifyChain` rejects
an entry whose `formatVersion` is missing or different, with a clear
reason, before it even tries to recompute the hash.

`index` is the entry's position (from 0), `prevHash` is the previous
entry's `entryHash` (or `GENESIS_HASH`, 64 zeros, for the first entry) and
`createdAt` is `new Date().toISOString()` at append time. `prevHash` is a
field inside the hashed JSON, not a string glued onto it, so field
boundaries cannot be confused.

Test vector (from `test/vectors.test.ts`): this record string

```
{"createdAt":"2026-01-01T00:00:00.000Z","formatVersion":"audit-chain-kit/v1","index":0,"payload":{"action":"report.created","by":"user_1"},"prevHash":"0000000000000000000000000000000000000000000000000000000000000000"}
```

has `entryHash` `e2e95ac52a1f387f89f091b90d6a6caf1e2f68acffabe3b4243ed887acab76ca`
(`printf '%s' '<record>' | shasum -a 256` gives the same value).

The byte-level rules (key order, number formatting, string escaping, how
`createdAt` is encoded) are written out with worked examples in
[docs/CANONICAL-FORM.md](docs/CANONICAL-FORM.md), simple enough to reproduce
in SQL or another language; the examples are recomputed by a test.

If you reimplement the verifier in another language: keys are sorted by
UTF-16 code unit, and numbers and strings are written exactly as
JavaScript's `JSON.stringify` writes them (non-ASCII characters are not
escaped). For the two test vectors, Python's
`json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`
produced the same bytes. Other inputs can differ: Python sorts keys by code
point (different for keys with characters above U+FFFF), and its number
formatting is not JavaScript's for every value.

## API

Main entry: `audit-chain-kit`.

### `appendEntry(chain, payload, canonicalize?, hash?)`

Returns `Promise<readonly Readonly<ChainEntry<T>>[]>`: a new frozen array
with one new frozen entry at the end. Does not mutate `chain`.

- `chain`: the whole existing chain, or `[]`. Only the last entry is
  inspected (the chain is not re-verified). The array's length, its entries
  and the last entry's `entryHash` and `index` are read once, before the first
  `await`, and the result is built from that copy. Pushing to, truncating or
  replacing entries in `chain` while the hash is pending does not change what
  is returned. Entries are shared, not copied, and a hole in a sparse array
  becomes an `undefined` element that `verifyChain` then rejects at its index.
- `payload`: plain JSON data. With the default canonicalizer it must be
  exactly its own JSON form: strings, finite numbers, booleans, `null`, arrays
  and plain objects, nested at most 255 levels deep. It is refused with a
  `TypeError` (naming where) if it holds `undefined`, a function, a symbol, a
  BigInt, `NaN` or `Infinity`, anything with a `toJSON` method (so a `Date`:
  use `date.toISOString()`), a `Map`, `Set`, boxed primitive or class instance,
  a getter, a symbol-keyed or non-enumerable property, an array with holes or
  extra properties, or a cycle. Otherwise the object you hold would not be the
  object that was hashed. A custom `canonicalize` is not checked. The payload
  is stored by reference and not frozen, so mutating it afterwards makes the
  entry fail verification. Clone it first if you reuse the object.
- `canonicalize`: defaults to `canonicalJSON`. Use the same one for every
  append and verify of a chain. It must be synchronous and return a string.
- `hash`: defaults to `sha256Hex`. It must resolve to a string.

Throws a `TypeError` if `chain` is not an array, its last entry has no
string `entryHash`, the payload is not plain JSON data (default canonicalizer
only), `canonicalize` or `hash` is not a function, or either returns the wrong type (for example a hasher that resolves to `undefined`,
which would otherwise be stored as an entry with no hash). It throws a
`RangeError` if the last entry's `index` is not its position (for example,
you passed only the tail). Errors thrown by `canonicalize` or `hash`
propagate.

### `verifyChain(chain, canonicalize?, options?)`

Returns `Promise<{ valid: boolean; brokenAtIndex: number | null; reason: string | null; entriesChecked: number }>`
describing the first problem found.

`entriesChecked` is how many entries were fully checked (link, hash and index)
before the result was decided: the whole chain when `valid` is `true`, the
entries before the first failing one otherwise, and `0` for a chain that is not
an array. **An empty chain is `valid: true` with `entriesChecked: 0`.** Nothing
was verified, so a result for a log that should have entries is only evidence
when `entriesChecked` is what you expect; `expectedMinLength` and `anchor` are
the checks that say how many there should be.

For each entry in order it checks that the entry is an object with string
`prevHash` and `entryHash`; that `formatVersion` equals `FORMAT_VERSION`
exactly (a missing or different value fails here, with a reason naming
`formatVersion`, before the hash is even recomputed); that `prevHash`
equals the previous entry's `entryHash` (or `GENESIS_HASH`); that
`entryHash` equals the recomputed hash of the entry minus `entryHash` (so a
changed, added or removed field fails); and that `index` equals the
position. A non-array `chain` returns
`{ valid: false, brokenAtIndex: null, reason: "chain is not an array", entriesChecked: 0 }`, and
a similar result for an array-like whose `length` is not a non-negative integer.

With the default `canonicalJSON`, an entry held in memory must also be exactly
its JSON form (the rule `appendEntry` applies to payloads, applied to the whole
entry). An entry with a `Date`, `undefined`, a function, a symbol, `NaN`, a
getter, a symbol-keyed or non-enumerable field, a cycle or a payload nested
deeper than 255 levels is reported invalid at its index. The entry object itself
may be a class instance (an ORM row, say) if its own fields are plain data. JSON
text parsed with `JSON.parse` always passes, so a stored chain read back from
JSON verifies as before. An entry that is unreadable (a revoked proxy, a getter
that throws) is reported invalid at its index instead of throwing. A custom
`canonicalize` is not checked; its own limits apply.

**The result describes the chain as it was when you called.** Before the first
`await`, `verifyChain` reads the options, the anchor's `index` and `entryHash`,
the array's length and entries, and a shallow copy of each entry's fields.
Everything after that, including the anchor comparison, uses only that copy:
the anchor is compared with the `entryHash` that was recomputed and matched,
never with a value read again after an `await`. Pushing to, truncating or
replacing entries, or editing an entry's fields or the anchor object, while a
hash is pending does not change the result. The copy is shallow: each entry's
`payload` is read by reference when that entry is canonicalized, so editing a
payload in place during the call can still change the outcome for that entry.
Do not mutate a chain you are verifying. A hole in a sparse array is an invalid
entry, and nothing after the first entry that is not an object is read.

Reasons that include a value from the chain (a `formatVersion` or `index`
that is not what was expected) name the value safely. A string is quoted and
cut at 80 characters, and control, line-break, bidirectional and other
invisible format characters, every Unicode space except the ordinary space (such as
NBSP), and U+2800 (Braille blank) are written as `\uXXXX`, so a stored value cannot
add a line or send a terminal escape. A BigInt is `1n`. An object, symbol or
function is named ("an object"), never serialized, so a cyclic object or a
throwing `toJSON` cannot break the report. `brokenAtIndex` and the reason
still say which entry is wrong.

`options` (`undefined` or a plain object with only these keys):

- `expectedMinLength`: a non-negative integer. A shorter chain is invalid.
  This only catches entries deleted from the end if nobody appended new
  ones afterwards; anyone can append. Leave the key out to skip the check; a
  key that is present with the value `undefined` throws.
- `anchor`: `{ index, entryHash }` (any `ChainEntry` fits). The chain must
  have an entry at `anchor.index` with exactly that `entryHash`. `entryHash`
  must not be blank (empty, or only whitespace, invisible characters and
  U+2800). Leave the key out to skip the check; a key that is present with the
  value `undefined` throws, so a lookup that found nothing cannot silently turn
  the check off.
- `hash`: the hash function used to append. Defaults to `sha256Hex` (also when the key is present and `undefined`).

These throw a `TypeError` (a bug in the caller, not a property of the chain):
`options` that is not a plain object, an unknown option key (so a typo, or an
anchor passed where the options belong, cannot silently skip the anchor
check), a malformed `expectedMinLength` or `anchor` (including one that is present but `undefined`), a `canonicalize` or `hash`
that is not a function, a `canonicalize` that does not return a string, or a
`hash` that does not resolve to one. Errors thrown by `canonicalize` or `hash`
propagate.

| Change to the stored chain | Without anchor | With anchor at the old last entry |
| --- | --- | --- |
| Edit a field, no hashes recomputed | detected at that entry | detected |
| Delete, reorder, duplicate or insert an entry in the middle, no recompute | detected (broken `prevHash` link) | detected |
| Delete entries from the end | not detected (`expectedMinLength` catches it if nothing was appended after) | detected |
| Delete from the end, then append new entries | not detected, even with `expectedMinLength` | detected |
| Edit anything and recompute every later hash | not detected | detected |
| Changes after the anchored entry, with recompute | not detected | not detected |

### `canonicalJSON(value)`

Returns a deterministic JSON string: keys sorted at every level by UTF-16
code unit, array order kept, no whitespace. This function stays lenient:
`appendEntry` and `verifyChain` are the ones that refuse values it would
silently change. The value is first converted
exactly as `JSON.stringify` converts it: `toJSON()` is called (a `Date`
becomes its ISO string), `undefined`, functions and symbols are dropped
from objects and become `null` in arrays, `NaN` and `±Infinity` become
`null`, `-0` becomes `0`, and a `Map` or `Set` becomes `{}`. So a value and
its JSON round trip give the same string. No Unicode normalization.

Throws a `TypeError` for a top-level `undefined`, function or symbol, a
cyclic value, or a `BigInt`, and a `RangeError` ("nested deeper than 256
levels") for a value nested more than 256 levels of objects and arrays deep.
The limit is fixed, not the engine's stack size, so a chain that verifies on one
machine verifies on every other.

### `sha256Hex(input)`

`Promise<string>`: SHA-256 of the UTF-8 bytes of `input`, as 64 lowercase
hex characters, using `globalThis.crypto.subtle`. Rejects with a
`TypeError` for a non-string input and with an `Error` if Web Crypto is
missing. Tested on Node 20, 22, 24 and 26; other runtimes that expose
`crypto.subtle.digest` should work but are not tested here.

### `GENESIS_HASH`

`"0".repeat(64)`: the `prevHash` of the first entry of every chain.

### `FORMAT_VERSION`

`"audit-chain-kit/v1"`: the fixed tag `appendEntry` writes into every
entry's `formatVersion` field, and the only value `verifyChain` accepts
there. Compare against it if you write your own tooling around stored
chains.

### `sha256HexNodeFallback(input)` from `audit-chain-kit/hash-node-fallback`

Same contract and same output as `sha256Hex` (tested, including non-ASCII
and lone surrogates), using `node:crypto`. For Node-like runtimes without
`globalThis.crypto.subtle`; you do not need it on Node 20 or later. The
main entry never imports it.

```js
import { appendEntry, canonicalJSON, verifyChain } from "audit-chain-kit";
import { sha256HexNodeFallback } from "audit-chain-kit/hash-node-fallback";

const chain = await appendEntry([], { a: 1 }, canonicalJSON, sha256HexNodeFallback);
console.log((await verifyChain(chain, undefined, { hash: sha256HexNodeFallback })).valid); // true
```

### Types

`ChainRecord<T>` (`formatVersion`, `index`, `payload`, `prevHash`,
`createdAt`), `ChainEntry<T>` (a record plus `entryHash`), `ChainAnchor`
(`{ index, entryHash }`), `Canonicalizer` (`(value: unknown) => string`),
`Hasher` (`(input: string) => Promise<string>`), `VerifyOptions` and
`VerifyResult` (`valid`, `brokenAtIndex`, `reason`, `entriesChecked`). For the
store-backed API: `ChainHead`, `ComputeEntryInput`, `ChainVerifier`,
`ChainVerifierOptions`, `ChainVerifierResult`, `MarkedGap`, `SplitResult`,
`AppendStore`, `StoreHeadResult`, `StoreAppendResult`, `AppendOutcome`.

## Store-backed appends and streaming verification

`appendEntry` and `verifyChain` work on an array in memory and stamp entries
with the local clock. A real log lives in a database, which holds the lock,
the last hash and the clock. These functions let the database do that and keep
the hashing in one place. Nothing here talks to a database; you supply two
small functions.

```ts
import {
  appendToStore, computeEntry, createChainVerifier, splitValidPrefix,
  type AppendStore,
} from "audit-chain-kit";
```

### `computeEntry({ prevHash, index, payload, createdAt })`

Returns the entry with its `entryHash`, using the canonical form above:
`Promise<Readonly<ChainEntry<T>>>`, frozen, identical to what `appendEntry`
would produce for the same inputs. `createdAt` is a string you pass in (your
store's clock); there is no default and it never reads `Date`. It is hashed
exactly as given, so store and re-read the same text. The payload rules are
`appendEntry`'s (plain JSON data); a bad payload, a blank `createdAt` or an
`index` that is not a non-negative safe integer throws a `TypeError`.
Optional second argument: `{ canonicalize, hash }`.

### `createChainVerifier({ from?, allowMarkedGaps?, hash?, canonicalize? })`

Verifies a chain a page at a time, so you can read a table through a cursor
without loading it. Memory stays constant however many entries you push.

```ts
const verifier = createChainVerifier({ from: savedHead, allowMarkedGaps: false });
let after = savedHead.index;
for (;;) {
  const rows = await db.rowsAfter(after, 1000);      // your query, ordered by index
  if (rows.length === 0) break;
  for (const row of rows) await verifier.push(toEntry(row));
  after = rows[rows.length - 1].index;
}
const result = await verifier.finish();
```

- `push(entry)` resolves `true` while the chain is intact and `false` once it
  is not; after the first break nothing more is hashed. Pushes are queued in
  order, so you can issue a page and await them together.
- `finish()` returns `{ status, valid, brokenAtIndex, reason, entriesChecked,
  head, gaps }`. `status` is `"valid"`, `"broken"` (positive evidence, with the
  first break's position and reason) or `"error"` (your `hash` or
  `canonicalize` function threw; that says nothing about the chain, and the
  thrown value is in `error`). `head` is `{ index, hash }` of the last
  accepted entry: save it as the next run's `from`, and compare it with a head
  you keep elsewhere to see a truncated tail.
- `from` is `{ index, hash }` of the entry just before the first one you push.
  Leave it out to start at the beginning (`GENESIS_HEAD` is
  `{ index: -1, hash: GENESIS_HASH }`). A wrong `from` fails at the first
  entry. It only helps if you keep it somewhere the log's writer cannot change.
- Positions stop at 2^53 - 1: after an entry at that index (a gap record can
  reach it), the next entry is a break, because larger integers repeat.
- Each entry is read once, by property descriptor, when you call `push`:
  getters, `toJSON` and Proxy traps are never run for you, and an entry that is
  not exactly its JSON form is a break (the same check `verifyChain` makes).
  Read your database rows into plain objects first, and turn a `bigint` id
  column into a `number` (node-postgres returns it as a string, which fails
  verification).

`splitValidPrefix(entries, options?)` runs the same checks over an array and
returns `{ valid, rest, firstBreak }`: the longest valid prefix, everything
from the first break on (unverified), and `{ index, reason }` for the break or
`null`. It is for repair tooling. It never changes its input. Every element is
read once; one that throws when read (a getter, a Proxy trap) appears in `rest`
as `{ unreadable: true, arrayIndex }` (type `UnreadableEntry`) instead of
costing you the rows after it, and holes in a sparse array are left out. `rest`
is in index order. If the array's keys cannot be listed (a Proxy whose `ownKeys`
throws) the indexes are read one by one, up to 1,000,000, skipping holes; past
that `restComplete` is `false` and `rest` may be shorter than the input.
`restComplete` is also `false` when the array's length cannot be read or a hole
check throws, so it is `true` only when every index was accounted for. Recovery
from Proxies and other exotic arrays is best effort: pass plain arrays.

### Marked gaps

A gap record is an ordinary entry that says "positions `from` to `to` hold no
entries", for a restore or outage that lost rows you cannot recover. Build the
payload with `gapPayload({ reason, from, to })` and give the entry
`index = to + 1` (or call `appendGapToStore(store, { reason, count })`, which
computes both; the store must be typed `AppendStore<YourPayload | GapPayload>`
and the outcome's entry is typed `GapPayload`). Its payload is exactly
`{ kind: "audit-chain-kit/gap", reason, from, to }`.

- With `allowMarkedGaps: true`, the verifier accepts a gap record whose range is
  exact (`from` is the next unfilled position, `to` is at least `from`, and the
  record sits at `to + 1`) and lists it in `result.gaps` as
  `{ atIndex, from, to, reason }`.
- With `allowMarkedGaps` false or left out, a gap record is a break.
- A jump in `index` with no gap record is always a break, and so is a gap
  record whose range does not match its position.
- The string `audit-chain-kit/gap` as a payload `kind` is reserved. Anyone who
  can write to the log can write a gap record, so turning the option on means
  trusting them as much as you trust the rest of the log. A gap record cannot
  say who deleted what, only that the log admits a hole. Show `reason` only
  after escaping it: it is free text.

### `AppendStore` and `appendToStore(store, payload, options?)`

```ts
interface AppendStore<T> {
  readHead(): Promise<
    | { status: "ok"; head: { index: number; hash: string }; now: string }
    | { status: "unavailable"; reason?: string }>;
  appendIfHead(input: { expectedHead: { index: number; hash: string }; entry: ChainEntry<T> }): Promise<
    | { status: "appended" } | { status: "conflict" } | { status: "unavailable"; reason?: string }>;
}
```

`readHead` returns the newest entry (or `GENESIS_HEAD`) and the store's clock
in the same call. `appendIfHead` writes the entry only if the head is still
`expectedHead`, as one atomic step; if another writer got there first it
returns `conflict` and writes nothing.

`appendToStore` reads the head and clock, computes the entry, calls
`appendIfHead`, and on `conflict` re-reads and tries again, up to
`maxAttempts` (default 5, at most 100). It returns
`{ status: "appended", entry, attempts }`, `{ status: "conflict", attempts }`
once the attempts are used up, or `{ status: "unavailable", attempts, reason }`.
It fails closed: a store that returns `unavailable`, throws, rejects or answers
with anything unexpected gives `unavailable` and the entry is not reported as
written. It does not retry an `unavailable` (the store could not say whether the
write happened). An answer that cannot be read (a getter or Proxy trap that
throws) counts as `unavailable` too, on the head read and after the write. A payload that is not plain JSON data throws, as in
`appendEntry`. The name differs from `appendEntry` because that one stays as it
is.

`createMemoryAppendStore({ now })` is an in-memory store for tests and
examples. It is not durable and is not a model of a real database's failure
modes; there is no conformance suite in this package.

### Postgres recipe

Text only: this package has no SQL and no driver, and nothing in this repo's
tests talks to a database. The statements below were run once by hand against
PostgreSQL 17 (the stale-head and race cases returned zero rows and a `23505`
as described); adapt them to your schema and driver and test them there.

Table, with two unique constraints doing the real work: one position per
index, and one successor per entry (so two writers cannot fork the chain, even
across a gap record):

```sql
create table audit_log (
  idx         bigint primary key,
  prev_hash   text   not null unique,
  entry_hash  text   not null unique,
  created_at  text   not null,   -- the exact string that was hashed, not a timestamptz
  payload     jsonb  not null    -- jsonb rejects U+0000 in strings; use text if you cannot rule that out
);
```

`readHead`: one query returns the head and the clock, so the clock is read
after the head it attaches to (database time, not application time). Format
the clock as one fixed text shape and use the same text for `createdAt`:

```sql
select coalesce(max(idx), -1) as idx,
       coalesce((select entry_hash from audit_log order by idx desc limit 1), repeat('0', 64)) as hash,
       to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as now
from audit_log;
```

`appendIfHead`, option A (conditional insert, no lock held across your
application's hashing): insert only if the head is still what you read. Zero
rows returned, or a unique violation (`23505`), is `conflict`; a connection
error or timeout is `unavailable`:

```sql
insert into audit_log (idx, prev_hash, entry_hash, created_at, payload)
select $1, $2, $3, $4, $5
where coalesce((select max(idx) from audit_log), -1) = $6          -- expectedHead.index
  and coalesce((select entry_hash from audit_log order by idx desc limit 1), repeat('0', 64)) = $2
returning idx;
```

Option B (advisory lock): in a transaction, `select pg_advisory_xact_lock(<key>)`
first, then read the head and the clock, compute, insert and commit. The clock
is then read after the lock is held, so no other writer can commit between the
read and the insert. This keeps the lock open while your code hashes, so keep
that window short, and a store written this way holds the transaction between
`readHead` and `appendIfHead`.

To verify from the table, read rows `where idx > $after order by idx limit
1000`, map each to `{ formatVersion, index: Number(idx), payload, prevHash:
prev_hash, createdAt: created_at, entryHash: entry_hash }`, and push them as
shown above. The hash can also be recomputed in SQL; see
[docs/CANONICAL-FORM.md](docs/CANONICAL-FORM.md).

## Honest limits

- **No key and no signatures.** Whoever can write the stored chain can
  rewrite it undetectably unless the verifier holds an anchor from outside
  that writer's control. `expectedMinLength` does not help against someone
  who truncates and appends.
- **Streaming verification has the same limits as `verifyChain`.** A valid
  result means the pushed entries are consistent with each other and with
  `from`. It does not detect a truncated tail or a fully recomputed rewrite
  unless you compare `head` with one you kept outside the writer's control. The
  atomic "append only if the head is unchanged" step belongs to your database;
  `createMemoryAppendStore` and the tests here do not prove it holds under real
  concurrency, and no fault-injection suite for a real database is included.
  Marked gaps are accepted only when you turn them on, and a gap record is as
  forgeable as any other entry by someone who can write the log.
- **Chains are not bound to an identity.** Every chain starts from the same
  `GENESIS_HASH`, so a whole valid chain from one log can be presented as
  another log's. If you keep several chains, put a log id in every payload,
  or keep an anchor per chain.
- **Timestamps are claims.** `createdAt` is hashed, so it cannot be changed
  later without detection, but nothing checks that it was accurate or that
  timestamps increase. With `appendToStore` the time is whatever your store's
  `readHead` returned; using the database's clock makes it one clock, not a
  trusted one.
- **What is hashed is the JSON form.** `canonicalJSON` is lossy in the same
  ways as `JSON.stringify` (`NaN` becomes `null`, a `Map` becomes `{}`,
  `undefined` fields disappear). `appendEntry` and `verifyChain` therefore
  refuse an in-memory payload or entry that JSON would change, so what you
  hold is what was hashed (see `appendEntry` and `verifyChain` above). Convert
  such values yourself first. `-0` is accepted and hashes as `0`.
- **The faithfulness check reads descriptors, not values, and cannot see through a
  Proxy.** It never runs a getter, `toJSON` or `valueOf`, and it rejects a
  `toJSON` anywhere on a prototype chain, objects whose prototype is not
  `Object.prototype` (any realm) or null, and objects that carry internal data
  JSON ignores (boxed primitives, Date, Map, Set, RegExp, ArrayBuffer, typed
  arrays, even with the prototype removed; the one gap is a Map, Set, WeakMap,
  WeakSet or ArrayBuffer that was deliberately given `Object.prototype` as its
  prototype or has own enumerable properties, which is not detected, because
  telling those apart takes a throwing probe that is too slow to run on every
  object). Arrays longer than 50,000 elements are checked by counting enumerable keys, because listing every key of a huge array can exhaust the heap; a non-enumerable named property on such an array is not detected. A Proxy whose traps answer a
  descriptor query differently from a value read can still show the check one
  object and the hash another. Do not pass Proxies you do not control.
- **Verification is over parsed JSON values, not bytes.** `verifyChain` sees
  the result of `JSON.parse` (or your live objects), never the stored text, so
  stored text that parses to the same values verifies even though the bytes
  differ. Known cases: `-0` where `0` was hashed; a repeated object key (the
  last one wins, so `{"by":"a","by":"b"}` reads as `b`); any spelling of the
  same number (`1.50`, `1E2`); different escapes of the same string; whitespace
  and key order. Integers beyond 2^53 are read as the nearest double, so a
  stored `9007199254740993` and `9007199254740992` are the same value to
  `verifyChain`, and an implementation in another language that keeps exact
  integers will compute different bytes (a false failure, not a false pass).
  Keep payload integers within ±(2^53 - 1) or store large ones as strings. A
  stored `1e999` parses to `Infinity` and is reported invalid, not read as
  `null`. If you need byte-exact integrity of the stored text, hash the text
  itself (for example, anchor a SHA-256 of the exported file).
- **A format tag, not a migration path.** Every entry's hash includes
  `formatVersion: "audit-chain-kit/v1"`, so a future format change gets a
  new tag instead of quietly producing hashes that look like this one, and
  `verifyChain` rejects a chain written with a missing or different
  `formatVersion`. There is no reader that accepts multiple format versions
  or migrates an old chain forward; that would be new code, not written
  here. Changing the record fields or the canonicalizer still changes every
  hash, tag or no tag.
- **Custom canonicalizers.** Both hashers encode a lone surrogate as U+FFFD,
  so `"\ud800"` and `"\ufffd"` hash the same. `canonicalJSON` escapes lone
  surrogates, so this only matters if your canonicalizer emits them.
- **Mutating a chain during a call.** `verifyChain` and `appendEntry` decide
  from a copy of the array and of each entry's fields taken before their first
  `await`, so changes to the array, entries or anchor during the call cannot
  change the result. Payloads are not deep-copied: they are read by reference
  when canonicalized, and the payload of an appended entry is stored by
  reference. The result says nothing about what the stored chain looks like
  after the call returns. This is not a transaction and does not stop another
  process from writing.
- **Cost and size.** `verifyChain` rehashes every entry from 0 on every
  call, and holds one shallow copy of each entry while it runs (measured with
  20,000 small entries on Node 26.3.0: about 216 ms before the snapshot change
  and 217 ms after; one machine, not a benchmark suite). Checking that each
  entry is plain JSON data adds one more pass over every entry; in isolation it
  took about 0.5 s of CPU for a payload array of one million numbers. Verifying
  20,000 small entries took 1.1 to 1.7 s of CPU before and 0.6 to 1.7 s after on a
  heavily loaded machine (Node 26.3.0, five runs each), so no slowdown showed
  above the noise; this is not a benchmark.
  Nesting is limited to 256 levels of objects and arrays per entry (255 inside a
  payload, because the entry itself is the first level). The limit is a fixed
  number so the verdict does not depend on the engine's stack size: a deeper
  payload is refused by `appendEntry`, reported invalid by `verifyChain`, and
  makes `canonicalJSON` throw a `RangeError` that names the limit. Before this
  limit, the same payloads threw the engine's stack-overflow `RangeError` at an
  engine-dependent depth (on Node 26, 1,000 levels worked and 5,000 threw).

## Relationship to sibling kits

[agent-receipt-kit](https://github.com/lkopietz3-byte/agent-receipt-kit)
checks whether an autonomous agent's self-reported claim matches what it was
authorized to do and what a caller-supplied observation shows. It does not know
about hash chains, and this package does not know what a receipt is. The
result of `verifyReceipt` (or the work packet it checked) is a natural payload
for `appendEntry`, if it contains only values `canonicalJSON` can represent.
The chain then lets anyone who holds it detect an edit to that record made
without recomputing the hashes. It does not make an accepted receipt true (that
kit says what `accepted` covers), it does not say who appended the entry, and
`createdAt` is the appender's own clock. Neither package depends on the other;
combining them is a matter of passing one library's plain output as the other's
input.

## Where this came from

Generalized from the audit log in the author's `forensic-report-tool`
project, which uses the same construction: `prevHash` is a hashed field, the
canonical JSON has sorted keys, and `entryHash` is the SHA-256 of everything
except `entryHash`. This is new code, not a copy of that file.

## Development

```bash
npm ci
npm run verify   # lint, typecheck, test, build, then pack and test the installed tarball
```

## License

MIT
