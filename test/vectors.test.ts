import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendEntry, canonicalJSON, FORMAT_VERSION, GENESIS_HASH, sha256Hex, verifyChain } from "../src/index.js";
import { sha256HexNodeFallback } from "../src/hash-node-fallback.js";

// Golden vectors. They pin the exact bytes that get hashed, so a change to
// the record format or canonicalization shows up here, and so someone
// reimplementing the verifier in another language has something to test
// against. Recomputed independently with `shasum -a 256` and with Python's
// json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False).
//
// These vectors include the `formatVersion` field (added in round 2); they
// are NOT the same bytes or hashes as the pre-formatVersion vectors.
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const P0 = { action: "report.created", by: "user_1" };
const P1 = {
  action: "report.exported",
  by: "user_1",
  meta: { z: [1, 2.5, -0, 1e21, "ü日本\u{1f680}", null, true, 'line\nbreak "q"'], a: {}, 10: "ten", 9: "nine" },
};
const RECORD0 =
  '{"createdAt":"2026-01-01T00:00:00.000Z","formatVersion":"audit-chain-kit/v1","index":0,"payload":{"action":"report.created","by":"user_1"},"prevHash":"0000000000000000000000000000000000000000000000000000000000000000"}';
const HASH0 = "e2e95ac52a1f387f89f091b90d6a6caf1e2f68acffabe3b4243ed887acab76ca";
const RECORD1 =
  '{"createdAt":"2026-01-01T00:00:00.000Z","formatVersion":"audit-chain-kit/v1","index":1,"payload":{"action":"report.exported","by":"user_1","meta":{"10":"ten","9":"nine","a":{},"z":[1,2.5,0,1e+21,"ü日本\u{1f680}",null,true,"line\\nbreak \\"q\\""]}},"prevHash":"e2e95ac52a1f387f89f091b90d6a6caf1e2f68acffabe3b4243ed887acab76ca"}';
const HASH1 = "8ae404a78a3453c749219ab8416fc1ba0bbb9b5516ed95e43507bc71410556d8";

describe("golden vectors", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(CREATED_AT));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("GENESIS_HASH is 64 zeros", () => {
    expect(GENESIS_HASH).toBe("0".repeat(64));
  });

  it("hashes exactly the documented record string", async () => {
    let chain = await appendEntry([], P0);
    chain = await appendEntry(chain, P1);
    const [e0, e1] = chain;
    expect(e0).toEqual({
      formatVersion: FORMAT_VERSION,
      index: 0,
      payload: P0,
      prevHash: GENESIS_HASH,
      createdAt: CREATED_AT,
      entryHash: HASH0,
    });
    expect(e1!.entryHash).toBe(HASH1);
    const recordOf = (e: typeof e0) => ({
      formatVersion: e!.formatVersion,
      index: e!.index,
      payload: e!.payload,
      prevHash: e!.prevHash,
      createdAt: e!.createdAt,
    });
    expect(canonicalJSON(recordOf(e0))).toBe(RECORD0);
    expect(canonicalJSON(recordOf(e1))).toBe(RECORD1);
  });

  it("matches an independent recomputation: sha256(utf8(record string))", () => {
    const digest = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
    expect(digest(RECORD0)).toBe(HASH0);
    expect(digest(RECORD1)).toBe(HASH1);
  });

  it("a chain built from the vectors by hand verifies", async () => {
    const chain = [
      { formatVersion: FORMAT_VERSION, index: 0, payload: P0, prevHash: GENESIS_HASH, createdAt: CREATED_AT, entryHash: HASH0 },
      {
        formatVersion: FORMAT_VERSION,
        index: 1,
        payload: JSON.parse(JSON.stringify(P1)) as unknown,
        prevHash: HASH0,
        createdAt: CREATED_AT,
        entryHash: HASH1,
      },
    ];
    expect(await verifyChain(chain, undefined, { anchor: { index: 1, entryHash: HASH1 } })).toEqual({
      valid: true,
      brokenAtIndex: null,
      reason: null,
    });
  });
});

describe("Web Crypto and node:crypto paths are interchangeable for whole chains", () => {
  it("a chain appended with one hasher verifies with the other, including non-ASCII payloads", async () => {
    const payloads = [{ note: "été" }, { note: "日本語 \u{1f680}" }, { note: "é" }];
    let viaWeb: Awaited<ReturnType<typeof appendEntry>> = [];
    let viaNode: Awaited<ReturnType<typeof appendEntry>> = [];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(CREATED_AT));
    try {
      for (const p of payloads) {
        viaWeb = await appendEntry(viaWeb, p, canonicalJSON, sha256Hex);
        viaNode = await appendEntry(viaNode, p, canonicalJSON, sha256HexNodeFallback);
      }
    } finally {
      vi.useRealTimers();
    }
    expect(viaNode.map((e) => e.entryHash)).toEqual(viaWeb.map((e) => e.entryHash));
    expect((await verifyChain(viaWeb, undefined, { hash: sha256HexNodeFallback })).valid).toBe(true);
    expect((await verifyChain(viaNode)).valid).toBe(true);
  });
});
