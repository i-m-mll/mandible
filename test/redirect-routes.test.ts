import SqliteDatabase from "../src/sqlite.ts";
import { describe, expect, it } from "vitest";
import {
  registerRedirectRoutes,
  resolveLedgerIssueLinkFromDb,
} from "../src/routes/redirects.js";
import { Router } from "../src/server.js";

describe("redirect routes", () => {
  it.each(['', '/r'])('keeps path-owned identity through %s redirects despite conflicting alias selectors', async (prefix) => {
    const router = new Router();
    registerRedirectRoutes(router, { resolveBriefingLink: () => ({ ok: true, briefingId: 'target' }) });
    const targetPrefix = prefix ? 'mandible:///' : '/#/';
    const artifact = await router.invoke({ method: 'GET',
      url: `${prefix}/artifact/artifact-version%3Aexact?ref=wrong&artifact=wrong&series=wrong&version=2&sidebar=hidden&agent_session=worker&unknown=keep` });
    expect(String(artifact.body)).toContain(JSON.stringify(`${targetPrefix}artifacts?sidebar=hidden&agent_session=worker&unknown=keep&ref=artifact-version%3Aexact`));
    const briefing = await router.invoke({ method: 'GET',
      url: `${prefix}/briefing/target?briefing=wrong&group=wrong&round=one&sidebar=hidden&unknown=keep` });
    expect(String(briefing.body)).toContain(JSON.stringify(`${targetPrefix}briefing?round=one&sidebar=hidden&unknown=keep&briefing=target`));
  });

  it("serves a ledger-resolved issue redirect page with a visible fallback link", async () => {
    const router = new Router();
    registerRedirectRoutes(router, {
      resolveIssueLink: (ref) => ({
        ok: true,
        repoId: "mandible",
        issueId: ref,
      }),
    });

    const response = await router.invoke({
      method: "GET",
      url: "/r/issue/089fe42",
    });

    const body = String(response.body);
    expect(response.status).toBe(200);
    expect(body).toContain(
      "window.location.replace(\"mandible:///issues?repo=mandible&issue=089fe42\")",
    );
    expect(body).toContain('href="mandible:///issues?repo=mandible&amp;issue=089fe42"');
  });

  it("routes auth requests and artifacts to their existing in-app hash destinations", async () => {
    const router = new Router();
    registerRedirectRoutes(router);

    const auth = await router.invoke({ method: "GET", url: "/r/auth/auth-1" });
    const artifact = await router.invoke({
      method: "GET",
      url: "/r/artifact/abcdef123456",
    });

    expect(String(auth.body)).toContain("mandible:///auth?request=auth-1");
    expect(String(artifact.body)).toContain("mandible:///artifacts?ref=abcdef123456");
  });

  // Issue f59b5bd (review R2) — inbound refs pass through untouched: /r/ never
  // discards a caller's full UUID, so an 8-char collision stays
  // disambiguatable via /r/. Shortening happens only at emission sites.
  it("preserves a caller-supplied full auth-request UUID", async () => {
    const router = new Router();
    registerRedirectRoutes(router);

    const auth = await router.invoke({
      method: "GET",
      url: "/r/auth/e4c52737-40e4-472a-8367-fbdbe97801a2",
    });

    expect(String(auth.body)).toContain(
      "mandible:///auth?request=e4c52737-40e4-472a-8367-fbdbe97801a2",
    );
  });

  // Issue f59b5bd — /r/ redirects preserve extra query params (notably
  // agent_session) so session-bound links compose.
  it("carries extra query params through auth and artifact redirects", async () => {
    const router = new Router();
    registerRedirectRoutes(router);

    const auth = await router.invoke({
      method: "GET",
      url: "/r/auth/auth-1?agent_session=0198c0de&sidebar=hidden",
    });
    const artifact = await router.invoke({
      method: "GET",
      url: "/r/artifact/abcdef123456?agent_session=0198c0de",
    });

    const authBody = String(auth.body);
    expect(authBody).toContain("mandible:///auth?");
    expect(authBody).toContain("agent_session=0198c0de");
    expect(authBody).toContain("sidebar=hidden");
    expect(authBody).toContain("request=auth-1");
    expect(String(artifact.body)).toContain("agent_session=0198c0de");
    expect(String(artifact.body)).toContain("ref=abcdef123456");
  });

  it("carries extra query params through issue redirects and keeps its own params authoritative", async () => {
    const router = new Router();
    registerRedirectRoutes(router, {
      resolveIssueLink: () => ({
        ok: true,
        repoId: "mandible",
        issueId: "089fe42",
      }),
    });

    const response = await router.invoke({
      method: "GET",
      url: "/r/issue/089fe42?agent_session=0198c0de&issue=spoofed&repo=spoofed",
    });

    const body = String(response.body);
    expect(body).toContain("agent_session=0198c0de");
    expect(body).toContain("repo=mandible");
    expect(body).toContain("issue=089fe42");
    expect(body).not.toContain("spoofed");
  });

  it("routes Briefing refs through the server resolver to the canonical id", async () => {
    const seen: string[] = [];
    const router = new Router();
    registerRedirectRoutes(router, {
      resolveBriefingLink: (ref) => {
        seen.push(ref);
        return ref === "ambig"
          ? { ok: false, status: 409, message: "Briefing reference 'ambig' is ambiguous." }
          : { ok: true, briefingId: "briefing:0123456789abcdef" };
      },
    });

    const resolved = await router.invoke({
      method: "GET",
      url: "/r/briefing/briefing%3A0123?agent_session=0198c0de&briefing=spoofed",
    });
    const ambiguous = await router.invoke({ method: "GET", url: "/r/briefing/ambig" });

    expect(seen).toEqual(["briefing:0123", "ambig"]);
    expect(String(resolved.body)).toContain(
      "mandible:///briefing?agent_session=0198c0de&briefing=briefing%3A0123456789abcdef",
    );
    expect(ambiguous.status).toBe(409);
    expect(String(ambiguous.body)).toContain("ambiguous");
    expect(String(ambiguous.body)).not.toContain("window.location.replace");
  });

  // Issue 75153b8 — every entity's web link differs from its desktop link
  // only by the /r prefix: the same resolver and params land on the
  // same-origin web hash route, with extra params forwarded unchanged.
  it("serves /<kind>/<ref> web links on the same-origin hash route", async () => {
    const router = new Router();
    registerRedirectRoutes(router, {
      resolveIssueLink: () => ({ ok: true, repoId: "mandible", issueId: "089fe42" }),
      resolveBriefingLink: () => ({ ok: true, briefingId: "0123abcd" }),
    });

    const issue = await router.invoke({
      method: "GET",
      url: "/issue/089fe42?agent_session=0198c0de&sidebar=hidden&issue=spoofed",
    });
    const auth = await router.invoke({ method: "GET", url: "/auth/auth-1" });
    const artifact = await router.invoke({
      method: "GET",
      url: "/artifact/artifact-version%3Aabcdef123456",
    });
    const briefing = await router.invoke({ method: "GET", url: "/briefing/0123" });

    const issueBody = String(issue.body);
    expect(issueBody).toContain(
      "window.location.replace(\"/#/issues?agent_session=0198c0de&sidebar=hidden&repo=mandible&issue=089fe42\")",
    );
    expect(issueBody).not.toContain("mandible:");
    expect(issueBody).not.toContain("spoofed");
    expect(String(auth.body)).toContain("\"/#/auth?request=auth-1\"");
    expect(String(artifact.body)).toContain("\"/#/artifacts?ref=artifact-version%3Aabcdef123456\"");
    expect(String(briefing.body)).toContain("\"/#/briefing?briefing=0123abcd\"");
  });

  it("URL-encodes deep-link targets and escapes fallback HTML", async () => {
    const router = new Router();
    registerRedirectRoutes(router, {
      resolveIssueLink: () => ({
        ok: true,
        repoId: "mandible",
        issueId: "<script>",
      }),
    });

    const response = await router.invoke({
      method: "GET",
      url: "/r/issue/%3Cscript%3E",
    });

    const body = String(response.body);
    expect(response.status).toBe(200);
    expect(body).toContain("mandible:///issues?repo=mandible&issue=%3Cscript%3E");
    expect(body).not.toContain('href="mandible:///issues?repo=mandible&issue=<script>"');
  });

  it("does not guess when an issue ref is ambiguous or missing", async () => {
    const router = new Router();
    registerRedirectRoutes(router, {
      resolveIssueLink: () => ({
        ok: false,
        status: 409,
        message: "Issue reference 'abcd' is ambiguous.",
      }),
    });

    const response = await router.invoke({
      method: "GET",
      url: "/r/issue/abcd",
    });

    expect(response.status).toBe(409);
    expect(String(response.body)).toContain("ambiguous");
    expect(String(response.body)).not.toContain("window.location.replace");
  });

  it("does not claim unsupported redirect kinds", async () => {
    const router = new Router();
    registerRedirectRoutes(router);

    for (const url of ["/r/session/s1", "/session/s1"]) {
      await expect(router.invoke({ method: "GET", url })).resolves.toEqual({
        status: 404,
        body: { error: "not_found" },
      });
    }
  });

  it("resolves issue refs through the ledger before building issue links", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      db.exec(`
        CREATE TABLE ledger_projects (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL
        );
        CREATE TABLE ledger_project_checkouts (
          project_id TEXT NOT NULL,
          work_repo_id TEXT,
          name TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE ledger_issues (
          id TEXT PRIMARY KEY,
          short_id TEXT NOT NULL,
          project_id TEXT NOT NULL
        );
        CREATE TABLE ledger_issue_aliases (
          issue_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          alias TEXT NOT NULL
        );
      `);
      db.prepare("INSERT INTO ledger_projects (id, display_name) VALUES (?, ?)").run(
        "project-1",
        "Mandible",
      );
      db.prepare(
        "INSERT INTO ledger_project_checkouts (project_id, work_repo_id, name, created_at) VALUES (?, ?, ?, ?)",
      ).run("project-1", "mandible", "Mandible checkout", 1);
      db.prepare("INSERT INTO ledger_issues (id, short_id, project_id) VALUES (?, ?, ?)").run(
        "issue-full-id",
        "59181bf",
        "project-1",
      );

      expect(resolveLedgerIssueLinkFromDb(db, "59181bf")).toEqual({
        ok: true,
        repoId: "mandible",
        issueId: "59181bf",
      });
    } finally {
      db.close();
    }
  });
});
