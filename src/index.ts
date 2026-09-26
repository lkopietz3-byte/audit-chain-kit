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

// Note: the Node fallback hasher is deliberately NOT re-exported from here.
// Import it explicitly from "audit-chain-kit/hash-node-fallback" if you need
// it — see that file's header comment for why.
