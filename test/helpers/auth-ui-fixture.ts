import { resolveInstanceInfo } from '../../src/instance-policy.js';
import type { InstanceInfo } from '../../ui/src/api';
import { bindTestInstanceCatalog } from './instance-operation-fixtures';

export const authMainInstance: InstanceInfo = {
  ...resolveInstanceInfo({ env: {} }),
  instance_id: 'auth-ui-main',
  backend_generation: 'auth-ui-main-1',
};

/** Use the daemon's authored route effects, including the approval boundary. */
export function bindAuthUiOperations(instance: InstanceInfo = authMainInstance): void {
  bindTestInstanceCatalog(instance, ['src/routes/auth.ts', 'src/routes/auth-hooks.ts']);
}
