import { getCommitLog, getDiff, getSpec } from "../review.js";
import { WorkScanner } from "../work-scanner.js";

type QuerySource = Record<string, string | string[] | undefined> | undefined;

type RequestLike = {
  url?: string;
  query?: QuerySource;
};

type ResponseLike = {
  status?: (code: number) => ResponseLike;
  json?: (body: unknown) => void;
};

type RouteHandler = (req: RequestLike, res?: ResponseLike) => Promise<unknown> | unknown;

type RouteRegistrar = {
  get: (path: string, handler: RouteHandler) => void;
};

const getQueryValue = (req: RequestLike, key: string): string | undefined => {
  if (req.query) {
    const value = req.query[key];
    if (Array.isArray(value)) {
      return value[0];
    }
    if (value !== undefined) {
      return value;
    }
  }

  if (req.url) {
    const url = new URL(req.url, "http://localhost");
    const value = url.searchParams.get(key);
    return value === null ? undefined : value;
  }

  return undefined;
};

const jsonResponse = (res: ResponseLike | undefined, body: unknown, status = 200): unknown => {
  if (res?.status && res?.json) {
    res.status(status);
    res.json(body);
    return;
  }

  const ResponseCtor = (globalThis as { Response?: new (body?: unknown, init?: unknown) => unknown })
    .Response;
  if (ResponseCtor) {
    return new ResponseCtor(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
      },
    });
  }

  return {
    status,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
};

const requireParam = (value: string | undefined, name: string): string => {
  if (!value) {
    throw new Error(`Missing required query param: ${name}`);
  }
  return value;
};

export const registerReviewRoutes = (
  server: RouteRegistrar,
  scanner?: WorkScanner,
): void => {
  const workScanner = scanner ?? new WorkScanner();

  const resolveRepoParam = (repo: string): string => {
    const match = workScanner.getRepoById(repo);
    return match ? match.root : repo;
  };

  server.get("/api/review/diff", async (req, res) => {
    try {
      const repo = resolveRepoParam(requireParam(getQueryValue(req, "repo"), "repo"));
      const base = requireParam(getQueryValue(req, "base"), "base");
      const head = requireParam(getQueryValue(req, "head"), "head");
      const diff = await getDiff(repo, base, head);
      return jsonResponse(res, diff);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load diff";
      return jsonResponse(res, { error: message }, 400);
    }
  });

  server.get("/api/review/spec", async (req, res) => {
    try {
      const repo = resolveRepoParam(requireParam(getQueryValue(req, "repo"), "repo"));
      const branch = getQueryValue(req, "branch") ?? "HEAD";
      const spec = await getSpec(repo, branch);
      return jsonResponse(res, {
        ...spec,
        markdown: spec.raw,
        content: spec.raw,
        commits: [],
        meta: {},
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load spec";
      return jsonResponse(res, { error: message }, 400);
    }
  });

  server.get("/api/review/log", async (req, res) => {
    try {
      const repo = resolveRepoParam(requireParam(getQueryValue(req, "repo"), "repo"));
      const base = requireParam(getQueryValue(req, "base"), "base");
      const head = requireParam(getQueryValue(req, "head"), "head");
      const log = await getCommitLog(repo, base, head);
      return jsonResponse(res, log);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load log";
      return jsonResponse(res, { error: message }, 400);
    }
  });
};
