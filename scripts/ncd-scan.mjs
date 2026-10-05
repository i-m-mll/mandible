#!/usr/bin/env bun
// Alpha-normalized NCD duplication scanner.
//
// Finds declarations that carry substantially the same structural information
// even when identifiers, constants, and formatting differ.
//
//   NCD(x, y) = (C(xy) - min(C(x), C(y))) / max(C(x), C(y))
//
// Lower is more similar. Zero would mean one unit is fully redundant given the
// other under the chosen compressor.
//
// Pipeline:
//   1. extract   TypeScript AST -> comparable units (functions, types, SQL)
//   2. normalize alpha-rename bound identifiers, erase locally arbitrary
//                literals, keep operators, control flow, call targets, types
//   3. prefilter token 5-shingles -> exact prefix filter -> exact Jaccard
//   4. score     deterministic deflate NCD over the surviving candidate pairs
//   5. report    ranked JSON and Markdown with paired locations and context
//
// The output is an ATTENTION LIST. A low NCD is a reason to look at a pair. It
// is never on its own a reason to merge one.
//
// Usage:
//   node scripts/ncd-scan.mjs [--root DIR] [--config FILE] [--out FILE]
//                             [--format json|md|both] [--top N]
//                             [--min-tokens N] [--jaccard F] [--ncd-max F]
//                             [--literals erase|keep] [--kinds a,b,c]
//                             [--include-dropped] [--quiet]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI and configuration
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    let value;
    if (eq !== -1) value = arg.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { value = argv[i + 1]; i += 1; }
    else value = true;
    out.flags[key] = value;
  }
  return out.flags;
}

function loadConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  for (const key of Object.keys(parsed)) {
    if (key.startsWith('$comment')) delete parsed[key];
  }
  return parsed;
}

// Only read argv when run as a script. Importing this module for its
// extraction and normalization functions must not parse a caller's arguments.
const IS_MAIN = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
const flags = IS_MAIN ? parseArgs(process.argv.slice(2)) : {};
if (flags.help) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')
    .filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const ROOT = path.resolve(String(flags.root ?? process.cwd()));
const CONFIG_PATH = path.resolve(String(flags.config ?? path.join(HERE, 'ncd-scan.config.json')));
const config = loadConfig(CONFIG_PATH);

const num = (v, d) => (v === undefined ? d : Number(v));
const settings = {
  minTokens: num(flags['min-tokens'], config.minTokens ?? 40),
  maxTokens: num(flags['max-tokens'], config.maxTokens ?? 20000),
  shingleK: num(flags['shingle-k'], config.shingleK ?? 5),
  jaccardMin: num(flags.jaccard, config.jaccardMin ?? 0.45),
  ncdMax: num(flags['ncd-max'], config.ncdMax ?? 0.6),
  literals: String(flags.literals ?? config.literals ?? 'erase'),
  compressLevel: num(flags['compress-level'], config.compressLevel ?? 9),
  maxCandidatePairs: num(flags['max-candidate-pairs'], config.maxCandidatePairs ?? 3000000),
  kinds: new Set(String(flags.kinds ?? (config.kinds ?? ['function', 'type', 'sql']).join(',')).split(',')),
  top: num(flags.top, 200),
  includeDropped: Boolean(flags['include-dropped']),
  quiet: Boolean(flags.quiet),
};

const includeExt = new Set(config.includeExtensions ?? ['.ts', '.tsx']);
const excludeRe = (config.excludePaths ?? []).map((p) => new RegExp(p));
const tagRules = (config.tagRules ?? []).map((r) => ({ tag: r.tag, re: new RegExp(r.path) }));
const dropPairTags = new Set(config.dropPairTags ?? []);
const bindingRejections = (config.bindingRejections ?? []).map((r) => ({
  id: r.id, label: r.label, res: r.paths.map((p) => new RegExp(p)),
}));

const log = (...args) => { if (!settings.quiet) console.error(...args); };
const timings = {};
function timed(name, fn) {
  const t0 = process.hrtime.bigint();
  const value = fn();
  timings[name] = Number(process.hrtime.bigint() - t0) / 1e6;
  return value;
}

// ---------------------------------------------------------------------------
// 1. File selection
// ---------------------------------------------------------------------------

function trackedFiles() {
  const stdout = execFileSync('git', ['-C', ROOT, '--no-optional-locks', 'ls-files', '-z'], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  return stdout.split('\0').filter(Boolean);
}

function selectFiles() {
  const files = [];
  for (const rel of trackedFiles()) {
    if (!includeExt.has(path.extname(rel))) continue;
    if (excludeRe.some((re) => re.test(rel))) continue;
    files.push(rel);
  }
  files.sort();
  return files;
}

function tagsFor(rel) {
  const tags = [];
  for (const rule of tagRules) if (rule.re.test(rel)) tags.push(rule.tag);
  return tags;
}

function rejectionsFor(rel) {
  const ids = [];
  for (const r of bindingRejections) if (r.res.some((re) => re.test(rel))) ids.push(r.id);
  return ids;
}

// ---------------------------------------------------------------------------
// 2. Extraction and alpha-normalization
// ---------------------------------------------------------------------------

const ts = require('typescript');

const SQL_RE = /\b(CREATE\s+(TABLE|INDEX|VIEW|TRIGGER)|SELECT\s|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|ALTER\s+TABLE)\b/i;

function scriptKindFor(rel) {
  switch (path.extname(rel)) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.js': case '.mjs': case '.cjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

/** Names bound inside a unit, so they can be alpha-renamed. */
function collectBoundNames(root) {
  const bound = new Set();
  const addBindingName = (name) => {
    if (!name) return;
    if (ts.isIdentifier(name)) { bound.add(name.text); return; }
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) {
        if (ts.isBindingElement(el)) addBindingName(el.name);
      }
    }
  };
  const walk = (node) => {
    if (ts.isParameter(node)) addBindingName(node.name);
    else if (ts.isVariableDeclaration(node)) addBindingName(node.name);
    else if (ts.isFunctionDeclaration(node) && node.name) bound.add(node.name.text);
    else if (ts.isClassDeclaration(node) && node.name) bound.add(node.name.text);
    else if (ts.isTypeParameterDeclaration(node)) bound.add(node.name.text);
    else if (ts.isCatchClause(node) && node.variableDeclaration) addBindingName(node.variableDeclaration.name);
    ts.forEachChild(node, walk);
  };
  walk(root);
  return bound;
}

/** True when this identifier occupies a property-name position, where the text
 *  is a member of an external contract rather than a locally chosen name. */
function isPropertyNamePosition(node) {
  const p = node.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === node) return true;
  if (ts.isQualifiedName(p) && p.right === node) return true;
  if (ts.isBindingElement(p) && p.propertyName === node) return true;
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  if (ts.isShorthandPropertyAssignment(p) && p.name === node) return true;
  if (ts.isPropertySignature(p) && p.name === node) return true;
  if (ts.isPropertyDeclaration(p) && p.name === node) return true;
  if (ts.isMethodSignature(p) && p.name === node) return true;
  if (ts.isMethodDeclaration(p) && p.name === node) return true;
  if (ts.isEnumMember(p) && p.name === node) return true;
  if (ts.isMetaProperty(p)) return true;
  if (ts.isJsxAttribute(p) && p.name === node) return true;
  return false;
}

const KIND_NAME = (() => {
  const names = new Map();
  for (const [key, value] of Object.entries(ts.SyntaxKind)) {
    if (typeof value === 'number' && !names.has(value)) names.set(value, key);
  }
  return (kind) => names.get(kind) ?? `K${kind}`;
})();

/**
 * Serialize a unit as an alpha-normalized structural token stream.
 * Preserved: node kinds (so control flow, operators, and type structure survive),
 * free identifiers (call targets, imported names, property and type names).
 * Normalized: bound identifiers to $0, $1, ... in order of first appearance.
 * Erased (by default): string, numeric, regex and template literal payloads.
 */
function normalizeUnit(root, opts) {
  const bound = collectBoundNames(root);
  const alpha = new Map();
  const tokens = [];
  const eraseLiterals = opts.literals === 'erase';

  const emitIdentifier = (node) => {
    const text = node.text ?? node.escapedText ?? '';
    if (isPropertyNamePosition(node)) { tokens.push(text); return; }
    if (!bound.has(text)) { tokens.push(text); return; }
    let slot = alpha.get(text);
    if (slot === undefined) { slot = alpha.size; alpha.set(text, slot); }
    tokens.push(`$${slot}`);
  };

  const walk = (node) => {
    const kind = node.kind;
    if (kind === ts.SyntaxKind.Identifier || kind === ts.SyntaxKind.PrivateIdentifier) {
      emitIdentifier(node);
      return;
    }
    if (kind === ts.SyntaxKind.StringLiteral || kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
      || kind === ts.SyntaxKind.TemplateHead || kind === ts.SyntaxKind.TemplateMiddle
      || kind === ts.SyntaxKind.TemplateTail || kind === ts.SyntaxKind.JsxText) {
      tokens.push(eraseLiterals ? '#s' : JSON.stringify(node.text ?? ''));
      return;
    }
    if (kind === ts.SyntaxKind.NumericLiteral || kind === ts.SyntaxKind.BigIntLiteral) {
      tokens.push(eraseLiterals ? '#n' : String(node.text ?? ''));
      return;
    }
    if (kind === ts.SyntaxKind.RegularExpressionLiteral) { tokens.push('#re'); return; }
    if (kind >= ts.SyntaxKind.FirstToken && kind <= ts.SyntaxKind.LastToken) {
      tokens.push(ts.tokenToString(kind) ?? KIND_NAME(kind));
      return;
    }
    tokens.push(KIND_NAME(kind));
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      tokens.push(ts.tokenToString(node.operator) ?? String(node.operator));
    }
    ts.forEachChild(node, walk);
  };

  walk(root);
  return tokens;
}

/** SQL is normalized textually: comments stripped, whitespace collapsed,
 *  keywords upper-cased, quoted payloads erased. Table and column names stay. */
function normalizeSql(text) {
  const cleaned = text
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "'#s'")
    .replace(/\$\{[^}]*\}/g, '#x')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.split(/([(),;])|\s+/).filter(Boolean).map((t) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t) ? t.toUpperCase() : t));
}

function unitNameOf(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (node.name && ts.isStringLiteral(node.name)) return node.name.text;
  const p = node.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  return '<anonymous>';
}

function extractUnits(rel, text) {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKindFor(rel));
  const units = [];
  const lineOf = (pos) => source.getLineAndCharacterOfPosition(pos).line + 1;

  const push = (node, kind, tokens, name) => {
    if (tokens.length < settings.minTokens || tokens.length > settings.maxTokens) return;
    units.push({
      file: rel,
      kind,
      name,
      start: node.getStart(source),
      end: node.getEnd(),
      startLine: lineOf(node.getStart(source)),
      endLine: lineOf(node.getEnd()),
      tokens,
    });
  };

  const walk = (node) => {
    if (settings.kinds.has('function')
      && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
        || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
      push(node, 'function', normalizeUnit(node, settings), unitNameOf(node));
    } else if (settings.kinds.has('type')
      && (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))) {
      push(node, 'type', normalizeUnit(node, settings), unitNameOf(node));
    }
    if (settings.kinds.has('sql')
      && (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || ts.isStringLiteral(node))) {
      const raw = node.getText(source);
      if (raw.length > 120 && SQL_RE.test(raw)) {
        push(node, 'sql', normalizeSql(raw), 'sql');
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return units;
}

// ---------------------------------------------------------------------------
// 3. Prefilter: token shingles + exact Jaccard, with an exact prefix filter
// ---------------------------------------------------------------------------

function hash32(str) {
  // FNV-1a, deterministic across runs and platforms.
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function shingleSet(tokens, k) {
  const seen = new Set();
  const limit = tokens.length - k;
  for (let i = 0; i <= limit; i += 1) {
    seen.add(hash32(tokens.slice(i, i + k).join('')));
  }
  const arr = Int32Array.from(seen);
  arr.sort();
  return arr;
}

/**
 * Exact prefix filter for a Jaccard threshold.
 *
 * Order every shingle by ascending global document frequency. For a unit with
 * n distinct shingles, index only its p = n - ceil(t*n) + 1 rarest shingles.
 * Two units whose Jaccard is at least t must share at least
 * o = ceil(t/(1+t) * (|x|+|y|)) shingles, and t*|x| <= o under the size filter
 * t*|x| <= |y| <= |x|/t, so their prefixes must intersect. The filter therefore
 * has no false negatives: unlike MinHash/LSH banding it cannot silently drop a
 * pair above the threshold. Candidates are still verified with exact Jaccard.
 */
function prefixFilterCandidates(units, threshold, maxPairs, stats) {
  const freq = new Map();
  for (const u of units) {
    for (let i = 0; i < u.shingles.length; i += 1) {
      const s = u.shingles[i];
      freq.set(s, (freq.get(s) ?? 0) + 1);
    }
  }
  const ordered = [...freq.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const rank = new Map();
  for (let i = 0; i < ordered.length; i += 1) rank.set(ordered[i][0], i);
  stats.distinctShingles = ordered.length;

  const bySize = units.map((u, idx) => idx).sort((a, b) => units[a].shingles.length - units[b].shingles.length);
  const postings = new Map();
  const pairKeys = new Set();
  const n = units.length;

  for (const idx of bySize) {
    const u = units[idx];
    const len = u.shingles.length;
    const ranked = Array.from(u.shingles).map((s) => rank.get(s)).sort((a, b) => a - b);
    const prefix = Math.max(1, len - Math.ceil(threshold * len) + 1);
    const minSize = threshold * len;
    const seen = new Set();
    for (let i = 0; i < prefix; i += 1) {
      const list = postings.get(ranked[i]);
      if (!list) continue;
      for (const other of list) {
        if (other === idx || seen.has(other)) continue;
        seen.add(other);
        // Units are visited shortest-first, so `other` is never longer.
        if (units[other].shingles.length < minSize) continue;
        const lo = Math.min(idx, other);
        const hi = Math.max(idx, other);
        pairKeys.add(lo * n + hi);
      }
    }
    if (pairKeys.size > maxPairs) { stats.overflow = true; break; }
    for (let i = 0; i < prefix; i += 1) {
      const r = ranked[i];
      let list = postings.get(r);
      if (!list) { list = []; postings.set(r, list); }
      list.push(idx);
    }
  }
  stats.postingLists = postings.size;
  stats.candidatePairs = pairKeys.size;
  return pairKeys;
}

function jaccardSorted(a, b) {
  let i = 0; let j = 0; let inter = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { inter += 1; i += 1; j += 1; }
    else if (a[i] < b[j]) i += 1;
    else j += 1;
  }
  const union = a.length + b.length - inter;
  return union === 0 ? 0 : inter / union;
}

// ---------------------------------------------------------------------------
// 4. NCD
// ---------------------------------------------------------------------------

const deflateOpts = { level: settings.compressLevel, memLevel: 9, windowBits: 15, strategy: zlib.constants.Z_DEFAULT_STRATEGY };
const clen = (buf) => zlib.deflateRawSync(buf, deflateOpts).length;

function ncdPair(bx, by, cx, cy) {
  const cxy = clen(Buffer.concat([bx, SEP, by]));
  const cyx = clen(Buffer.concat([by, SEP, bx]));
  const lo = Math.min(cx, cy);
  const hi = Math.max(cx, cy);
  const forward = (cxy - lo) / hi;
  const backward = (cyx - lo) / hi;
  return { ncd: Math.min(forward, backward), asymmetry: Math.abs(forward - backward) };
}
const SEP = Buffer.from('\n');

// zlib's sliding window is 32 KiB. Beyond that the second half of a
// concatenation can no longer reference the first, and NCD understates
// similarity. Report it rather than hiding it.
const WINDOW_BYTES = 32 * 1024;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const files = timed('select', selectFiles);
  log(`[ncd] ${files.length} tracked source files`);

  const units = timed('extract', () => {
    const all = [];
    for (const rel of files) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      try {
        for (const u of extractUnits(rel, text)) all.push(u);
      } catch (err) {
        log(`[ncd] extraction failed for ${rel}: ${err.message}`);
      }
    }
    return all;
  });
  log(`[ncd] ${units.length} units extracted`);

  timed('prepare', () => {
    for (const u of units) {
      u.text = u.tokens.join(' ');
      u.buf = Buffer.from(u.text, 'utf8');
      u.clen = clen(u.buf);
      u.tags = tagsFor(u.file);
      u.rejections = rejectionsFor(u.file);
      u.shingles = shingleSet(u.tokens, settings.shingleK);
    }
  });

  const stats = { candidatePairs: 0, overflow: false };
  const candidates = timed('prefilter', () => prefixFilterCandidates(
    units, settings.jaccardMin, settings.maxCandidatePairs, stats,
  ));

  if (stats.overflow) {
    console.error(`[ncd] FAILED: candidate pairs exceeded ${settings.maxCandidatePairs}. `
      + 'The prefilter is too permissive for this tree. Raise --jaccard or --min-tokens, '
      + 'or raise --max-candidate-pairs, then rerun. Refusing to emit a partial ranking.');
    process.exit(2);
  }

  const n = units.length;
  const scored = timed('score', () => {
    const results = [];
    let evaluated = 0;
    for (const key of candidates) {
      const i = Math.floor(key / n);
      const j = key % n;
      const a = units[i];
      const b = units[j];
      // Skip a unit against a unit it lexically contains.
      if (a.file === b.file && a.start < b.end && b.start < a.end) continue;
      const jac = jaccardSorted(a.shingles, b.shingles);
      if (jac < settings.jaccardMin) continue;
      evaluated += 1;
      const { ncd, asymmetry } = ncdPair(a.buf, b.buf, a.clen, b.clen);
      if (ncd > settings.ncdMax) continue;
      results.push({ i, j, jaccard: jac, ncd, asymmetry });
    }
    stats.ncdEvaluated = evaluated;
    return results;
  });

  scored.sort((x, y) => x.ncd - y.ncd || y.jaccard - x.jaccard);
  log(`[ncd] ${stats.candidatePairs} candidate pairs, ${stats.ncdEvaluated} NCD-scored, ${scored.length} retained`);

  const describe = (u) => ({
    file: u.file,
    name: u.name,
    kind: u.kind,
    lines: [u.startLine, u.endLine],
    tokens: u.tokens.length,
    bytes: u.buf.length,
    compressed: u.clen,
    tags: u.tags,
    windowLimited: u.buf.length > WINDOW_BYTES,
    head: u.tokens.slice(0, 24).join(' '),
  });

  const kept = [];
  const dropped = [];
  for (const s of scored) {
    const a = units[s.i];
    const b = units[s.j];
    const pairTags = new Set([...a.tags, ...b.tags]);
    const dropTags = [...pairTags].filter((t) => dropPairTags.has(t));
    const shared = a.rejections.filter((r) => b.rejections.includes(r));
    const entry = {
      ncd: Number(s.ncd.toFixed(4)),
      jaccard: Number(s.jaccard.toFixed(4)),
      asymmetry: Number(s.asymmetry.toFixed(4)),
      sameFile: a.file === b.file,
      bindingRejections: shared.map((id) => {
        const r = bindingRejections.find((x) => x.id === id);
        return { id, label: r ? r.label : '' };
      }),
      windowLimited: a.buf.length > WINDOW_BYTES || b.buf.length > WINDOW_BYTES,
      a: describe(a),
      b: describe(b),
    };
    if (dropTags.length) { entry.droppedBy = dropTags; dropped.push(entry); } else kept.push(entry);
  }

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      root: ROOT,
      config: path.relative(ROOT, CONFIG_PATH) || CONFIG_PATH,
      node: process.version,
      typescript: ts.version,
      compressor: `deflateRaw level=${settings.compressLevel} memLevel=9 windowBits=15`,
      settings: {
        minTokens: settings.minTokens,
        shingleK: settings.shingleK,
        jaccardMin: settings.jaccardMin,
        ncdMax: settings.ncdMax,
        literals: settings.literals,
        kinds: [...settings.kinds],
      },
      counts: {
        files: files.length,
        units: units.length,
        unitsByKind: units.reduce((acc, u) => { acc[u.kind] = (acc[u.kind] ?? 0) + 1; return acc; }, {}),
        distinctShingles: stats.distinctShingles,
        postingLists: stats.postingLists,
        candidatePairs: stats.candidatePairs,
        ncdEvaluated: stats.ncdEvaluated,
        retained: scored.length,
        kept: kept.length,
        droppedByTag: dropped.length,
      },
      timingsMs: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Number(v.toFixed(1))])),
    },
    pairs: kept.slice(0, settings.top),
    droppedPairs: settings.includeDropped ? dropped.slice(0, settings.top) : dropped.slice(0, 40),
  };

  const format = String(flags.format ?? 'both');
  const outBase = flags.out ? String(flags.out) : null;

  if (format === 'json' || format === 'both') {
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (outBase) fs.writeFileSync(outBase.endsWith('.json') ? outBase : `${outBase}.json`, text);
    else if (format === 'json') process.stdout.write(text);
  }
  if (format === 'md' || format === 'both') {
    const md = renderMarkdown(report);
    if (outBase) fs.writeFileSync(outBase.replace(/\.json$/, '') + '.md', md);
    else process.stdout.write(md);
  }
  log(`[ncd] timings ms: ${JSON.stringify(report.meta.timingsMs)}`);
}

function renderMarkdown(report) {
  const m = report.meta;
  const lines = [];
  lines.push('# Alpha-normalized NCD duplication scan');
  lines.push('');
  lines.push('Ranked attention list. A low NCD means two normalized units compress well together:');
  lines.push('one carries little information the other does not. It is a reason to look at a pair,');
  lines.push('never on its own a reason to merge one.');
  lines.push('');
  lines.push(`Generated ${m.generatedAt} | node ${m.node} | typescript ${m.typescript}`);
  lines.push(`Compressor: ${m.compressor}`);
  lines.push('');
  lines.push('| measure | value |');
  lines.push('| --- | ---: |');
  for (const [k, v] of Object.entries(m.counts)) {
    lines.push(`| ${k} | ${typeof v === 'object' ? Object.entries(v).map(([a, b]) => `${a}=${b}`).join(', ') : v} |`);
  }
  for (const [k, v] of Object.entries(m.timingsMs)) lines.push(`| time.${k} (ms) | ${v} |`);
  lines.push('');
  lines.push('Settings: ' + Object.entries(m.settings).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : v}`).join(', '));
  lines.push('');

  const section = (title, pairs, note) => {
    lines.push(`## ${title}`);
    lines.push('');
    if (note) { lines.push(note); lines.push(''); }
    if (!pairs.length) { lines.push('_none_'); lines.push(''); return; }
    let idx = 0;
    for (const p of pairs) {
      idx += 1;
      const flagsText = [
        p.sameFile ? 'same-file' : null,
        p.windowLimited ? 'window-limited' : null,
        p.droppedBy ? `dropped:${p.droppedBy.join('+')}` : null,
        ...p.bindingRejections.map((r) => `binding-rejection:${r.id}`),
      ].filter(Boolean);
      lines.push(`### ${idx}. NCD ${p.ncd.toFixed(3)} · Jaccard ${p.jaccard.toFixed(3)}${flagsText.length ? ` · ${flagsText.join(' · ')}` : ''}`);
      lines.push('');
      lines.push(`- \`${p.a.file}:${p.a.lines[0]}-${p.a.lines[1]}\` — **${p.a.name}** (${p.a.kind}, ${p.a.tokens} tok${p.a.tags.length ? `, ${p.a.tags.join('/')}` : ''})`);
      lines.push(`- \`${p.b.file}:${p.b.lines[0]}-${p.b.lines[1]}\` — **${p.b.name}** (${p.b.kind}, ${p.b.tokens} tok${p.b.tags.length ? `, ${p.b.tags.join('/')}` : ''})`);
      if (p.bindingRejections.length) {
        for (const r of p.bindingRejections) {
          lines.push(`- Binding rejection ${r.id} (${r.label}) covers both sides: settled, do not re-litigate without new semantic evidence.`);
        }
      }
      lines.push('');
      lines.push('```');
      lines.push(`A: ${p.a.head}`);
      lines.push(`B: ${p.b.head}`);
      lines.push('```');
      lines.push('');
    }
  };

  section('Ranked pairs', report.pairs);
  section('Pairs dropped by tag', report.droppedPairs,
    `Excluded from the primary list because at least one side is tagged ${[...dropPairTags].join(', ')}. Listed so the exclusion is auditable, not silent.`);
  return lines.join('\n');
}

export { extractUnits, normalizeUnit, normalizeSql, shingleSet, jaccardSorted, ncdPair };

if (IS_MAIN) main();
