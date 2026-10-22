// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetResourceRefRecognizers,
  isResourceRef,
  linkifyResourceRefs,
  parseResourceRef,
  previewableResourceFromAnchor,
  registerResourceRefRecognizer,
  resourceRefHref,
  seriesDetailHref,
  versionDetailHref,
} from '../ui/src/resource-refs';

const HASH64 = 'a'.repeat(64);
const ISSUE_ID64 = 'ceb5963936d47c70315242651c792dd1840ad49d6c3ce79a942f7e0ef3257053';
const COMMENT_ID64 = 'c8819b4725e341cc7e035a578a2f5c0e2fcfaff736fb75b04c4cf2954a746238';

afterEach(() => {
  __resetResourceRefRecognizers();
  vi.restoreAllMocks();
});

describe('approval references', () => {
  it('preserves full lookup and navigation authority while protecting code', () => {
    const fullId = '2257522a-39a2-467b-b3f8-491aea66754c';
    expect(parseResourceRef(`auth:${fullId}`)).toMatchObject({ kind: 'auth', canonical: `auth:${fullId}` });
    expect(parseResourceRef('auth:mandible/2257522a')).toBeNull();
    expect(resourceRefHref(`auth:${fullId}`)).toBe(`#/auth?request=${fullId}`);
    const container = document.createElement('div');
    container.innerHTML = linkifyResourceRefs(`<p>[auth:${fullId}]</p><code>[auth:2257522b]</code><pre>[auth:2257522c]</pre><a href="auth:${fullId}">Review</a>`);
    const anchors = container.querySelectorAll<HTMLAnchorElement>('a.resource-ref__link');
    expect(anchors).toHaveLength(2);
    expect([...anchors].map(anchor => anchor.getAttribute('href'))).toEqual([`#/auth?request=${fullId}`, `#/auth?request=${fullId}`]);
    expect(container.querySelector('code a')).toBeNull();
    expect(container.querySelector('pre a')).toBeNull();
  });
});

describe('Briefing references', () => {
  it('links typed refs through the server link route, which resolves legacy id spellings', () => {
    const fullId = '75e6ecb5-9927-4687-a8d5-34f8c030ad0c';
    expect(parseResourceRef(`briefing:${fullId}`)).toMatchObject({ kind: 'briefing', canonical: `briefing:${fullId}`, display: 'briefing:75e6ecb5' });
    expect(parseResourceRef('briefing:mandible/75e6ecb5')).toBeNull();
    const container = document.createElement('div');
    container.innerHTML = linkifyResourceRefs('<p>[briefing:8d34a5d3]</p><code>[briefing:75e6ecb5]</code>');
    const anchors = container.querySelectorAll<HTMLAnchorElement>('a.resource-ref__link');
    expect([...anchors].map(anchor => [anchor.textContent, anchor.getAttribute('href')])).toEqual([
      ['briefing:8d34a5d3', '/briefing/briefing%3A8d34a5d3'],
    ]);
  });
});

describe('legacy artifact ref rejection', () => {
  it('does not recognize obsolete hash refs as normal resource refs', () => {
    expect(parseResourceRef(`artifact:sha256:${HASH64}`)).toBeNull();
    expect(parseResourceRef(`sha256:${HASH64}`)).toBeNull();
    expect(parseResourceRef(HASH64)).toBeNull();
  });

});

describe('resource ref grammar', () => {
  it.each([
    ['artifact', 'artifact:abcdef0'],
    ['artifact', 'artifact-series:abcdef0@2'],
    ['artifact', 'artifact-series:abcdef0@latest'],
    ['artifact', 'artifact-version:1234567'],
    ['artifact', `artifact-blob:${HASH64}`],
    ['repo', 'repo://mandible@main/src/db.ts'],
    ['mandible', 'mandible://mandible/issue/252e125'],
    ['issue', `issue:${ISSUE_ID64}`],
    ['comment', `comment:${ISSUE_ID64}#${COMMENT_ID64}`],
  ])('parses a %s ref and keeps %s canonical', (kind, ref) => {
    expect(parseResourceRef(ref)).toMatchObject({ kind, canonical: ref });
  });

  it('submission refs accept only the closed direct and ask-ordinal grammar', () => {
    const ask = 'abcdef0-1234-5678-9abc-def012345678';
    expect(parseResourceRef(`submission:${ask}`)).toMatchObject({ kind: 'submission' });
    expect(parseResourceRef(`submission:${ask}#3`)).toMatchObject({ kind: 'submission' });
    for (const invalid of ['submission:', 'submission:abcdef#1', 'submission:abcdef0#0',
      'submission:abcdef0#', 'submission:abcdef_0#1', 'submission:abcdef%0#1', 'submission:-------#1']) {
      expect(parseResourceRef(invalid)).toBeNull();
    }
  });

  it('rejects plain http(s)/mailto navigation links', () => {
    expect(isResourceRef('https://example.com/x')).toBe(false);
    expect(isResourceRef('mailto:a@b.com')).toBe(false);
    expect(isResourceRef('just some prose')).toBe(false);
  });

  it.each([
    'artifact:abcdef0',
    'artifact-series:abcdef0@2',
    'artifact-version:version-1',
    `artifact-blob:${HASH64}`,
    'repo://mandible@main/src/db.ts',
    'mandible://mandible/issue/252e125',
    'issue:abc123',
    'comment:mandible/abc#com_1',
  ])('linkifies %s as bracketed text and as a link href, the href being the authority', (ref) => {
    expect(linkifyResourceRefs(`<p>[${ref}]</p>`)).toContain(`data-resource-ref="${ref}"`);
    const html = linkifyResourceRefs(`<p><a href="${ref}">label text</a></p>`);
    expect(html).toContain(`data-resource-ref="${ref}"`);
    expect(html).toContain('label text');
  });
});

describe('issue navigation and preview authority', () => {
  it('routes scoped issue refs normally and derives preview targets from the same grammar', () => {
    const href = resourceRefHref('issue:mandible/5096e37');
    expect(href).toBe('#/issues?issue=5096e37&repo=mandible');
    const host = document.createElement('div');
    host.innerHTML = linkifyResourceRefs('<p>[issue:mandible/5096e37]</p>');
    const anchor = host.querySelector('a')!;
    expect(anchor.getAttribute('href')).toBe(href);
    expect(previewableResourceFromAnchor(anchor)).toMatchObject({
      kind: 'issue', ref: '5096e37', repoId: 'mandible', href,
    });
  });

  it('derives artifact previews from the same wrapped resource grammar', () => {
    const href = resourceRefHref('artifact-version:1234567');
    const host = document.createElement('div');
    host.innerHTML = linkifyResourceRefs('<p>[artifact-version:1234567]</p>');
    const anchor = host.querySelector('a')!;
    expect(previewableResourceFromAnchor(anchor)).toMatchObject({
      kind: 'artifact', ref: 'artifact-version:1234567', href,
    });
  });
});

describe('artifact nav hrefs', () => {
  it('builds shareable logical and pinned-version artifact routes', () => {
    expect(seriesDetailHref('artifact:demo')).toBe('#/artifacts?series=artifact%3Ademo');
    expect(versionDetailHref('artifact:demo', 2)).toBe('#/artifacts?series=artifact%3Ademo&version=2');
    expect(resourceRefHref('artifact:abcdef0')).toBe('#/artifacts?ref=artifact%3Aabcdef0');
    expect(resourceRefHref('artifact-version:1234567')).toBe('#/artifacts?ref=artifact-version%3A1234567');
    expect(resourceRefHref('artifact-series:abcdef0')).toBe('#/artifacts?series=artifact-series%3Aabcdef0');
    expect(resourceRefHref('artifact-series:abcdef0@latest')).toBe(
      '#/artifacts?series=artifact-series%3Aabcdef0%40latest',
    );
    expect(resourceRefHref('artifact-series:abcdef0@2')).toBe(
      '#/artifacts?series=artifact-series%3Aabcdef0&version=2',
    );
    expect(resourceRefHref(`artifact-blob:${HASH64}`)).toBe(`#/artifacts?ref=artifact-blob%3A${HASH64}`);
  });

  it('routes the whole submission ref through the redirect with an encoded ordinal separator', () => {
    expect(resourceRefHref('submission:abcdef0#3')).toBe('/r/submission/submission%3Aabcdef0%233');
  });
});

describe('issue and comment ref links', () => {

  it('linkifies long issue and comment refs with compact labels but canonical authority', () => {
    const issueRef = `issue:${ISSUE_ID64}`;
    const commentRef = `comment:${ISSUE_ID64}#${COMMENT_ID64}`;
    const html = linkifyResourceRefs(`<p>See [${issueRef}] and [${commentRef}]</p>`);
    const container = document.createElement('div');
    container.innerHTML = html;

    const issueLink = container.querySelector(
      `[data-resource-ref="${issueRef}"] a.resource-ref__link`,
    ) as HTMLAnchorElement | null;
    const commentLink = container.querySelector(
      `[data-resource-ref="${commentRef}"] a.resource-ref__link`,
    ) as HTMLAnchorElement | null;

    expect(issueLink?.textContent).toBe('issue:ceb5963');
    expect(commentLink?.textContent).toBe('comment:ceb5963#c8819b4');
    expect(issueLink?.getAttribute('href')).toBe(`#/issues?issue=${ISSUE_ID64}`);
    expect(commentLink?.getAttribute('href')).toBe(`#/issues?issue=${ISSUE_ID64}&comment=${COMMENT_ID64}`);
  });

  it('links issue comment-ordinal refs to the comment on the issue', () => {
    expect(resourceRefHref('issue:abc1234#3')).toBe('#/issues?issue=abc1234&comment=3');
    expect(resourceRefHref('issue:mandible/abc1234#3')).toBe('#/issues?issue=abc1234&repo=mandible&comment=3');
    // Ordinal 0 is the issue description, the same card the issue view numbers 0.
    expect(resourceRefHref('issue:abc1234#0')).toBe('#/issues?issue=abc1234&comment=0');

    const container = document.createElement('div');
    container.innerHTML = linkifyResourceRefs('<p>See [issue:abc1234#3].</p>');
    const link = container.querySelector('[data-resource-ref="issue:abc1234#3"] a.resource-ref__link');
    expect(link?.textContent).toBe('issue:abc1234#3');
    expect(link?.getAttribute('href')).toBe('#/issues?issue=abc1234&comment=3');
  });
});

describe('grammar-extension point (C12 hook)', () => {
  it('extension recognizers run before built-ins and can claim a form', () => {
    const unregister = registerResourceRefRecognizer((candidate) =>
      candidate.startsWith('directive:')
        ? { raw: candidate, canonical: candidate, kind: 'unknown', display: candidate }
        : null,
    );
    const parsed = parseResourceRef('directive:include');
    expect(parsed?.canonical).toBe('directive:include');
    unregister();
    expect(parseResourceRef('directive:include')).toBeNull();
  });

});

describe('no regression: existing artifact linkify behavior', () => {
  it('leaves code/pre and plain prose untouched', () => {
    const html = linkifyResourceRefs(
      `<pre><code>[artifact:abcdef0]</code></pre><p>nothing here</p>`,
    );
    expect(html).not.toContain('resource-ref--unresolved');
    expect(html).toContain('[artifact:abcdef0]');
  });
});
