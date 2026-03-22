import { getRuntimeManager } from "../runtime-manager.js";
// Bug: cc4688b — Zone 2 runtime API routes
export function registerRuntimeRoutes(router) {
    const mgr = getRuntimeManager();
    // GET /api/runtime/status — current runtime status
    router.get("/api/runtime/status", async (_req, res) => {
        try {
            const status = await mgr.getStatus();
            res.json(status);
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // GET /api/runtime/patches — list recorded patches
    router.get("/api/runtime/patches", async (_req, res) => {
        try {
            const patches = await mgr.listPatches();
            res.json(patches);
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // POST /api/runtime/bootstrap — trigger Zone 2 clone (async)
    router.post("/api/runtime/bootstrap", (_req, res) => {
        // Return immediately, run bootstrap in background
        res.json({ ok: true, message: "Bootstrap started" });
        void mgr.bootstrapZone2().catch((err) => {
            // Best-effort: the status endpoint will show the result
            console.error(`[runtime] bootstrap failed: ${err}`);
        });
    });
    // POST /api/runtime/update — check + apply upstream update
    router.post("/api/runtime/update", async (_req, res) => {
        try {
            const check = await mgr.checkForUpdates();
            if (!check.available) {
                res.json({ ok: true, updated: false, message: "Already up to date" });
                return;
            }
            await mgr.applyUpdate();
            const status = await mgr.getStatus();
            res.json({ ok: true, updated: true, behindBy: check.behindBy, status });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // POST /api/runtime/rollback — revert last patch
    router.post("/api/runtime/rollback", async (_req, res) => {
        try {
            await mgr.rollbackLastPatch();
            const status = await mgr.getStatus();
            res.json({ ok: true, status });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // POST /api/runtime/reset — reset to upstream main
    router.post("/api/runtime/reset", async (_req, res) => {
        try {
            await mgr.resetToUpstream();
            const status = await mgr.getStatus();
            res.json({ ok: true, status });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
}
