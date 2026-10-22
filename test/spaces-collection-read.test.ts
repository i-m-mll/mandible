// @vitest-environment node
// Fact-packet read test for the collection renderer (umbrella de56ffa, C8 /
// issue fa83ec7).
//
// C8 made `GET /api/spaces/:id` return the full fact packet (space +
// items/occurrences/edges) per the umbrella plan §5.1 / §589 — the bare space
// alone is not enough to render. The `space` field is preserved for backward
// compatibility; this test pins the superset shape the renderer reads.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setDb, type Db } from '../src/db.js';
import { registerSpacesRoutes } from '../src/routes/spaces.js';
import { Router } from '../src/server.js';
import { migratedMemoryDb } from './helpers/ledger-fixtures.js';

let db: Db;
let router: Router;
const PROJECT_ID = 'prj-collection-read';

function seedProject(id: string, name: string): void {
  db.prepare(
    `INSERT INTO ledger_projects (id, display_name, remote_identity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, name, `github.com/test/${id}`, Date.now(), Date.now());
}

async function call(method: string, url: string, body?: unknown) {
  return router.invoke({ method, url, body });
}

beforeEach(() => {
  db = migratedMemoryDb();
  setDb(db);
  router = new Router();
  registerSpacesRoutes(router);
  seedProject(PROJECT_ID, 'Collection Read');
});

afterEach(() => {
  db.close();
});

describe('GET /api/spaces/:id fact packet (C8 read surface)', () => {
  it('returns space + items + occurrences + edges, preserving the legacy `space` field', async () => {
    const spaceId = (
      (await call('POST', '/api/spaces', { project_id: PROJECT_ID, title: 'Coll' })).body as {
        space: { id: string };
      }
    ).space.id;

    // An item with no occurrence (the unplaced-shelf case) plus a placed item.
    const item = (
      (await call('POST', `/api/spaces/${spaceId}/items`, { ref_type: 'external_ref', ref_id: 'x:1', ref_uri: 'mandible://issue/x1' })).body as {
        item: { id: string };
      }
    ).item;
    const occ = (
      (await call('POST', `/api/spaces/${spaceId}/occurrences`, { item_id: item.id, renderer: 'collection' })).body as {
        occurrence: { id: string };
      }
    ).occurrence;
    // A second unplaced item that must still appear in the packet.
    await call('POST', `/api/spaces/${spaceId}/items`, { ref_type: 'external_ref', ref_id: 'x:2', ref_uri: 'mandible://issue/x2' });

    const got = await call('GET', `/api/spaces/${spaceId}`);
    expect(got.status).toBe(200);
    const body = got.body as {
      space: { id: string };
      items: { id: string }[];
      occurrences: { id: string }[];
      edges: unknown[];
    };
    expect(body.space.id).toBe(spaceId);
    expect(body.items).toHaveLength(2);
    expect(body.items.map((i) => i.id)).toContain(item.id);
    expect(body.occurrences.map((o) => o.id)).toContain(occ.id);
    expect(Array.isArray(body.edges)).toBe(true);
  });
});
