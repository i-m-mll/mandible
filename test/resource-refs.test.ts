import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetResourceRefRecognizers,
  attachResourceRefResolution,
  compactArtifactBlobRef,
  compactArtifactRef,
  displayResourceRef,
  isResourceRef,
  linkifyResourceRefs,
  parseResourceRef,
  registerResourceRefRecognizer,
  resolveResourceRef,
  resourceRefHref,
  seriesDetailHref,
  versionDetailHref,
  type ResolverResult,
} from '../ui/src/resource-refs';

const HASH64 = 'a'.repeat(64);
const ISSUE_ID64 = 'ceb5963936d47c70315242651c792dd1840ad49d6c3ce79a942f7e0ef3257053';
const COMMENT_ID64 = 'c8819b4725e341cc7e035a578a2f5c0e2fcfaff736fb75b04c4cf2954a746238';

afterEach(() => {
  __resetResourceRefRecognizers();
  vi.restoreAllMocks();
});

describe('legacy artifact ref rejection', () => {
  it('does not recognize old hash or series refs as normal resource refs', () => {
    expect(parseResourceRef(`artifact:sha256:${HASH64}`)).toBeNull();
    expect(parseResourceRef(`sha256:${HASH64}`)).toBeNull();
    expect(parseResourceRef(HASH64)).toBeNull();
    expect(parseResourceRef('artifact-series:abcdef0@2')).toBeNull();
  });

  it('does not linkify old hash refs in rendered content', () => {
    const html = linkifyResourceRefs(`<p>see [artifact:sha256:${HASH64}] please</p>`);
    expect(html).not.toContain('data-resource-ref="artifact:sha256:');
    expect(html).toContain(`[artifact:sha256:${HASH64}]`);
  });
});

describe('parseResourceRef recognizes canonical ref forms', () => {
  it('logical artifact form', () => {
    const parsed = parseResourceRef('artifact:abcdef0');
    expect(parsed?.kind).toBe('artifact');
    expect(parsed?.canonical).toBe('artifact:abcdef0');
  });

  it('artifact version and blob forms', () => {
    const version = parseResourceRef('artifact-version:1234567');
    const blob = parseResourceRef(`artifact-blob:${HASH64}`);
    expect(version?.kind).toBe('artifact');
    expect(version?.canonical).toBe('artifact-version:1234567');
    expect(blob?.kind).toBe('artifact');
    expect(blob?.canonical).toBe(`artifact-blob:${HASH64}`);
  });

  it('repo:// custody refs', () => {
    const parsed = parseResourceRef('repo://mandible@main/src/db.ts');
    expect(parsed?.kind).toBe('repo');
    expect(parsed?.canonical).toBe('repo://mandible@main/src/db.ts');
  });

  it('mandible:// issue refs', () => {
    const parsed = parseResourceRef('mandible://mandible/issue/252e125');
    expect(parsed?.kind).toBe('mandible');
    expect(parsed?.canonical).toBe('mandible://mandible/issue/252e125');
  });

  it('issue: inline refs', () => {
    const parsed = parseResourceRef(`issue:${ISSUE_ID64}`);
    expect(parsed?.kind).toBe('issue');
    expect(parsed?.canonical).toBe(`issue:${ISSUE_ID64}`);
    expect(parsed?.display).toBe('issue:ceb5963');
  });

  it('comment: inline refs', () => {
    const parsed = parseResourceRef(`comment:${ISSUE_ID64}#${COMMENT_ID64}`);
    expect(parsed?.kind).toBe('comment');
    expect(parsed?.canonical).toBe(`comment:${ISSUE_ID64}#${COMMENT_ID64}`);
    expect(parsed?.display).toBe('comment:ceb5963#c8819b4');
  });

  it('rejects plain http(s)/mailto navigation links', () => {
    expect(isResourceRef('https://example.com/x')).toBe(false);
    expect(isResourceRef('mailto:a@b.com')).toBe(false);
    expect(isResourceRef('just some prose')).toBe(false);
  });
});

describe('round-trip: text and markdown-link hrefs', () => {
  const cases: Array<[string, string]> = [
    ['logical artifact', 'artifact:abcdef0'],
    ['artifact version', 'artifact-version:version-1'],
    ['artifact blob', `artifact-blob:${HASH64}`],
    ['repo', 'repo://mandible@main/src/db.ts'],
    ['mandible', 'mandible://mandible/issue/252e125'],
    ['issue', 'issue:abc123'],
    ['comment', 'comment:mandible/abc#com_1'],
  ];

  for (const [name, ref] of cases) {
    it(`linkifies ${name} as bracketed text`, () => {
      const html = linkifyResourceRefs(`<p>[${ref}]</p>`);
      expect(html).toContain(`data-resource-ref="${ref}"`);
    });

    it(`linkifies ${name} as a markdown-link href`, () => {
      const html = linkifyResourceRefs(`<p><a href="${ref}">label text</a></p>`);
      expect(html).toContain(`data-resource-ref="${ref}"`);
      // The href is the resolution authority even when the label differs.
      expect(html).toContain('label text');
    });
  }
});

describe('edited content prefers markdown links with canonical hrefs', () => {
  it('href is the authority; label may change', () => {
    const html = linkifyResourceRefs(
      `<p><a href="artifact-blob:${HASH64}">My nice label</a></p>`,
    );
    expect(html).toContain(`data-resource-ref="artifact-blob:${HASH64}"`);
    // custom label preserved (not overwritten by the compact display form)
    expect(html).toContain('My nice label');
    expect(resourceRefHref(`artifact-blob:${HASH64}`)).toContain(
      encodeURIComponent(`artifact-blob:${HASH64}`),
    );
  });
});

describe('display helpers', () => {
  it('compacts logical artifact and blob refs', () => {
    expect(compactArtifactRef(`artifact:${HASH64}`)).toBe('artifact:aaaaaaaaaaaa');
    expect(compactArtifactBlobRef(`artifact-blob:${HASH64}`)).toBe('artifact-blob:aaaaaaaaaaaa');
  });

  it('displayResourceRef passes through unrecognized text', () => {
    expect(displayResourceRef('hello world')).toBe('hello world');
  });

  it('displayResourceRef compacts long issue and comment ids without changing canonical refs', () => {
    expect(displayResourceRef(`issue:${ISSUE_ID64}`)).toBe('issue:ceb5963');
    expect(displayResourceRef(`comment:${ISSUE_ID64}#${COMMENT_ID64}`)).toBe(
      'comment:ceb5963#c8819b4',
    );
    expect(parseResourceRef(`issue:${ISSUE_ID64}`)?.canonical).toBe(`issue:${ISSUE_ID64}`);
    expect(parseResourceRef(`comment:${ISSUE_ID64}#${COMMENT_ID64}`)?.canonical).toBe(
      `comment:${ISSUE_ID64}#${COMMENT_ID64}`,
    );
  });
});

describe('artifact nav hrefs', () => {
  it('builds shareable logical and pinned-version artifact routes', () => {
    expect(seriesDetailHref('artifact:demo')).toBe('#/artifacts?series=artifact%3Ademo');
    expect(versionDetailHref('artifact:demo', 2)).toBe('#/artifacts?series=artifact%3Ademo&version=2');
    expect(resourceRefHref('artifact:abcdef0')).toBe('#/artifacts?ref=artifact%3Aabcdef0');
    expect(resourceRefHref('artifact-version:1234567')).toBe('#/artifacts?ref=artifact-version%3A1234567');
    expect(resourceRefHref(`artifact-blob:${HASH64}`)).toBe(`#/artifacts?ref=artifact-blob%3A${HASH64}`);
  });
});

describe('unresolved-reference UI + C2 resolver', () => {
  it('renders an unresolved placeholder as a quiet link without resolve clutter', () => {
    const html = linkifyResourceRefs(`<p>[artifact-blob:${HASH64}]</p>`);
    expect(html).toContain('resource-ref--unresolved');
    expect(html).toContain('data-ref-state="unresolved"');
    expect(html).toContain('#/artifacts?ref=artifact-blob%3A' + HASH64);
    expect(html).not.toContain('resource-ref__resolve');
  });

  it('resolveResourceRef calls the C2 endpoint and unwraps {resolution}', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ resolution: { ref: 'x', kind: 'artifact', resolved: true, entity: {} } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const result = await resolveResourceRef(`artifact-blob:${HASH64}`, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const calledPath = (fetchImpl.mock.calls[0] as unknown[])[0] as string;
    expect(calledPath).toContain('/api/spaces/resolve?ref=');
    expect(result.resolved).toBe(true);
  });

  it('attachResourceRefResolution is inert when normal refs have no retry button', async () => {
    const container = document.createElement('div');
    container.innerHTML = linkifyResourceRefs(`<p>[artifact-blob:${HASH64}]</p>`);
    const resolve = vi.fn(
      async (ref: string): Promise<ResolverResult> => ({ ref, kind: 'artifact', resolved: true, entity: {} }),
    );
    attachResourceRefResolution(container, { resolve });

    const button = container.querySelector('button.resource-ref__resolve') as HTMLButtonElement;
    expect(button).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    const wrapper = container.querySelector('.resource-ref') as HTMLElement;
    expect(wrapper.getAttribute('data-ref-state')).toBe('unresolved');
    expect(wrapper.querySelector('.resource-ref__link')).toBeTruthy();
    expect(container.querySelector('button.resource-ref__resolve')).toBeNull();
  });

  it('an unresolvable-looking ref still renders as a quiet unresolved placeholder', async () => {
    const container = document.createElement('div');
    container.innerHTML = linkifyResourceRefs(`<p>[artifact:abcdef0]</p>`);
    const resolve = vi.fn(
      async (ref: string): Promise<ResolverResult> => ({ ref, kind: 'artifact', resolved: false, entity: null, error: 'not found' }),
    );
    attachResourceRefResolution(container, { resolve });
    expect(container.querySelector('button.resource-ref__resolve')).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    expect(container.querySelector('[data-resource-ref="artifact:abcdef0"]')).toBeTruthy();
  });

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
    expect(issueLink?.getAttribute('href')).toContain(encodeURIComponent(issueRef));
    expect(commentLink?.getAttribute('href')).toContain(encodeURIComponent(commentRef));
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

  it('does NOT recognize directive nodes by default (C12 owns that grammar)', () => {
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
