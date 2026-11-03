import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CodexParser } from '../src/parsers/codex.js';
import { ClaudeParser } from '../src/parsers/claude.js';
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from '../src/conversations/source-types.js';
import { projectToolProgram } from '../src/presentation/tool-program.js';
import { presentTool } from '../src/presentation/tool-presentation.js';

const sourceSchema = z.object({ file: z.string(), sourceHash: z.string(), position: z.number().int().nullable(), line: z.number().int().optional(), sourceHashScope: z.enum(['logical-source', 'stored-file']).optional(), recordOrdinal: z.number().int().nullable(), nativeId: z.string().nullable() });
const caseSchema = z.object({ id: z.string(), provider: z.enum(['codex', 'claude_code']), name: z.string(), kind: z.string().optional(), input: z.union([z.string(), z.record(z.string(), z.unknown())]), source: sourceSchema });
const bundleSchema = z.object({ schema: z.literal('mandible-provider-survey-inputs@1'), cases: z.array(caseSchema) });
type SurveyCase = z.infer<typeof caseSchema>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const count = (values: string[]) => Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(other => other === value).length]));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function help(): string {
  return `Manual provider-stream diagnostic; never executes archived tool inputs or changes the ledger.\n\n` +
    `bun scripts/provider-stream-survey.ts scan --provider codex|claude_code --files <paths.json> --out <report.json> [--save-inputs <private-inputs.json>]\n` +
    `bun scripts/provider-stream-survey.ts replay --inputs <private-inputs.json> --out <report.json>\n\n` +
    `paths.json is an explicit array of native JSONL paths (relative paths resolve beside the manifest). Production parsers handle compressed logical sources. Scan records source hashes and normalized envelope classes; it does not promise universal coverage.\n` +
    `Replay reads frozen tool inputs, independently of native files. It re-evaluates tool recognition, not transcript normalization, transport output attribution or UI behavior. Preserve selected native records and incident probes separately when those boundaries matter.\n` +
    `Reports contain source references and classification facts; --save-inputs also writes private prompts/scripts. Keep those outputs out of the repository. Use a new file selection for a fresh survey; use the identical frozen input bundle for an exact recognition replay. Neither mode is a CI gate.\n`;
}

function options(argv: string[]): { mode: 'scan' | 'replay'; values: Map<string, string> } {
  const [mode, ...rest] = argv;
  if (mode !== 'scan' && mode !== 'replay') throw new Error(help());
  const allowed = new Set(mode === 'scan' ? ['provider', 'files', 'out', 'save-inputs'] : ['inputs', 'out']);
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index]?.replace(/^--/, '');
    const value = rest[index + 1];
    if (!allowed.has(name) || !rest[index].startsWith('--') || !value || value.startsWith('--') || values.has(name)) throw new Error(`Invalid option ${rest[index] ?? ''}\n${help()}`);
    values.set(name, value);
  }
  for (const key of mode === 'scan' ? ['provider', 'files', 'out'] : ['inputs', 'out']) if (!values.has(key)) throw new Error(`Missing --${key}\n${help()}`);
  return { mode, values };
}

function classify(entry: SurveyCase) {
  const program = projectToolProgram(entry.name, entry.input, entry.kind);
  const header = presentTool(entry.name, entry.input, entry.kind);
  const wrapper = /^(?:functions\.)?exec$/.test(entry.name);
  return {
    id: entry.id, provider: entry.provider, name: entry.name, kind: entry.kind, source: entry.source,
    inputHash: digest(JSON.stringify(entry.input)),
    recognition: program ? program.effectsComplete === false ? 'proven-prefix' : 'complete-program' : wrapper ? 'generic-program' : header.category === 'other' && !header.operation ? 'unclassified-tool' : 'direct-tool',
    resultAttribution: program ? program.outputAttributed === false ? 'opaque' : 'attributed' : null,
    category: header.category, operation: header.operation ?? null,
    operations: program?.operations.map(operation => {
      const item = presentTool(operation.name, operation.input ?? {}, 'function_call');
      return { name: operation.name, inputKnown: operation.input !== undefined, category: item.category, operation: item.operation ?? null };
    }) ?? [],
  };
}

async function scan(provider: 'codex' | 'claude_code', manifest: string) {
  const selected = z.array(z.string()).min(1).parse(JSON.parse(await fs.readFile(manifest, 'utf8')));
  const files = [...new Set(selected.map(file => path.resolve(path.dirname(path.resolve(manifest)), file)))];
  const cases: SurveyCase[] = [];
  const sources: Array<{ file: string; sourceHash: string; blocks: number; calls: number }> = [];
  const envelopes: string[] = [];
  const unclassifiedInputs: Array<{ file: string; position: number; name: string | null }> = [];
  for (const file of files) {
    const parser = provider === 'codex' ? new CodexParser() : new ClaudeParser();
    const parsed = await parser.parse(file);
    if (!parsed) throw new Error(`Production parser did not accept ${file}`);
    let calls = 0;
    for (const block of parsed.blocks) {
      const metadata = block.metadata;
      const item = metadata.chat_item;
      envelopes.push([block.type, block.role, metadata.source_event_type ?? '', metadata.display_local_command?.kind ?? '', metadata.display_task_notification ? 'task-notification' : ''].join(':'));
      if (item?.type !== 'tool-call' || item.phase !== 'call') continue;
      calls++;
      if (typeof item.tool_name !== "string" || (typeof item.input !== 'string' && !object(item.input))) { unclassifiedInputs.push({ file, position: block.position, name: item.tool_name ?? null }); continue; }
      cases.push({
        id: digest([provider, file, parsed.conversation.source_hash, block.position, item.tool_id].join('\0')),
        provider, name: item.tool_name, kind: item.tool_kind, input: item.input,
        source: { file, sourceHash: parsed.conversation.source_hash, sourceHashScope: 'logical-source', position: block.position, recordOrdinal: metadata.source_record_ordinal ?? null, nativeId: item.tool_id ?? null },
      });
    }
    sources.push({ file, sourceHash: parsed.conversation.source_hash, blocks: parsed.blocks.length, calls });
  }
  return { cases, sources, envelopeCounts: count(envelopes), unclassifiedInputs };
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

async function main() {
  if (process.argv.slice(2).some(value => value === '--help' || value === '-h')) { console.log(help()); return; }
  const { mode, values } = options(process.argv.slice(2));
  const started = performance.now();
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim().length > 0;
  const captured = mode === 'scan'
    ? await scan(z.enum(['codex', 'claude_code']).parse(values.get('provider')), values.get('files')!)
    : { cases: bundleSchema.parse(JSON.parse(await fs.readFile(values.get('inputs')!, 'utf8'))).cases };
  const results = captured.cases.map(classify);
  const report = {
    schema: 'mandible-provider-stream-survey@1', mode, runtime: {version: process.versions.bun, executable: process.execPath}, measuredAt: new Date().toISOString(), revision, dirty,
    epochs: CURRENT_CONVERSATION_SOURCE_EPOCHS, inputDigest: digest(JSON.stringify(captured.cases)),
    scope: mode === 'scan' ? 'Explicit native files through production normalization and tool recognition; read-only, not exhaustive.' : 'Frozen tool-input recognition replay only; no native normalization, output attribution or UI qualification.',
    ...('sources' in captured ? { sources: captured.sources, envelopeCounts: captured.envelopeCounts, unclassifiedInputs: captured.unclassifiedInputs } : {}),
    summary: { cases: results.length, recognition: count(results.map(result => result.recognition)), categories: count(results.map(result => result.category)), toolNames: count(results.map(result => result.name)) },
    results, elapsedMs: performance.now() - started,
  };
  if (values.has('save-inputs')) await writeJson(values.get('save-inputs')!, { schema: 'mandible-provider-survey-inputs@1', cases: captured.cases });
  await writeJson(values.get('out')!, report);
  console.log(JSON.stringify({ out: path.resolve(values.get('out')!), revision, ...report.summary, elapsedMs: report.elapsedMs }));
}

await main();
