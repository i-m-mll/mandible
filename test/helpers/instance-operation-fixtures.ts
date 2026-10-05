import { bindOperationCatalog, type InstanceInfo } from '../../ui/src/api';
import { operationCatalogFixture } from './operation-catalog-fixture';

/** Registered route descriptors are shared; bind them to the exact fixture generation. */
export function bindTestInstanceCatalog(instance: InstanceInfo, files?: string[]): void {
  if (!bindOperationCatalog(instance, operationCatalogFixture(instance, files))) {
    throw new Error('Fixture operation catalog is incompatible with its instance');
  }
}
