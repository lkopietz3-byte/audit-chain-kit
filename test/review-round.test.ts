import { describe, expect, it } from "vitest";
import {
  appendEntry,
  createChainVerifier,
  splitValidPrefix,
  verifyChain,
} from "../src/index.js";
import type { ChainEntry } from "../src/index.js";

/**
 * Final review round. Each case pins one input and its correct verdict:
 * an anchor mismatch is not hidden by a later break, and an entry with a
 * getter or toJSON hook is rejected without running it.
 */

async function build(payloads: readonly unknown[]): Promise<ChainEntry[]> {
  let chain: readonly ChainEntry[] = [];
  for (const payload of payloads) chain = await appendEntry(chain, payload);
  return [...chain];
}

describe("splitValidPrefix: an anchor mismatch is not hidden by a later break", () => {
  it("keeps nothing as valid when the anchored entry was rewritten and a later entry is malformed", async () => {
    const original = await build([{ a: 1 }, { a: 2 }, { a: 3 }]);
    const rewritten = await build([{ a: "changed" }, { a: 2 }, { a: 3 }]);
    const anchor = { index: 0, hash: original[0]!.entryHash };
    const split = await splitValidPrefix([rewritten[0], null, rewritten[2]], { anchor });
    expect(split.valid).toEqual([]);
    expect(split.firstBreak).toMatchObject({ index: 0 });
    expect(split.firstBreak!.reason).toMatch(/anchor/);
    expect(split.rest).toEqual([rewritten[0], null, rewritten[2]]);
    expect(split.restComplete).toBe(true);
  });

  it("the streaming verifier reports the earlier anchor mismatch, not only the later break", async () => {
    const original = await build([{ a: 1 }, { a: 2 }]);
    const rewritten = await build([{ a: "changed" }, { a: 2 }]);
    const verifier = createChainVerifier({ anchor: { index: 0, hash: original[0]!.entryHash } });
    await verifier.push(rewritten[0]);
    await verifier.push(null);
    expect(await verifier.finish()).toMatchObject({ valid: false, status: "broken", brokenAtIndex: 0 });
  });

  it("guard: a matching anchor with a later break keeps the prefix up to the break", async () => {
    const chain = await build([{ a: 1 }, { a: 2 }, { a: 3 }]);
    const split = await splitValidPrefix([chain[0], chain[1], null], { anchor: { index: 0, hash: chain[0]!.entryHash } });
    expect(split.valid).toEqual([chain[0], chain[1]]);
    expect(split.firstBreak).toMatchObject({ index: 2 });
  });
});

describe("an entry with a getter or toJSON hook is rejected without running it", () => {
  const hooked = async (kind: "getter" | "toJSON") => {
    const [entry] = await build([{ a: 1 }]);
    const calls = { n: 0 };
    const payload =
      kind === "getter"
        ? Object.defineProperty({}, "a", { enumerable: true, get: () => ++calls.n })
        : { a: 1, toJSON: () => ++calls.n };
    return { entry: { ...entry!, payload }, calls };
  };

  it.each(["getter", "toJSON"] as const)("verifyChain: a %s payload is broken and never called", async (kind) => {
    const { entry, calls } = await hooked(kind);
    expect(await verifyChain([entry])).toMatchObject({ valid: false, brokenAtIndex: 0 });
    expect(calls.n).toBe(0);
  });

  it.each(["getter", "toJSON"] as const)("push: a %s payload is broken and never called", async (kind) => {
    const { entry, calls } = await hooked(kind);
    const verifier = createChainVerifier();
    expect(await verifier.push(entry)).toBe(false);
    expect(await verifier.finish()).toMatchObject({ valid: false, brokenAtIndex: 0 });
    expect(calls.n).toBe(0);
  });
});
