import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type ProviderMarkState = {
  activeLabel: string | null;
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

function renderProviderMarkState(): ProviderMarkState {
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
    <script>
      const button = document.querySelector('button');
      const mark = document.querySelector('svg');
      const beforeButton = getComputedStyle(button);
      const beforeMark = getComputedStyle(mark);
      const before = {
        background: beforeButton.backgroundColor,
        borderWidth: beforeButton.borderTopWidth,
        markOpacity: beforeMark.opacity,
      };
      button.focus({ focusVisible: true });
      const focusedButton = getComputedStyle(button);
      const focusedMark = getComputedStyle(mark);
      document.title = btoa(JSON.stringify({
        activeLabel: document.activeElement?.getAttribute('aria-label') ?? null,
        before,
        focused: {
          background: focusedButton.backgroundColor,
          outlineStyle: focusedButton.outlineStyle,
          outlineWidth: focusedButton.outlineWidth,
          markOpacity: focusedMark.opacity,
        },
      }));
    </script>
  </body></html>`;

  const rendered = spawnSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--dump-dom',
    '--window-size=320,240',
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  ], { encoding: 'utf8', maxBuffer: 10_000_000 });
  if (rendered.status !== 0) throw new Error(`Chromium provider mark fixture failed: ${rendered.stderr}`);
  const encoded = rendered.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
  if (!encoded) throw new Error('Chromium provider mark fixture did not return computed styles.');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as ProviderMarkState;
}

describe('New chat provider marks', () => {
  it('keeps the default hit target unboxed and reveals the darker focus treatment', () => {
    const state = renderProviderMarkState();

    expect(state.activeLabel).toBe('Start with Codex (OpenAI)');
    expect(state.before.background).toBe('rgba(0, 0, 0, 0)');
    expect(state.before.borderWidth).toBe('0px');
    expect(Number(state.focused.markOpacity)).toBeGreaterThan(Number(state.before.markOpacity));
    expect(state.focused.background).not.toBe(state.before.background);
    expect(state.focused.outlineStyle).not.toBe('none');
    expect(state.focused.outlineWidth).toBe('2px');
  });
});
