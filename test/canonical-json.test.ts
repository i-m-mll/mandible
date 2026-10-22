import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../src/canonical-json.js";
import type { Db } from "../src/db.js";
import { ingestArtifact } from "../src/provider-artifacts.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

describe("canonicalJson", () => {
  it("orders keys by code unit, not by host locale collation", () => {
    // Digest inputs must not depend on the machine's locale. `localeCompare`
    // places "ä" next to "a" under en-US but after "z" under sv-SE, so a
    // collation-based sort would make the same value hash differently on
    // different hosts. Code-unit order is stable everywhere.
    expect(canonicalJson({ "ä": 1, z: 2, a: 3 })).toBe('{"a":3,"z":2,"ä":1}');
  });

  it("is insensitive to insertion order at every depth", () => {
    const first = canonicalJson({ b: { d: 1, c: [{ f: 1, e: 2 }] }, a: null });
    const second = canonicalJson({ a: null, b: { c: [{ e: 2, f: 1 }], d: 1 } });
    expect(first).toBe(second);
    expect(first).toBe('{"a":null,"b":{"c":[{"e":2,"f":1}],"d":1}}');
  });
});

// An artifact's id is the sha256 of its serialized bytes, so the serializer's
// key order is part of the content-addressing contract. It has to be a
// function of the value alone. `stableJson` used to sort with `localeCompare`
// and no locale argument, which reads the host's collation, so the same JSON
// ingested on two machines could land on two different addresses (issue
// 89f4bd2).
//
// These assertions pin the exact bytes and the exact address rather than
// merely calling the serializer, so they fail if the ordering rule changes at
// all.

let db: Db;
let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-content-address-"));
  db = migratedMemoryDb();
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const sha256 = (text: string) =>
  crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

describe("JSON artifact content addressing", () => {
  it("orders keys by code unit, so the address does not depend on the host locale", () => {
    // Two independent reasons this value would serialize differently under a
    // collation-based sort:
    //   "ä"  en-US and de-DE place it beside "a"; sv-SE places it after "z".
    //   "B"  every common collation orders "a" before "B"; code-unit order
    //        puts uppercase first. This half fails under `localeCompare` on
    //        any host, not only a Swedish one, which is what keeps this test
    //        meaningful on an en-US CI box.
    const value = { "ä": 1, z: 2, a: 3, B: 4 };
    const expectedBytes = '{"B":4,"a":3,"z":2,"ä":1}';

    const artifact = ingestArtifact(
      db,
      { json: value, media_type: "application/json", custody_mode: "managed" },
      1_700_000_000_000,
      path.join(tempDir, "artifacts"),
    );

    expect(artifact.content_hash).toBe(sha256(expectedBytes));
    expect(artifact.content_hash).toBe(
      "665f4c57d0da42753b17cd13698bede45146526796dc484561b936a3ab2a0318",
    );

    // The bytes actually written to the content-addressed store must be the
    // ones the address was computed from, and must parse back to the value.
    const stored = fs.readFileSync(
      path.join(tempDir, "artifacts", "sha256", artifact.content_hash.slice(0, 2), artifact.content_hash),
      "utf8",
    );
    expect(stored).toBe(expectedBytes);
    expect(JSON.parse(stored)).toEqual(value);
  });
});
