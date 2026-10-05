import type { InstanceInfo } from '../../ui/src/api';
import { registeredOperationMetadata } from './registered-operation-metadata';

/** Read the real browser hints without importing or evaluating server services. */
export function operationCatalogFixture(instance: InstanceInfo, files?: string[]) {
  return {
    schema: 'mandible-operation-catalog@2', source: 'Router.listRoutePolicies',
    runtime: { version: 'ui-test', instance_id: instance.instance_id, backend_generation: instance.backend_generation },
    // Dynamic effects remain null, matching Router.listRoutePolicies: daemon ingress owns them.
    routes: registeredOperationMetadata(files).map(({ expression: _expression, method, ...metadata }) => ({ method: method.toUpperCase(), fileRpc: 'deny', ...metadata })),
  };
}
