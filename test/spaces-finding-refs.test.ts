import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, setDb, type Db } from "../src/db.js";
import {
  findingCandidateIdFromRef,
  findingStoreAvailable,
  listFindingCandidates,
  normalizeFindingMetadata,
  readFindingRefMetadata,
  registerSpacesRoutes,
  resolveFindingReference,
} from "../src/routes/spaces.js";
import { Router } from "../src/server.js";
import { SPACE_ITEM_REF_TYPES } from "../src/contracts.js";
import { SPACE_ITEM_REF_TYPES as BACKEND_REF_TYPES } from "../src/ledger/spaces.js";

// Issue d7e51a1 (umbrella 99b74d6): Space finding references — the `finding`
// ref type, latest-vs-pinned revision semantics, and save-to-Space as a
// placement fact that records NO decision event.
//
// The briefing candidate store (integration contract v1 §2) is owned by the
// briefing server lane. These tests build it as a fixture from the contract DDL
// so this lane's resolution/validation behavior is verified against the pinned
// shapes ahead of that lane landing.

const PROJECT_ID = "prj-finding-test";

let db: Db;
let router: Router;

/** Contract v1 §2 DDL for the tables this lane reads (fixture, never a migration). */
function createBriefingStore(database: Db): void {
  database.exec(`
    CREATE TABLE review_candidates (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      candidate_key TEXT NOT NULL,
      current_revision_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(source, candidate_key)
    );
    CREATE TABLE candidate_revisions (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      title TEXT,
      why_notable TEXT,
      refs_json TEXT,
      source_ref TEXT,
      evidence_hash TEXT,
      evidence_kind TEXT CHECK(evidence_kind IN ('snapshot-item','finding-only')),
      captured_at TEXT,
      run_id TEXT,
      digest_series_ref TEXT,
      digest_version INTEGER,
      rank INTEGER NULL,
      batch_key TEXT,
      ingested_at INTEGER,
      UNIQUE(candidate_id, evidence_hash)
    );
    CREATE TABLE decision_events (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('keep','dismiss','undo','expire')),
      actor_user_id TEXT NULL,
      comment_id TEXT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

function seedCandidate(
  database: Db,
  id: string,
  opts: { source?: string; candidateKey?: string } = {},
): void {
  database
    .prepare(
      `INSERT INTO review_candidates (id, source, candidate_key, current_revision_id, created_at)
       VALUES (?, ?, ?, NULL, ?)`,
    )
    .run(id, opts.source ?? "daily-digest", opts.candidateKey ?? `key-${id}`, Date.now());
}

/** Append a revision and move the candidate's current revision (an ingest re-pend). */
function seedRevision(
  database: Db,
  candidateId: string,
  revisionId: string,
  opts: { title?: string; evidenceHash?: string; whyNotable?: string; refs?: string[] } = {},
): void {
  database
    .prepare(
      `INSERT INTO candidate_revisions (
         id, candidate_id, title, why_notable, refs_json, source_ref, evidence_hash,
         evidence_kind, captured_at, run_id, digest_series_ref, digest_version, rank,
         batch_key, ingested_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'snapshot-item', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      revisionId,
      candidateId,
      opts.title ?? `Title for ${revisionId}`,
      opts.whyNotable ?? "because it matters",
      JSON.stringify(opts.refs ?? ["https://example.invalid/x"]),
      "https://example.invalid/x",
      opts.evidenceHash ?? `hash-${revisionId}`,
      "2026-08-11T09:00:00Z",
      "run-1",
      "artifact-series:abc",
      7,
      1,
      "batch-1",
      Date.now(),
    );
  database
    .prepare("UPDATE review_candidates SET current_revision_id = ? WHERE id = ?")
    .run(revisionId, candidateId);
}

function seedDecision(
  database: Db,
  candidateId: string,
  revisionId: string,
  action: "keep" | "dismiss" | "undo" | "expire",
  createdAt: number,
): void {
  database
    .prepare(
      `INSERT INTO decision_events (id, candidate_id, revision_id, action, actor_user_id, comment_id, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .run(`de-${revisionId}-${action}-${createdAt}`, candidateId, revisionId, action, createdAt);
}

/**
 * Whether the live `space_items.ref_type` CHECK accepts 'finding'. That
 * constraint is a migration owned by the briefing schema lane (contract §7
 * assumed no schema change was needed for this lane, which is true of the item
 * METADATA but not of the ref type itself). Persistence assertions below are
 * gated on it and light up automatically once the migration lands.
 */
function spaceItemsAcceptFindingRefType(database: Db): boolean {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'space_items'")
    .get() as { sql: string } | undefined;
  return !!row && row.sql.includes("'finding'");
}

const PERSISTENCE_SUPPORTED = (() => {
  const probe = new Database(":memory:") as unknown as Db;
  migrate(probe);
  const supported = spaceItemsAcceptFindingRefType(probe);
  probe.close();
  return supported;
})();

async function call(method: string, url: string, body?: unknown) {
  return router.invoke({ method, url, body });
}

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  migrate(db);
  setDb(db);
  router = new Router();
  registerSpacesRoutes(router);
  db.prepare(
    `INSERT INTO ledger_projects (id, display_name, remote_identity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(PROJECT_ID, "Finding Test", `github.com/test/${PROJECT_ID}`, Date.now(), Date.now());
});

afterEach(() => {
  db.close();
});

async function makeSpace(title = "Findings Space"): Promise<string> {
  const res = await call("POST", "/api/spaces", { project_id: PROJECT_ID, title });
  expect(res.status).toBe(201);
  return (res.body as { space: { id: string } }).space.id;
}

describe("finding ref type contract", () => {
  it("adds `finding` to the shared and backend ref-type vocabularies", () => {
    expect(SPACE_ITEM_REF_TYPES).toContain("finding");
    expect(BACKEND_REF_TYPES).toContain("finding");
    expect([...SPACE_ITEM_REF_TYPES]).toEqual([...BACKEND_REF_TYPES]);
  });

  it("parses candidate ids with or without the `finding:` prefix", () => {
    expect(findingCandidateIdFromRef("finding:cand-1")).toBe("cand-1");
    expect(findingCandidateIdFromRef("  cand-1 ")).toBe("cand-1");
  });

  it("reads revision semantics off item metadata, defaulting to latest-tracking", () => {
    expect(readFindingRefMetadata(null)).toEqual({ revision_mode: "latest" });
    expect(readFindingRefMetadata({ revision_mode: "latest" })).toEqual({ revision_mode: "latest" });
    expect(readFindingRefMetadata({ revision_mode: "pinned", pinned_revision_id: "rev-1" })).toEqual({
      revision_mode: "pinned",
      pinned_revision_id: "rev-1",
    });
    // Pinned WITHOUT an id is not a pin; it degrades to latest rather than
    // silently pretending to be pinned to nothing.
    expect(readFindingRefMetadata({ revision_mode: "pinned" })).toEqual({ revision_mode: "latest" });
  });
});

describe("finding metadata validation", () => {
  beforeEach(() => {
    createBriefingStore(db);
    seedCandidate(db, "cand-1");
    seedRevision(db, "cand-1", "rev-1");
    seedCandidate(db, "cand-2", { candidateKey: "key-2" });
    seedRevision(db, "cand-2", "rev-2");
  });

  it("defaults an omitted revision_mode to explicit latest-tracking", () => {
    expect(normalizeFindingMetadata(db, "cand-1", undefined)).toEqual({ revision_mode: "latest" });
    expect(normalizeFindingMetadata(db, "cand-1", { note: "x" })).toEqual({
      note: "x",
      revision_mode: "latest",
    });
  });

  it("requires pinned_revision_id when the mode is pinned", () => {
    expect(() => normalizeFindingMetadata(db, "cand-1", { revision_mode: "pinned" })).toThrow(
      /pinned_revision_id is required/,
    );
  });

  it("rejects a pinned_revision_id under latest-tracking", () => {
    expect(() =>
      normalizeFindingMetadata(db, "cand-1", { revision_mode: "latest", pinned_revision_id: "rev-1" }),
    ).toThrow(/requires revision_mode 'pinned'/);
  });

  it("rejects an unknown revision_mode and a revision from another candidate", () => {
    expect(() => normalizeFindingMetadata(db, "cand-1", { revision_mode: "floating" })).toThrow(
      /revision_mode must be one of/,
    );
    expect(() =>
      normalizeFindingMetadata(db, "cand-1", { revision_mode: "pinned", pinned_revision_id: "rev-2" }),
    ).toThrow(/does not belong to finding cand-1/);
    expect(() =>
      normalizeFindingMetadata(db, "cand-1", { revision_mode: "pinned", pinned_revision_id: "nope" }),
    ).toThrow(/pinned revision not found/);
  });

  it("accepts a pin to the candidate's own revision", () => {
    expect(
      normalizeFindingMetadata(db, "cand-1", { revision_mode: "pinned", pinned_revision_id: "rev-1" }),
    ).toEqual({ revision_mode: "pinned", pinned_revision_id: "rev-1" });
  });
});

describe("finding resolution: latest vs pinned", () => {
  beforeEach(() => {
    createBriefingStore(db);
    seedCandidate(db, "cand-1", { source: "hn-scan" });
    seedRevision(db, "cand-1", "rev-1", { title: "First revision" });
  });

  it("reports an unresolved reference when the candidate store is absent", () => {
    const fresh = new Database(":memory:") as unknown as Db;
    migrate(fresh);
    expect(findingStoreAvailable(fresh)).toBe(false);
    const resolution = resolveFindingReference(fresh, "cand-1", { revision_mode: "latest" });
    expect(resolution.resolved).toBe(false);
    expect(resolution.warnings).toContain("finding_store_unavailable");
    expect(resolution.revision_state).toBe("unresolved");
    fresh.close();
  });

  it("reports an unresolved reference for an unknown candidate", () => {
    const resolution = resolveFindingReference(db, "finding:missing", { revision_mode: "latest" });
    expect(resolution.resolved).toBe(false);
    expect(resolution.error).toMatch(/finding not found/);
  });

  it("tracks the latest revision and always says it is not pinned", () => {
    const first = resolveFindingReference(db, "finding:cand-1", { revision_mode: "latest" });
    expect(first.resolved).toBe(true);
    expect(first.source).toBe("hn-scan");
    expect(first.revision_state).toBe("latest");
    expect(first.warnings).toContain("finding_latest_not_pinned");
    expect(first.effective_revision?.id).toBe("rev-1");

    // A newer revision arrives (new evidence hash for the same candidate).
    seedRevision(db, "cand-1", "rev-2", { title: "Second revision" });

    const after = resolveFindingReference(db, "finding:cand-1", { revision_mode: "latest" });
    expect(after.effective_revision?.id).toBe("rev-2");
    expect(after.effective_revision?.title).toBe("Second revision");
    expect(after.current_revision?.id).toBe("rev-2");
    expect(after.revision_state).toBe("latest");
    expect(after.warnings).toContain("finding_latest_not_pinned");
  });

  it("keeps a pinned reference on its revision when a newer revision arrives", () => {
    const pinned = { revision_mode: "pinned", pinned_revision_id: "rev-1" };
    const before = resolveFindingReference(db, "cand-1", pinned);
    expect(before.revision_state).toBe("pinned_current");
    expect(before.warnings).toEqual([]);
    expect(before.effective_revision?.id).toBe("rev-1");

    seedRevision(db, "cand-1", "rev-2", { title: "Second revision" });

    const after = resolveFindingReference(db, "cand-1", pinned);
    // THE invariant: the pinned reference does not move.
    expect(after.effective_revision?.id).toBe("rev-1");
    expect(after.effective_revision?.title).toBe("First revision");
    expect(after.current_revision?.id).toBe("rev-2");
    expect(after.revision_state).toBe("pinned_superseded");
    expect(after.warnings).toContain("finding_pinned_revision_superseded");
  });

  it("flags a pin to a revision that is not in the store", () => {
    const resolution = resolveFindingReference(db, "cand-1", {
      revision_mode: "pinned",
      pinned_revision_id: "rev-gone",
    });
    expect(resolution.revision_state).toBe("pinned_missing");
    expect(resolution.warnings).toContain("finding_pinned_revision_missing");
    expect(resolution.effective_revision).toBeNull();
  });

  it("projects the revision payload, including parsed refs", () => {
    const resolution = resolveFindingReference(db, "cand-1", { revision_mode: "latest" });
    expect(resolution.effective_revision).toMatchObject({
      id: "rev-1",
      candidate_id: "cand-1",
      why_notable: "because it matters",
      evidence_kind: "snapshot-item",
      digest_version: 7,
      rank: 1,
    });
    expect(resolution.effective_revision?.refs).toEqual(["https://example.invalid/x"]);
  });
});

describe("finding review state (display only)", () => {
  beforeEach(() => {
    createBriefingStore(db);
    seedCandidate(db, "cand-1");
    seedRevision(db, "cand-1", "rev-1");
  });

  it("derives pending, decided, undone, and expired states from decision events", () => {
    expect(resolveFindingReference(db, "cand-1", {}).review_state).toBe("pending");

    seedDecision(db, "cand-1", "rev-1", "keep", 1);
    expect(resolveFindingReference(db, "cand-1", {}).review_state).toBe("kept");

    seedDecision(db, "cand-1", "rev-1", "undo", 2);
    expect(resolveFindingReference(db, "cand-1", {}).review_state).toBe("pending");

    seedDecision(db, "cand-1", "rev-1", "dismiss", 3);
    expect(resolveFindingReference(db, "cand-1", {}).review_state).toBe("dismissed");

    seedDecision(db, "cand-1", "rev-1", "undo", 4);
    seedDecision(db, "cand-1", "rev-1", "expire", 5);
    expect(resolveFindingReference(db, "cand-1", {}).review_state).toBe("expired_unreviewed");
  });

  it("reports an unknown review state rather than guessing pending without the store", () => {
    const fresh = new Database(":memory:") as unknown as Db;
    migrate(fresh);
    expect(resolveFindingReference(fresh, "cand-1", {}).review_state).toBe("unknown");
    fresh.close();
  });

  it("re-pends on a new revision: the new current revision carries no decision", () => {
    seedDecision(db, "cand-1", "rev-1", "keep", 1);
    seedRevision(db, "cand-1", "rev-2");
    expect(resolveFindingReference(db, "cand-1", {}).review_state).toBe("pending");
  });
});

describe("finding candidate listing (item picker source)", () => {
  it("lists nothing when the candidate store is absent", () => {
    expect(listFindingCandidates(db)).toEqual([]);
  });

  it("lists candidates with their current title, source, and review state", () => {
    createBriefingStore(db);
    seedCandidate(db, "cand-1", { source: "hn-scan" });
    seedRevision(db, "cand-1", "rev-1", { title: "Interesting thing" });
    seedCandidate(db, "cand-2", { source: "arxiv", candidateKey: "key-2" });
    seedRevision(db, "cand-2", "rev-2", { title: "Another thing" });
    seedDecision(db, "cand-2", "rev-2", "dismiss", 1);

    const all = listFindingCandidates(db);
    expect(all).toHaveLength(2);
    expect(all.find((row) => row.candidate_id === "cand-1")).toMatchObject({
      source: "hn-scan",
      title: "Interesting thing",
      current_revision_id: "rev-1",
      review_state: "pending",
    });
    expect(all.find((row) => row.candidate_id === "cand-2")?.review_state).toBe("dismissed");

    expect(listFindingCandidates(db, { query: "interesting" })).toHaveLength(1);
    expect(listFindingCandidates(db, { query: "arxiv" })).toHaveLength(1);
    expect(listFindingCandidates(db, { limit: 1 })).toHaveLength(1);
  });
});

describe("finding routes", () => {
  beforeEach(() => {
    createBriefingStore(db);
    seedCandidate(db, "cand-1", { source: "hn-scan" });
    seedRevision(db, "cand-1", "rev-1", { title: "Interesting thing" });
  });

  it("lists findings and resolves one under explicit revision semantics", async () => {
    const list = await call("GET", "/api/spaces/findings");
    expect(list.status).toBe(200);
    expect((list.body as { findings: unknown[] }).findings).toHaveLength(1);

    const latest = await call("GET", "/api/spaces/findings/cand-1/resolve?revision_mode=latest");
    expect(latest.status).toBe(200);
    expect((latest.body as { resolution: { revision_state: string } }).resolution.revision_state).toBe(
      "latest",
    );

    const pinned = await call(
      "GET",
      "/api/spaces/findings/cand-1/resolve?revision_mode=pinned&pinned_revision_id=rev-1",
    );
    expect((pinned.body as { resolution: { revision_state: string } }).resolution.revision_state).toBe(
      "pinned_current",
    );
  });

  it("rejects an unknown revision_mode on the resolve route", async () => {
    const res = await call("GET", "/api/spaces/findings/cand-1/resolve?revision_mode=floating");
    expect(res.status).toBe(400);
  });

  it("keeps finding reads available to the file-RPC transport", () => {
    expect(router.resolveFileRpcPolicy("GET", "/api/spaces/findings")).toBe(true);
    expect(router.resolveFileRpcPolicy("GET", "/api/spaces/findings/cand-1/resolve")).toBe(true);
  });

  it("rejects a finding item whose candidate does not exist", async () => {
    const spaceId = await makeSpace();
    const res = await call("POST", `/api/spaces/${spaceId}/items`, {
      ref_type: "finding",
      ref_id: "nope",
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/finding ref not found/);
  });

  it("scopes the placement-resolution route to real finding items", async () => {
    const spaceId = await makeSpace();
    expect((await call("GET", `/api/spaces/${spaceId}/items/nope/finding`)).status).toBe(404);

    // An existing non-finding item is refused rather than resolved as one.
    const artifactItem = await call("POST", `/api/spaces/${spaceId}/items`, {
      ref_type: "external_ref",
      ref_id: "https://example.invalid/x",
      ref_uri: "https://example.invalid/x",
    });
    expect(artifactItem.status).toBe(201);
    const itemId = (artifactItem.body as { item: { id: string } }).item.id;
    const res = await call("GET", `/api/spaces/${spaceId}/items/${itemId}/finding`);
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/not a finding reference/);
  });

  it("rejects an invalid revision_mode before touching storage", async () => {
    const spaceId = await makeSpace();
    const res = await call("POST", `/api/spaces/${spaceId}/items`, {
      ref_type: "finding",
      ref_id: "cand-1",
      metadata: { revision_mode: "pinned" },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/pinned_revision_id is required/);
  });

  // The remaining route assertions need `space_items.ref_type` to accept
  // 'finding'. That CHECK-constraint rebuild is a migration owned by the
  // briefing schema lane; these light up as soon as it lands.
  it.skipIf(!PERSISTENCE_SUPPORTED)(
    "saves a finding to a Space as a placement fact and normalizes its metadata",
    async () => {
      const spaceId = await makeSpace();
      const created = await call("POST", `/api/spaces/${spaceId}/items`, {
        ref_type: "finding",
        ref_id: "cand-1",
        title: "Interesting thing",
      });
      expect(created.status).toBe(201);
      const item = (created.body as { item: { id: string; metadata: Record<string, unknown> } }).item;
      expect(item.metadata).toEqual({ revision_mode: "latest" });

      // A placement creates NO decision event.
      const decisions = db.prepare("SELECT COUNT(*) AS n FROM decision_events").get() as { n: number };
      expect(decisions.n).toBe(0);

      const resolved = await call("GET", `/api/spaces/${spaceId}/items/${item.id}/finding`);
      expect(resolved.status).toBe(200);
      expect(
        (resolved.body as { resolution: { revision_state: string; effective_revision: { id: string } } })
          .resolution,
      ).toMatchObject({ revision_state: "latest" });
    },
  );

  it.skipIf(!PERSISTENCE_SUPPORTED)(
    "pins a placed reference so a newer revision does not move it",
    async () => {
      const spaceId = await makeSpace();
      const created = await call("POST", `/api/spaces/${spaceId}/items`, {
        ref_type: "finding",
        ref_id: "cand-1",
        metadata: { revision_mode: "pinned", pinned_revision_id: "rev-1" },
      });
      expect(created.status).toBe(201);
      const itemId = (created.body as { item: { id: string } }).item.id;

      seedRevision(db, "cand-1", "rev-2", { title: "Second revision" });

      const resolved = await call("GET", `/api/spaces/${spaceId}/items/${itemId}/finding`);
      const resolution = (resolved.body as {
        resolution: {
          revision_state: string;
          effective_revision: { id: string };
          current_revision: { id: string };
        };
      }).resolution;
      expect(resolution.effective_revision.id).toBe("rev-1");
      expect(resolution.current_revision.id).toBe("rev-2");
      expect(resolution.revision_state).toBe("pinned_superseded");
    },
  );

  it.skipIf(!PERSISTENCE_SUPPORTED)("validates metadata on a placement update", async () => {
    const spaceId = await makeSpace();
    const created = await call("POST", `/api/spaces/${spaceId}/items`, {
      ref_type: "finding",
      ref_id: "cand-1",
    });
    const itemId = (created.body as { item: { id: string } }).item.id;

    const bad = await call("PATCH", `/api/spaces/${spaceId}/items/${itemId}`, {
      metadata: { revision_mode: "pinned" },
    });
    expect(bad.status).toBe(400);

    const good = await call("PATCH", `/api/spaces/${spaceId}/items/${itemId}`, {
      metadata: { revision_mode: "pinned", pinned_revision_id: "rev-1" },
    });
    expect(good.status).toBe(200);
    expect((good.body as { item: { metadata: Record<string, unknown> } }).item.metadata).toEqual({
      revision_mode: "pinned",
      pinned_revision_id: "rev-1",
    });
  });
});
