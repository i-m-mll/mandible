import { expect, it } from "vitest";
import { mutateLedgerRecord } from "../src/ledger/mutation-history.js";
import { Router, type ClientAuthGate } from "../src/server.js";
import { createUser } from "../src/users/store.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

it("dispatch preserves resolved caller attribution separately from native origin", async () => {
  const db = migratedMemoryDb();
  try {
    const actor = createUser(db, { slug: "operator", kind: "human", display_name: "Operator" });
    const target = createUser(db, { slug: "target", kind: "agent", display_name: "Before" });
    const gate: ClientAuthGate = {
      authenticate: () => null, mode: () => "compat", recordUnattributedWrite: () => {},
      mutationAttribution: () => ({ user_id: actor.id, evidence_method: "api_token" }),
    };
    const router = new Router({ clientAuth: gate });
    router.post("/mutate", (_req, res) => {
      mutateLedgerRecord(db, { entity_type: "user", entity_id: target.id,
        snapshot: () => db.prepare("SELECT display_name FROM users WHERE id = ?").get(target.id),
      }, () => db.prepare("UPDATE users SET display_name = 'After' WHERE id = ?").run(target.id));
      res.json({ ok: true });
    }, { localCliCredential: {"mode":"omit"}, operation: { id: "origin.test", effects: ["ledger:write"], reportingCategory: "ledger", requestSchema: null }, fileRpc: "allow" });
    const origin = { provider: "codex", provider_session_id: "native-caller" };
    expect((await router.invoke({ method: "POST", url: "/mutate", ambient_identity: origin })).status).toBe(200);
    const event = db.prepare("SELECT actor_user_id, evidence_method, payload_json FROM ledger_events WHERE entity_id = ? AND event_type = 'user.updated'").get(target.id);
    expect(event).toMatchObject({ actor_user_id: actor.id, evidence_method: "api_token" });
    expect(JSON.parse(event.payload_json)).toMatchObject({ changed_fields: ["display_name"], request_origin: origin });
  } finally { db.close(); }
});
