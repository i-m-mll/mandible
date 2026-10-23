export type DiffFileIdentity = { oldPath: string | null; newPath: string | null };

export function diffFileKey(file: DiffFileIdentity): string {
  return JSON.stringify([file.oldPath, file.newPath]);
}

/** Git quotes path bytes using C escapes, including UTF-8 octal sequences. */
export function decodeGitPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const text = path.slice(1, -1);
  for (let index = 0; index < text.length;) {
    if (text[index] === '\\') {
      const octal = text.slice(index + 1).match(/^[0-7]{1,3}/)?.[0];
      if (octal) {
        bytes.push(parseInt(octal, 8));
        index += 1 + octal.length;
      } else {
        bytes.push(escapes[text[index + 1]!] ?? text.charCodeAt(index + 1));
        index += 2;
      }
    } else {
      const point = String.fromCodePoint(text.codePointAt(index)!);
      bytes.push(...encoder.encode(point));
      index += point.length;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function headerPaths(header: string): [string, string] | null {
  const quoted = header.match(/^("(?:\\.|[^"\\])*") ("(?:\\.|[^"\\])*")$/);
  if (quoted) return [decodeGitPath(quoted[1]!), decodeGitPath(quoted[2]!)];
  const mixed = header.match(/^("(?:\\.|[^"\\])*") (b\/.*)$|^(a\/.*?) ("(?:\\.|[^"\\])*")$/);
  if (mixed) return [decodeGitPath(mixed[1] ?? mixed[3]!), decodeGitPath(mixed[2] ?? mixed[4]!)];
  for (let index = header.indexOf(' b/'); index >= 0; index = header.indexOf(' b/', index + 1)) {
    if (header.slice(2, index) === header.slice(index + 3)) return [header.slice(0, index), header.slice(index + 1)];
  }
  const plain = header.match(/^(a\/.*?) (b\/.*)$/);
  return plain ? [plain[1]!, plain[2]!] : null;
}

export function parseDiffFileIdentity(section: string): DiffFileIdentity | null {
  const header = section.match(/^diff --git (.*)$/m)?.[1];
  if (!header) {
    const old = section.match(/^--- ([^\n]+)$/m)?.[1];
    const next = section.match(/^\+\+\+ ([^\n]+)$/m)?.[1];
    if (old === undefined || next === undefined) return null;
    const path = (value: string) => value === '/dev/null' ? null : decodeGitPath(value.split('\t')[0]!);
    return { oldPath: path(old), newPath: path(next) };
  }
  const paths = headerPaths(header);
  if (!paths) return null;
  const stripPrefix = (path: string): string | null => path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
  const marker = (prefix: string) => section.split('\n').find(line => line.startsWith(prefix))?.slice(prefix.length);
  const oldMarker = marker('--- ');
  const newMarker = marker('+++ ');
  const oldMetadata = marker('rename from ') ?? marker('copy from ');
  const newMetadata = marker('rename to ') ?? marker('copy to ');
  return {
    oldPath: /^new file mode /m.test(section) ? null
      : oldMetadata !== undefined ? decodeGitPath(oldMetadata)
        : stripPrefix(oldMarker === undefined ? paths[0] : decodeGitPath(oldMarker.split('\t')[0]!)),
    newPath: /^deleted file mode /m.test(section) ? null
      : newMetadata !== undefined ? decodeGitPath(newMetadata)
        : stripPrefix(newMarker === undefined ? paths[1] : decodeGitPath(newMarker.split('\t')[0]!)),
  };
}
