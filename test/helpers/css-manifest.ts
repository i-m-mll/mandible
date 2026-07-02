import { dirname, join, normalize } from 'node:path';
import { readFileSync } from 'node:fs';

const localImportPattern = /^@import\s+["']([^"']+)["'];\s*$/gm;

export function readResolvedStylesheet(entryPath = 'ui/src/style.css'): string {
  const seen = new Set<string>();

  function readLocal(path: string): string {
    const normalized = normalize(path);
    if (seen.has(normalized)) return '';
    seen.add(normalized);

    const css = readFileSync(normalized, 'utf8');
    return css.replace(localImportPattern, (_statement, importPath: string) => {
      if (!importPath.startsWith('.')) return '';
      return readLocal(join(dirname(normalized), importPath));
    });
  }

  return readLocal(entryPath);
}
