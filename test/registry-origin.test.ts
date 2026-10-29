import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Db } from "../src/db.js";
import { addProject, updateProject, addOrUpdateCheckout, repairRegistry } from "../src/ledger/project-registry.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { createUser, updateUser, addCredential, revokeCredential, addBinding, removeBinding } from "../src/users/store.js";
import { addGroup, addGroupMember, addGrant, removeGroup, setProjectRestricted } from "../src/permissions/store.js";
import { withRequestOrigin } from "../src/request-origin.js";
import { withLedgerMutationActor } from "../src/ledger/mutation-history.js";
import { createManagedReminder, reconcileManagedReminders, cancelManagedReminder, acknowledgeManagedReminderOccurrence } from "../src/managed-reminders.js";
import { parseManagedReminderCreateRequest } from "../src/managed-reminder-parser.js";
import { MANAGED_REMINDER_SCHEMA } from "../src/contracts.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { SYSTEM_USER_ID } from "../src/users/store.js";
import * as sse from "../src/sse.js";

let db: Db;
const origin = { provider: "codex", provider_session_id: "native-registry-caller" };
const later = { provider: "claude", provider_session_id: "native-later-caller" };
const events = () => db.prepare("SELECT * FROM ledger_events ORDER BY rowid").all();
beforeEach(() => { db = migratedMemoryDb(); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });

it("keeps project creation, edits, checkout reassignment and deletion history with no-op suppression", async () => {
  const project = withRequestOrigin(origin, () => addProject(db, { project_key: "first" }));
  const target = addProject(db, { project_key: "target" });
  withRequestOrigin(later, () => {
    updateProject(db, project.id, { display_name: "Changed" });
    addOrUpdateCheckout(db, project.id, { root: "/tmp/origin-first", name: "First" });
    addOrUpdateCheckout(db, target.id, { root: "/tmp/origin-first", name: "Moved" });
  });
  const count = events().length;
  updateProject(db, project.id, { display_name: "Changed" });
  addOrUpdateCheckout(db, target.id, { root: "/tmp/origin-first", name: "Moved" });
  expect(events()).toHaveLength(count);
  expect(() => addProject(db, { project_key: "first" })).toThrow();
  await withRequestOrigin(origin, () => repairRegistry(db, { apply: true, merge: { source: project.id, target: target.id } }));
  expect(db.prepare("SELECT id FROM ledger_projects WHERE id = ?").get(project.id)).toBeUndefined();
  expect(events().filter(e => e.entity_id === project.id).map(e => [e.event_type, JSON.parse(e.payload_json).request_origin]))
    .toEqual([["project.created", origin], ["project.updated", later], ["project.deleted", origin]]);
  const discovered = withRequestOrigin(origin, () => resolveProjectForCheckout(db, { root: "/tmp/origin-discovery", name: "Discovery" }));
  const n = events().length;
  resolveProjectForCheckout(db, { root: "/tmp/origin-discovery", name: "Discovery" });
  expect(events()).toHaveLength(n);
  expect(events().find(e => e.entity_id === discovered.checkout.id).payload_json).toContain(origin.provider_session_id);
});

it("records access changes and cascades without secrets, pre-commit notifications, or changed authority", () => {
  const actor = createUser(db, { slug: "actor", kind: "human", display_name: "Actor" });
  const project = addProject(db, { project_key: "access" });
  const publish = vi.spyOn(sse, "broadcast");
  const run = <T>(fn: () => T) => withRequestOrigin(origin, () => withLedgerMutationActor({ attribution: { user_id: actor.id, evidence_method: "api_token" } }, fn));
  const credential = run(() => addCredential(db, actor.id, { type: "api_token", fingerprint: "confidential-token-fingerprint", label: "private-label" }));
  const binding = run(() => addBinding(db, actor.id, { binding_type: "app_name", value: "secret-binding-value" }));
  const group = run(() => addGroup(db, { slug: "access-team" }));
  run(() => {
    addGroupMember(db, group.id, actor.id);
    addGrant(db, { subject_type: "group", subject: group.id, resource_type: "project", resource: project.id, permission: "write" });
    setProjectRestricted(db, project.id, true);
    const noOpCount = events().length;
    addGroupMember(db, group.id, actor.id);
    addGrant(db, { subject_type: "group", subject: group.id, resource_type: "project", resource: project.id, permission: "write" });
    setProjectRestricted(db, project.id, true);
    expect(events()).toHaveLength(noOpCount);
    revokeCredential(db, credential.id);
    removeBinding(db, binding.id);
    removeGroup(db, group.id);
  });
  const recorded = events().filter(e => JSON.parse(e.payload_json).request_origin?.provider_session_id === origin.provider_session_id);
  expect(recorded.map(e => e.event_type)).toEqual(["credential.created", "binding.created", "group.created", "group_member.created", "grant.created", "project.updated", "credential.updated", "binding.deleted", "grant.deleted", "group_member.deleted", "group.deleted"]);
  expect(recorded.every(e => e.actor_user_id === actor.id && e.evidence_method === "api_token")).toBe(true);
  expect(JSON.stringify(recorded)).not.toMatch(/confidential-token-fingerprint|private-label|secret-binding-value/);
  expect(db.prepare("SELECT project_id FROM ledger_change_log WHERE event_id = ?").get(recorded[0].id)).toBeUndefined();
  const baseline = events().length;
  publish.mockClear();
  expect(() => run(() => db.transaction(() => {
    updateUser(db, actor.id, { display_name: "Rollback" });
    expect(publish).not.toHaveBeenCalled();
    throw new Error("abort");
  })())).toThrow("abort");
  expect(events()).toHaveLength(baseline);
  expect(publish).not.toHaveBeenCalled();
  db.exec("CREATE TRIGGER reject_history BEFORE INSERT ON ledger_events BEGIN SELECT RAISE(ABORT, 'history unavailable'); END");
  expect(() => run(() => updateUser(db, actor.id, { display_name: "Unrecorded" }))).toThrow("history unavailable");
  expect(db.prepare("SELECT display_name FROM users WHERE id = ?").get(actor.id)).toEqual({ display_name: "Actor" });
  expect(events()).toHaveLength(baseline);
  expect(publish).not.toHaveBeenCalled();
  db.exec("DROP TRIGGER reject_history");
  run(() => updateUser(db, actor.id, { status: "retired" }));
  expect(events().at(-1).actor_user_id).toBe(actor.id);
});

it("restores reminder initiating origin at durable firing while preserving the system executor", () => {
  const actor = createUser(db, { slug: "reminder", kind: "agent", display_name: "Reminder" });
  const project = addProject(db, { project_key: "reminders" });
  const now = Date.parse("2026-10-26T12:00:00Z");
  const request = (key: string) => parseManagedReminderCreateRequest({ schema: MANAGED_REMINDER_SCHEMA, project: "reminders", message: "Review", idempotency_key: key, predicate: { kind: "at", at: "2026-10-26T13:00:00Z" } });
  const result = withRequestOrigin(origin, () => createManagedReminder(db, request("fire"), { userId: actor.id, evidenceMethod: "api_token" }, { now }));
  withRequestOrigin(later, () => createManagedReminder(db, request("fire"), { userId: actor.id, evidenceMethod: "api_token" }, { now }));
  expect(db.prepare("SELECT count(*) n FROM managed_task_events").get()).toEqual({ n: 1 });
  withRequestOrigin(later, () => reconcileManagedReminders(db, now + 3_600_000));
  const completed = db.prepare("SELECT * FROM managed_task_events WHERE event_type = 'completed'").get();
  expect(completed).toMatchObject({ actor_user_id: SYSTEM_USER_ID, evidence_method: "system_internal" });
  expect(JSON.parse(completed.payload_json).request_origin).toEqual(origin);
  const occurrence = db.prepare("SELECT id FROM managed_task_occurrences WHERE task_id = ?").get(result.reminder.id);
  withRequestOrigin(later, () => acknowledgeManagedReminderOccurrence(db, occurrence.id, actor.id));
  expect(JSON.parse(events().at(-1).payload_json).request_origin).toEqual(later);
  const cancel = withRequestOrigin(origin, () => createManagedReminder(db, request("cancel"), { userId: actor.id, evidenceMethod: "api_token" }, { now }));
  withRequestOrigin(later, () => cancelManagedReminder(db, cancel.reminder.id, { userId: actor.id, evidenceMethod: "api_token" }, now));
  expect(JSON.parse(db.prepare("SELECT payload_json FROM managed_task_events WHERE event_type = 'cancelled'").get().payload_json).request_origin).toEqual(later);
  expect(() => cancelManagedReminder(db, cancel.reminder.id, { userId: actor.id, evidenceMethod: "api_token" }, now)).toThrow();
  expect(db.prepare("SELECT count(*) n FROM managed_task_events").get()).toEqual({ n: 4 });
});
