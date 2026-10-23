import type { InstanceInfo } from '../../ui/src/api';
import { registeredOperationRouter } from './registered-operation-router';

/** Use the evaluated authored descriptors, including instance-bound effects. */
export function operationCatalogFixture(instance: InstanceInfo, files?: string[]) {
  return registeredOperationRouter(instance, files).operationCatalog('ui-test');
}
