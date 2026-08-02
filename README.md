# audit-chain-kit

A small, dependency-free TypeScript library for append-only, hash-chained
audit logs — plus a verifier meant to be run by someone who does **not**
trust you.

Zero runtime dependencies. ESM only. MIT licensed.

## What this is honestly, not what it sounds like

**The hash-chain append pattern itself is common — this library does not
claim otherwise.** `entry_hash = sha256(prev_hash + canonicalJSON(record))`
is, as of 2026, one of the most commoditized ideas in AI/dev tooling: 20+
near-identical open-source implementations exist. `halo-record` (61 GitHub
stars) uses this exact formula. `AgentLens`, `ai-audit-trail`, `Tesserae`,
`capsule`, and `GoLogX` all implement variations on the same idea. If you
came here looking for a novel tamper-evidence algorithm, this isn't one —
nobody's is, at this point; it's a solved, well-understood pattern and
you should feel free to treat it as a commodity.

**What's less common, and what this library actually leads with, is
`verifyChain` as a standalone, zero-dependency, independently-runnable
artifact meant for a skeptical THIRD PARTY — not the chain's own operator —
to execute themselves.** Most of the 20+ comparable projects are libraries
*you* install to write and check *your own* chain; you run the verifier on
your own infrastructure, with your own trust in your own process. Fewer of
them explicitly ship a verifier designed for the other direction: someone
who received a chain from you and does not want to trust your server, your
database, or your npm registry account — just Web Crypto and a copy of a
few small functions they can read in one sitting. That's the actual reason
`verifyChain` exists as its own exported function using only
`globalThis.crypto.subtle`, with no import of any kind, rather than being
folded into a "verify chain, but only if you trust our SDK" story. Ship the
chain plus this file (or its ~80 lines, pasted) to the third party, and they
never have to run `npm install` or trust anything about you to check your
work.

So: treat the append/hash-chain half of this package as infrastructure —
useful, not a differentiator, don't market it as one. The verifier's
third-party-runnable framing is the one part worth calling out.

## Install

```bash
npm install audit-chain-kit
```

## API

### `appendEntry(chain, payload, canonicalize?, hash?)`

Pure function. Computes `entryHash` from `prevHash` + `canonicalize(record)`,
where `record = { index, payload, prevHash, createdAt }`. Returns a **new**
(frozen) array — does not mutate the `chain` you passed in.

```ts
import { appendEntry, verifyChain } from "audit-chain-kit";

let chain = await appendEntry([], { action: "report.created", by: "user_1" });
chain = await appendEntry(chain, { action: "report.exported", by: "user_1" });
```

- `canonicalize` (optional) — defaults to `canonicalJSON` (recursive
  key-sorted JSON serialization). Override this if you need different
  serialization semantics, but use the SAME canonicalizer for every append
  *and* every verify of a given chain — mixing them breaks the chain.
- `hash` (optional) — defaults to `sha256Hex` (Web Crypto). You will not
  normally override this on the append side; it exists mainly so tests and
  the Node fallback (below) can swap it in.

### `verifyChain(chain, canonicalize?, options?)`

The third-party verifier. Walks the entire chain from genesis, independently
recomputing every hash.

```ts
const result = await verifyChain(chain);
// { valid: boolean, brokenAtIndex: number | null, reason: string | null }
```

Detects:

| Tamper mode | How it's detected |
| --- | --- |
| Mutated payload (or any field) on an entry | recomputed `entryHash` no longer matches the stored one |
| Severed link / reordered entries | an entry's `prevHash` no longer equals the preceding entry's `entryHash` |
| An entry spliced out of the middle | same as above — the successor's `prevHash` now points at a hash that isn't the new preceding entry's hash |
| Entries deleted from the **end** of the chain | invisible to the walk above (nothing after a tail deletion to notice a broken pointer) — pass `options.expectedMinLength` (from a count you stored separately) to catch this |

```ts
// Catches a tail truncation that a plain structural walk cannot see:
await verifyChain(chain, undefined, { expectedMinLength: 42 });
```

This proves the chain you were handed is internally consistent and
unaltered *since it was hashed*. It does **not** prove nobody with write
access to the origin ever rewrote the whole chain from genesis and handed
you a self-consistent fake — that's what "tamper-evident, not tamper-proof"
means, and it's true of every hash-chain scheme, not a limitation specific
to this one.

### Web Crypto only — the one runtime-specific exception

`sha256Hex` (the default hasher, in `src/hash.ts`) uses
`globalThis.crypto.subtle` and imports nothing. This works unmodified in
every modern browser, Deno, Bun, Cloudflare Workers, and **Node 19+**
(Node has exposed Web Crypto as a global since v19 — no flag needed since
v20). `test/chain.test.ts` includes a source-scan assertion that
`src/hash.ts` and `src/chain.ts` contain no `node:crypto` import, so this
stays true.

If you must support a runtime old enough or locked-down enough that
`globalThis.crypto.subtle` genuinely isn't available (and can't be
polyfilled), a Node fallback is provided as a **separate, explicitly-opted-in
module** — the one place in this package that touches `node:crypto`:

```ts
import { verifyChain } from "audit-chain-kit";
import { sha256HexNodeFallback } from "audit-chain-kit/hash-node-fallback";

await verifyChain(chain, undefined, { hash: sha256HexNodeFallback });
```

It is never imported by `index.ts`, so a bundler targeting a Node-free
runtime never pulls `node:crypto` in unless you reach for it explicitly.

## `reference-impl/postgres-advisory-lock-append.sql`

`appendEntry` is an in-memory pure function — fine for a single process,
not fine the moment two callers can append to the *same* chain concurrently
against a shared database. The naive "SELECT prev_hash, then INSERT" has a
race: two concurrent callers can read the same `prev_hash` and both insert,
forking the chain into two branches that each look internally valid to
`verifyChain`.

`reference-impl/postgres-advisory-lock-append.sql` is a documented reference
implementation that closes that race with a **transaction-scoped Postgres
advisory lock** (`pg_advisory_xact_lock`, keyed per chain, auto-released at
commit/rollback) spanning the prev-hash `SELECT` and the `INSERT`. This
correctness detail — the actual concurrency-safe version, not just the
easy in-memory example — is the kind of thing many of the 20+ simple
hash-chain examples out there skip. It generalizes a pattern used in one of
the author's own production codebases (a Supabase RPC doing the same
lock-then-read-then-write); the SQL here is rewritten as a standalone
schema + function, not copied from anywhere.

## Where this came from

Distilled from two of the author's private codebases: an append-only
hash-chained log with `Object.freeze`'d events and a Node-side verifier, and
a *separate*, dependency-free Web-Crypto reimplementation of the same
verification logic meant to be run by a third party who doesn't trust the
originating server. This package generalizes both patterns (plus a
concurrency-safe Postgres append pattern from a second codebase) into a
standalone, non-proprietary library — it is new code, not an extraction of
either original file, and has not yet been wired back into either source
project.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build        # emit dist/
```

## License

MIT
