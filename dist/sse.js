import { getDb } from "./db.js";
export class SseManager {
    clients = new Set();
    heartbeatTimer = null;
    startupCommit = null;
    /** Start periodic heartbeat comments to keep connections alive. */
    startHeartbeat(intervalMs = 15_000) {
        if (this.heartbeatTimer)
            return;
        this.heartbeatTimer = setInterval(() => {
            const comment = `: heartbeat ${Date.now()}\n\n`;
            for (const client of this.clients) {
                try {
                    client.res.write(comment);
                }
                catch { /* removed on close */ }
            }
        }, intervalMs);
        // Ensure the timer doesn't prevent process exit
        if (this.heartbeatTimer && typeof this.heartbeatTimer === "object" && "unref" in this.heartbeatTimer) {
            this.heartbeatTimer.unref();
        }
    }
    addClient(req, res, topics) {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
        });
        res.write(`: connected\n\n`);
        const client = { res, topics };
        this.clients.add(client);
        this.maybeSendReloadEvent(client);
        const remove = () => {
            this.clients.delete(client);
        };
        req.on("close", remove);
        res.on("close", remove);
    }
    setStartupCommit(info) {
        this.startupCommit = info;
    }
    broadcast(event) {
        const payload = `data: ${JSON.stringify(event)}\n\n`;
        for (const client of this.clients) {
            if (client.topics.length > 0 && !matchesTopic(event.type, client.topics)) {
                continue;
            }
            // Guard against the race where the client disconnected between the topic
            // check and the write (the "close" event that removes from this.clients
            // is async, so the client can still be in the set with a dead socket).
            try {
                client.res.write(payload);
            }
            catch { /* removed on close */ }
        }
    }
    closeAll() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        for (const client of this.clients) {
            client.res.destroy();
        }
        this.clients.clear();
    }
    count() {
        return this.clients.size;
    }
    maybeSendReloadEvent(client) {
        const uptime = process.uptime();
        if (uptime >= 60) {
            return;
        }
        if (!this.startupCommit) {
            return;
        }
        // Query recently-completed auth requests (within the daemon uptime window)
        let recentRequests = [];
        const bugRefs = [];
        try {
            const db = getDb();
            const cutoff = Date.now() - 60_000;
            const rows = db.prepare(`SELECT id, title, commit_message, repo FROM auth_requests
         WHERE status = 'completed' AND exit_code = 0 AND resolved_at > ?
         ORDER BY resolved_at DESC`).all(cutoff);
            recentRequests = rows.map((r) => ({ id: r.id, title: r.title }));
            for (const row of rows) {
                const msg = row.commit_message || "";
                const match = msg.match(/^Bug:\s+(\S+)/m);
                if (match && row.repo) {
                    bugRefs.push({ repo_id: row.repo, issue_id: match[1] });
                }
            }
        }
        catch {
            // DB not ready yet — proceed without recent requests
        }
        const event = {
            type: "daemon:reloaded",
            data: {
                commit_hash: this.startupCommit.hash,
                commit_summary: this.startupCommit.summary,
                commit_date: this.startupCommit.date,
                uptime,
                recent_requests: recentRequests,
                bug_refs: bugRefs,
            },
            timestamp: new Date().toISOString()
        };
        try {
            client.res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        catch {
            return;
        }
    }
}
function matchesTopic(type, topics) {
    return topics.some((topic) => type.startsWith(topic));
}
// --- Module-level singleton for partition code ---
let _instance = null;
export function setSseManager(manager) {
    _instance = manager;
}
export function broadcast(eventOrType, data) {
    if (!_instance)
        return;
    let type;
    let eventData;
    if (typeof eventOrType === "string") {
        type = eventOrType;
        eventData = data;
    }
    else {
        type = eventOrType.type ?? eventOrType.event;
        eventData = eventOrType.data;
    }
    _instance.broadcast({
        type,
        data: eventData,
        timestamp: new Date().toISOString()
    });
}
