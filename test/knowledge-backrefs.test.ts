import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createKnowledgeBackref,
  listKnowledgeBackrefs,
} from "../src/knowledge-backrefs.js";
import { ingestArtifact } from "../src/provider-artifacts.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let db: SqliteDatabase;
let tempDir = "";
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-backrefs-test-"));
  process.env.HOME = path.join(tempDir, "home");
  db = migratedMemoryDb();
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (savedHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = savedHome;
  }
});

describe("knowledge backrefs", () => {
  it("stores typed HumbleB refs against artifacts without storing KG claims", () => {
    const artifact = ingestArtifact(db, {
      provider_id: "mandible",
      role: "report",
      media_type: "text/markdown",
      content: "# Report\n",
      link: {
        entity_type: "issue",
        entity_id: "c9531c6",
        link_type: "references",
      },
    }, 1000);

    const document = createKnowledgeBackref(db, {
      source_type: "artifact",
      source_id: artifact.id,
      external_ref: "humbleb:document:doc_0000000000000001",
      status: "indexed",
      metadata: { ingestion_run_id: "run_1" },
    }, 2000);
    const claim = createKnowledgeBackref(db, {
      source_type: "artifact",
      source_id: artifact.id,
      ref_type: "claim",
      external_id: "claim_0000000000000001",
      metadata: { note: "reference only" },
    }, 3000);

    expect(document).toMatchObject({
      source_type: "artifact",
      source_id: artifact.id,
      provider_id: "humbleb",
      ref_type: "document",
      external_id: "doc_0000000000000001",
      external_ref: "humbleb:document:doc_0000000000000001",
      status: "indexed",
      metadata: { ingestion_run_id: "run_1" },
    });

    const listed = listKnowledgeBackrefs(db, {
      sourceType: "artifact",
      sourceId: artifact.id,
    });
    expect(listed.map((ref) => ref.external_ref).sort()).toEqual([
      "humbleb:claim:claim_0000000000000001",
      "humbleb:document:doc_0000000000000001",
    ]);
    expect(claim.metadata).toEqual({ note: "reference only" });
    expect(JSON.stringify(listed)).not.toContain("claim_text");
  });

});
