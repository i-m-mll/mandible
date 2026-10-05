#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selector = path.join(root, 'scripts/bun-runtime.sh');
const archive = execFileSync('/bin/sh', [selector, '--archive'], { encoding: 'utf8' }).trim();
const runtime = execFileSync('/bin/sh', [selector], { encoding: 'utf8' }).trim();
const directory = path.join(root, 'src-tauri/resources/bun-runtime');
fs.mkdirSync(directory, { recursive: true });
const target = path.join(directory, 'bun.zip');
const bytes = fs.readFileSync(archive);
if (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new Error('The canonical selector must return a verified ZIP for --archive; refusing to package executable bytes as an archive.');
const digest = value => createHash('sha256').update(value).digest('hex');
const temporary = `${target}.${process.pid}.tmp`;
fs.writeFileSync(temporary, bytes, { mode: 0o600 });
if (digest(fs.readFileSync(temporary)) !== digest(bytes)) throw new Error('Desktop runtime archive copy differs from the verified source.');
fs.renameSync(temporary, target);
const sqliteArchive = execFileSync(runtime, [path.join(root, 'scripts/sqlite-runtime-install.mjs'), '--archive'], { encoding: 'utf8' }).trim();
const sqliteTarget = path.join(directory, 'sqlite.tar.gz');
const sqliteBytes = fs.readFileSync(sqliteArchive);
const sqliteTemporary = `${sqliteTarget}.${process.pid}.tmp`;
fs.writeFileSync(sqliteTemporary, sqliteBytes, { mode: 0o600 });
if (digest(fs.readFileSync(sqliteTemporary)) !== digest(sqliteBytes)) throw new Error('Desktop SQLite archive copy differs from the verified source.');
fs.renameSync(sqliteTemporary, sqliteTarget);
process.stdout.write('Verified offline Bun archive staged for desktop packaging.\n');
