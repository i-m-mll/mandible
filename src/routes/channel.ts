import { exactAgentRef } from "../ambient-provider-identity.js";
import { EXECUTION_CONTEXT_ARGUMENT } from "../claude-execution-context.js";
import * as z from "zod";
import { CHANNEL_EVENT_SCHEMA, DOMAIN_EVENT_SCHEMA, DOMAIN_EVENTS, type MandibleEvent } from "../contracts.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestLike, Router } from "../server.js";
import { ChannelOperationError, createChannelClient } from "../channel/client.js";
import { registerTools } from "../channel/tools.js";
import { dispatchEvent } from "../channel/events.js";
import { runStartupCatchUp } from "../channel/catchup.js";
import { INSTRUCTIONS } from "../channel/instructions.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const execute = promisify(execFile);
type Tool = { name: string; description: string; schema: z.ZodObject; run: (args: Record<string, unknown>) => Promise<ToolResult> };
export const CHANNEL_CONTEXT_SCHEMA = z.object({ session_id: z.string().nullable(), conversation_id: z.string().nullable(),
  cwd: z.string(), parent_pid: z.number().int().positive(), app: z.string().regex(/^[A-Za-z0-9._-]+$/).default("claude") });
type Context = z.infer<typeof CHANNEL_CONTEXT_SCHEMA>;
type Notification = { method: string; params: Record<string, unknown> };
export function registerChannelRoutes(router: Router): void {
  const clientFor = (req: RequestLike, app: string) => createChannelClient(async <T>(method: string, url: string, body?: unknown) => {
    const result = await router.invokeFrom(req, { method, url, body });
    if (result.status >= 400) throw new ChannelOperationError(`${method} ${url}: ${JSON.stringify(result.body)}`, result.status);
    return result.body as T;
  }, app);
  function tools(req: RequestLike, ctx: Context): Tool[] {
    const result: Tool[] = [];
    const collector = { tool(name: string, description: string, shape: z.ZodRawShape, run: Tool["run"]) {
      result.push({ name, description, schema: z.object(shape), run });
    } };
    registerTools(collector as unknown as McpServer, ctx.session_id, clientFor(req, ctx.app), ctx.cwd, exactAgentRef(req.ambient_identity ?? null));
    return result;
  }
  router.post("/api/channel/catalog", (req, res) => {
    const ctx = req.body as Context;
    res.json({ protocol: 1, instructions: INSTRUCTIONS, event_topics: [CHANNEL_EVENT_SCHEMA.shape.type.value],
      tools: tools(req, ctx).map(tool => ({ name: tool.name, description: tool.description,
        inputSchema: z.toJSONSchema(tool.schema.extend({ [EXECUTION_CONTEXT_ARGUMENT]: z.object({ provider: z.literal("claude"), agent_id: z.string().nullable(), session_id: z.string() }).optional() }), { unrepresentable: "any" }) })) });
  }, { operation: { id: "post:/api/channel/catalog", effects: ["ledger:read"], requestSchema: CHANNEL_CONTEXT_SCHEMA, reportingCategory: null }, fileRpc: "deny" });
  router.post("/api/channel/connect", async (req, res) => {
    const ctx = req.body as Context;
    const client = clientFor(req, ctx.app);
    let sessionId = ctx.session_id;
    if (sessionId) {
      const owner = await client.sessionOwnerPid(sessionId);
      if (owner != null && owner !== ctx.parent_pid) sessionId = null;
    }
    let registration;
    if (sessionId) {
      let branch: string | null = null;
      try { branch = (await execute("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ctx.cwd, encoding: "utf8", timeout: 1_500 })).stdout.trim() || null; }
      catch { /* A channel may start outside a Git checkout. */ }
      registration = await client.registerSession({ id: sessionId, status: "active", cwd: ctx.cwd, branch, conversation_id: ctx.conversation_id });
    }
    res.json({ session_id: sessionId, identity_warning: registration?.identity_warning ?? null });
  }, { operation: { id: "post:/api/channel/connect", effects: ["ledger:read"], requestSchema: CHANNEL_CONTEXT_SCHEMA, reportingCategory: null }, fileRpc: "deny" });
  router.post("/api/channel/call", async (req, res) => {
    const body = req.body as Context & { name: string; arguments: Record<string, unknown> };
    const tool = tools(req, body).find(value => value.name === body.name);
    if (!tool) { res.status(404).json({ error: "unknown_tool" }); return; }
    const parsed = tool.schema.safeParse(body.arguments);
    if (!parsed.success) { res.status(400).json({ error: "invalid_arguments", issues: parsed.error.issues }); return; }
    res.json(await tool.run(parsed.data));
  }, { operation: { id: "post:/api/channel/call", effects: ["ledger:read"], requestSchema: CHANNEL_CONTEXT_SCHEMA.extend({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }), reportingCategory: null }, fileRpc: "deny" });
  router.post("/api/channel/render", async (req, res) => {
    const body = req.body as Context & { event?: MandibleEvent };
    const notifications: Notification[] = [];
    const delivered: string[] = [];
    const channel = (payload: { content: string; meta?: Record<string, string> }) => {
      notifications.push({ method: "notifications/claude/channel", params: { ...payload } });
    };
    if (body.event) {
      if (body.event.type === DOMAIN_EVENTS.AUTH_RESOLVED) dispatchEvent(body.event, body.session_id, (category, message) => {
        notifications.push({ method: "notifications/message", params: { level: "info", logger: `mandible/${category}`, data: message } });
      }, channel, id => delivered.push(id), body.conversation_id);
    } else if (body.session_id) {
      const client = clientFor(req, body.app);
      await runStartupCatchUp({ sessionId: body.session_id, conversationId: body.conversation_id,
        mcpServer: { async notification(notification) { notifications.push({ ...notification, params: { ...notification.params } }); } },
        fetchUndelivered: client.fetchUndeliveredAuthResults,
        async markDelivered(id) { delivered.push(id); }, log: message => process.stderr.write(message) });
    }
    res.json({ notifications, delivered });
  }, { operation: { id: "post:/api/channel/render", effects: ["ledger:read"], requestSchema: CHANNEL_CONTEXT_SCHEMA.extend({ event: DOMAIN_EVENT_SCHEMA.optional() }), reportingCategory: null }, fileRpc: "deny" });
}
