import { resolveInstanceInfo } from '../../src/instance-policy.js';
import { bindOperationCatalog, type InstanceInfo } from '../../ui/src/api';
import { registeredOperationRouter } from './registered-operation-router.js';

export const authMainInstance: InstanceInfo = {
  ...resolveInstanceInfo({ env: {} }),
  instance_id: 'auth-ui-main',
  backend_generation: 'auth-ui-main-1',
};

/** Use the daemon's authored route effects, including the approval boundary. */
export function bindAuthUiOperations(instance: InstanceInfo = authMainInstance): void {
  if (!bindOperationCatalog(instance, registeredOperationRouter(instance).operationCatalog('auth-ui-test'))) {
    throw new Error('Auth UI fixture could not bind the registered operation catalog');
  }
}
