import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

export type RegisteredOperationMetadata = {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  effects: string[] | null;
  expression: string;
  operationId: string;
  operationalMutationCategory: string | null;
  requestSchema: "handler" | "zod";
};
const cache = new Map<string, RegisteredOperationMetadata[]>();

/** One authored-descriptor parser shared by full Router and lean UI fixtures. */
export function registeredOperationMetadata(files = fs.readdirSync('src/routes')
  .filter(name => name.endsWith('.ts')).map(name => path.join('src/routes', name))): RegisteredOperationMetadata[] {
  const sources = files.map(file => ({ file, source: fs.readFileSync(file, 'utf8') }));
  const key = createHash('sha256').update(JSON.stringify(sources)).digest('hex');
  const existing = cache.get(key);
  if (existing) return existing;
  const entries: RegisteredOperationMetadata[] = [];
  for (const { file, source } of sources) {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const property = (object: ts.ObjectLiteralExpression, name: string) => object.properties.find(
      (entry): entry is ts.PropertyAssignment => ts.isPropertyAssignment(entry) && entry.name.getText(tree) === name,
    )?.initializer;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && ['get', 'post', 'put', 'patch', 'delete'].includes(node.expression.name.text)
          && node.arguments.length >= 3 && ts.isStringLiteral(node.arguments[0])) {
        const options = node.arguments[2];
        if (ts.isObjectLiteralExpression(options)) {
          const operation = property(options, 'operation');
          const effects = operation && ts.isObjectLiteralExpression(operation) ? property(operation, 'effects') : undefined;
          if (!operation || !effects) throw new Error(`Missing authored operation descriptor: ${file} ${node.arguments[0].text}`);
          if (!ts.isArrayLiteralExpression(effects) && !ts.isArrowFunction(effects) && !ts.isFunctionExpression(effects)
              && !ts.isConditionalExpression(effects)) {
            throw new Error(`Unsupported authored route effects: ${file} ${node.arguments[0].text}`);
          }
          if (!ts.isObjectLiteralExpression(operation)) throw new Error(`Nonliteral operation descriptor: ${file}`);
          const id = property(operation, 'id');
          const category = property(operation, 'reportingCategory');
          const schema = property(operation, 'requestSchema');
          if (!id || !ts.isStringLiteral(id) || !category || (!ts.isStringLiteral(category) && category.kind !== ts.SyntaxKind.NullKeyword) || !schema) {
            throw new Error(`Unsupported authored operation metadata: ${file} ${node.arguments[0].text}`);
          }
          const staticEffects = ts.isArrayLiteralExpression(effects) ? effects.elements.map(value => {
            if (!ts.isStringLiteral(value)) throw new Error(`Nonliteral static route effect: ${file}`);
            return value.text;
          }) : null;
          entries.push({ method: node.expression.name.text as RegisteredOperationMetadata['method'],
            path: node.arguments[0].text, effects: staticEffects, expression: operation.getText(tree),
            operationId: id.text, operationalMutationCategory: ts.isStringLiteral(category) ? category.text : null,
            requestSchema: schema.kind === ts.SyntaxKind.NullKeyword ? 'handler' : 'zod' });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  cache.set(key, entries);
  return entries;
}
