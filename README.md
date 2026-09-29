# audit-chain-kit

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
- Several processes append to the same chain at once. `appendEntry` works
  on an in-memory array and does not serialize writers. Making concurrent,
  DB-backed appends safe (for example, a transaction-scoped lock around the
  read-last-hash-then-insert step) is your application's job; this package
  has no reference implementation for it.
- You need to prove one entry is in a log without handing over the whole
  chain (inclusion proofs). This is a linear chain, not a Merkle tree, and
  `verifyChain` always walks from entry 0.

## Install

```bash
npm install audit-chain-kit
```

Or build from source: clone the repository and run
`npm install && npm run build`. The behavior described below is version 0.2.0;
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
// { valid: true, brokenAtIndex: null, reason: null }

const tampered = JSON.parse(stored);
tampered[0].payload.by = "user_2";
console.log(await verifyChain(tampered, undefined, { anchor }));
// { valid: false, brokenAtIndex: 0,
//   reason: 'entry 0 content does not match its entryHash (a hashed field was changed, added, or removed after appending)' }
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
- `payload`: any value `canonicalJSON` accepts. It is stored by reference
  and not frozen, so mutating it afterwards makes the entry fail
  verification. Clone it first if you reuse the object.
- `canonicalize`: defaults to `canonicalJSON`. Use the same one for every
  append and verify of a chain. It must be synchronous and return a string.
- `hash`: defaults to `sha256Hex`. It must resolve to a string.

Throws a `TypeError` if `chain` is not an array, its last entry has no
string `entryHash`, `canonicalize` or `hash` is not a function, or either
returns the wrong type (for example a hasher that resolves to `undefined`,
which would otherwise be stored as an entry with no hash). It throws a
`RangeError` if the last entry's `index` is not its position (for example,
you passed only the tail). Errors thrown by `canonicalize` or `hash`
propagate.

### `verifyChain(chain, canonicalize?, options?)`

Returns `Promise<{ valid: boolean; brokenAtIndex: number | null; reason: string | null }>`
describing the first problem found.

For each entry in order it checks that the entry is an object with string
`prevHash` and `entryHash`; that `formatVersion` equals `FORMAT_VERSION`
exactly (a missing or different value fails here, with a reason naming
`formatVersion`, before the hash is even recomputed); that `prevHash`
equals the previous entry's `entryHash` (or `GENESIS_HASH`); that
`entryHash` equals the recomputed hash of the entry minus `entryHash` (so a
changed, added or removed field fails); and that `index` equals the
position. A non-array `chain` returns
`{ valid: false, brokenAtIndex: null, reason: "chain is not an array" }`, and
so does an array-like whose `length` is not a non-negative integer.

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
invisible format characters are written as `\uXXXX`, so a stored value cannot
add a line or send a terminal escape. A BigInt is `1n`. An object, symbol or
function is named ("an object"), never serialized, so a cyclic object or a
throwing `toJSON` cannot break the report. `brokenAtIndex` and the reason
still say which entry is wrong.

`options` (`undefined` or a plain object with only these keys):

- `expectedMinLength`: a non-negative integer. A shorter chain is invalid.
  This only catches entries deleted from the end if nobody appended new
  ones afterwards; anyone can append.
- `anchor`: `{ index, entryHash }` (any `ChainEntry` fits). The chain must
  have an entry at `anchor.index` with exactly that `entryHash`. `entryHash`
  must not be blank (empty, or only whitespace and invisible characters).
- `hash`: the hash function used to append. Defaults to `sha256Hex`.

These throw a `TypeError` (a bug in the caller, not a property of the chain):
`options` that is not a plain object, an unknown option key (so a typo, or an
anchor passed where the options belong, cannot silently skip the anchor
check), a malformed `expectedMinLength` or `anchor`, a `canonicalize` or `hash`
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
code unit, array order kept, no whitespace. The value is first converted
exactly as `JSON.stringify` converts it: `toJSON()` is called (a `Date`
becomes its ISO string), `undefined`, functions and symbols are dropped
from objects and become `null` in arrays, `NaN` and `±Infinity` become
`null`, `-0` becomes `0`, and a `Map` or `Set` becomes `{}`. So a value and
its JSON round trip give the same string. No Unicode normalization.

Throws a `TypeError` for a top-level `undefined`, function or symbol, a
cyclic value, or a `BigInt`.

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
`VerifyResult`.

## Honest limits

- **No key and no signatures.** Whoever can write the stored chain can
  rewrite it undetectably unless the verifier holds an anchor from outside
  that writer's control. `expectedMinLength` does not help against someone
  who truncates and appends.
- **Chains are not bound to an identity.** Every chain starts from the same
  `GENESIS_HASH`, so a whole valid chain from one log can be presented as
  another log's. If you keep several chains, put a log id in every payload,
  or keep an anchor per chain.
- **Timestamps are claims.** `createdAt` is hashed, so it cannot be changed
  later without detection, but nothing checks that it was accurate or that
  timestamps increase.
- **What is hashed is the JSON form.** `canonicalJSON` is lossy in the same
  ways as `JSON.stringify` (`NaN` becomes `null`, a `Map` becomes `{}`,
  `undefined` fields disappear). Convert such values yourself if they
  matter.
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
  and 217 ms after; one machine, not a benchmark suite). Very deeply nested payloads overflow the call stack (on Node 26,
  1,000 levels worked and 5,000 threw a `RangeError`).

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
