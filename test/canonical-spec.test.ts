import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalJSON, computeEntry, createChainVerifier, FORMAT_VERSION } from "../src/index.js";

/**
 * docs/CANONICAL-FORM.md is the published spec. Its worked examples are
 * recomputed here two ways: with the kit, and with a second implementation
 * written only from the spec's byte rules (no JSON.stringify, no kit code),
 * so the page and the code cannot drift apart unnoticed.
 */

const SPEC = readFileSync(fileURLToPath(new URL("../docs/CANONICAL-FORM.md", import.meta.url)), "utf8");

function blocks(kind: string): Record<string, string>[] {
  const found: Record<string, string>[] = [];
  const fence = new RegExp("```" + kind + "\\n([\\s\\S]*?)\\n```", "g");
  for (const match of SPEC.matchAll(fence)) {
    const fields: Record<string, string> = {};
    for (const line of match[1]!.split("\n")) {
      const cut = line.indexOf(": ");
      fields[line.slice(0, cut)] = line.slice(cut + 2);
    }
    found.push(fields);
  }
  return found;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Section 3 of the spec, implemented from the rules alone. */
function specCanonical(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return Object.is(value, -0) ? "0" : String(value);
  if (typeof value === "string") return specString(value);
  if (Array.isArray(value)) return "[" + value.map(specCanonical).join(",") + "]";
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort(); // UTF-16 code unit order
  return "{" + keys.map((k) => specString(k) + ":" + specCanonical(object[k])).join(",") + "}";
}

function specString(text: string): string {
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    const ch = text[i]!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (unit === 8) out += "\\b";
    else if (unit === 9) out += "\\t";
    else if (unit === 10) out += "\\n";
    else if (unit === 12) out += "\\f";
    else if (unit === 13) out += "\\r";
    else if (unit < 0x20) out += "\\u" + unit.toString(16).padStart(4, "0");
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      out += ch + text[++i]!; // a surrogate pair is one character, written as itself
    } else if (unit >= 0xd800 && unit <= 0xdfff) out += "\\u" + unit.toString(16);
    else out += ch;
  }
  return out + '"';
}

describe("docs/CANONICAL-FORM.md worked examples", () => {
  const values = blocks("example");
  const records = blocks("example-record");

  it("the page has examples to check (a broken pattern must not pass by finding none)", () => {
    expect(values.length).toBeGreaterThanOrEqual(5);
    expect(records.length).toBeGreaterThanOrEqual(4);
  });

  it.each(values.map((v, i) => [i, v] as const))("value example %i: the kit and the spec's byte rules both give the documented text", (_i, example) => {
    const parsed: unknown = JSON.parse(example["json"]!);
    expect(canonicalJSON(parsed)).toBe(example["canonical"]);
    expect(specCanonical(parsed)).toBe(example["canonical"]);
  });

  it.each(records.map((r, i) => [i, r] as const))("record example %i: the documented canonical text and hash are reproduced", async (_i, example) => {
    const payload: unknown = JSON.parse(example["payload"]!);
    const record = {
      createdAt: example["createdAt"]!,
      formatVersion: FORMAT_VERSION,
      index: Number(example["index"]),
      payload,
      prevHash: example["prevHash"]!,
    };
    expect(specCanonical(record)).toBe(example["canonical"]);
    expect(canonicalJSON(record)).toBe(example["canonical"]);
    expect(sha256(example["canonical"]!)).toBe(example["entryHash"]);
    const entry = await computeEntry({ prevHash: record.prevHash, index: record.index, payload, createdAt: record.createdAt });
    expect(entry.entryHash).toBe(example["entryHash"]);
  });

  it("the record examples form a chain the streaming verifier accepts (the last one is a gap record)", async () => {
    const verifier = createChainVerifier({ allowMarkedGaps: true });
    for (const example of records) {
      const payload: unknown = JSON.parse(example["payload"]!);
      const accepted = await verifier.push({
        formatVersion: FORMAT_VERSION,
        index: Number(example["index"]),
        payload,
        prevHash: example["prevHash"],
        createdAt: example["createdAt"],
        entryHash: example["entryHash"],
      });
      expect(accepted).toBe(true);
    }
    const result = await verifier.finish();
    expect(result).toMatchObject({ valid: true, entriesChecked: records.length });
    expect(result.gaps).toEqual([{ atIndex: 7, from: 3, to: 6, reason: "backup restore" }]);
  });

  it("the spec's own rules are not a restatement of the kit: they reject a wrong edit of an example", () => {
    const sample = values[0]!;
    expect(specCanonical(JSON.parse(sample["json"]!))).not.toBe(sample["canonical"]!.replace("[true,null]", "[true, null]"));
  });
});

/** The JavaScript example in section 4 of the spec, run as an outside implementer would run it. */
function docExample(): { entryIsIntact: (e: unknown) => boolean; recompute: (e: unknown) => string } {
  const match = /## 4\.[\s\S]*?```js\n([\s\S]*?)\n```/.exec(SPEC);
  if (match === null) throw new Error("section 4 has no js example");
  const code = match[1]!.replace(/^import .*$/m, "");
  return vm.runInNewContext(`${code}\n({ entryIsIntact, recompute })`, { createHash }) as {
    entryIsIntact: (e: unknown) => boolean;
    recompute: (e: unknown) => string;
  };
}

describe("docs/CANONICAL-FORM.md section 4 example logic", () => {
  const records = blocks("example-record");
  const asEntry = (r: Record<string, string>): Record<string, unknown> => ({
    formatVersion: FORMAT_VERSION,
    index: Number(r["index"]),
    payload: JSON.parse(r["payload"]!) as unknown,
    prevHash: r["prevHash"],
    createdAt: r["createdAt"],
    entryHash: r["entryHash"],
  });

  it("accepts every documented entry", () => {
    const { entryIsIntact } = docExample();
    for (const r of records) expect(entryIsIntact(asEntry(r))).toBe(true);
  });

  it("rejects a changed formatVersion, even with the hash recomputed for it, and an added own field", () => {
    const { entryIsIntact, recompute } = docExample();
    const entry = asEntry(records[0]!);
    expect(entryIsIntact({ ...entry, formatVersion: "audit-chain-kit/v2" })).toBe(false);
    const other: Record<string, unknown> = { ...entry, formatVersion: "other/v9" };
    other["entryHash"] = recompute(other);
    expect(entryIsIntact(other)).toBe(false);
    expect(entryIsIntact({ ...entry, tenant: "t1" })).toBe(false);
    expect(entryIsIntact({ ...entry, formatVersion: undefined })).toBe(false);
  });

  it("rejects the edits the package rejects: payload, index, prevHash, createdAt", () => {
    const { entryIsIntact } = docExample();
    const entry = asEntry(records[1]!);
    for (const patch of [{ payload: { n: 43 } }, { index: 2 }, { prevHash: "f".repeat(64) }, { createdAt: "2027-01-01T00:00:00.000Z" }]) {
      expect(entryIsIntact({ ...entry, ...patch })).toBe(false);
    }
  });
});
