import * as ts from "typescript";
import { registeredOperationMetadata } from "./registered-operation-metadata.js";
import * as z from "zod";
import { documentArtifactImportEffects, documentHistoryImportEffects } from "../../src/security/document-import-effects.js";
import { Router } from "../../src/server.js";
import { isInlineManagedArtifactByteRequest, type OperationDescriptor } from "../../src/security/operation-policy.js";
import type { InstanceInfo } from "../../src/types.js";
import { CHILD_RETENTION_SETTINGS_SCHEMA } from "../../src/conversations/retention-contract.js";
import { INTEGRATION_ACTION } from "../../src/optional-integrations.js";

type Metadata = ReturnType<typeof registeredOperationMetadata>;
type DescriptorFactory = (discoverModels: boolean) => OperationDescriptor[];
const factories = new WeakMap<Metadata, DescriptorFactory>();
const noDatabase = () => { throw new Error("Persisted import effects require an owned database fixture"); };

function descriptorFactory(entries: Metadata): DescriptorFactory {
  const cached = factories.get(entries);
  if (cached) return cached;
  // Metadata identity is content-addressed by the shared parser. Compile each
  // authored source set once; instance-dependent choices are evaluated afresh.
  const source = `const descriptors = [${entries.map(entry => entry.expression).join(",\n")}]; descriptors;`;
  const expression = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const evaluate = new Function("z", "isInlineManagedArtifactByteRequest", "documentArtifactImportEffects", "documentHistoryImportEffects", "getDb", "discoverModels", "CHILD_RETENTION_SETTINGS_SCHEMA", "INTEGRATION_ACTION",
    expression.replace(/descriptors;\s*$/, "return descriptors;"));
  const factory: DescriptorFactory = discoverModels => evaluate(z, isInlineManagedArtifactByteRequest,
    documentArtifactImportEffects, documentHistoryImportEffects, noDatabase, discoverModels, CHILD_RETENTION_SETTINGS_SCHEMA, INTEGRATION_ACTION);
  factories.set(entries, factory);
  return factory;
}

/** Read the descriptors actually authored on registrations, without starting their services. */
export function registeredOperationRouter(instance?: InstanceInfo, files?: string[]): Router {
  const router = new Router(instance ? { instance } : {});
  const entries = registeredOperationMetadata(files);
  const discoverModels = instance?.role !== 'preview' && (instance?.allowed_effects.includes('provider:send') ?? true);
  const descriptors = descriptorFactory(entries)(discoverModels);
  for (const [index, entry] of entries.entries()) {
    router[entry.method](entry.path, () => {}, { localCliCredential: entry.localCliCredential, operation: descriptors[index], fileRpc: "deny" });
  }
  return router;
}
