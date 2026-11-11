import { beforeEach, expect, it } from "vitest";
import { recordCredentialLeak } from "../src/credential-leak-scan.js";
import { setDb, type Db } from "../src/db.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";
import { countUnreadUserNotifications, raiseOpenUserNotifications } from "../src/notices/user-notifications.js";
import { registerNotificationRoutes } from "../src/routes/notifications.js";
import { createUser, setupOperator, type User } from "../src/users/store.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
let db: Db;

const instance = resolveInstanceInfo({ env: { MANDIBLE_OPERATIONAL_MUTATIONS: "allow" } as NodeJS.ProcessEnv });

function routes(user: User) {
  const router = authenticatedTestRouter(user, { instance });
  registerNotificationRoutes(router, db);
  return router;
}

function leak(): void {
  recordCredentialLeak(
    db,
    { credential_id: "cred-1", user_id: "someone", user_slug: "someone", label: "laptop", session_scoped: false },
    { conversation_id: "conv-1", session_id: "sess-1" },
    NOW,
  );
}

function openConvergenceAlert(): void {
  db.prepare(
    `INSERT INTO auth_hook_alerts (id, auth_request_id, hook_id, hook_label, detail, created_at, updated_at)
     VALUES ('alert-1', 'auth-1', 'hook-1', 'Deploy', 'Deploy hook exited 1', ?, ?)`,
  ).run(NOW - 1000, NOW - 1000);
}

function sessionNotice(id: string, raisedAt: number, deliveredAt: number | null): void {
  db.prepare(
    `INSERT INTO notifications (id, subject_kind, subject_id, recipient_kind, recipient_provider, recipient_id,
       responsible_agent_ref, raised_at, delivered_at, digest, text)
     VALUES (?, 'auth_request', 'auth-1', 'session', 'claude', ?, 'claude:agent-1', ?, ?, 'digest', 'Merged')`,
  ).run(id, `session-${id}`, raisedAt, deliveredAt);
}

beforeEach(() => {
  db = migratedMemoryDb();
  setDb(db);
});

it("raises one notification per open fact, including facts recorded before an operator existed", () => {
  openConvergenceAlert();
  leak();
  expect(db.prepare("SELECT COUNT(*) AS n FROM notifications").get()).toEqual({ n: 0 });

  setupOperator(db, { slug: "operator", display_name: "Operator" }, NOW);
  expect(raiseOpenUserNotifications(db)).toBe(2);
  expect(raiseOpenUserNotifications(db)).toBe(0);
  leak();

  expect(db.prepare("SELECT subject_kind, raised_at FROM notifications ORDER BY raised_at").all()).toEqual([
    { subject_kind: "convergence_failure", raised_at: NOW - 1000 },
    { subject_kind: "credential_leak", raised_at: NOW },
  ]);
  expect(countUnreadUserNotifications(db)).toBe(2);
});

it("lists every notification newest first, and only the user's read mark moves the badge", async () => {
  const operator = setupOperator(db, { slug: "operator", display_name: "Operator" }, NOW);
  openConvergenceAlert();
  leak();
  raiseOpenUserNotifications(db);
  sessionNotice("delivered", NOW + 1000, NOW + 2000);
  sessionNotice("undelivered", NOW + 3000, null);
  const router = routes(operator);

  const list = await router.invoke({ method: "GET", url: "/api/notifications" });
  expect(list.status).toBe(200);
  const rows = (list.body as { notifications: Array<Record<string, any>> }).notifications;
  expect(rows.map((row) => [row.recipient.kind, row.subject.kind, row.delivered_at, row.target])).toEqual([
    ["session", "auth_request", null, { kind: "auth_request", id: "auth-1" }],
    ["session", "auth_request", NOW + 2000, { kind: "auth_request", id: "auth-1" }],
    ["user", "credential_leak", null, { kind: "conversation", id: "conv-1" }],
    ["user", "convergence_failure", null, { kind: "auth_request", id: "auth-1" }],
  ]);
  expect(countUnreadUserNotifications(db)).toBe(2);

  const page = await router.invoke({ method: "GET", url: "/api/notifications?limit=3" });
  expect((page.body as { next_before: number | null }).next_before).toBe(NOW);

  const leakRow = rows[2];
  const agent = createUser(db, { slug: "agent", kind: "agent", display_name: "Agent" }, NOW);
  expect((await routes(agent).invoke({ method: "POST", url: `/api/notifications/${leakRow.id}/read`, body: {} })).status).toBe(403);
  expect((await router.invoke({ method: "POST", url: `/api/notifications/${rows[0].id}/read`, body: {} })).status).toBe(409);
  expect((await router.invoke({ method: "POST", url: "/api/notifications/missing/read", body: {} })).status).toBe(404);

  const read = await router.invoke({ method: "POST", url: `/api/notifications/${leakRow.id}/read`, body: {} });
  expect(read.status).toBe(200);
  const readAt = (read.body as { delivered_at: number }).delivered_at;
  expect(readAt).toEqual(expect.any(Number));
  expect(countUnreadUserNotifications(db)).toBe(1);
  const again = await router.invoke({ method: "POST", url: `/api/notifications/${leakRow.id}/read`, body: {} });
  expect((again.body as { delivered_at: number }).delivered_at).toBe(readAt);
});
