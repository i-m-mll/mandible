import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { connectCdp, type CdpClient, waitFor } from './chromium-cdp';

type ProviderMarkState = {
  activeLabel: string | null;
  documentFocused: boolean;
  matchesFocus: boolean;
  before: { background: string; borderWidth: string; markOpacity: string };
  focused: { background: string; outlineStyle: string; outlineWidth: string; markOpacity: string };
};

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate): candidate is string => Boolean(candidate));

async function renderProviderMarkState(): Promise<ProviderMarkState> {
  const chrome = CHROME_CANDIDATES.find(existsSync);
  if (!chrome) throw new Error('A Chromium browser is required for the provider mark interaction regression.');

  const tokens = readFileSync(resolve('ui/src/styles/tokens.css'), 'utf8');
  const conversations = readFileSync(resolve('ui/src/styles/conversations.css'), 'utf8');
  const html = `<!doctype html><html data-theme="light"><head><style>
    ${tokens}\n${conversations}
    .new-chat-provider-picker__mark { transition: none; }
  </style></head><body>
    <button class="new-chat-provider-picker__provider" aria-label="Start with Codex (OpenAI)">
      <svg class="new-chat-provider-picker__mark" viewBox="0 0 721 721" aria-hidden="true"><path d="M0 0h721v721H0z" /></svg>
    </button>
  </body></html>`;
  const fixtureUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  const directory = mkdtempSync(join(tmpdir(), 'mandible-provider-mark-'));
  const profile = join(directory, 'profile');
  const browser = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--no-first-run',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--window-size=320,240',
    fixtureUrl,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let browserStderr = '';
  browser.stderr?.on('data', (chunk) => {
    browserStderr = `${browserStderr}${String(chunk)}`.slice(-4_000);
  });
  const requireRunning = () => {
    if (browser.exitCode !== null) {
      throw new Error(`Chromium exited during provider mark setup (${browser.exitCode}): ${browserStderr}`);
    }
  };

  let client: CdpClient | null = null;
  try {
    const port = await waitFor('Chromium provider mark DevTools port', () => {
      requireRunning();
      const path = join(profile, 'DevToolsActivePort');
      if (!existsSync(path)) return null;
      const rawPort = readFileSync(path, 'utf8').split('\n')[0]?.trim() ?? '';
      if (!/^\d+$/.test(rawPort)) return null;
      const value = Number(rawPort);
      return value > 0 ? value : null;
    });
    const page = await waitFor('Chromium provider mark fixture page target', () => {
      requireRunning();
      return fetch(`http://127.0.0.1:${port}/json/list`)
        .then((response) => response.json())
        .then((entries: Array<{ type: string; url: string; webSocketDebuggerUrl: string }>) =>
          entries.find((entry) => entry.type === 'page' && entry.url.startsWith('data:text/html')) ?? null)
        .catch(() => null);
    });
    client = await connectCdp(page.webSocketDebuggerUrl, 'Chromium provider mark');
    const evaluate = async (expression: string): Promise<any> => {
      const response = await client!.call('Runtime.evaluate', { expression, returnByValue: true });
      if (response.exceptionDetails) throw new Error(`Chromium provider mark evaluation failed: ${JSON.stringify(response.exceptionDetails)}`);
      return response.result?.value;
    };
    await waitFor('Chromium provider mark fixture readiness', async () => {
      requireRunning();
      return (await evaluate("document.readyState === 'complete'")) ? true : null;
    });
    await client.call('Emulation.setFocusEmulationEnabled', { enabled: true });
    return await evaluate(`(() => {
      const button = document.querySelector('button');
      const mark = document.querySelector('svg');
      const beforeButton = getComputedStyle(button);
      const beforeMark = getComputedStyle(mark);
      const before = {
        background: beforeButton.backgroundColor,
        borderWidth: beforeButton.borderTopWidth,
        markOpacity: beforeMark.opacity,
      };
      button.focus();
      const focusedButton = getComputedStyle(button);
      const focusedMark = getComputedStyle(mark);
      return {
        activeLabel: document.activeElement?.getAttribute('aria-label') ?? null,
        documentFocused: document.hasFocus(),
        matchesFocus: button.matches(':focus'),
        before,
        focused: {
          background: focusedButton.backgroundColor,
          outlineStyle: focusedButton.outlineStyle,
          outlineWidth: focusedButton.outlineWidth,
          markOpacity: focusedMark.opacity,
        },
      };
    })()`);
  } finally {
    client?.close();
    if (browser.exitCode === null) {
      const exited = new Promise<boolean>((resolveExit) => browser.once('exit', () => resolveExit(true)));
      browser.kill('SIGTERM');
      const stopped = await Promise.race([
        exited,
        new Promise<boolean>((resolveExit) => setTimeout(() => resolveExit(false), 1_000)),
      ]);
      if (!stopped && browser.exitCode === null) browser.kill('SIGKILL');
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('New chat provider marks', () => {
  it('keeps the default hit target unboxed and reveals the darker focus treatment', async () => {
    const state = await renderProviderMarkState();

    expect(state.activeLabel).toBe('Start with Codex (OpenAI)');
    expect(state.documentFocused).toBe(true);
    expect(state.matchesFocus).toBe(true);
    expect(state.before.background).toBe('rgba(0, 0, 0, 0)');
    expect(state.before.borderWidth).toBe('0px');
    expect(Number(state.focused.markOpacity)).toBeGreaterThan(Number(state.before.markOpacity));
    expect(state.focused.background).not.toBe(state.before.background);
    expect(state.focused.outlineStyle).not.toBe('none');
    expect(state.focused.outlineWidth).toBe('2px');
  });
});
