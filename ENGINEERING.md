# Engineering contract

## Invariants (each is covered by tests in `test/`)

- `entryHash` = lowercase hex SHA-256 of the UTF-8 bytes of
  `canonicalize({ createdAt, formatVersion, index, payload, prevHash })`.
  Golden vectors in `test/vectors.test.ts` pin the exact bytes.
- Every entry's `formatVersion` is exactly `FORMAT_VERSION`
  (`"audit-chain-kit/v1"`). `appendEntry` always writes it; `verifyChain`
  rejects a missing or different value with a reason naming
  `formatVersion`, checked before the hash is recomputed, and never throws
  for this.
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
- A migration path between format versions. `verifyChain` only accepts the
  current `FORMAT_VERSION`; reading an older or newer format is not
  implemented.
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

## Are the types wrong? (attw)

CI runs [`arethetypeswrong`](https://github.com/arethetypeswrong/arethetypeswrong.github.io)
(`npm run attw`, which is `attw --pack . --ignore-rules cjs-resolves-to-esm --profile node16`)
against the packed tarball after the build step. The `cjs-resolves-to-esm` rule is ignored on
purpose: this is an ESM-only package (`"type": "module"`, no `require` entry point), so a
CommonJS consumer must use Node's `require(esm)` support (Node >=20.19 or >=22.12 — see
"Runtime support policy" below) rather than a native `require`. A dual CJS+ESM build was
rejected to avoid the dual-package hazard (two separately-identified copies of the same module,
with broken `instanceof` checks and duplicated module state across the CJS and ESM entry
points).

`attw`'s strict Node 10 resolution check currently fails for this package's `./hash-node-fallback` subpath export because there is no `typesVersions` fallback for a CommonJS-style (`moduleResolution: node`) resolver. CI runs with `--profile node16` to stay green while that's true. Fixing it needs a `typesVersions` entry in `package.json`, which ships in the npm tarball — out of scope for this repo-hygiene pass; it is planned for the per-kit follow-up pass.

## Release and rollback

`npm run verify` (lint, typecheck, test, build, verify:package) runs automatically before
publish via the `prepublishOnly` script, so a broken build cannot reach the registry by
accident. To release: add a dated entry to `CHANGELOG.md`, bump `version` in
`package.json`, commit, and push a `vX.Y.Z` tag that matches the new version, then let
`.github/workflows/release.yml` install, verify, and publish it. (You can also run
`npm publish` locally; `prepublishOnly` still guards it.)

npm's unpublish policy is deliberately narrow. Within 72 hours of publishing, a version can be
unpublished only if no other published package depends on it. After 72 hours, unpublishing also
requires fewer than 300 downloads in the last week and a single maintainer — most released
versions won't qualify either way. A given `name@version` can never be reused, published or
not, even after an unpublish. Treat unpublish as unavailable: prefer fixing forward with a new
patch version, and use `npm deprecate <name>@"<range>" "<message>"` to warn consumers off a
bad release while it stays installable for anyone already pinned to it.

### Runtime support policy

- **Supported (recommended for production):** Node 22 and 24 LTS; Node 26 current.
- **Compatibility-tested:** Node 20. Node 20 is end-of-life — nodejs.org's release page
  (<https://nodejs.org/en/about/previous-releases>) lists it as `EOL`, with its final release
  dated Mar 24, 2026. The `compat` job in `verify.yml` still runs on Node 20 to catch
  regressions, but that runtime gets no security fixes upstream; don't run production traffic
  on it.
- CommonJS `require()` of this package needs Node >=20.19 or >=22.12 (`require(esm)`
  support). ESM `import` works on every version this package tests (20, 22, 24).
- `engines` in `package.json` is unchanged by this policy.

### Publishing with provenance

`.github/workflows/release.yml` publishes using npm trusted publishing: it triggers on
`workflow_dispatch` or a pushed `v*` tag, requests a short-lived OIDC token instead of
reading a stored npm token (`permissions: id-token: write`), and runs a plain `npm publish`
with no token and no `--provenance` flag, because provenance attestation is generated
automatically under trusted publishing. Before publishing, the workflow confirms the tag
matches `package.json`'s `version` and checks whether that version is already on the
registry, so re-running it on a version that's already published is a no-op rather than an
error. Trusted publishing must be configured for this package on npmjs.com (linking it to this
GitHub repository and the `release.yml` workflow) before the first automated release will
work.
