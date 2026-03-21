/**
 * Preset HTTP routes.
 * Bug: 61bee4e — Presets feature backend
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb } from "../db.js";
import { broadcast } from "../sse.js";
import { parseMarkdownToNodes, serializeNodesToMarkdown, computeContentHash, computePresetUnion, importClaudeMd, routePresetDiffWithNodes, } from "../presets.js";
function sendJson(res, code, payload) {
    res.status(code).json(payload);
}
export function registerPresetRoutes(server) {
    // IMPORTANT: Register non-parameterized /api/presets/* routes BEFORE
    // /api/presets/:id — the router matches in registration order, so
    // "union", "library", "diffs", "import", "violations" would be
    // captured as :id if registered after it.
    // ================================================================
    // Union (must be before :id routes)
    // ================================================================
    // GET /api/presets/union?session_id=X
    server.get("/api/presets/union", (req, res) => {
        const sessionId = req.query.session_id;
        if (!sessionId) {
            sendJson(res, 400, { error: "session_id query parameter required" });
            return;
        }
        const db = getDb();
        const rows = db
            .prepare("SELECT preset_id FROM session_presets WHERE session_id = ? ORDER BY position ASC")
            .all(sessionId);
        const presetIds = rows.map((r) => r.preset_id);
        const result = computePresetUnion(presetIds, db);
        res.status(200).json(result);
    });
    // ================================================================
    // Convention Library (must be before :id routes)
    // ================================================================
    // GET /api/presets/library?q=<search>&limit=100&offset=0
    server.get("/api/presets/library", (req, res) => {
        const db = getDb();
        const query = req.query.q ?? "";
        const limitRaw = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 100;
        const offsetRaw = typeof req.query.offset === "string" ? parseInt(req.query.offset, 10) : 0;
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 500)) : 100;
        const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;
        // Get all leaf nodes (nodes with no children) across all presets, deduped by body content hash
        let sql = `
      SELECT pn.*, p.name as preset_name, p.id as source_preset_id
      FROM preset_nodes pn
      JOIN presets p ON p.id = pn.preset_id
      WHERE pn.id NOT IN (
        SELECT DISTINCT parent_id FROM preset_nodes WHERE parent_id IS NOT NULL
      )
    `;
        const params = [];
        if (query) {
            sql += " AND (pn.title LIKE ? OR pn.body LIKE ?)";
            const pattern = `%${query}%`;
            params.push(pattern, pattern);
        }
        sql += " ORDER BY pn.created_at DESC LIMIT ? OFFSET ?";
        params.push(limit, offset);
        const nodes = db.prepare(sql).all(...params);
        // Dedup by content hash
        const seen = new Set();
        const dedupedNodes = nodes.filter((node) => {
            const hash = computeContentHash(`${node.title}:${node.body}`);
            if (seen.has(hash))
                return false;
            seen.add(hash);
            return true;
        });
        res.status(200).json({ nodes: dedupedNodes });
    });
    // ================================================================
    // Preset Diffs (must be before :id routes)
    // ================================================================
    // GET /api/presets/diffs?session_id=X
    server.get("/api/presets/diffs", (req, res) => {
        const sessionId = req.query.session_id;
        if (!sessionId) {
            sendJson(res, 400, { error: "session_id query parameter required" });
            return;
        }
        const db = getDb();
        const diffs = db
            .prepare("SELECT * FROM preset_diffs WHERE session_id = ? ORDER BY created_at DESC")
            .all(sessionId);
        res.status(200).json({ diffs });
    });
    // POST /api/presets/diffs — create a diff (from workflow violation agent)
    server.post("/api/presets/diffs", (req, res) => {
        const body = (req.body ?? {});
        if (!body.session_id || typeof body.session_id !== "string") {
            sendJson(res, 400, { error: "session_id is required" });
            return;
        }
        const validDiffTypes = ["add", "remove", "modify"];
        if (!body.diff_type ||
            !validDiffTypes.includes(body.diff_type)) {
            sendJson(res, 400, { error: "diff_type must be add, remove, or modify" });
            return;
        }
        const db = getDb();
        const now = Date.now();
        const id = randomUUID();
        db.prepare(`INSERT INTO preset_diffs (id, session_id, preset_id, node_id, diff_type, old_content, new_content, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`).run(id, body.session_id, body.preset_id ?? null, body.node_id ?? null, body.diff_type, body.old_content ?? null, body.new_content ?? null, now);
        const diff = {
            id,
            session_id: body.session_id,
            preset_id: body.preset_id ?? null,
            node_id: body.node_id ?? null,
            diff_type: body.diff_type,
            old_content: body.old_content ?? null,
            new_content: body.new_content ?? null,
            status: "proposed",
            created_at: now,
        };
        broadcast("preset:diff:created", diff);
        res.status(201).json({ diff });
    });
    // PUT /api/presets/diffs/:id — update diff status
    server.put("/api/presets/diffs/:id", (req, res) => {
        const db = getDb();
        const diff = db
            .prepare("SELECT * FROM preset_diffs WHERE id = ?")
            .get(req.params.id);
        if (!diff) {
            sendJson(res, 404, { error: "diff not found" });
            return;
        }
        const body = (req.body ?? {});
        const validStatuses = [
            "proposed",
            "accepted",
            "rejected",
            "promoted",
        ];
        if (!body.status ||
            !validStatuses.includes(body.status)) {
            sendJson(res, 400, {
                error: "status must be proposed, accepted, rejected, or promoted",
            });
            return;
        }
        db.prepare("UPDATE preset_diffs SET status = ? WHERE id = ?").run(body.status, diff.id);
        const updated = { ...diff, status: body.status };
        broadcast("preset:diff:resolved", updated);
        res.status(200).json({ diff: updated });
    });
    // ================================================================
    // Export/Import (must be before :id routes for POST /api/presets/import)
    // ================================================================
    // POST /api/presets/import — accept Markdown content with optional front-matter.
    // Bug: 61bee4e — This endpoint accepts only inline markdown content, not file paths.
    // File-based imports use POST /api/presets/import-claudemd (controlled safe-path endpoint).
    server.post("/api/presets/import", (req, res) => {
        const body = (req.body ?? {});
        if (typeof body.markdown !== "string" || !body.markdown.trim()) {
            sendJson(res, 400, { error: "markdown content required" });
            return;
        }
        const db = getDb();
        const raw = body.markdown;
        // Parse front-matter
        let name = "Imported Preset";
        let description = "";
        let content = raw;
        const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (fmMatch) {
            const fmBlock = fmMatch[1];
            content = fmMatch[2];
            const nameMatch = fmBlock.match(/^name:\s*(.+)$/m);
            if (nameMatch)
                name = nameMatch[1].trim();
            const descMatch = fmBlock.match(/^description:\s*(.+)$/m);
            if (descMatch)
                description = descMatch[1].trim();
        }
        const now = Date.now();
        const id = randomUUID();
        const contentHash = computeContentHash(content);
        db.prepare(`INSERT INTO presets (id, name, description, source, content_hash, version, created_at, updated_at)
       VALUES (?, ?, ?, 'manual', ?, 1, ?, ?)`).run(id, name, description, contentHash, now, now);
        const nodes = parseMarkdownToNodes(content, id);
        const insertNode = db.prepare(`INSERT INTO preset_nodes (id, preset_id, parent_id, position, title, body, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const insertAll = db.transaction(() => {
            for (const node of nodes) {
                insertNode.run(node.id, node.preset_id, node.parent_id, node.position, node.title, node.body, node.level, node.created_at, node.updated_at);
            }
        });
        insertAll();
        const preset = {
            id,
            name,
            description,
            source: "manual",
            source_path: null,
            content_hash: contentHash,
            version: 1,
            created_at: now,
            updated_at: now,
        };
        broadcast("preset:created", preset);
        res.status(201).json({ preset });
    });
    // POST /api/presets/import-claudemd — import CLAUDE.md from known safe paths only.
    // Bug: 61bee4e — Controlled file-based import that only reads from known safe locations,
    // preventing path traversal. Accepts { source: "global" | "project", cwd?: string }.
    server.post("/api/presets/import-claudemd", (req, res) => {
        const body = (req.body ?? {});
        const source = body.source;
        if (source !== "global" && source !== "project") {
            sendJson(res, 400, { error: 'source must be "global" or "project"' });
            return;
        }
        let filePath;
        if (source === "global") {
            filePath = path.join(os.homedir(), ".claude", "CLAUDE.md");
        }
        else {
            // Project-level: require cwd and look for <cwd>/CLAUDE.md or <cwd>/.claude/CLAUDE.md
            const cwd = typeof body.cwd === "string" ? body.cwd : null;
            if (!cwd) {
                sendJson(res, 400, { error: "cwd is required for project source" });
                return;
            }
            // Resolve and verify the cwd is a directory to prevent shenanigans
            const resolvedCwd = path.resolve(cwd);
            try {
                const stat = fs.statSync(resolvedCwd);
                if (!stat.isDirectory()) {
                    sendJson(res, 400, { error: "cwd must be a directory" });
                    return;
                }
            }
            catch {
                sendJson(res, 400, { error: "cwd directory not found" });
                return;
            }
            // Try .claude/CLAUDE.md first, then root CLAUDE.md
            const dotClaudePath = path.join(resolvedCwd, ".claude", "CLAUDE.md");
            const rootPath = path.join(resolvedCwd, "CLAUDE.md");
            if (fs.existsSync(dotClaudePath)) {
                filePath = dotClaudePath;
            }
            else if (fs.existsSync(rootPath)) {
                filePath = rootPath;
            }
            else {
                sendJson(res, 404, { error: "No CLAUDE.md found in project" });
                return;
            }
        }
        try {
            const db = getDb();
            const preset = importClaudeMd(filePath, db);
            broadcast("preset:created", preset);
            res.status(201).json({ preset });
        }
        catch (error) {
            sendJson(res, 400, { error: `Failed to import: ${String(error)}` });
        }
    });
    // ================================================================
    // Workflow Violation Hook (must be before :id routes)
    // ================================================================
    // POST /api/presets/violations
    server.post("/api/presets/violations", (req, res) => {
        const body = (req.body ?? {});
        if (!body.sessionId || typeof body.sessionId !== "string") {
            sendJson(res, 400, { error: "sessionId is required" });
            return;
        }
        if (!body.context || typeof body.context !== "object") {
            sendJson(res, 400, { error: "context is required" });
            return;
        }
        const db = getDb();
        const now = Date.now();
        const diffId = randomUUID();
        const conventionText = body.context.conventionText ?? "";
        // Get the session's active presets for routing
        const sessionPresetRows = db
            .prepare(`SELECT p.* FROM presets p
         JOIN session_presets sp ON sp.preset_id = p.id
         WHERE sp.session_id = ?
         ORDER BY sp.position ASC`)
            .all(body.sessionId);
        // Route the violation to the best preset
        const routeResult = routePresetDiffWithNodes(conventionText, sessionPresetRows, {
            repo: body.context.repo,
            tool: body.context.tool,
            filePath: body.context.filePath,
        }, db);
        // Create the diff
        db.prepare(`INSERT INTO preset_diffs (id, session_id, preset_id, node_id, diff_type, old_content, new_content, status, created_at)
       VALUES (?, ?, ?, ?, 'add', ?, ?, 'proposed', ?)`).run(diffId, body.sessionId, routeResult.recommendedPresetId || null, null, null, conventionText, now);
        const diff = {
            id: diffId,
            session_id: body.sessionId,
            preset_id: routeResult.recommendedPresetId || null,
            node_id: null,
            diff_type: "add",
            old_content: null,
            new_content: conventionText,
            status: "proposed",
            created_at: now,
        };
        broadcast("preset:violation", {
            diff,
            routing: routeResult,
            context: body.context,
        });
        res.status(201).json({
            diff,
            routing: routeResult,
        });
    });
    // ================================================================
    // Preset CRUD
    // ================================================================
    // GET /api/presets — list all presets
    // Bug: 61bee4e — Uses aggregate query instead of N+1 per-preset queries.
    server.get("/api/presets", (_req, res) => {
        const db = getDb();
        // Single query: get presets with node count and approximate token estimate.
        // Token estimate: SUM of body + title character lengths / 3.5 (rough tokenizer heuristic).
        const enriched = db
            .prepare(`SELECT p.*,
                COALESCE(agg.node_count, 0) AS node_count,
                CAST(CEIL(COALESCE(agg.total_chars, 0) / 3.5) AS INTEGER) AS token_estimate
         FROM presets p
         LEFT JOIN (
           SELECT preset_id,
                  COUNT(*) AS node_count,
                  SUM(LENGTH(title) + LENGTH(body)) AS total_chars
           FROM preset_nodes
           GROUP BY preset_id
         ) agg ON agg.preset_id = p.id
         ORDER BY p.created_at DESC`)
            .all();
        res.status(200).json({ presets: enriched });
    });
    // POST /api/presets — create preset
    server.post("/api/presets", (req, res) => {
        const body = (req.body ?? {});
        if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
            sendJson(res, 400, { error: "name is required" });
            return;
        }
        const db = getDb();
        const now = Date.now();
        const id = randomUUID();
        const name = body.name.trim();
        const description = typeof body.description === "string" ? body.description : "";
        const source = body.source === "claude_md_global" ||
            body.source === "claude_md_project" ||
            body.source === "claude_md_local"
            ? body.source
            : "manual";
        const sourcePath = typeof body.source_path === "string" ? body.source_path : null;
        const content = typeof body.content === "string" ? body.content : "";
        const contentHash = content ? computeContentHash(content) : "";
        db.prepare(`INSERT INTO presets (id, name, description, source, source_path, content_hash, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(id, name, description, source, sourcePath, contentHash, now, now);
        // Parse and insert nodes if content provided
        if (content) {
            const nodes = parseMarkdownToNodes(content, id);
            const insertNode = db.prepare(`INSERT INTO preset_nodes (id, preset_id, parent_id, position, title, body, level, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            const insertAll = db.transaction(() => {
                for (const node of nodes) {
                    insertNode.run(node.id, node.preset_id, node.parent_id, node.position, node.title, node.body, node.level, node.created_at, node.updated_at);
                }
            });
            insertAll();
        }
        const preset = {
            id,
            name,
            description,
            source,
            source_path: sourcePath,
            content_hash: contentHash,
            version: 1,
            created_at: now,
            updated_at: now,
        };
        broadcast("preset:created", preset);
        res.status(201).json({ preset });
    });
    // GET /api/presets/:id — get preset with full node tree
    server.get("/api/presets/:id", (req, res) => {
        const db = getDb();
        const preset = db
            .prepare("SELECT * FROM presets WHERE id = ?")
            .get(req.params.id);
        if (!preset) {
            sendJson(res, 404, { error: "preset not found" });
            return;
        }
        const nodes = db
            .prepare("SELECT * FROM preset_nodes WHERE preset_id = ? ORDER BY position ASC")
            .all(preset.id);
        res.status(200).json({ preset, nodes });
    });
    // PUT /api/presets/:id — update preset metadata
    server.put("/api/presets/:id", (req, res) => {
        const db = getDb();
        const preset = db
            .prepare("SELECT * FROM presets WHERE id = ?")
            .get(req.params.id);
        if (!preset) {
            sendJson(res, 404, { error: "preset not found" });
            return;
        }
        const body = (req.body ?? {});
        const now = Date.now();
        const name = typeof body.name === "string" && body.name.trim()
            ? body.name.trim()
            : preset.name;
        const description = typeof body.description === "string" ? body.description : preset.description;
        db.prepare("UPDATE presets SET name = ?, description = ?, updated_at = ? WHERE id = ?").run(name, description, now, preset.id);
        const updated = { ...preset, name, description, updated_at: now };
        broadcast("preset:updated", updated);
        res.status(200).json({ preset: updated });
    });
    // DELETE /api/presets/:id — delete preset (cascade deletes nodes)
    server.delete("/api/presets/:id", (req, res) => {
        const db = getDb();
        const preset = db
            .prepare("SELECT * FROM presets WHERE id = ?")
            .get(req.params.id);
        if (!preset) {
            sendJson(res, 404, { error: "preset not found" });
            return;
        }
        // Delete nodes first (FK cascade may not work in all SQLite configs)
        db.prepare("DELETE FROM preset_nodes WHERE preset_id = ?").run(preset.id);
        db.prepare("DELETE FROM session_presets WHERE preset_id = ?").run(preset.id);
        db.prepare("DELETE FROM preset_diffs WHERE preset_id = ?").run(preset.id);
        db.prepare("DELETE FROM presets WHERE id = ?").run(preset.id);
        broadcast("preset:deleted", { id: preset.id });
        res.status(200).json({ ok: true });
    });
    // ================================================================
    // Node Operations
    // ================================================================
    // GET /api/presets/:id/nodes — flat list of nodes
    server.get("/api/presets/:id/nodes", (req, res) => {
        const db = getDb();
        const preset = db
            .prepare("SELECT id FROM presets WHERE id = ?")
            .get(req.params.id);
        if (!preset) {
            sendJson(res, 404, { error: "preset not found" });
            return;
        }
        const nodes = db
            .prepare("SELECT * FROM preset_nodes WHERE preset_id = ? ORDER BY position ASC")
            .all(preset.id);
        res.status(200).json({ nodes });
    });
    // PUT /api/presets/:id/nodes — bulk replace entire node tree
    server.put("/api/presets/:id/nodes", (req, res) => {
        const db = getDb();
        const preset = db
            .prepare("SELECT * FROM presets WHERE id = ?")
            .get(req.params.id);
        if (!preset) {
            sendJson(res, 404, { error: "preset not found" });
            return;
        }
        const body = (req.body ?? {});
        const now = Date.now();
        let nodes;
        if (typeof body.markdown === "string") {
            // Parse from Markdown
            nodes = parseMarkdownToNodes(body.markdown, preset.id);
        }
        else if (Array.isArray(body.nodes)) {
            // Accept raw node data
            nodes = body.nodes.map((n, i) => ({
                id: typeof n.id === "string" ? n.id : randomUUID(),
                preset_id: preset.id,
                parent_id: typeof n.parent_id === "string" ? n.parent_id : null,
                position: typeof n.position === "number" ? n.position : i,
                title: typeof n.title === "string" ? n.title : "",
                body: typeof n.body === "string" ? n.body : "",
                level: typeof n.level === "number" ? n.level : 1,
                created_at: now,
                updated_at: now,
            }));
        }
        else {
            sendJson(res, 400, { error: "nodes array or markdown string required" });
            return;
        }
        const insertNode = db.prepare(`INSERT INTO preset_nodes (id, preset_id, parent_id, position, title, body, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const replaceAll = db.transaction(() => {
            // Delete existing nodes
            db.prepare("DELETE FROM preset_nodes WHERE preset_id = ?").run(preset.id);
            // Insert new nodes
            for (const node of nodes) {
                insertNode.run(node.id, node.preset_id, node.parent_id, node.position, node.title, node.body, node.level, node.created_at, node.updated_at);
            }
            // Update preset content hash and version
            const markdown = serializeNodesToMarkdown(nodes);
            const contentHash = computeContentHash(markdown);
            db.prepare("UPDATE presets SET content_hash = ?, version = version + 1, updated_at = ? WHERE id = ?").run(contentHash, now, preset.id);
        });
        replaceAll();
        broadcast("preset:updated", { id: preset.id });
        res.status(200).json({ nodes });
    });
    // POST /api/presets/:id/nodes — add a single node
    server.post("/api/presets/:id/nodes", (req, res) => {
        const db = getDb();
        const preset = db
            .prepare("SELECT id FROM presets WHERE id = ?")
            .get(req.params.id);
        if (!preset) {
            sendJson(res, 404, { error: "preset not found" });
            return;
        }
        const body = (req.body ?? {});
        const now = Date.now();
        const nodeId = randomUUID();
        const parentId = typeof body.parent_id === "string" ? body.parent_id : null;
        const position = typeof body.position === "number" ? body.position : 0;
        const title = typeof body.title === "string" ? body.title : "";
        const nodeBody = typeof body.body === "string" ? body.body : "";
        const level = typeof body.level === "number" ? body.level : 1;
        db.prepare(`INSERT INTO preset_nodes (id, preset_id, parent_id, position, title, body, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(nodeId, preset.id, parentId, position, title, nodeBody, level, now, now);
        // Update preset timestamp
        db.prepare("UPDATE presets SET updated_at = ? WHERE id = ?").run(now, preset.id);
        const node = {
            id: nodeId,
            preset_id: preset.id,
            parent_id: parentId,
            position,
            title,
            body: nodeBody,
            level,
            created_at: now,
            updated_at: now,
        };
        broadcast("preset:updated", { id: preset.id });
        res.status(201).json({ node });
    });
    // PUT /api/presets/:id/nodes/:nodeId — update a single node
    server.put("/api/presets/:id/nodes/:nodeId", (req, res) => {
        const db = getDb();
        const node = db
            .prepare("SELECT * FROM preset_nodes WHERE id = ? AND preset_id = ?")
            .get(req.params.nodeId, req.params.id);
        if (!node) {
            sendJson(res, 404, { error: "node not found" });
            return;
        }
        const body = (req.body ?? {});
        const now = Date.now();
        const parentId = body.parent_id !== undefined
            ? typeof body.parent_id === "string"
                ? body.parent_id
                : null
            : node.parent_id;
        const position = typeof body.position === "number" ? body.position : node.position;
        const title = typeof body.title === "string" ? body.title : node.title;
        const nodeBody = typeof body.body === "string" ? body.body : node.body;
        const level = typeof body.level === "number" ? body.level : node.level;
        db.prepare(`UPDATE preset_nodes SET parent_id = ?, position = ?, title = ?, body = ?, level = ?, updated_at = ?
       WHERE id = ?`).run(parentId, position, title, nodeBody, level, now, node.id);
        // Update preset timestamp
        db.prepare("UPDATE presets SET updated_at = ? WHERE id = ?").run(now, req.params.id);
        const updated = {
            ...node,
            parent_id: parentId,
            position,
            title,
            body: nodeBody,
            level,
            updated_at: now,
        };
        broadcast("preset:updated", { id: req.params.id });
        res.status(200).json({ node: updated });
    });
    // DELETE /api/presets/:id/nodes/:nodeId — delete a node (cascade children)
    server.delete("/api/presets/:id/nodes/:nodeId", (req, res) => {
        const db = getDb();
        const node = db
            .prepare("SELECT * FROM preset_nodes WHERE id = ? AND preset_id = ?")
            .get(req.params.nodeId, req.params.id);
        if (!node) {
            sendJson(res, 404, { error: "node not found" });
            return;
        }
        // Recursively delete children (SQLite FK cascade may not be enabled)
        const deleteRecursive = (nodeId) => {
            const children = db
                .prepare("SELECT id FROM preset_nodes WHERE parent_id = ?")
                .all(nodeId);
            for (const child of children) {
                deleteRecursive(child.id);
            }
            db.prepare("DELETE FROM preset_nodes WHERE id = ?").run(nodeId);
        };
        db.transaction(() => {
            deleteRecursive(node.id);
            db.prepare("UPDATE presets SET updated_at = ? WHERE id = ?").run(Date.now(), req.params.id);
        })();
        broadcast("preset:updated", { id: req.params.id });
        res.status(200).json({ ok: true });
    });
    // PATCH /api/presets/:id/nodes/reorder — reorder a node
    server.patch("/api/presets/:id/nodes/reorder", (req, res) => {
        const db = getDb();
        const preset = db
            .prepare("SELECT id FROM presets WHERE id = ?")
            .get(req.params.id);
        if (!preset) {
            sendJson(res, 404, { error: "preset not found" });
            return;
        }
        const body = (req.body ?? {});
        if (!body.nodeId || typeof body.nodeId !== "string") {
            sendJson(res, 400, { error: "nodeId is required" });
            return;
        }
        const node = db
            .prepare("SELECT * FROM preset_nodes WHERE id = ? AND preset_id = ?")
            .get(body.nodeId, preset.id);
        if (!node) {
            sendJson(res, 404, { error: "node not found" });
            return;
        }
        const now = Date.now();
        const newParentId = body.newParentId === null || body.newParentId === undefined
            ? null
            : typeof body.newParentId === "string"
                ? body.newParentId
                : node.parent_id;
        const newPosition = typeof body.newPosition === "number" ? body.newPosition : node.position;
        db.prepare("UPDATE preset_nodes SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?").run(newParentId, newPosition, now, node.id);
        db.prepare("UPDATE presets SET updated_at = ? WHERE id = ?").run(now, preset.id);
        broadcast("preset:updated", { id: preset.id });
        res.status(200).json({ ok: true });
    });
    // ================================================================
    // Session-Preset Association
    // ================================================================
    // GET /api/console/sessions/:id/presets — get session's active presets
    server.get("/api/console/sessions/:id/presets", (req, res) => {
        const db = getDb();
        const rows = db
            .prepare(`SELECT sp.*, p.name, p.description, p.source, p.version as current_version
         FROM session_presets sp
         JOIN presets p ON p.id = sp.preset_id
         WHERE sp.session_id = ?
         ORDER BY sp.position ASC`)
            .all(req.params.id);
        res.status(200).json({ presets: rows });
    });
    // POST /api/console/sessions/:id/presets — add preset(s) to session
    server.post("/api/console/sessions/:id/presets", (req, res) => {
        const db = getDb();
        const sessionId = req.params.id;
        const body = (req.body ?? {});
        if (!Array.isArray(body.presetIds) || body.presetIds.length === 0) {
            sendJson(res, 400, { error: "presetIds array required" });
            return;
        }
        // Get current max position
        const maxRow = db
            .prepare("SELECT MAX(position) as max_pos FROM session_presets WHERE session_id = ?")
            .get(sessionId);
        let nextPos = (maxRow?.max_pos ?? -1) + 1;
        const insert = db.prepare(`INSERT OR IGNORE INTO session_presets (session_id, preset_id, preset_version, position)
       VALUES (?, ?, ?, ?)`);
        const addAll = db.transaction(() => {
            for (const presetId of body.presetIds) {
                const preset = db
                    .prepare("SELECT version FROM presets WHERE id = ?")
                    .get(presetId);
                if (preset) {
                    insert.run(sessionId, presetId, preset.version, nextPos++);
                }
            }
        });
        addAll();
        res.status(200).json({ ok: true });
    });
    // DELETE /api/console/sessions/:id/presets/:presetId — remove preset from session
    server.delete("/api/console/sessions/:id/presets/:presetId", (req, res) => {
        const db = getDb();
        db.prepare("DELETE FROM session_presets WHERE session_id = ? AND preset_id = ?").run(req.params.id, req.params.presetId);
        res.status(200).json({ ok: true });
    });
    // ================================================================
    // Export (parameterized :id route — registered after non-parameterized routes)
    // ================================================================
    // GET /api/presets/:id/export — return Markdown with front-matter
    server.get("/api/presets/:id/export", (req, res) => {
        const db = getDb();
        const preset = db
            .prepare("SELECT * FROM presets WHERE id = ?")
            .get(req.params.id);
        if (!preset) {
            sendJson(res, 404, { error: "preset not found" });
            return;
        }
        const nodes = db
            .prepare("SELECT * FROM preset_nodes WHERE preset_id = ? ORDER BY position ASC")
            .all(preset.id);
        const markdown = serializeNodesToMarkdown(nodes);
        const frontMatter = [
            "---",
            `name: ${preset.name}`,
            `version: ${preset.version}`,
            `source: ${preset.source}`,
            `description: ${preset.description}`,
            "---",
            "",
        ].join("\n");
        res.status(200).json({ markdown: frontMatter + markdown });
    });
}
