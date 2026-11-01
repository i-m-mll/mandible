import { resolveInstanceInfo } from '../../src/instance-policy.js';
import { bindOperationCatalog, type InstanceInfo } from '../../ui/src/api';
import { registeredOperationRouter } from './registered-operation-router';

export const authMainInstance: InstanceInfo = {
  ...resolveInstanceInfo({ env: {} }),
  instance_id: 'auth-ui-main',
  backend_generation: 'auth-ui-main-1',
};

/** Use the daemon's authored route effects, including the approval boundary. */
export function bindAuthUiOperations(instance: InstanceInfo = authMainInstance): void {
  const router = registeredOperationRouter(instance, ['src/routes/auth.ts', 'src/routes/auth-hooks.ts']);
  if (!bindOperationCatalog(instance, router.operationCatalog('ui-test'))) {
    throw new Error('Fixture operation catalog is incompatible with its instance');
  }
}
