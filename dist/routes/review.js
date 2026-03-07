import { getCommitLog, getDiff, getSpec } from "../review.js";
import { WorkScanner } from "../work-scanner.js";
const getQueryValue = (req, key) => {
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
const jsonResponse = (res, body, status = 200) => {
    if (res?.status && res?.json) {
        res.status(status);
        res.json(body);
        return;
    }
    const ResponseCtor = globalThis
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
const requireParam = (value, name) => {
    if (!value) {
        throw new Error(`Missing required query param: ${name}`);
    }
    return value;
};
export const registerReviewRoutes = (server, scanner) => {
    const workScanner = scanner ?? new WorkScanner();
    const resolveRepoParam = (repo) => {
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
        }
        catch (error) {
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
        }
        catch (error) {
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
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Failed to load log";
            return jsonResponse(res, { error: message }, 400);
        }
    });
};
