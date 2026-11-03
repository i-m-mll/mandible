import { HistoricalRootRequestSchema } from '../../src/ledger/historical-roots.js';
import { DOMAIN_EVENT_SCHEMA } from "../../src/contracts.js";
import { RepairOptionsSchema } from "../../src/ledger/project-registry.js";
import { CHANNEL_CONTEXT_SCHEMA } from "../../src/routes/channel.js";
import type { RegisteredOperationMetadata } from "../../scripts/registered-operation-metadata.js";
import * as z from "zod";
import { documentArtifactImportEffects, documentHistoryImportEffects } from "../../src/security/document-import-effects.js";
import { Router } from "../../src/server.js";
import { isInlineManagedArtifactByteRequest, type OperationDescriptor } from "../../src/security/operation-policy.js";
import type { InstanceInfo } from "../../src/types.js";
import { CHILD_RETENTION_SETTINGS_SCHEMA } from "../../src/conversations/retention-contract.js";
import { INTEGRATION_ACTION } from "../../src/optional-integrations.js";

export interface PreparedOperationRouter {
  entries: RegisteredOperationMetadata[];
  descriptorFactoryBody: string;
}
type DescriptorFactory = (discoverModels: boolean) => OperationDescriptor[];
const factories = new WeakMap<PreparedOperationRouter, DescriptorFactory>();
const noDatabase = () => { throw new Error("Persisted import effects require an owned database fixture"); };

function descriptorFactory(prepared: PreparedOperationRouter): DescriptorFactory {
  const cached = factories.get(prepared);
  if (cached) return cached;
  const evaluate = new Function("z", "isInlineManagedArtifactByteRequest", "documentArtifactImportEffects", "documentHistoryImportEffects", "getDb", "discoverModels", "CHILD_RETENTION_SETTINGS_SCHEMA", "INTEGRATION_ACTION", "RepairOptionsSchema", "CHANNEL_CONTEXT_SCHEMA", "DOMAIN_EVENT_SCHEMA", "HistoricalRootRequestSchema",
    prepared.descriptorFactoryBody);
  const factory: DescriptorFactory = discoverModels => evaluate(z, isInlineManagedArtifactByteRequest,
    documentArtifactImportEffects, documentHistoryImportEffects, noDatabase, discoverModels, CHILD_RETENTION_SETTINGS_SCHEMA, INTEGRATION_ACTION, RepairOptionsSchema, CHANNEL_CONTEXT_SCHEMA, DOMAIN_EVENT_SCHEMA, HistoricalRootRequestSchema);
  factories.set(prepared, factory);
  return factory;
}

/** Evaluate authored descriptors and register their effects against this instance. */
export function preparedOperationRouter(prepared: PreparedOperationRouter, instance?: InstanceInfo, files?: readonly string[]): Router {
  const router = new Router(instance ? { instance } : {});
  const discoverModels = instance?.role !== 'preview' && (instance?.allowed_effects.includes('provider:send') ?? true);
  const descriptors = descriptorFactory(prepared)(discoverModels);
  for (const [index, entry] of prepared.entries.entries()) {
    if (files && !files.includes(entry.file)) continue;
    router[entry.method](entry.path, () => {}, { operation: descriptors[index], fileRpc: "deny" });
  }
  return router;
}
