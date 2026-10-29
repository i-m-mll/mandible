// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkLocalCredentialProjection, localCredentialProjection } from '../scripts/generate-local-credential-routes.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-credential-projection-')); roots.push(root);
  fs.mkdirSync(path.join(root, 'src/routes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'cli'));
  fs.writeFileSync(path.join(root, 'src/server.ts'), '');
  return root;
}
function registration(route: string, policy = '{ mode: "omit" }') {
  return `router.get("${route}", handler, { ${policy ? `localCliCredential: ${policy},` : ''} operation: { id: "test", effects: [], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });\n`;
}
it('fails generation for missing and invalid policies and missing registration options', () => {
  const root = fixture(), file = path.join(root, 'src/routes/a.ts');
  for (const source of [registration('/api/a', ''), registration('/api/a', '{ mode: "guess" }'),
    registration('/api/a', '{ mode: "body-nonempty", field: "" }'), 'router.get("/api/a", handler);']) {
    fs.writeFileSync(file, source);
    expect(() => localCredentialProjection(root)).toThrow();
  }
});
it('preserves within-module route order, rejects unresolved module overlaps and detects stale projections', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'src/routes/a.ts'), registration('/api/users/operator') + registration('/api/users/:ref', '{ mode: "durable" }'));
  fs.writeFileSync(path.join(root, 'cli/local-credential-routes.json'), JSON.stringify(localCredentialProjection(root), null, 2) + '\n');
  expect(() => checkLocalCredentialProjection(root)).not.toThrow();
  fs.appendFileSync(path.join(root, 'src/routes/a.ts'), registration('/api/new'));
  expect(() => checkLocalCredentialProjection(root)).toThrow('Stale CLI credential projection');
  fs.writeFileSync(path.join(root, 'src/routes/b.ts'), registration('/api/users/:id'));
  expect(() => localCredentialProjection(root)).toThrow('Unresolved route overlap');
});

it('detects computed registrations independently of the metadata extractor and rejects dynamic typed aliases', async () => {
  const { Router } = await import('../src/server.js');
  const root = fixture(), file = path.join(root, 'src/routes/a.ts');
  const initial = registration('/api/existing');
  fs.writeFileSync(file, initial);
  fs.writeFileSync(path.join(root, 'cli/local-credential-routes.json'), JSON.stringify(localCredentialProjection(root), null, 2) + '\n');
  const computed = registration('/api/added', '{ mode: "durable" }').replace('router.get', 'router["get"]');
  fs.appendFileSync(file, computed);
  const router = new Router();
  new Function('router', 'handler', initial + computed)(router, () => {});
  expect(router.listRoutePolicies()).toHaveLength(2);
  expect(() => checkLocalCredentialProjection(root)).toThrow('Stale CLI credential projection');
  fs.writeFileSync(file, `import type { RouteRegistrar } from ${JSON.stringify(path.resolve('src/server.js'))};
    export function register(alternate: RouteRegistrar, route: string, options: Parameters<RouteRegistrar['get']>[2]) {
      const renamed = alternate;
      renamed.get(route, () => {}, options);
    }`);
  expect(() => localCredentialProjection(root)).toThrow('Nonliteral registered route');
});
