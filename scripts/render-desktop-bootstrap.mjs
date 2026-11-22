import fs from 'node:fs';
import path from 'node:path';
import { injectStartupFrame } from '../src/startup-frame.ts';

const output = path.join(process.argv[2], 'index.html');
const html = injectStartupFrame(fs.readFileSync('src-tauri/bootstrap/index.html', 'utf8'));
if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== html) fs.writeFileSync(output, html);
