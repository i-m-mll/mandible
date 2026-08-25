import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "../../src/db.js";
import { AttributionReadResolver } from "../../src/identity/read-projection.js";
import { createUser } from "../../src/users/store.js";

// The read projection is what the dashboard consumes to decide how much trust an
// attributed author's identity carries. Issue 6f356c7: every stored evidence
// class must survive the projection so the UI can distinguish a verified author
// from a merely claimed one, and an unattributed row must project to nothing.

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-evidence-proj-"));
  db = openDb(path.join(tempDir, "mandible.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("attribution read projection exposes evidence_method", () => {
  const classes = [
    "api_token",
    "credential_signature",
    "session_claim",
    "system_internal",
  ] as const;

  for (const method of classes) {
    it(`carries the ${method} evidence class alongside the resolved author`, () => {
      const user = createUser(db, {
        slug: `author-${method}`,
        kind: "agent",
        display_name: `Author ${method}`,
      });
      const projection = new AttributionReadResolver(db).attribution({
        user_id: user.id,
        evidence_method: method,
      });
      expect(projection).not.toBeNull();
      expect(projection?.evidence_method).toBe(method);
      expect(projection?.user?.id).toBe(user.id);
    });
  }

  it("projects an unattributed row (no user, no evidence) to null", () => {
    const projection = new AttributionReadResolver(db).attribution({
      user_id: null,
      evidence_method: null,
    });
    expect(projection).toBeNull();
  });

  it("still projects evidence when only the evidence class is present", () => {
    const projection = new AttributionReadResolver(db).attribution({
      user_id: null,
      evidence_method: "api_token",
    });
    expect(projection?.evidence_method).toBe("api_token");
    expect(projection?.user).toBeNull();
  });
});
