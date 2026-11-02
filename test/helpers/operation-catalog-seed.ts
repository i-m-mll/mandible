import type { InstanceInfo } from '../../src/types.js';
import type { Router } from '../../src/server.js';
import { prepareRunFixture, readRunFixture } from './run-fixture-seed.js';
import type { PreparedOperationRouter } from './prepared-operation-router.js';

const CATALOG_SEED = { file: 'main-cli-catalog.json', manifest: 'main-cli-catalog.manifest.json',
  label: 'operation catalog seed', identity: { schema: 'mandible-operation-catalog@2' } };
const ROUTER_SEED = { file: 'authored-operation-router.json', manifest: 'authored-operation-router.manifest.json',
  label: 'authored operation router seed', identity: { schema: 'mandible-authored-operation-router@1' } };

export function prepareOperationRouterSeed(root: string, prepared: PreparedOperationRouter): void {
  prepareRunFixture(root, ROUTER_SEED, Buffer.from(JSON.stringify(prepared)));
}

export function readOperationRouterSeed(root = process.env.MANDIBLE_TEST_RUNTIME_ROOT): PreparedOperationRouter {
  return JSON.parse(readRunFixture(root, ROUTER_SEED).toString('utf8'));
}

export interface MainCliInstanceResponse {
  instance: InstanceInfo;
  operations: ReturnType<Router['operationCatalog']>;
}

export function prepareOperationCatalogSeed(root: string, response: MainCliInstanceResponse): void {
  prepareRunFixture(root, CATALOG_SEED, Buffer.from(JSON.stringify(response)));
}

export function readOperationCatalogSeed(root = process.env.MANDIBLE_TEST_RUNTIME_ROOT): MainCliInstanceResponse {
  return JSON.parse(readRunFixture(root, CATALOG_SEED).toString('utf8'));
}
