export { appendEntry, verifyChain, GENESIS_HASH } from "./chain.js";
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

// The node:crypto hasher is deliberately not re-exported here, so importing
// the main entry never pulls in a Node built-in. Import it from
// "audit-chain-kit/hash-node-fallback" if you need it.
