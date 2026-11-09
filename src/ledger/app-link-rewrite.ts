const APP_ORIGIN = "https://app.mandible.localhost:19420";

const VIEW_PATHS = new Set([
  "issues", "auth", "artifacts", "briefing",
  "spaces", "console", "work", "settings", "inbox", "logs", "graph", "timeline", "overview", "tasks",
]);

const HASH_ROUTE_URL = new RegExp(
  String.raw`(?:https?://(?:localhost|127\.0\.0\.1|app\.mandible\.localhost):19420/?#/|mandible:///?)`
    + String.raw`([a-z]+)(\?[^\s()<>\[\]"'\x60]*)?`,
  "g",
);

const TRAILING_PROSE = /[.,;:!?*_]+$/;

export interface AppLinkRewrite {
  from: string;
  to: string;
}

/** Rewrite fragment-routed app URLs and `mandible:///<view>?…` deep links into path routes. */
export function rewriteHashAppLinks(segment: string): { text: string; rewrites: AppLinkRewrite[] } {
  const rewrites: AppLinkRewrite[] = [];
  const text = segment.replace(HASH_ROUTE_URL, (match: string, view: string, rawQuery: string | undefined, offset: number) => {
    if (!VIEW_PATHS.has(view) || /^[\w/#%<…-]/.test(segment.slice(offset + match.length))) return match;
    const trailing = rawQuery?.match(TRAILING_PROSE)?.[0] ?? "";
    const query = new URLSearchParams((rawQuery ?? "").slice(1, rawQuery ? rawQuery.length - trailing.length : 0));
    const prefix = match.startsWith("mandible:") ? "mandible://" : APP_ORIGIN;
    const rewritten = `${prefix}${pathFor(view, query)}${trailing}`;
    rewrites.push({ from: match, to: rewritten });
    return rewritten;
  });
  return { text, rewrites };
}

function pathFor(view: string, query: URLSearchParams): string {
  const entity = takeEntity(view, query);
  const path = entity ? `/${entity.kind}/${entity.ref}` : `/${view}`;
  const rest = query.toString();
  return rest ? `${path}?${rest}` : path;
}

function takeEntity(view: string, query: URLSearchParams): { kind: string; ref: string } | null {
  switch (view) {
    case "issues": {
      const issue = take(query, "issue");
      const repo = take(query, "repo");
      if (!issue) {
        if (repo) query.set("repo", repo);
        return null;
      }
      return { kind: "issue", ref: repo ? `${pathRef(repo)}/${pathRef(issue)}` : pathRef(issue) };
    }
    case "auth": {
      const request = take(query, "request");
      return request ? { kind: "auth", ref: pathRef(request) } : null;
    }
    case "artifacts": {
      const series = take(query, "series");
      const version = take(query, "version");
      const ref = take(query, "ref");
      const artifact = take(query, "artifact");
      const chosen = series
        ? `${series}${version && /^\d+$/.test(version) ? `@${version}` : ""}`
        : ref ?? artifact;
      return chosen ? { kind: "artifact", ref: pathRef(chosen) } : null;
    }
    case "briefing": {
      const briefing = take(query, "briefing");
      return briefing ? { kind: "briefing", ref: pathRef(briefing) } : null;
    }
    default:
      return null;
  }
}

function take(query: URLSearchParams, key: string): string | null {
  const value = query.get(key)?.trim() || null;
  query.delete(key);
  return value;
}

function pathRef(value: string): string {
  return encodeURIComponent(value).replace(/%3A/gi, ":").replace(/%40/g, "@");
}
