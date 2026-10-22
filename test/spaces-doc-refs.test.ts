import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetResourceRefRecognizers,
  isResourceRef,
  linkifyResourceRefs,
  parseResourceRef,
} from '../../ui/src/resource-refs';
import {
  installSpacesDocRefRecognizer,
  recognizeSpacesDocDirectiveRef,
} from '../../ui/src/spaces-doc-refs';

const HASH64 = 'a'.repeat(64);

afterEach(() => {
  __resetResourceRefRecognizers();
});

describe('C6 shared parser: spaces-doc.v1 directive extension', () => {
  it('without the extension, the C6 parser does NOT recognize a directive node', () => {
    __resetResourceRefRecognizers();
    expect(parseResourceRef(':ref[abc]{href="artifact:logical"}')).toBeNull();
  });

  it('after installing the extension, the C6 parser recognizes a canonical directive ref node', () => {
    installSpacesDocRefRecognizer();
    const parsed = parseResourceRef(':ref[abc]{href="artifact-blob:' + HASH64 + '"}');
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe('artifact');
    expect(parsed!.canonical).toBe(`artifact-blob:${HASH64}`);
    expect(parsed!.display).toBe('abc');
  });

  it('the C6 parser STILL recognizes refs as markdown-link/bare forms after extension', () => {
    installSpacesDocRefRecognizer();
    // Built-in canonical artifact ref still works (extension runs first,
    // declines, built-in claims it).
    const bare = parseResourceRef(`artifact-blob:${HASH64}`);
    expect(bare).not.toBeNull();
    expect(bare!.kind).toBe('artifact');
    // A repo:// scheme ref still resolves via built-in recognition.
    expect(isResourceRef('repo://mandible@main/docs/x.md')).toBe(true);
  });

  it('directive recognition does not break markdown-link linkification', () => {
    installSpacesDocRefRecognizer();
    const html = linkifyResourceRefs(
      `<p><a href="artifact-blob:${HASH64}">fig</a></p>`,
    );
    expect(html).toContain('resource-ref');
    expect(html).toContain('data-resource-ref');
  });

  it('the adapter maps directive kinds onto C6 ParsedResourceRef', () => {
    const issue = recognizeSpacesDocDirectiveRef(':ref[i]{href="mandible://mandible/issue/e70757d"}');
    expect(issue!.kind).toBe('issue');
    const repo = recognizeSpacesDocDirectiveRef(':embed{href="repo://mandible@main/x.md"}');
    expect(repo!.kind).toBe('repo');
    expect(recognizeSpacesDocDirectiveRef('not a directive')).toBeNull();
  });

  it('installation is idempotent (single registration)', () => {
    const off1 = installSpacesDocRefRecognizer();
    const off2 = installSpacesDocRefRecognizer();
    expect(off1).toBe(off2);
    off1();
    // After unregister, recognition falls back to built-in (declines directive).
    expect(parseResourceRef(':ref[x]{href="artifact:logical"}')).toBeNull();
  });

  it('declines legacy artifact directive hrefs', () => {
    installSpacesDocRefRecognizer();
    expect(parseResourceRef(':ref[x]{href="artifact:sha256:' + HASH64 + '"}')).toBeNull();
    expect(parseResourceRef(':ref[x]{href="sha256:' + HASH64 + '"}')).toBeNull();
  });

  it('recognizes compatibility series selectors through directive refs', () => {
    installSpacesDocRefRecognizer();
    const parsed = parseResourceRef(':ref[x]{href="artifact-series:abcdef0@2"}');
    expect(parsed).toMatchObject({
      kind: 'artifact',
      canonical: 'artifact-series:abcdef0@2',
      display: 'x',
    });
  });
});
