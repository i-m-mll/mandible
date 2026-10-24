// Find daemon source that lets a child process write to the daemon's own
// stdout or stderr. The daemon rotates those files by copying and truncating
// them, and only its rotating thread may write to them (docs/runtime-handoff.md).
import ts from 'typescript';

const STD_STREAMS = new Set(['process.stdout', 'process.stderr']);

function inherits(node) {
  if (ts.isStringLiteralLike(node) && node.text === 'inherit') return '"inherit"';
  if (ts.isNumericLiteral(node) && (node.text === '1' || node.text === '2')) return `fd ${node.text}`;
  if (ts.isPropertyAccessExpression(node) && STD_STREAMS.has(node.getText())) return node.getText();
  return null;
}

function propertyName(node) {
  return node.name && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) ? node.name.text : null;
}

/** Each site in one source file, as `{ line, reason }`, with 1-based lines. */
export function stderrInheritanceSites(fileName, source) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const forks = new Set();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !/^(?:node:)?child_process$/.test(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (clause?.name) forks.add(`${clause.name.text}.fork`);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) forks.add(`${bindings.name.text}.fork`);
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) if ((element.propertyName ?? element.name).text === 'fork') forks.add(element.name.text);
  }
  const sites = [];
  const report = (node, reason) => sites.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, reason });
  const visit = node => {
    if (ts.isStringLiteralLike(node) && node.text === 'inherit') report(node, '"inherit"');
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node);
      const value = node.initializer;
      if (name === 'stdio' && ts.isArrayLiteralExpression(value)) {
        value.elements.slice(1, 3).forEach(element => { const reason = inherits(element); if (reason && reason !== '"inherit"') report(element, `stdio passes ${reason}`); });
      }
      if (name === 'stdout' || name === 'stderr') {
        const reason = inherits(value);
        if (reason && reason !== '"inherit"') report(value, `${name} passes ${reason}`);
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file);
      if (callee === 'Bun.spawn' || callee === 'Bun.spawnSync') report(node, `${callee} inherits stderr by default`);
      if (forks.has(callee)) report(node, 'fork inherits stdio by default');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return sites;
}
