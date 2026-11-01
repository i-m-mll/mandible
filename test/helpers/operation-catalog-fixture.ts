import type { InstanceInfo } from '../../ui/src/api';
import { preparedOperationRouter } from './prepared-operation-router';
import { readOperationRouterSeed } from './operation-catalog-seed';

const prepared = readOperationRouterSeed();

/** Use the evaluated authored descriptors, including instance-bound effects. */
export function operationCatalogFixture(instance: InstanceInfo, files?: readonly string[]) {
  return preparedOperationRouter(prepared, instance, files).operationCatalog('ui-test');
}
