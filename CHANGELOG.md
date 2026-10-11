# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The record format (`audit-chain-kit/v1`), `canonicalJSON` output and every golden
vector are unchanged, so chains written by earlier versions still verify when read
back from JSON. Some in-memory input that was accepted before is now refused (see
Changed).

### Added

Store-backed append and streaming verification. Existing functions, the record
format and every existing verdict are unchanged.

- **`computeEntry({ prevHash, index, payload, createdAt })`** returns an entry with
  its hash, using the same canonical form as `appendEntry`. `createdAt` is a string
  the caller supplies (a store's clock); it is required and never defaults to the
  local clock.
- **`createChainVerifier({ from?, allowMarkedGaps?, hash?, canonicalize? })`**, a
  streaming verifier with `push(entry)` and `finish()`, so a log can be checked
  page by page from a database cursor in constant memory. It reports the first break
  with its position and reason, a `head` to resume from or compare with a stored
  head, and every accepted marked gap. A throwing `hash` or `canonicalize` gives
  `status: "error"`, not a false verdict.
- **`splitValidPrefix(entries, options?)`** returns `{ valid, rest, firstBreak }` for
  repair tooling.
- **Marked gaps**: `gapPayload({ reason, from, to })`, `MARKED_GAP_KIND` and
  `appendGapToStore`. A gap record declares positions `from` to `to` empty and sits at
  index `to + 1`. It is accepted only with `allowMarkedGaps: true`, only when its range
  is exact, and is always listed in the result. An index jump without one is a break.
- **`AppendStore`** (`readHead`, `appendIfHead`), **`appendToStore`** (bounded retry on
  conflict, fails closed when the store is unavailable, throws or answers oddly) and
  **`createMemoryAppendStore`** (in-memory, for tests only). `GENESIS_HEAD` is the head
  of an empty chain.
- The streaming verifier treats a position past 2^53 - 1 as a break (repeated
  indexes after a maximal gap record could otherwise verify), reports a nesting-depth
  failure inside a custom `canonicalize` as `status: "error"` rather than a break, and
  `splitValidPrefix` keeps every readable row after the first break (an unreadable one
  becomes `{ unreadable: true, arrayIndex }`). `appendToStore` returns `unavailable`
  when a store's answer cannot be read, instead of rejecting.
- **`readStoredEntry(row)` and `verifier.pushRow(row)`**: a strict reader for rows read back
  from a database. It converts only exactly-representable forms (a plain decimal-string or
  bigint `index` within the safe range) and refuses the rest with a reason: a `Date` or
  number `createdAt`, upper-case hex hashes, a missing field. It never normalizes a
  timestamp or a hash's case. A refused row is a break at its position.
- **`createChainVerifier({ anchor })`**: the streaming verifier can now check an
  `{ index, hash }` checkpoint, like `verifyChain`, including with `allowMarkedGaps`.
- A hash mismatch in the streaming verifier now adds a storage hint after the usual reason when
  the entry shows a known sign of reformatting (string `index`, non-ISO or non-string
  `createdAt`, upper-case hash). `verifyChain` reasons are unchanged.
- A refused gap record's message now names the record's own index and the range it declares.
- README opening rewritten for who the kit is for and what it does not do; new
  "Retention and pruning" section; the Postgres recipe has a tested read query and the
  mistakes to avoid when writing an adapter. `docs/CANONICAL-FORM.md` states that hex case
  matters and how each field must be stored to round-trip.
- Types: `appendGapToStore` requires a store that admits `GapPayload` and returns
  `AppendOutcome<GapPayload>`; `AppendStore.appendIfHead` is declared as a function
  property so that check is strict; `splitValidPrefix` types `valid` as possibly gap
  records. `splitValidPrefix` includes non-enumerable index elements in `rest` and
  rethrows exactly what a custom `hash` or `canonicalize` threw.
- `docs/CANONICAL-FORM.md` section 4 now hashes the entry minus `entryHash` and
  checks the format version, like the package, and a test runs that example against
  tampering. `splitValidPrefix` returns `rest` in index order, reads indexes one by
  one when a Proxy's `ownKeys` throws, and sets `restComplete: false` when `rest` may
  be shorter than the input.
- **`docs/CANONICAL-FORM.md`**, the byte-level canonical form with worked examples that
  a test recomputes, and a Postgres recipe in the README (text only; no SQL or driver
  dependency).

### Fixed

- **`anchor: undefined` and `expectedMinLength: undefined` silently skipped their
  check.** A key that is present with the value `undefined` (for example, an
  anchor lookup that found nothing) switched the check off, so a rewritten or
  truncated chain verified. It now throws a `TypeError`, the same as an unknown
  option key. Leave the key out to skip the check.
- **A live entry could verify as something other than what was hashed.** The
  default canonicalizer hashes the JSON form of a value, so an in-memory entry
  holding a `toJSON` method, a function, `undefined`, a symbol, `NaN`,
  `Infinity`, a getter, a symbol-keyed or non-enumerable field, a `Map`, `Set` or
  class instance, or an array with holes verified as valid while the object you
  held differed from the object that was hashed. `verifyChain` now reports such an
  entry invalid at its index, and `appendEntry` refuses such a payload with a
  `TypeError` that names where. A stored `1e999` (which parses to `Infinity`) where
  `null` was hashed is now reported invalid, not read as `null`.
- **Deep nesting threw the engine's stack-overflow `RangeError`.** An entry nested
  deeper than 256 levels now gives `valid: false` from `verifyChain`, a `TypeError`
  from `appendEntry`, and a `RangeError` that names the limit from `canonicalJSON`.
  The limit is fixed, so a chain no longer verifies on one machine and overflows on
  another.
- **An unreadable entry threw instead of failing closed.** A revoked proxy or a
  getter that throws, as an entry or as the chain itself, now gives `valid: false`
  at that entry (or with `brokenAtIndex: null` for the chain).
- **Reason text could carry visually blank characters.** NBSP and the other Unicode
  spaces, and U+2800 (Braille blank), are now written as `\uXXXX`, and an
  `anchor.entryHash` made only of them (or of U+2800) throws like a blank one.

- **The faithfulness check no longer runs caller code or misses inherited hooks.** It
  reads property descriptors only (no getter, `toJSON` or `valueOf` runs), rejects a
  `toJSON` anywhere on a prototype chain (including a null-prototype parent), and
  rejects Date, Map, Set, RegExp, ArrayBuffer, typed-array and boxed-primitive
  objects even with the prototype removed. A root entry that is a class instance is
  accepted only if nothing on its prototype chain defines `toJSON`. `verifyChain`
  no longer invokes getters on an entry's own fields.
- **The faithfulness check was about 13 times slower than needed on ordinary data.**
  It threw and caught a TypeError per brand probe for every object. Ordinary objects
  now take a non-throwing path (`Object.prototype.toString`, `ArrayBuffer.isView`);
  the throwing probes run only for an object with no own keys whose prototype is not
  `Object.prototype`. Verifying 2,000 small entries is back to about the cost of 0.2.1.
- **The nesting check and the inspection used memory proportional to width.** An array of
  1,500,000 numbers ran out of heap under `--max-old-space-size=128`, where 0.2.1 did not.
  Both now keep memory proportional to depth (arrays over 50,000 elements are checked
  without listing every key; see Honest limits).
- **A long key put its whole text into a reason or error.** A payload key of 100,000
  characters gave a 100,000-character message. Keys are cut at 80 characters and the
  reported path stops at about 200.
- **`verifyChain` returned a thrown error for malformed data the default
  canonicalizer could not serialize** (for example `{ first: undefined, later: 1n }`,
  a nested throwing getter or a revoked proxy). It now returns `valid: false` at that
  entry. Errors thrown by a custom `canonicalize` still propagate.

### Changed

- **`VerifyResult` has a new field, `entriesChecked`**: how many entries were fully
  checked before the result was decided. An empty chain is `valid: true` with
  `entriesChecked: 0`; read it before treating a result as evidence that a log has
  content. Code that compares a whole result with strict deep equality now needs
  the new key.
- **Behavior change: `appendEntry` refuses payloads that JSON would change** (with
  the default canonicalizer). `new Date(...)` payloads, `{ a: undefined }`, `NaN`,
  `Map`, `Set` and class instances used to be converted silently. Convert them
  first (`date.toISOString()`, `null`, plain objects). A custom `canonicalize` is
  not checked. Stored JSON text is unaffected.
- **Behavior change: `verifyChain` reports an in-memory entry invalid when it is
  not plain JSON data** (same rule, applied to the whole entry). The entry object
  itself may still be a class instance, such as an ORM row, if its own fields are
  plain data. A cycle or a BigInt in an entry now gives `valid: false` instead of a
  thrown `TypeError`.
- **Behavior change: `anchor` and `expectedMinLength` present with the value
  `undefined` now throw.** Code that passed `{ anchor: maybeUndefined }` must leave
  the key out when there is no anchor.

### Documented

- Verification is over parsed JSON values, not stored bytes: `-0` for `0`, a
  repeated object key (last wins), alternate spellings of a number, different
  escapes of a string, whitespace and key order all verify. Integers beyond 2^53
  are read as the nearest double, so a different literal can verify and another
  language that keeps exact integers computes different bytes. See "Honest limits".
- The 256-level nesting limit and the cost of the new inspection pass.
- `hash: undefined` still means the default hasher.

## [0.2.1] - 2026-10-07

No change to the library's behavior or API.

### Changed

- The README links to the [in-browser playground](https://lkopietz3-byte.github.io/honesty-kits/#audit-chain-kit) and the honesty kits family, and the npm homepage now points to the playground.
- Added the `honesty-kits` npm keyword so the family shows up together in search.

### Security

- Development lockfile: `source-map-js` 1.2.2 (GHSA-68fv-2mgg-jv7q). Development tooling only; the published package has no runtime dependencies.

## [0.2.0] - 2026-09-28

Minor bump: some input that was accepted before now throws, and some results
change. The record format (`audit-chain-kit/v1`), `canonicalJSON` output and
every golden vector are unchanged, so existing chains still verify.

### Fixed

- **`verifyChain` compared the anchor with a value read after the `await`
  (ACK-001).** It recomputed each hash from one read of an entry but later
  compared the anchor with `chain[anchor.index].entryHash` read again, and read
  the array length, the entries and the anchor object again on every pass. A
  chain, entry or anchor edited while a hash was pending could produce
  `valid: true` for a state that was never checked (for example a correctly
  hashed alternative entry whose `entryHash` was swapped to the anchored value
  mid-call, an anchor replaced mid-call, or an array shortened to skip a
  corrupt tail). It now reads the options, the anchor's `index` and
  `entryHash`, the length, the entries and a shallow copy of each entry's
  fields once, before the first `await`, decides from that copy, and compares
  the anchor with the `entryHash` that was recomputed and matched. Payloads are
  still read by reference (documented).
- **`appendEntry` read `chain` again after its `await`.** It spread the live
  array into the result, so an entry pushed while the hash was pending landed
  in the output and the new entry's `index` no longer matched its position; a
  truncated input dropped entries. It now builds the result from the entries
  it read before the `await`. The last entry's `entryHash` and `index` are read
  once each.
- **A malformed `formatVersion` threw instead of returning `valid: false`
  (ACK-002).** A BigInt, a cyclic object or an object with a throwing `toJSON`
  broke the reason builder (`JSON.stringify`). Reasons now describe values by
  `typeof` and never serialize or convert an object. The same fix covers a
  BigInt or odd `index` in the index-mismatch reason, the `appendEntry`
  wrong-position `RangeError` and the `expectedMinLength` `TypeError`.
- **Reasons could forge structure or send terminal escapes.** A string
  `formatVersion` or `index` was echoed with only `JSON.stringify` escaping, so
  bidirectional controls, C1 controls, line separators and invisible format
  characters passed through raw. They are now written as `\uXXXX`, and strings
  over 80 characters are cut.
- **An anchor whose `entryHash` was only whitespace or invisible characters
  was accepted** and then reported as a mismatch. It now throws the same
  `TypeError` as an empty one.
- **A non-integer `length` on an array-like (a `Proxy` returning `NaN`) made
  `verifyChain` report `valid: true` for an empty walk.** It now returns
  `valid: false`, and `appendEntry` throws a `TypeError`.
- Verifying a huge sparse array no longer scans past its first hole.

### Changed (previously accepted input now throws)

- `verifyChain` throws a `TypeError` for `options` that is not `undefined` or a
  plain object (including `null`, an array or a `Map`), and for an unknown
  option key. A typo such as `{ anhcor }`, or an anchor passed where the options
  belong, used to be ignored, which silently skipped the anchor check.
- `verifyChain` and `appendEntry` throw a `TypeError` for a `canonicalize` or
  `hash` that is not a function (`undefined` still means the default; a `null`
  `options.hash` used to be treated as the default, and a `null` `canonicalize`
  only failed once an entry was reached), for a `canonicalize`
  that does not return a string, and for a `hash` that does not resolve to one.
  Before, `verifyChain` reported a non-string hash as tampering and
  `appendEntry` stored an entry whose `entryHash` was not a string.
- An entry that has no own `prevHash` (for example an inherited one) is rejected
  by the shape check.

### Added

- `typesVersions` for `audit-chain-kit/hash-node-fallback`, so
  `moduleResolution: node10` resolves its types. `npm run attw` no longer needs
  `--profile node16` and reports all four resolution modes as clean.
- TSDoc on `sha256HexNodeFallback` (it was a file header before, so it was not
  attached to the export).
- CI: the compatibility jobs pin Node 20.19.0 and 22.12.0, the documented
  `require(esm)` floors. The release workflow runs `audit:dependencies`,
  `verify` and `attw`, requires a `v*` tag on both triggers, and treats only a
  confirmed `E404` as "not published yet".
- README: the ESM/CommonJS compatibility table, the snapshot semantics, the new
  input rules and a corrected sibling-kit section.
- Tests: `test/snapshot.test.ts` (deterministic races with a hasher parked on a
  promise the test controls), `test/messages.test.ts` and `test/errors.test.ts`.
  Mutation score 88.85% -> 99.27%; v8 coverage 100%.

### Docs

- README "Relationship to sibling kits" no longer lists the result fields of
  another package or says the chain proves "when"; `createdAt` is the
  appender's clock.
- `PROJECT_CONTEXT.md` purpose line no longer says "append-only" or
  "independent third-party use" without the anchor caveat.
- `ENGINEERING.md` release notes: no first-release step, no unconditional
  unpublish statement, and the Node support policy names the tested versions.

## [0.1.1] - 2026-09-27

### Added

- CommonJS `require()` support: a `"default"` condition next to `"import"`
  on every `exports` entry (root and `./hash-node-fallback`), pointing at
  the same built file. Proven against the packed tarball with `require()`
  on Node 26.3.0, and guarded in CI on Node 20, 22, and 24 by an extended
  `scripts/verify-package.mjs`.
- README: a "Relationship to sibling kits" section linking to
  [agent-receipt-kit](https://github.com/lkopietz3-byte/agent-receipt-kit) —
  a receipt-verification result can be appended to a chain built with this
  package for a tamper-evident record of what an agent claimed and when.

### Fixed

- Shipped `.js.map` files now inline the original TypeScript source
  (`inlineSources` in `tsconfig.build.json`), so they resolve without the
  unshipped `src/` directory. `.d.ts.map` generation is now disabled instead
  of shipping a source map with an unresolvable `../src/*.ts` path; the
  `.d.ts` declaration files themselves are unaffected.

### Changed

- README: replaced "ESM only" with an accurate statement that `require()`
  also works on Node versions that support `require(esm)`.

## [0.1.0] - 2026-09-27

First release.

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
