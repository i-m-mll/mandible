// @provisioned chromium
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { runChromium } from '../helpers/chromium';

it('paints command tokens with the shared artifact syntax palette under production theme CSS', () => {
  const directory=mkdtempSync(join(tmpdir(),'mandible-execution-paint-'));
  try {
    const output=join(directory,'fixture.js');
    const build=spawnSync(createRequire(import.meta.url).resolve('esbuild/bin/esbuild'),[
      resolve('test/provisioned/fixtures/execution-highlight-fixture.tsx'),'--bundle',`--outfile=${output}`,
      '--format=iife','--platform=browser','--target=es2020','--jsx=automatic','--jsx-import-source=preact','--log-level=silent',
    ],{encoding:'utf8',timeout:10000});
    expect(build.status,build.stderr).toBe(0);
    const file=join(directory,'fixture.html');
    writeFileSync(file,`<!doctype html><html data-theme="codex"><head><link rel="stylesheet" href="file://${resolve('ui/src/style.css')}"></head><body><div id="root"></div><script>${readFileSync(output,'utf8')}</script></body></html>`);
    const rendered=runChromium(['--virtual-time-budget=1500','--dump-dom','--window-size=1200,500',`file://${file}`],{encoding:'utf8',maxBuffer:5_000_000});
    expect(rendered.status,rendered.stderr).toBe(0);
    const encoded=rendered.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
    expect(encoded,rendered.stdout.slice(-2000)).toBeDefined();
    const values=JSON.parse(Buffer.from(encoded!,'base64').toString()) as Array<{theme:string;code:string;string:string;artifactString:string;command:string}>;
    for(const value of values) {
      expect(value.command).toBe("sed -n '1,260p' /tmp/example.md");
      expect(value.string,value.theme).not.toBe(value.code);
      expect(value.string,value.theme).toBe(value.artifactString);
    }
  } finally {rmSync(directory,{recursive:true,force:true});}
});
