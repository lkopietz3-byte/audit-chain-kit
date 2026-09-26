# audit-chain-kit

Build and verify SHA-256 hash chains over audit records, in TypeScript,
with zero runtime dependencies. Each entry's hash covers its content and the
previous entry's hash, and `verifyChain` recomputes every hash from the
first entry. The verifier uses only Web Crypto, so someone checking a chain
does not have to run your code or trust your server to recompute it.

ESM only. Node 20 or later. MIT licensed.

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
  on an in-memory array and does not serialize writers (see
  [reference-impl](#reference-impl)).
- You need to prove one entry is in a log without handing over the whole
  chain (inclusion proofs). This is a linear chain, not a Merkle tree, and
  `verifyChain` always walks from entry 0.

## Install

Not published to npm yet. Install from GitHub (the repository is private
for now, so this needs access to it):

```bash
npm install github:lkopietz3-byte/audit-chain-kit
```

A git install runs the package's `prepare` script, which builds `dist/`
with TypeScript. (Checked with an equivalent local `git+file:` install on
npm 11.16, which prints an `allow-scripts` warning and still builds.)

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

Each entry is `{ index, payload, prevHash, createdAt, entryHash }`, where

```
entryHash = lowercase hex SHA-256 of the UTF-8 bytes of
            canonicalJSON({ createdAt, index, payload, prevHash })
```

`index` is the entry's position (from 0), `prevHash` is the previous
entry's `entryHash` (or `GENESIS_HASH`, 64 zeros, for the first entry) and
`createdAt` is `new Date().toISOString()` at append time. `prevHash` is a
field inside the hashed JSON, not a string glued onto it, so field
boundaries cannot be confused.

Test vector (from `test/vectors.test.ts`): this record string

```
{"createdAt":"2026-01-01T00:00:00.000Z","index":0,"payload":{"action":"report.created","by":"user_1"},"prevHash":"0000000000000000000000000000000000000000000000000000000000000000"}
```

has `entryHash` `65e663a7038e462487c6626b4b5ed03dd7c7d58d37ff2e332c6e0f0aac77cd94`
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
  inspected (the chain is not re-verified).
- `payload`: any value `canonicalJSON` accepts. It is stored by reference
  and not frozen, so mutating it afterwards makes the entry fail
  verification. Clone it first if you reuse the object.
- `canonicalize`: defaults to `canonicalJSON`. Use the same one for every
  append and verify of a chain.
- `hash`: defaults to `sha256Hex`.

Throws a `TypeError` if `chain` is not an array or its last entry has no
string `entryHash`, and a `RangeError` if the last entry's `index` is not
its position (for example, you passed only the tail). Errors from
`canonicalize` or `hash` propagate.

### `verifyChain(chain, canonicalize?, options?)`

Returns `Promise<{ valid: boolean; brokenAtIndex: number | null; reason: string | null }>`
describing the first problem found.

For each entry in order it checks that the entry is an object with string
`prevHash` and `entryHash`; that `prevHash` equals the previous entry's
`entryHash` (or `GENESIS_HASH`); that `entryHash` equals the recomputed hash
of the entry minus `entryHash` (so a changed, added or removed field
fails); and that `index` equals the position. A non-array `chain` returns
`{ valid: false, brokenAtIndex: null, reason: "chain is not an array" }`.

`options`:

- `expectedMinLength`: a non-negative integer. A shorter chain is invalid.
  This only catches entries deleted from the end if nobody appended new
  ones afterwards; anyone can append.
- `anchor`: `{ index, entryHash }` (any `ChainEntry` fits). The chain must
  have an entry at `anchor.index` with exactly that `entryHash`.
- `hash`: the hash function used to append. Defaults to `sha256Hex`.

A malformed `expectedMinLength` or `anchor` throws a `TypeError` (a bug in
the caller, not a property of the chain). Errors from `canonicalize` or
`hash` propagate.

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

`ChainRecord<T>` (`index`, `payload`, `prevHash`, `createdAt`),
`ChainEntry<T>` (a record plus `entryHash`), `ChainAnchor`
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
- **No version tag in the hash input.** Changing the record format or the
  canonicalizer changes every hash; there is no field that says which
  format a chain uses.
- **Custom canonicalizers.** Both hashers encode a lone surrogate as U+FFFD,
  so `"\ud800"` and `"\ufffd"` hash the same. `canonicalJSON` escapes lone
  surrogates, so this only matters if your canonicalizer emits them.
- **Cost and size.** `verifyChain` rehashes every entry from 0 on every
  call. Very deeply nested payloads overflow the call stack (on Node 26,
  1,000 levels worked and 5,000 threw a `RangeError`).

## reference-impl

`reference-impl/postgres-advisory-lock-append.sql` shows one way to stop two
concurrent appends from forking a Postgres-backed chain: a
transaction-scoped advisory lock (`pg_advisory_xact_lock`) held across the
"read the last hash" query and the insert, plus a unique `(chain_id, idx)`
constraint. It is **not** compatible with `verifyChain`: it hashes
`sha256(prev_hash || canonical_json)` instead of the record format above,
does not hash `idx`, `chain_id` or `created_at`, and does not store the
hashed bytes. It is not tested in this repository and is not included in
the package. Read it as an illustration of the locking pattern only.

## Where this came from

Generalized from the audit log in the author's `forensic-report-tool`
project, which uses the same record shape (`prevHash` as a hashed field,
key-sorted canonical JSON). This is new code, not a copy of that file.

## Development

```bash
npm ci
npm run verify   # lint, typecheck, test, build, then pack and test the installed tarball
```

## License

MIT
