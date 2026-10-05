import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import * as z from "zod";
import { Router } from "../../src/server.js";
import { isInlineManagedArtifactByteRequest } from "../../src/security/operation-policy.js";
import type { InstanceInfo } from "../../src/types.js";

/** Read the descriptors actually authored on registrations, without starting their services. */
export function registeredOperationRouter(instance?: InstanceInfo): Router {
  const router = new Router(instance ? { instance } : {});
  for (const filename of fs.readdirSync("src/routes").filter(name => name.endsWith(".ts"))) {
    const source = fs.readFileSync(path.join("src/routes", filename), "utf8");
    const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && ["get", "post", "put", "patch", "delete"].includes(node.expression.name.text)
          && node.arguments.length >= 3 && ts.isStringLiteral(node.arguments[0])) {
        const options = node.arguments[2];
        if (ts.isObjectLiteralExpression(options)) {
          const operation = options.properties.find(property => ts.isPropertyAssignment(property)
            && property.name.getText(tree) === "operation") as ts.PropertyAssignment | undefined;
          if (!operation) throw new Error(`Missing operation descriptor: ${filename} ${node.arguments[0].text}`);
          const expression = ts.transpileModule(`const descriptor = ${operation.initializer.getText(tree)}; descriptor;`,
            { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
          const descriptor = new Function("z", "isInlineManagedArtifactByteRequest", `${expression.replace(/descriptor;\s*$/, "return descriptor;")}`)(z, isInlineManagedArtifactByteRequest);
          router[node.expression.name.text as "get"](node.arguments[0].text, () => {},
            { operation: descriptor, fileRpc: "deny" });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return router;
}
