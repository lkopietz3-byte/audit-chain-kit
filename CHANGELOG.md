# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-27

First release. Not published to npm; install from GitHub.

### Added

- `appendEntry(chain, payload, canonicalize?, hash?)`: returns a new frozen
  chain with one entry whose `entryHash` is the SHA-256 of
  `canonicalJSON({ createdAt, formatVersion, index, payload, prevHash })`.
- `verifyChain(chain, canonicalize?, options?)`: recomputes every link and
  hash from genesis, checks each entry's `formatVersion` against
  `FORMAT_VERSION`, and checks each `index` against its position. Options:
  `expectedMinLength`, `anchor` (`{ index, entryHash }` held outside the
  writer's control; the only way to detect a rewrite or truncate-and-append),
  and `hash`.
- `canonicalJSON`: key-sorted JSON that applies `JSON.stringify`'s
  conversions first, so a value and its JSON round trip hash the same.
- `sha256Hex` (Web Crypto) and `sha256HexNodeFallback` (`node:crypto`, in
  the `audit-chain-kit/hash-node-fallback` subpath), with identical output.
- `GENESIS_HASH`, `FORMAT_VERSION` (`"audit-chain-kit/v1"`, the
  format-and-domain tag hashed into every entry) and the types
  `ChainRecord`, `ChainEntry`, `ChainAnchor`, `Canonicalizer`, `Hasher`,
  `VerifyOptions`, `VerifyResult`.

### Changed before release (differences from the pre-release code)

- `canonicalJSON` no longer emits `undefined` or `{}` for values
  `JSON.stringify` converts (such as `undefined` fields and `Date`s); plain
  JSON values hash exactly as before.
- `appendEntry` returns `readonly` types matching the frozen values
  (TypeScript only), and throws on a partial or malformed chain.
- `verifyChain` returns `valid: false` for a non-array chain, rejects
  entries whose `index` is not their position, and throws a `TypeError` for
  a malformed `expectedMinLength`.
- Both hashers reject non-string input with a `TypeError`.
- Every entry's hashed record now includes `formatVersion: "audit-chain-kit/v1"`
  (exported as `FORMAT_VERSION`), so a future format change gets a new tag instead
  of silently producing hashes that look like this format, and so this
  package's `entryHash` can't be confused with another hash-chain library's
  digest of the same bytes. This changes every `entryHash`, including the
  golden vectors in `test/vectors.test.ts` (recomputed and re-verified
  independently with `shasum` and Python's `json.dumps`). `verifyChain`
  rejects an entry whose `formatVersion` is missing or different, with a
  reason that names `formatVersion`, and does not throw.
- `reference-impl/` (the Postgres advisory-lock SQL) is deleted. It hashed
  `sha256(prev_hash || canonical_json)`, a different formula from this
  package's, so it was never compatible with `verifyChain`, was never
  shipped in the npm package, and had no Postgres test harness in this
  repository to make it right. Labeling it as incompatible (0.1.0, earlier
  in this section) was a stopgap; deleting it removes a file that could
  only mislead a reader into using its formula.
