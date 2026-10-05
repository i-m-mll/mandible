import { bindOperationCatalog, type InstanceInfo } from '../../ui/src/api';
import { MAIN_CLI_INSTANCE_RESPONSE } from './cli-instance-response';

/** Registered route descriptors are shared; bind them to the exact fixture generation. */
export function bindTestInstanceCatalog(instance: InstanceInfo): void {
  const registered = MAIN_CLI_INSTANCE_RESPONSE.operations;
  const catalog = { ...registered, runtime: {
    ...registered.runtime,
    instance_id: instance.instance_id,
    backend_generation: instance.backend_generation,
  } };
  if (!bindOperationCatalog(instance, catalog)) throw new Error('Fixture operation catalog is incompatible with its instance');
}
