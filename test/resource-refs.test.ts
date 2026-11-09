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
} from '../ui/src/resource-refs';
import { routeFromUrl } from '../ui/src/routing';

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
    const container = document.createElement('div');
    container.innerHTML = linkifyResourceRefs(`<p>[auth:${fullId}]</p><code>[auth:2257522b]</code><pre>[auth:2257522c]</pre><a href="auth:${fullId}">Review</a>`);
    const anchors = container.querySelectorAll<HTMLAnchorElement>('a.resource-ref__link');
    expect(anchors).toHaveLength(2);
    expect(container.querySelector('code a')).toBeNull();
    expect(container.querySelector('pre a')).toBeNull();
  });
});

describe('Briefing references', () => {
  it('recognizes typed refs outside code', () => {
    const fullId = '75e6ecb5-9927-4687-a8d5-34f8c030ad0c';
    expect(parseResourceRef(`briefing:${fullId}`)).toMatchObject({ kind: 'briefing', canonical: `briefing:${fullId}`, display: 'briefing:75e6ecb5' });
    expect(parseResourceRef('briefing:mandible/75e6ecb5')).toBeNull();
    const container = document.createElement('div');
    container.innerHTML = linkifyResourceRefs('<p>[briefing:8d34a5d3]</p><code>[briefing:75e6ecb5]</code>');
    const anchors = container.querySelectorAll<HTMLAnchorElement>('a.resource-ref__link');
    expect(anchors).toHaveLength(1);
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
    ['mandible', 'mandible:///issue/252e125'],
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
    'mandible:///issue/252e125',
    'issue:abc123',
    'comment:mandible/abc#com_1',
  ])('linkifies %s as bracketed text and as a link href, the href being the authority', (ref) => {
    expect(linkifyResourceRefs(`<p>[${ref}]</p>`)).toContain(`data-resource-ref="${ref}"`);
    const html = linkifyResourceRefs(`<p><a href="${ref}">label text</a></p>`);
    expect(html).toContain(`data-resource-ref="${ref}"`);
    expect(html).toContain('label text');
  });
});

describe('resource ref navigation', () => {
  const at = (href: string | undefined) => routeFromUrl(new URL(href!, 'https://app.test'));

  it.each([
    ['issue:mandible/5096e37', 'issue', 'mandible/5096e37', {}],
    ['issue:abc1234#3', 'issue', 'abc1234', { comment: '3' }],
    [`comment:${ISSUE_ID64}#${COMMENT_ID64}`, 'issue', ISSUE_ID64, { comment: COMMENT_ID64 }],
    ['auth:2257522a-39a2-467b-b3f8-491aea66754c', 'auth', '2257522a-39a2-467b-b3f8-491aea66754c', {}],
    ['briefing:8d34a5d3', 'briefing', 'briefing:8d34a5d3', {}],
    ['artifact-series:abcdef0@2', 'artifact', 'artifact-series:abcdef0@2', {}],
    [`artifact-blob:${HASH64}`, 'artifact', `artifact-blob:${HASH64}`, {}],
    ['repo://mandible@main/src/db.ts', 'artifact', 'repo://mandible@main/src/db.ts', {}],
    ['mandible:///issue/252e125?comment=2', 'issue', '252e125', { comment: '2' }],
    ['mandible://issue/252e125', 'issue', '252e125', {}],
  ])('links %s to the %s path naming %s', (ref, kind, entityRef, params) => {
    expect(at(resourceRefHref(ref))).toMatchObject({ entity: { kind, ref: entityRef }, params });
  });

  it('gives submission refs, which have no page, no link', () => {
    expect(resourceRefHref('submission:abcdef0#3')).toBeUndefined();
  });

  it('derives previews from wrapped refs and from same-app entity paths', () => {
    const host = document.createElement('div');
    host.innerHTML = `${linkifyResourceRefs('<p>[issue:mandible/5096e37] [artifact-version:1234567]</p>')}
      <a id="issue" href="/issue/mandible/abc1234?comment=2">abc1234</a>
      <a id="artifact" href="/artifact/artifact-series:abcdef0@2">v2</a>
      <a id="view" href="/issues">Issues</a>
      <a id="elsewhere" href="https://example.com/issue/abc1234">abc1234</a>`;
    const [issue, artifact] = host.querySelectorAll<HTMLAnchorElement>('a.resource-ref__link');
    expect(previewableResourceFromAnchor(issue)).toMatchObject({ kind: 'issue', ref: '5096e37', repoId: 'mandible' });
    expect(previewableResourceFromAnchor(artifact)).toMatchObject({ kind: 'artifact', ref: 'artifact-version:1234567' });
    expect(previewableResourceFromAnchor(host.querySelector('#issue')!)).toMatchObject({
      kind: 'issue', ref: 'abc1234', repoId: 'mandible', comment: '2',
    });
    expect(previewableResourceFromAnchor(host.querySelector('#artifact')!)).toMatchObject({
      kind: 'artifact', ref: 'artifact-series:abcdef0@2',
    });
    expect(previewableResourceFromAnchor(host.querySelector('#view')!)).toBeNull();
    expect(previewableResourceFromAnchor(host.querySelector('#elsewhere')!)).toBeNull();
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
