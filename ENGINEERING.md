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
- Snapshot before the first `await` (`test/snapshot.test.ts`): `verifyChain`
  reads the options, the anchor's `index` and `entryHash`, the array length and
  entries, and a shallow copy of each entry's fields once, and decides from
  that copy only. The anchor is compared with the `entryHash` that was
  recomputed and matched. `appendEntry` reads the length, the entries and the
  last entry's `entryHash` and `index` once and builds the result from that
  copy. Each race test parks a custom hasher on a promise it controls, mutates
  the input while the hash is pending, then releases it, so the mutation
  timing is deterministic. Payloads are read by reference and are not
  deep-copied (documented in the README).
- Error and reason text never throws and never carries raw control, bidi or
  invisible characters (`describe()` in `src/chain.ts`, `test/messages.test.ts`).
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

## Mutation testing

Run by hand, not in CI: `npm i -D --no-save @stryker-mutator/core
@stryker-mutator/vitest-runner @vitest/coverage-v8@4.1.11`, then `npx stryker run`
with an uncommitted `stryker.config.json` (`testRunner: "vitest"`,
`mutate: ["src/**/*.ts"]`). The 0.2.0 run scored 99.27% (407 of 410 mutants
killed or timed out; it was 88.85% at 0.1.1). The 3 survivors are equivalent:
`length < minLength` with `minLength` undefined (`length < undefined` is
already false), `code > 0xffff` vs `>=` in the escaper (U+FFFF is never
escaped), and the `"utf8"` argument to `createHash().update` (it is the
default encoding). v8 coverage is 100% of statements, branches, functions and
lines.

## Are the types wrong? (attw)

CI runs [`arethetypeswrong`](https://github.com/arethetypeswrong/arethetypeswrong.github.io)
(`npm run attw`, which is `attw --pack . --ignore-rules cjs-resolves-to-esm`)
against the packed tarball after the build step, and the release workflow runs
it before publishing. The `cjs-resolves-to-esm` rule is ignored on
purpose: this is an ESM-only package (`"type": "module"`, no `require` entry point), so a
CommonJS consumer must use Node's `require(esm)` support (Node >=20.19 or >=22.12 — see
"Runtime support policy" below) rather than a native `require`. A dual CJS+ESM build was
rejected to avoid the dual-package hazard (two separately-identified copies of the same module,
with broken `instanceof` checks and duplicated module state across the CJS and ESM entry
points).

`package.json` has a `typesVersions` entry for the `./hash-node-fallback` subpath so
`moduleResolution: node10` resolves its types; `attw` reports all four resolution modes
(node10, node16 from CJS, node16 from ESM, bundler) as clean without `--profile node16`.

## Release and rollback

`npm run verify` (lint, typecheck, test, build, verify:package) runs before publish via the
`prepublishOnly` script, and `.github/workflows/release.yml` also runs
`npm run audit:dependencies` and `npm run attw`. To release: add a dated entry to
`CHANGELOG.md`, bump `version` in `package.json`, commit, and push a `vX.Y.Z` tag that
matches the new version, then let the workflow install, verify, and publish it. A manual
`workflow_dispatch` run must also be started from a `v*` tag, otherwise the job fails.
The already-published check treats only a confirmed `E404` from `npm view` as "not
published yet"; any other registry error fails the job instead of guessing. (You can also
run `npm publish` locally; `prepublishOnly` still guards it.) Record the source commit, the
packed tarball hash from `verify:package`, and what the registry reports after publishing
as three separate facts; the current `main` is not necessarily what is on the registry.

npm's unpublish rules are narrow and conditional (they depend on how long ago the version
was published, on downloads and on dependents; see npm's unpublish policy), and a
`name@version` can never be reused, even after an unpublish. Treat unpublish as
unavailable: prefer fixing forward with a new patch version, and use
`npm deprecate <name>@"<range>" "<message>"` to warn consumers off a bad release while it
stays installable for anyone already pinned to it. Chains reference specific published
versions by their exact bytes, so avoid unpublishing even where the policy would allow it.

### Runtime support policy

- **Supported (recommended for production):** Node 22 and 24 LTS; Node 26 current.
- **Compatibility-tested:** Node 20. Node 20 is end-of-life — nodejs.org's release page
  (<https://nodejs.org/en/about/previous-releases>) lists it as `EOL`, with its final release
  dated Mar 24, 2026. The `compat` job in `verify.yml` still runs the tests and
  `scripts/verify-package.mjs` (which includes the CommonJS `require()` probe) on Node 20.19.0
  and 22.12.0, the `require(esm)` floors, and on Node 24, to catch regressions, but Node 20
  gets no security fixes upstream; don't run production traffic on it.
- CommonJS `require()` of this package needs Node >=20.19 or >=22.12 (`require(esm)`
  support). ESM `import` works on every version this package tests (20, 22, 24, 26).
- `engines` in `package.json` is unchanged by this policy.

### Publishing with provenance

`.github/workflows/release.yml` publishes using npm trusted publishing: it triggers on
`workflow_dispatch` or a pushed `v*` tag (both must run on a tag ref), requests a short-lived OIDC token instead of
reading a stored npm token (`permissions: id-token: write`), and runs a plain `npm publish`
with no token and no `--provenance` flag, because provenance attestation is generated
automatically under trusted publishing. Before publishing, the workflow confirms the tag
matches `package.json`'s `version` and checks whether that version is already on the
registry, so re-running it on a version that's already published is a no-op rather than an
error. Whether trusted publishing is configured on npmjs.com is a setting outside this repo
that this file cannot verify. Trusted publishing must be configured for this package on npmjs.com (linking it to this
GitHub repository and the `release.yml` workflow) before the first automated release will
work.
