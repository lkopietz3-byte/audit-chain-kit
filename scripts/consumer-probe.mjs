// Consumer probe: runs from a clean project where the packed tarball is
// installed, importing the package by name the way a user would. Every
// check asserts a real output, not just that a name is exported.
import assert from 'node:assert/strict';
import {
  appendEntry, canonicalJSON, GENESIS_HASH, sha256Hex, verifyChain,
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
const record0 = '{"createdAt":"2026-01-01T00:00:00.000Z","index":0,"payload":{"action":"report.created","by":"user_1"},"prevHash":"0000000000000000000000000000000000000000000000000000000000000000"}';
const hash0 = '65e663a7038e462487c6626b4b5ed03dd7c7d58d37ff2e332c6e0f0aac77cd94';
assert.equal(await sha256Hex(record0), hash0);
assert.deepEqual(
  await verifyChain([{ index: 0, payload: { action: 'report.created', by: 'user_1' }, prevHash: GENESIS_HASH, createdAt: '2026-01-01T00:00:00.000Z', entryHash: hash0 }]),
  VALID,
);

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

// appendEntry refuses a partial chain.
await assert.rejects(appendEntry([stored[2]], { action: 'x' }), RangeError);

console.log('consumer probe: audit-chain-kit and audit-chain-kit/hash-node-fallback OK');
