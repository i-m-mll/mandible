import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { execFileSync } from "node:child_process";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, setDb, type Db } from "../src/db.js";
import { entityRefs, resolveId, shortRef, type IdKind } from "../src/entity-refs.js";
import { systemAction } from "../src/identity/resolver.js";
import { addProject } from "../src/ledger/project-registry.js";
import { LedgerStore } from "../src/ledger/store.js";
import { registerIssueRoutes } from "../src/routes/issues.js";
import type { Router } from "../src/server.js";
import { resolveBriefingId } from "../src/feedback/briefings.js";
import { registerUserRoutes } from "../src/routes/users.js";
import { createUser, setupOperator } from "../src/users/store.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { createLedgerIssue, insertRawLedgerIssue } from "./helpers/ledger-fixtures.js";

const fakeScanner = { getRepos: () => [], getRepoById: () => undefined, getBranches: () => [] } as never;

/** The short id the CLI prints for a full id. */
function printed(id: string): string {
  return execFileSync("jq", ["-L", "cli", "-r", 'include "mandible-identity"; mandible_short_id'], {
    input: JSON.stringify(id),
  }).toString().trim();
}

let db: Db;
let router: Router;
let store: LedgerStore;
let issueId: string;
let issueProject: string;

beforeEach(() => {
  db = new SqliteDatabase(":memory:");
  migrate(db);
  setDb(db);
  const project = addProject(db, { project_key: "refs", display_name: "Refs" });
  issueProject = project.id;
  issueId = createLedgerIssue(db, { project_id: project.id, alias: "ref1234" }).id;
  store = new LedgerStore(db);
  router = authenticatedTestRouter(setupOperator(db, { display_name: "Operator" }));
  registerIssueRoutes(router, fakeScanner, undefined, inlineLedgerReader());
});

afterEach(() => {
  db.close();
});

describe("printed short ids", () => {
  it("resolve a comment on every comment route", async () => {
    const comment = store.addComment(issueId, { body: "first", attribution: systemAction() });
    const short = printed(comment.id);
    expect(short.length).toBeLessThan(comment.id.length);

    const shown = await router.invoke({ method: "GET", url: `/api/ledger/comments/${short}/revisions` });
    expect(shown.status).toBe(200);
    expect((shown.body as { revisions: Array<{ entity_id: string }> }).revisions[0].entity_id).toBe(comment.id);

    const edited = await router.invoke({ method: "PATCH", url: `/api/ledger/comments/${short}`, body: { body: "second" } });
    expect(edited.status).toBe(200);
    expect(store.getComment(comment.id).body).toBe("second");

    const last = await router.invoke({ method: "GET", url: `/api/ledger/comments/${encodeURIComponent("ref1234#last")}/revisions` });
    expect((last.body as { revisions: Array<{ entity_id: string }> }).revisions[0].entity_id).toBe(comment.id);
  });

  it("are refused when they name several entities", async () => {
    const shared = "d6de794f";
    for (const suffix of ["a", "b"]) {
      store.addComment(issueId, { id: `${shared}${suffix.repeat(56)}`, body: suffix, attribution: systemAction() });
    }
    const refused = await router.invoke({ method: "PATCH", url: `/api/ledger/comments/${shared}`, body: { body: "x" } });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "ambiguous_ref", field: "params.commentId" });

  });

  it("tell apart ids minted in the same millisecond", async () => {
    const checkpoint = () => store.addIssueCheckpoint(issueId, {
      kind: "parent-role", payload: {}, attribution: systemAction(), created_at: 2,
    }).id;
    const twins = [checkpoint(), checkpoint()];
    expect(printed(twins[0])).not.toBe(printed(twins[1]));
    for (const twin of twins) {
      const found = await router.invoke({ method: "GET", url: `/api/ledger/issues/ref1234/checkpoints?id=${printed(twin)}` });
      expect(found.body).toMatchObject({ id: twin });
    }
  });
});

/** Insert a row naming only `values`, filling other required columns with placeholders. */
function insertRow(table: string, values: Record<string, unknown>): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>;
  const row: Record<string, unknown> = {};
  for (const column of columns) {
    if (!column.notnull || column.dflt_value !== null) continue;
    row[column.name] = /INT|REAL/i.test(column.type) ? 1 : `${column.name}-${values.id ?? Math.random()}`;
  }
  Object.assign(row, values);
  const names = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...(names.map((name) => row[name]) as never[]));
}

const SHARED = "cafe0123";
const hash = (fill: string) => `${SHARED}${fill.repeat(56)}`;

type Family = {
  kind: IdKind;
  /** Two entities whose keys share the prefix `SHARED`. */
  seed: () => [string, string];
  /** The key a reference spells for an id, without any typed prefix. */
  key: (id: string) => string;
};

const families: Record<string, Family> = {
  issue: {
    kind: "issue",
    seed: () => ["1", "2"].map((fill) => insertRawLedgerIssue(db, { id: hash(fill), projectId: issueProject, shortId: `${SHARED}${fill}` })) as [string, string],
    key: (id) => id,
  },
  "logical artifact": {
    kind: "artifact",
    seed: () => ["1", "2"].map((fill) => {
      insertRow("artifact", { id: `artifact:${hash(fill)}`, identity_key: `key-${fill}` });
      return `artifact:${hash(fill)}`;
    }) as [string, string],
    key: (id) => id.slice("artifact:".length),
  },
  "artifact blob": {
    kind: "artifact_blob",
    seed: () => ["1", "2"].map((fill) => {
      insertRow("artifact_blob", { id: `artifact-blob:${hash(fill)}`, algorithm: "sha256", content_hash: hash(fill) });
      return `artifact-blob:${hash(fill)}`;
    }) as [string, string],
    key: (id) => id.slice("artifact-blob:".length),
  },
  briefing: {
    kind: "briefing",
    // One legacy id stores the typed-ref prefix itself.
    seed: () => {
      insertRow("briefings", { id: hash("1") });
      insertRow("briefings", { id: `briefing:${hash("2")}` });
      return [hash("1"), `briefing:${hash("2")}`];
    },
    key: (id) => id.replace(/^briefing:/, ""),
  },
  "work unit": {
    kind: "work_unit",
    seed: () => ["1", "2"].map((fill) => {
      insertRow("work_units", { id: hash(fill), issue_id: issueId, state: "open", kind: "solo" });
      return hash(fill);
    }) as [string, string],
    key: (id) => id,
  },
};

describe.each(Object.entries(families))("%s references", (_name, family) => {
  let ids: [string, string];
  beforeEach(() => {
    db.exec("PRAGMA foreign_keys = OFF");
    ids = family.seed();
  });

  it("resolve an exact id or a unique prefix, and refuse a shared prefix naming the matches", () => {
    const [first, second] = ids;
    expect(resolveId(db, family.kind, family.key(first))).toEqual({ ok: true, id: first });
    expect(resolveId(db, family.kind, family.key(first).slice(0, SHARED.length + 1))).toEqual({ ok: true, id: first });
    expect(resolveId(db, family.kind, SHARED)).toEqual({ ok: false, error: "ambiguous", matches: [first, second].sort() });
    expect(resolveId(db, family.kind, "beef0123")).toEqual({ ok: false, error: "not_found" });
  });

  it("print short refs that resolve back", () => {
    for (const id of ids) {
      const short = shortRef(db, family.kind, id, { key: family.key(id) });
      expect(short.length).toBeLessThan(family.key(id).length);
      expect(resolveId(db, family.kind, short)).toEqual({ ok: true, id });
    }
  });
});

describe("issue references", () => {
  it("resolve short ids and aliases, within a project when one is named", () => {
    const elsewhere = addProject(db, { project_key: "elsewhere", display_name: "Elsewhere" }).id;
    const twin = insertRawLedgerIssue(db, { id: `${issueId.slice(0, 7)}f`.padEnd(64, "0"), projectId: elsewhere, shortId: "ref1234" });
    expect(store.resolveIssueRef("ref1234")).toMatchObject({ ok: false, error: "ambiguous" });
    expect(store.resolveIssueRef("refs/ref1234")).toEqual({ ok: true, id: issueId });
    expect(store.resolveIssueRef("elsewhere/ref1234")).toEqual({ ok: true, id: twin });
    expect(store.resolveIssueRef("ref1234", { project_id: elsewhere })).toEqual({ ok: true, id: twin });
  });
});

describe("conversation references", () => {
  it("complete a prefix to the one conversation, or the one session several conversations share", () => {
    const session = "5e5510aa-0000-4000-8000-000000000000";
    insertRow("conversations", { id: "c0a1-main", session_id: session, source: "claude_code" });
    insertRow("conversations", { id: "c0a1-side", session_id: session, source: "claude_code" });
    expect(entityRefs.conversation("c0a1-m")).toEqual({ ok: true, id: "c0a1-main" });
    expect(entityRefs.conversation(printed(session))).toEqual({ ok: true, id: session });
    expect(entityRefs.conversation("c0a1")).toEqual({ ok: false, error: "ambiguous", matches: ["c0a1-main", "c0a1-side"] });
  });
});

describe("references a caller cannot read", () => {
  it("resolves a caller's credential despite unreadable collisions and names only readable ambiguity", async () => {
    db.exec("PRAGMA foreign_keys = OFF");
    const agent = createUser(db, { slug: "refs-agent", kind: "agent", display_name: "Agent" });
    const peer = createUser(db, { slug: "refs-peer", kind: "human", display_name: "Peer" });
    for (const fill of ["1", "2"]) insertRow("user_credentials", { id: hash(fill), user_id: peer.id });
    const agentRouter = authenticatedTestRouter(agent);
    registerUserRoutes(agentRouter);
    const revoke = () => agentRouter.invoke({ method: "POST", url: "/api/users/credentials/" + SHARED + "/revoke" });

    const hidden = await revoke();
    expect(hidden.status).toBe(404);
    for (const fill of ["1", "2"]) expect(JSON.stringify(hidden.body)).not.toContain(hash(fill));

    insertRow("user_credentials", { id: hash("3"), user_id: agent.id });
    const own = await revoke();
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ credential: { id: hash("3"), status: "revoked" } });
    for (const fill of ["1", "2"]) {
      expect(db.prepare("SELECT status FROM user_credentials WHERE id = ?").get(hash(fill))).toEqual({ status: "active" });
    }

    insertRow("user_credentials", { id: hash("4"), user_id: agent.id });
    const ambiguous = await revoke();
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body).toMatchObject({ error: "ambiguous_ref", matches: [hash("3"), hash("4")] });
    for (const fill of ["1", "2"]) expect(JSON.stringify(ambiguous.body)).not.toContain(hash(fill));
  });

  it("resolves Briefings within membership before deciding ambiguity", () => {
    db.exec("PRAGMA foreign_keys = OFF");
    const agent = createUser(db, { slug: "refs-agent", kind: "agent", display_name: "Agent" });
    const viewer = { userId: agent.id, operator: false };
    insertRow("briefings", { id: hash("1") });
    insertRow("briefings", { id: hash("2") });
    insertRow("briefing_members", { briefing_id: hash("2"), user_id: agent.id, created_at: 1 });
    expect(resolveBriefingId(db, SHARED, viewer)).toBe(hash("2"));
    expect(resolveBriefingId(db, "briefing:" + SHARED, viewer)).toBe(hash("2"));
    expect(() => resolveBriefingId(db, hash("1"), viewer)).toThrowError(expect.objectContaining({ status: 404, code: "not_found" }));
    expect(() => resolveBriefingId(db, SHARED, { ...viewer, operator: true })).toThrowError(expect.objectContaining({ status: 409, code: "ambiguous_ref" }));
    insertRow("briefing_members", { briefing_id: hash("1"), user_id: agent.id, created_at: 1 });
    expect(() => resolveBriefingId(db, SHARED, viewer)).toThrowError(expect.objectContaining({ status: 409, code: "ambiguous_ref" }));
  });
});
