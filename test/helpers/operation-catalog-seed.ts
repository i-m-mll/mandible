import type { InstanceInfo } from '../../src/types.js';
import type { Router } from '../../src/server.js';
import { prepareRunFixture, readRunFixture } from './run-fixture-seed.js';

const CATALOG_SEED = { file: 'main-cli-catalog.json', manifest: 'main-cli-catalog.manifest.json',
  label: 'operation catalog seed', identity: { schema: 'mandible-operation-catalog@2' } };

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
