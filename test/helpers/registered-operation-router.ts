import * as ts from "typescript";
import { registeredOperationMetadata } from "./registered-operation-metadata.js";
import * as z from "zod";
import { documentArtifactImportEffects, documentHistoryImportEffects } from "../../src/security/document-import-effects.js";
import { Router } from "../../src/server.js";
import { isInlineManagedArtifactByteRequest } from "../../src/security/operation-policy.js";
import type { InstanceInfo } from "../../src/types.js";

/** Read the descriptors actually authored on registrations, without starting their services. */
export function registeredOperationRouter(instance?: InstanceInfo): Router {
  const router = new Router(instance ? { instance } : {});
  for (const entry of registeredOperationMetadata()) {
    const expression = ts.transpileModule(`const descriptor = ${entry.expression}; descriptor;`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const descriptor = new Function("z", "isInlineManagedArtifactByteRequest", "documentArtifactImportEffects", "documentHistoryImportEffects", "getDb", `${expression.replace(/descriptor;\s*$/, "return descriptor;")}`)(z, isInlineManagedArtifactByteRequest, documentArtifactImportEffects, documentHistoryImportEffects, () => { throw new Error("Persisted import effects require an owned database fixture"); });
    router[entry.method](entry.path, () => {}, { operation: descriptor, fileRpc: "deny" });
  }
  return router;
}
