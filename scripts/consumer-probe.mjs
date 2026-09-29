// Consumer probe: runs from a clean project where the packed tarball is
// installed, importing the package by name the way a user would. Every
// check asserts a real output, not just that a name is exported.
import assert from 'node:assert/strict';
import {
  appendEntry, canonicalJSON, FORMAT_VERSION, GENESIS_HASH, sha256Hex, verifyChain,
} from 'audit-chain-kit';
import { sha256HexNodeFallback } from 'audit-chain-kit/hash-node-fallback';

const VALID = { valid: true, brokenAtIndex: null, reason: null };

// Hashers: NIST vector, non-ASCII parity, non-string rejection.
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
assert.equal(await sha256Hex('abc'), ABC);
assert.equal(await sha256HexNodeFallback('abc'), ABC);
for (const s of ['é', 'é', '日本\u{1f680}', '\ud800']) {
  assert.equal(await sha256Hex(s), await sha256HexNodeFallback(s), `hasher parity for ${JSON.stringify(s)}`);
}
await assert.rejects(sha256Hex(undefined), TypeError);
await assert.rejects(sha256HexNodeFallback(undefined), TypeError);

// Canonical form.
assert.equal(canonicalJSON({ b: 1, a: [2, { d: undefined, c: new Date(0) }] }), '{"a":[2,{"c":"1970-01-01T00:00:00.000Z"}],"b":1}');
assert.throws(() => canonicalJSON(undefined), TypeError);
assert.equal(GENESIS_HASH, '0'.repeat(64));

// Golden vector: the documented record string hashes to the documented value.
assert.equal(FORMAT_VERSION, 'audit-chain-kit/v1');
const record0 = '{"createdAt":"2026-01-01T00:00:00.000Z","formatVersion":"audit-chain-kit/v1","index":0,"payload":{"action":"report.created","by":"user_1"},"prevHash":"0000000000000000000000000000000000000000000000000000000000000000"}';
const hash0 = 'e2e95ac52a1f387f89f091b90d6a6caf1e2f68acffabe3b4243ed887acab76ca';
assert.equal(await sha256Hex(record0), hash0);
assert.deepEqual(
  await verifyChain([{ formatVersion: FORMAT_VERSION, index: 0, payload: { action: 'report.created', by: 'user_1' }, prevHash: GENESIS_HASH, createdAt: '2026-01-01T00:00:00.000Z', entryHash: hash0 }]),
  VALID,
);

// A chain hashed without formatVersion (pre-round-2 format) is rejected with
// a clear reason, not silently accepted and not thrown.
const preV1Record = '{"createdAt":"2026-01-01T00:00:00.000Z","index":0,"payload":{"action":"report.created","by":"user_1"},"prevHash":"0000000000000000000000000000000000000000000000000000000000000000"}';
const preV1Hash = await sha256Hex(preV1Record);
const preV1Result = await verifyChain([{ index: 0, payload: { action: 'report.created', by: 'user_1' }, prevHash: GENESIS_HASH, createdAt: '2026-01-01T00:00:00.000Z', entryHash: preV1Hash }]);
assert.equal(preV1Result.valid, false);
assert.match(preV1Result.reason, /formatVersion/);

// Build a chain, store it as JSON, read it back, verify.
let chain = await appendEntry([], { action: 'report.created', by: 'user_1' });
chain = await appendEntry(chain, { action: 'report.exported', by: 'user_1', at: new Date() });
chain = await appendEntry(chain, { action: 'report.shared', with: undefined });
assert.equal(chain.length, 3);
assert.ok(Object.isFrozen(chain) && Object.isFrozen(chain[2]));
assert.equal(chain[0].prevHash, GENESIS_HASH);
assert.equal(chain[2].prevHash, chain[1].entryHash);
const stored = JSON.parse(JSON.stringify(chain));
assert.deepEqual(await verifyChain(stored), VALID);
assert.deepEqual(await verifyChain(stored, undefined, { hash: sha256HexNodeFallback }), VALID);

// Tampering the chain's own checks catch.
const edited = structuredClone(stored); edited[1].payload.by = 'someone_else';
assert.deepEqual(await verifyChain(edited), { valid: false, brokenAtIndex: 1, reason: 'entry 1 content does not match its entryHash (a hashed field was changed, added, or removed after appending)' });
assert.equal((await verifyChain([stored[0], stored[2]])).brokenAtIndex, 1);
assert.equal((await verifyChain([stored[1], stored[0], stored[2]])).brokenAtIndex, 0);
assert.equal((await verifyChain({})).valid, false);

// Truncate-then-append passes expectedMinLength; only an anchor catches it.
const anchor = { index: chain[2].index, entryHash: chain[2].entryHash };
let forged = stored.slice(0, 1);
forged = await appendEntry(forged, { action: 'fake' });
forged = await appendEntry(forged, { action: 'fake' });
assert.deepEqual(await verifyChain(forged, undefined, { expectedMinLength: 3 }), VALID);
const anchored = await verifyChain(forged, undefined, { expectedMinLength: 3, anchor });
assert.equal(anchored.valid, false);
assert.equal(anchored.brokenAtIndex, 2);
assert.deepEqual(await verifyChain(stored, undefined, { anchor }), VALID);
await assert.rejects(verifyChain(stored, undefined, { expectedMinLength: Number.NaN }), TypeError);

// Snapshot semantics: entries shortened while a hash is pending cannot hide a
// corrupt tail, and an entryHash forged to the anchored value mid-verification
// cannot pass the anchor check.
{
  const mutable = stored.map((e) => ({ ...e }));
  mutable[2].payload = { action: 'TAMPERED' };
  let calls = 0;
  const shrinkWhileHashing = async (input) => {
    calls += 1;
    if (calls === 1) mutable.length = 1;
    return sha256Hex(input);
  };
  const raced = await verifyChain(mutable, undefined, { hash: shrinkWhileHashing });
  assert.equal(raced.valid, false);
  assert.equal(raced.brokenAtIndex, 2);

  const other = (await appendEntry([], { action: 'other' })).map((e) => ({ ...e }));
  let paused = false;
  const swapWhileHashing = async (input) => {
    if (!paused) { paused = true; other[0].entryHash = stored[0].entryHash; }
    return sha256Hex(input);
  };
  const forgedAnchor = await verifyChain(other, undefined, { anchor: { index: 0, entryHash: stored[0].entryHash }, hash: swapWhileHashing });
  assert.equal(forgedAnchor.valid, false);
}

// A malformed formatVersion is reported, never thrown.
const oddVersion = await verifyChain([{ ...stored[0], formatVersion: 1n }]);
assert.deepEqual(oddVersion, { valid: false, brokenAtIndex: 0, reason: 'entry 0 has formatVersion 1n; this verifier requires "audit-chain-kit/v1"' });

// appendEntry refuses a partial chain.
await assert.rejects(appendEntry([stored[2]], { action: 'x' }), RangeError);

console.log('consumer probe: audit-chain-kit and audit-chain-kit/hash-node-fallback OK');
