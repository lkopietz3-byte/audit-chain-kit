// Strict NodeNext type probe: compiled against the installed declarations
// by scripts/verify-package.mjs. It uses the public types the way a
// TypeScript consumer would; it is type-checked, not run.
import {
  appendEntry, appendToStore, canonicalJSON, computeEntry, createChainVerifier, FORMAT_VERSION,
  GENESIS_HASH, GENESIS_HEAD, sha256Hex, splitValidPrefix, verifyChain,
} from 'audit-chain-kit';
import type {
  AppendOutcome, AppendStore, Canonicalizer, ChainAnchor, ChainEntry, ChainHead, ChainRecord,
  ChainVerifierResult, Hasher, VerifyOptions, VerifyResult,
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
  const record: ChainRecord<AuditEvent> = {
    formatVersion: last.formatVersion,
    index: last.index,
    payload,
    prevHash: last.prevHash,
    createdAt: last.createdAt,
  };
  const version: string = FORMAT_VERSION;
  void version;
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
  const checked: number = result.entriesChecked;
  void broken; void reason; void checked; void record; void genesis;
  return result;
}

/** A Postgres-backed store would implement these two methods; the helper does the retry. */
export async function storeProbe(store: AppendStore<AuditEvent>): Promise<ChainVerifierResult> {
  const outcome: AppendOutcome<AuditEvent> = await appendToStore(store, { action: 'report.created', by: 'user_1' }, { maxAttempts: 3 });
  if (outcome.status !== 'appended') throw new Error(outcome.status);
  const head: ChainHead = { index: outcome.entry.index, hash: outcome.entry.entryHash };
  const entry = await computeEntry({ prevHash: head.hash, index: head.index + 1, payload: { action: 'x', by: 'y' }, createdAt: '2026-01-01T00:00:00.000Z' });
  const verifier = createChainVerifier({ from: GENESIS_HEAD, allowMarkedGaps: true });
  await verifier.push(outcome.entry);
  await verifier.push(entry);
  const split = await splitValidPrefix<AuditEvent>([outcome.entry, entry]);
  const first: ChainEntry<AuditEvent> | undefined = split.valid[0];
  void first;
  // @ts-expect-error createdAt is required: there is no clock default
  await computeEntry({ prevHash: head.hash, index: 1, payload: {} });
  return verifier.finish();
}
