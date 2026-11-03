#!/usr/bin/env bun
import { EXECUTION_CONTEXT_ARGUMENT } from "../src/claude-execution-context.js";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { channelTransportHeaders, request, withChannelExecutionContext } from "./transport.js";
import { resolveBaseUrl, resolveTransport } from "./base-url.js";

type Catalog = { protocol: number; event_topics: string[]; instructions: string; tools: Tool[] };
type Rendered = { notifications: Array<{ method: string; params: Record<string, unknown> }>; delivered: string[] };

export async function main(): Promise<void> {
  const ctx = { session_id: process.env.MANDIBLE_SESSION_ID ?? process.env.SESSION_ID ?? null,
    conversation_id: process.env.CLAUDE_CODE_SESSION_ID ?? null,
    cwd: process.env.CLAUDE_CWD ?? process.cwd(), parent_pid: process.ppid,
    app: process.env.MANDIBLE_MANAGED_APP ?? "claude" };
  let stopped = false;
  let initialized = false;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let connection: http.ClientRequest | undefined;
  let generationTimer: ReturnType<typeof setInterval> | undefined;
  let inFlight = 0;
  const server = new Server({ name: "mandible", version: "1" }, {
    capabilities: { tools: { listChanged: true }, logging: {}, experimental: { "claude/channel": {} } },
    instructions: "Mandible tools and notifications come from the local daemon. After an adapter update, reconnect mandible using /mcp; your Claude chat remains open. Failed or interrupted tool calls are never replayed automatically.",
  });
  const log = (message: string) => process.stderr.write(`Mandible channel: ${message}\n`);
  const catalog = async () => {
    const value = await request<Catalog>("POST", "/api/channel/catalog", ctx);
    if (value.protocol !== 1 || !Array.isArray(value.event_topics) || value.event_topics.length === 0
      || !value.event_topics.every(topic => typeof topic === "string" && topic.length > 0)) throw new Error("Incompatible daemon channel protocol; update Mandible and reconnect /mcp.");
    return value;
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await catalog()).tools }));
  server.setRequestHandler(CallToolRequestSchema, async (message) => {
    if (stopped) throw new Error("Mandible adapter updated; reconnect using /mcp. Review interrupted calls before retrying.");
    inFlight++;
    try {
      const { [EXECUTION_CONTEXT_ARGUMENT]: executionContext, ...args } = message.params.arguments ?? {};
      return await withChannelExecutionContext(executionContext, () => request("POST", "/api/channel/call", { ...ctx, name: message.params.name, arguments: args }));
    } finally { inFlight--; }
  });
  async function render(event?: unknown) {
    const value = await request<Rendered>("POST", "/api/channel/render", { ...ctx, ...(event ? { event } : {}) });
    for (const notification of value.notifications) {
      if (stopped || !initialized) return;
      await server.notification(notification);
    }
    for (const id of value.delivered) await request("POST", `/api/inbox/delivered/${encodeURIComponent(id)}`);
  }
  let delivery = Promise.resolve();
  const enqueue = (event?: unknown) => {
    delivery = delivery.then(() => render(event)).catch(error => { log(`notification delivery deferred: ${String(error)}`); });
  };
  async function connectEvents() {
    if (stopped) return;
    let topics: string[];
    try { topics = (await catalog()).event_topics; }
    catch (error) { log(`event subscription deferred: ${String(error)}`); schedule(); return; }
    if (stopped) return;
    const transport = resolveTransport();
    const url = new URL("/api/events", resolveBaseUrl());
    url.searchParams.set("topic", topics.join(","));
    connection = (transport.kind === "http" && url.protocol === "https:" ? https : http).get({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      ...(transport.kind === "socket" ? { socketPath: transport.socketPath } : {}), headers: channelTransportHeaders(transport.kind),
    }, res => {
      if (res.statusCode !== 200) { res.resume(); schedule(); return; }
      void registerSession().then(catalog).then(() => {
        enqueue();
        return server.sendToolListChanged();
      }).catch(error => log(`reconnect deferred: ${String(error)}`));
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (data) {
            try { enqueue(JSON.parse(data)); }
            catch (error) { log(`invalid daemon event: ${String(error)}`); }
          }
        }
      });
      res.on("end", schedule); res.on("error", schedule);
    });
    connection.on("error", schedule);
  }
  function schedule() {
    if (stopped || reconnect) return;
    connection?.destroy();
    reconnect = setTimeout(() => { reconnect = undefined; connectEvents(); }, 2_000);
  }
  async function shutdown(reason?: string) {
    if (stopped) return;
    stopped = true;
    if (reason) log(reason);
    if (reconnect) clearTimeout(reconnect);
    if (generationTimer) clearInterval(generationTimer);
    connection?.destroy();
    const deadline = Date.now() + 1_000;
    while (inFlight && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    await Promise.race([server.close(), new Promise(resolve => setTimeout(resolve, 250))]);
    process.exit(0);
  }
  server.oninitialized = () => {
    initialized = true;
    connectEvents();
  };
  async function registerSession() {
    const result = await request<{ session_id: string | null; identity_warning?: { message?: string } }>("POST", "/api/channel/connect", ctx);
    ctx.session_id = result.session_id;
    if (result.identity_warning?.message) log(`identity warning: ${result.identity_warning.message}`);
  }
  server.onclose = () => { void shutdown(); };
  process.stdin.once("end", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
  await server.connect(new StdioServerTransport());
  if (process.env.MANDIBLE_CHANNEL_ACTIVE && process.env.MANDIBLE_CHANNEL_GENERATION) {
    generationTimer = setInterval(() => {
      try {
        const active = JSON.parse(fs.readFileSync(process.env.MANDIBLE_CHANNEL_ACTIVE!, "utf8"));
        if (active.generation !== process.env.MANDIBLE_CHANNEL_GENERATION) void shutdown("adapter updated; reconnect mandible using /mcp. Your Claude chat remains open; review interrupted calls before retrying.");
      } catch (error) { log(`cannot inspect installed adapter identity: ${String(error)}`); }
    }, 2_000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => { process.stderr.write(`Mandible channel failed: ${String(error)}\n`); process.exit(1); });
}
