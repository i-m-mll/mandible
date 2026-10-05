import { getDb, type Db } from "../db.js";
import { LedgerStore } from "../ledger/store.js";
import type { ResponseLike, RouteRegistrar } from "../server.js";

type RedirectKind = "issue" | "auth" | "artifact";
type IssueRedirectResolution =
  | { ok: true; repoId: string; issueId: string }
  | { ok: false; status: 404 | 409; message: string };

const REDIRECT_CONFIG: Record<RedirectKind, {
  route: string;
  label: string;
  targetPath: string;
  targetParam: string;
}> = {
  issue: {
    route: "/r/issue/:ref",
    label: "issue",
    targetPath: "issues",
    targetParam: "issue",
  },
  auth: {
    route: "/r/auth/:ref",
    label: "auth request",
    targetPath: "auth",
    targetParam: "request",
  },
  artifact: {
    route: "/r/artifact/:ref",
    label: "artifact",
    targetPath: "artifacts",
    targetParam: "ref",
  },
};

export interface RedirectRouteOptions {
  resolveIssueLink?: (ref: string) => IssueRedirectResolution;
}

export function registerRedirectRoutes(
  router: RouteRegistrar,
  options: RedirectRouteOptions = {},
): void {
  const resolveIssueLink = options.resolveIssueLink ?? resolveLedgerIssueLink;
  const entries = Object.entries(REDIRECT_CONFIG) as Array<
    [RedirectKind, typeof REDIRECT_CONFIG[RedirectKind]]
  >;
  for (const [kind, config] of entries) {
    router.get(config.route, (req, res) => {
      const ref = req.params.ref?.trim();
      if (!ref) {
        res.status(400).json({ error: "missing_ref", kind });
        return;
      }
      if (kind === "issue") {
        const resolved = resolveIssueLink(ref);
        if (!resolved.ok) {
          sendMessagePage(res.status(resolved.status), {
            title: "Mandible issue link",
            message: resolved.message,
          });
          return;
        }
        const query = buildTargetQuery(req.query, {
          repo: resolved.repoId,
          issue: resolved.issueId,
        });
        sendRedirectPage(res, {
          label: config.label,
          target: `mandible:///issues?${query.toString()}`,
        });
        return;
      }
      sendRedirectPage(res, {
        label: config.label,
        target: buildMandibleTarget(config.targetPath, config.targetParam, {
          // Issue f59b5bd (review R2) — inbound refs pass through untouched:
          // shortening happens only at emission sites, so a caller supplying a
          // full UUID keeps its power to disambiguate 8-char collisions.
          ref,
          extraQuery: req.query,
        }),
      });
    }, { operation: { id: `redirect.${kind}`, effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });
  }
}

// Issue f59b5bd — /r/ redirects preserve extra query params (notably
// agent_session) so session-bound links compose: the caller's params carry
// through into the deep-link target, but the params the redirect itself owns
// always win.
function buildTargetQuery(
  extraQuery: Record<string, string> | undefined,
  ownParams: Record<string, string>,
): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(extraQuery ?? {})) {
    if (key in ownParams) continue;
    query.set(key, value);
  }
  for (const [key, value] of Object.entries(ownParams)) {
    query.set(key, value);
  }
  return query;
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

function buildMandibleTarget(
  path: string,
  param: string,
  input: { ref: string; extraQuery?: Record<string, string> },
): string {
  const query = buildTargetQuery(input.extraQuery, { [param]: input.ref });
  return `mandible:///${path}?${query.toString()}`;
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
