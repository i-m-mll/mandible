import * as ts from "typescript";
import { registeredOperationMetadata } from "./registered-operation-metadata.js";
import { preparedOperationRouter, type PreparedOperationRouter } from "./prepared-operation-router.js";
import type { InstanceInfo } from "../../src/types.js";

type Metadata = ReturnType<typeof registeredOperationMetadata>;
const compiled = new WeakMap<Metadata, PreparedOperationRouter>();

export function compileOperationRouter(files?: string[]): PreparedOperationRouter {
  const entries = registeredOperationMetadata(files);
  const cached = compiled.get(entries);
  if (cached) return cached;
  const source = `const descriptors = [${entries.map(entry => entry.expression).join(",\n")}]; descriptors;`;
  const expression = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const prepared = { entries, descriptorFactoryBody: expression.replace(/descriptors;\s*$/, "return descriptors;") };
  compiled.set(entries, prepared);
  return prepared;
}

/** Read the descriptors actually authored on registrations, without starting their services. */
export function registeredOperationRouter(instance?: InstanceInfo, files?: string[]) {
  return preparedOperationRouter(compileOperationRouter(files), instance);
}
