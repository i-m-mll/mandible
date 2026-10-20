import { getDb, type Db } from "../db.js";
import { resolveBriefingId } from "../feedback/briefings.js";
import { LedgerStore } from "../ledger/store.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import { briefingReadViewer } from "./briefing.js";

type RedirectKind = "issue" | "auth" | "artifact" | "briefing";
type RedirectFailure = { ok: false; status: number; message: string };
type IssueRedirectResolution =
  | { ok: true; repoId: string; issueId: string }
  | RedirectFailure;
type BriefingRedirectResolution =
  | { ok: true; briefingId: string }
  | RedirectFailure;
type TargetResolution = { ok: true; params: Record<string, string> } | RedirectFailure;

// Each kind names its UI hash path. Every entity has two link forms that
// differ only by the `/r` prefix: `/<kind>/<ref>` opens the same-origin web
// hash route `/#/<path>?<query>` in the current browser, and
// `/r/<kind>/<ref>` hands the same route to the desktop app as
// `mandible:///<path>?<query>`. Both forms share one resolver per kind.
const REDIRECT_CONFIG: Record<RedirectKind, { label: string; targetPath: string }> = {
  issue: { label: "issue", targetPath: "issues" },
  auth: { label: "auth request", targetPath: "auth" },
  artifact: { label: "artifact", targetPath: "artifacts" },
  briefing: { label: "Briefing", targetPath: "briefing" },
};

const LINK_FORMS = [
  { routePrefix: "/r", targetPrefix: "mandible:///", operationPrefix: "redirect" },
  { routePrefix: "", targetPrefix: "/#/", operationPrefix: "link" },
] as const;

export interface RedirectRouteOptions {
  resolveIssueLink?: (ref: string) => IssueRedirectResolution;
  resolveBriefingLink?: (ref: string, req: RequestLike) => BriefingRedirectResolution;
}

export function registerRedirectRoutes(
  router: RouteRegistrar,
  options: RedirectRouteOptions = {},
): void {
  const resolveIssueLink = options.resolveIssueLink ?? resolveLedgerIssueLink;
  const resolveBriefingLink = options.resolveBriefingLink ?? resolveLedgerBriefingLink;
  const resolveTarget = (kind: RedirectKind, ref: string, req: RequestLike): TargetResolution => {
    switch (kind) {
      case "issue": {
        const resolved = resolveIssueLink(ref);
        return resolved.ok ? { ok: true, params: { repo: resolved.repoId, issue: resolved.issueId } } : resolved;
      }
      case "briefing": {
        const resolved = resolveBriefingLink(ref, req);
        return resolved.ok ? { ok: true, params: { briefing: resolved.briefingId } } : resolved;
      }
      // Issue f59b5bd (review R2) — inbound refs pass through untouched:
      // shortening happens only at emission sites, so a caller supplying a
      // full UUID keeps its power to disambiguate 8-char collisions.
      case "auth":
        return { ok: true, params: { request: ref } };
      case "artifact":
        return { ok: true, params: { ref } };
    }
  };
  const entries = Object.entries(REDIRECT_CONFIG) as Array<
    [RedirectKind, typeof REDIRECT_CONFIG[RedirectKind]]
  >;
  for (const form of LINK_FORMS) {
    for (const [kind, config] of entries) {
      router.get(`${form.routePrefix}/${kind}/:ref`, (req, res) => {
        const ref = req.params.ref?.trim();
        if (!ref) {
          res.status(400).json({ error: "missing_ref", kind });
          return;
        }
        const resolved = resolveTarget(kind, ref, req);
        if (!resolved.ok) {
          sendMessagePage(res.status(resolved.status), {
            title: `Mandible ${config.label} link`,
            message: resolved.message,
          });
          return;
        }
        const query = buildTargetQuery(req.query ?? {}, resolved.params);
        sendRedirectPage(res, {
          label: config.label,
          target: `${form.targetPrefix}${config.targetPath}?${query.toString()}`,
        });
      }, { operation: { id: `${form.operationPrefix}.${kind}`, effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });
    }
  }
}

// Issue f59b5bd — /r/ redirects preserve extra query params (notably
// agent_session) so session-bound links compose: the caller's params carry
// through into the deep-link target, but the params the redirect itself owns
// always win.
function buildTargetQuery(
  extraQuery: Record<string, string>,
  ownParams: Record<string, string>,
): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(extraQuery)) {
    if (key in ownParams) continue;
    query.set(key, value);
  }
  for (const [key, value] of Object.entries(ownParams)) {
    query.set(key, value);
  }
  return query;
}

// Briefing refs resolve server-side because agents may hold a typed
// `briefing:` ref or a legacy id that the view's prefix match cannot reach.
// The redirect emits the canonical id, which the view matches exactly.
function resolveLedgerBriefingLink(ref: string, req: RequestLike): BriefingRedirectResolution {
  try {
    const db = getDb();
    return { ok: true, briefingId: resolveBriefingId(db, ref, briefingReadViewer(db, req)) };
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    const code = (error as { code?: unknown }).code;
    return {
      ok: false,
      status: typeof status === "number" && status >= 400 && status < 500 ? status : 404,
      message: code === "ambiguous_ref"
        ? `Briefing reference '${ref}' is ambiguous.`
        : code === "not_found"
          ? `Briefing reference '${ref}' was not found.`
          : error instanceof Error ? error.message : "Briefing link could not be resolved.",
    };
  }
}

function resolveLedgerIssueLink(ref: string): IssueRedirectResolution {
  try {
    return resolveLedgerIssueLinkFromDb(getDb(), ref);
  } catch (error) {
    return {
      ok: false,
      status: 404,
      message: error instanceof Error ? error.message : "Issue link could not be resolved.",
    };
  }
}

export function resolveLedgerIssueLinkFromDb(db: Db, ref: string): IssueRedirectResolution {
  const resolved = new LedgerStore(db).resolveIssueRef(ref);
  if (!resolved.ok) {
    return {
      ok: false,
      status: resolved.error === "ambiguous" ? 409 : 404,
      message: resolved.error === "ambiguous"
        ? `Issue reference '${ref}' is ambiguous.`
        : `Issue reference '${ref}' was not found.`,
    };
  }

  // Issue 3d85f43: prefer the canonical project_key so /r/issue redirects land on
  // the same repo identity the issue-detail surface shows (and which the issue
  // listing repo filter now accepts), not the path-derived work_repo_id. Guarded
  // so synthetic pre-v87 schemas (some tests) without the column still resolve.
  const hasProjectKey = (db.prepare("PRAGMA table_info(ledger_projects)").all() as Array<{
    name: string;
  }>).some((column) => column.name === "project_key");
  const repoIdExpr = hasProjectKey
    ? "COALESCE(NULLIF(p.project_key, ''), NULLIF(c.work_repo_id, ''), NULLIF(c.name, ''), p.display_name, p.id)"
    : "COALESCE(NULLIF(c.work_repo_id, ''), NULLIF(c.name, ''), p.display_name, p.id)";
  const row = db.prepare(`
    SELECT
      i.id,
      i.short_id,
      i.project_id,
      ${repoIdExpr} AS repo_id
    FROM ledger_issues i
    JOIN ledger_projects p ON p.id = i.project_id
    LEFT JOIN ledger_project_checkouts c ON c.project_id = i.project_id
    WHERE i.id = ?
    ORDER BY
      CASE WHEN c.work_repo_id IS NOT NULL AND c.work_repo_id != '' THEN 0 ELSE 1 END,
      c.created_at ASC
    LIMIT 1
  `).get(resolved.id) as {
    id: string;
    short_id: string;
    project_id: string;
    repo_id: string | null;
  } | undefined;

  if (!row) {
    return {
      ok: false,
      status: 404,
      message: `Issue reference '${ref}' was not found.`,
    };
  }

  return {
    ok: true,
    repoId: row.repo_id ?? row.project_id,
    issueId: row.short_id || row.id,
  };
}

function sendRedirectPage(
  res: ResponseLike,
  input: {
    label: string;
    target: string;
  },
): void {
  const html = renderRedirectPage(input.label, input.target);
  if (typeof res.html === "function") {
    res.html(html);
    return;
  }
  res.json({ html });
}

function sendMessagePage(
  res: ResponseLike,
  input: {
    title: string;
    message: string;
  },
): void {
  const html = renderMessagePage(input.title, input.message);
  if (typeof res.html === "function") {
    res.html(html);
    return;
  }
  res.json({ message: input.message });
}

function renderRedirectPage(label: string, target: string): string {
  const escapedLabel = escapeHtml(label);
  const escapedTarget = escapeHtml(target);
  const scriptTarget = JSON.stringify(target);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Open Mandible ${escapedLabel}</title>
</head>
<body>
  <p>Opening Mandible ${escapedLabel}...</p>
  <p><a href="${escapedTarget}">Open in Mandible</a></p>
  <script>
    window.location.replace(${scriptTarget});
  </script>
</body>
</html>`;
}

function renderMessagePage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}
