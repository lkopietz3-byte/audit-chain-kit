# Engineering contract

## Invariants (each is covered by tests in `test/`)

- `entryHash` = lowercase hex SHA-256 of the UTF-8 bytes of
  `canonicalize({ createdAt, index, payload, prevHash })`. Golden vectors in
  `test/vectors.test.ts` pin the exact bytes.
- Entry 0 has `prevHash === GENESIS_HASH` (64 zeros); entry `i` has
  `prevHash === chain[i - 1].entryHash` and `index === i`.
- `canonicalJSON(v) === canonicalJSON(JSON.parse(JSON.stringify(v)))` for
  every `v` it accepts; key order never changes the output.
- `sha256Hex` and `sha256HexNodeFallback` return identical digests for every
  string and both reject non-strings.
- `verifyChain` fails closed: a malformed chain returns `valid: false`; a
  malformed option throws. It never reports valid for a chain it did not
  fully walk.
- Zero runtime dependencies. Only `src/hash-node-fallback.ts` imports a Node
  built-in, and `src/index.ts` never imports it (source-scan tests).

## What is not claimed

- Detection of a rewrite, or of truncate-then-append, without an anchor held
  outside the writer's control. There is no key.
- Anything about who wrote an entry or whether `createdAt` is accurate.
- Compatibility of `reference-impl/*.sql` with `verifyChain` (it is not
  compatible, not tested, and not shipped).
- Runtimes other than Node 20, 22, 24 and 26.
- Equivalence with RFC 8785 (JCS) or any other canonical JSON scheme.

## Set up and verify

```bash
npm ci
npm run verify          # lint, typecheck (src + test), test, build, verify:package
npm run audit:dependencies
```

`verify:package` packs the tarball, installs it in a clean temp project,
imports both entry points by name, compares exports with `api-surface.json`,
runs `scripts/consumer-probe.mjs` and type-checks `scripts/consumer-probe.mts`
under strict NodeNext. If the export list changes on purpose, run
`node scripts/verify-package.mjs --update-api` and review the diff.

## Compatibility rule

Any change to the record fields, `canonicalJSON` output, or the hash
changes every `entryHash`, so existing chains stop verifying. Treat it as a
breaking change: the golden vector test must fail first, then be updated in
the same commit with a CHANGELOG entry.

## Release and rollback

Not published. Before a first `npm publish`: run `npm run verify`, set the
CHANGELOG date, tag `v0.1.0`. To roll back a bad release, deprecate the
version (`npm deprecate`) and publish a fixed patch; do not unpublish a
version that others may have used to write chains.
