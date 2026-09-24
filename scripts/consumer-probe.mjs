// STUB-PROBE-REPLACE-ME
// Replace this with a probe that imports the package by name, calls the real API,
// and asserts real outputs (the way a consumer would use it).
import assert from 'node:assert/strict';
for (const spec of ["audit-chain-kit","audit-chain-kit/hash-node-fallback"]) {
  const mod = await import(spec);
  assert.ok(Object.keys(mod).length > 0, `${spec} exports nothing`);
}
