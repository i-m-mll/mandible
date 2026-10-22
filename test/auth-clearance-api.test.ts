import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthQueue } from "../src/auth-queue.js";
import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { resetDb, setDb } from "../src/db.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import type { RequestLike, ResponseLike, RouteHandler, RouteOptions, RouteRegistrar } from "../src/server.js";
import { setupOperator } from "../src/users/store.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

class CapturingRoutes implements RouteRegistrar {
  readonly handlers = new Map<string, RouteHandler>();
  get(path: string, handler: RouteHandler, _options: RouteOptions) { this.handlers.set(`GET ${path}`, handler); }
  post(path: string, handler: RouteHandler, _options: RouteOptions) { this.handlers.set(`POST ${path}`, handler); }
  put(path: string, handler: RouteHandler, _options: RouteOptions) { this.handlers.set(`PUT ${path}`, handler); }
  patch(path: string, handler: RouteHandler, _options: RouteOptions) { this.handlers.set(`PATCH ${path}`, handler); }
  delete(path: string, handler: RouteHandler, _options: RouteOptions) { this.handlers.set(`DELETE ${path}`, handler); }
}

function response() {
  const state = { status: 200, body: undefined as unknown };
  const res: ResponseLike = {
    status(code) { state.status = code; return res; },
    json(body) { state.body = body; },
    send(body) { state.body = body; },
    setHeader() {},
  };
  return { state, res };
}

afterEach(() => resetDb({ reason: "auth clearance API test ended" }));

describe("auth clearance API", () => {
  it("keeps prospective create operator-only and forwards explicit exact scope", async () => {
    const db = migratedMemoryDb();
    const operator = setupOperator(db, { slug: "clearance-api-operator", display_name: "Clearance API Operator" });
    setDb(db);
    const issue = vi.fn(async (input: unknown, issuer: string) => ({ id: "clearance-1", input, issuer }));
    const manager = {
      issue,
      list: () => [], show: () => ({}), uses: () => [], revoke: async () => ({}),
      signingStatus: () => ({}), setupSigning: async () => ({}), removeSigning: async () => ({}),
    };
    const routes = new CapturingRoutes();
    const queue = new AuthQueue({ db, backgroundMaintenance: false });
    registerAuthRoutes(routes, queue, new AuthAutoApproveManager({ db }), manager as never);
    const handler = routes.handlers.get("POST /api/auth/clearances")!;

    const anonymous = response();
    await handler({ body: {}, params: {}, query: {}, client_identity: null } as RequestLike, anonymous.res);
    expect(anonymous.state.status).toBe(401);

    const result = response();
    await handler({
      body: {
        grantee: "agent-a", project: "mandible", base: "develop", issue: "de690d2",
        head: "feature/exact", action: "merge", duration_minutes: 30, max_uses: 2,
      },
      params: {}, query: {},
      client_identity: {
        user_id: operator.id, slug: operator.slug, method: "api_token",
        credential_id: "operator-token", source: "http_bearer",
      },
    } as RequestLike, result.res);
    expect(result.state.status).toBe(201);
    expect(issue).toHaveBeenCalledWith({
      requestId: null,
      grantee: "agent-a",
      granteeCredentialId: null,
      project: "mandible",
      baseBranch: "develop",
      issueRef: "de690d2",
      headBranch: "feature/exact",
      action: "merge",
      durationMinutes: 30,
      maxUses: 2,
    }, operator.id);
    queue.dispose();
    db.close();
  });
});
