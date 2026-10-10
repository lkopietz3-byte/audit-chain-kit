export { appendEntry, verifyChain, FORMAT_VERSION, GENESIS_HASH } from "./chain.js";
export type {
  ChainAnchor,
  ChainEntry,
  ChainRecord,
  Canonicalizer,
  Hasher,
  VerifyOptions,
  VerifyResult,
} from "./types.js";
export { canonicalJSON } from "./canonicalize.js";
export { sha256Hex } from "./hash.js";
export { computeEntry, GENESIS_HEAD } from "./compute.js";
export type { ChainHead, ComputeEntryInput, ComputeEntryOptions } from "./compute.js";
export { gapPayload, MARKED_GAP_KIND, MAX_GAP_REASON_LENGTH } from "./gap.js";
export type { GapPayload, MarkedGap } from "./gap.js";
export { createChainVerifier, splitValidPrefix } from "./verifier.js";
export type { ChainVerifier, ChainVerifierOptions, ChainVerifierResult, SplitResult, UnreadableEntry } from "./verifier.js";
export { appendGapToStore, appendToStore, createMemoryAppendStore } from "./store.js";
export type {
  AppendOutcome,
  AppendStore,
  AppendToStoreOptions,
  MemoryAppendStore,
  StoreAppendResult,
  StoreHeadResult,
} from "./store.js";

// The node:crypto hasher is deliberately not re-exported here, so importing
// the main entry never pulls in a Node built-in. Import it from
// "audit-chain-kit/hash-node-fallback" if you need it.
