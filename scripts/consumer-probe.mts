// Strict NodeNext type probe: compiled against the installed declarations
// by scripts/verify-package.mjs. It uses the public types the way a
// TypeScript consumer would; it is type-checked, not run.
import {
  appendEntry, canonicalJSON, GENESIS_HASH, sha256Hex, verifyChain,
} from 'audit-chain-kit';
import type {
  Canonicalizer, ChainAnchor, ChainEntry, ChainRecord, Hasher, VerifyOptions, VerifyResult,
} from 'audit-chain-kit';
import { sha256HexNodeFallback } from 'audit-chain-kit/hash-node-fallback';

interface AuditEvent { action: string; by: string }

const hashers: Hasher[] = [sha256Hex, sha256HexNodeFallback];
const canonicalize: Canonicalizer = canonicalJSON;
const genesis: string = GENESIS_HASH;

export async function probe(): Promise<VerifyResult> {
  let chain: readonly ChainEntry<AuditEvent>[] = [];
  chain = await appendEntry<AuditEvent>(chain, { action: 'report.created', by: 'user_1' });
  chain = await appendEntry(chain, { action: 'report.exported', by: 'user_1' }, canonicalize, hashers[1]);

  const last = chain[chain.length - 1];
  if (last === undefined) throw new Error('empty');
  const payload: AuditEvent = last.payload;
  const record: ChainRecord<AuditEvent> = { index: last.index, payload, prevHash: last.prevHash, createdAt: last.createdAt };
  const anchor: ChainAnchor = last; // any entry is a valid anchor shape

  // @ts-expect-error appendEntry returns a readonly array
  const mutable: ChainEntry<AuditEvent>[] = await appendEntry<AuditEvent>([], payload);
  void mutable;
  // @ts-expect-error payload type is enforced
  await appendEntry<AuditEvent>(chain, { action: 1 });

  const options: VerifyOptions = { expectedMinLength: 2, anchor, hash: sha256HexNodeFallback };
  const result: VerifyResult = await verifyChain(chain, undefined, options);
  const broken: number | null = result.brokenAtIndex;
  const reason: string | null = result.reason;
  void broken; void reason; void record; void genesis;
  return result;
}
