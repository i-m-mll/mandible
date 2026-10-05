import { Router } from '../../src/server.js';
import { registerSpacesRoutes } from '../../src/routes/spaces.js';
import { bindOperationCatalog, type InstanceInfo } from '../../ui/src/api';
import type { InstanceInfo as ServerInstanceInfo } from '../../src/types.js';

/** Use the real registered routes for UI affordances; never a separate effect map. */
export function bindSpacesOperationCatalog(instance: InstanceInfo): void {
  const router = new Router({ instance: instance as ServerInstanceInfo });
  registerSpacesRoutes(router);
  if (!bindOperationCatalog(instance, router.operationCatalog('spaces-fixture'))) {
    throw new Error('Spaces fixture operation catalog does not match its instance');
  }
}
