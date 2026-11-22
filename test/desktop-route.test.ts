// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ownedDesktopRoute } from '../scripts/desktop-route.mjs';
import { PRODUCTION_ORIGIN } from '../src/canonical-origin';

const predecessor = { pid: 41, imageInode: 658, startedAt: 'Sun Nov 22 16:00:00 2026 GMT' };
const record = {
  schema: 'mandible-desktop-route@1',
  pid: 41,
  image_inode: 658,
  desktop_started_at_ms: Date.parse('2026-11-22T16:00:00.250Z'),
  href: `${PRODUCTION_ORIGIN}/issue/acc7589?sidebar=hidden#details`,
};

describe('desktop handover route', () => {
  it('preserves the route and query of the exact predecessor', () => {
    expect(ownedDesktopRoute(record, [predecessor])).toEqual({ href: record.href, predecessor });
  });

  it('disregards observations from a different process or mapped image', () => {
    expect(ownedDesktopRoute(record, [{ ...predecessor, pid: 42 }])).toBeNull();
    expect(ownedDesktopRoute(record, [{ ...predecessor, imageInode: 659 }])).toBeNull();
    expect(ownedDesktopRoute(record, [{ ...predecessor, startedAt: 'Sun Nov 22 16:00:01 2026 GMT' }])).toBeNull();
    expect(ownedDesktopRoute(null, [predecessor])).toBeNull();
  });

  it.each([
    '//app.mandible.localhost:19420/issues',
    'http://app.mandible.localhost:19420/issues',
    'https://app.mandible.localhost:19421/issues',
    'https://app.mandible.localhost.example:19420/issues',
    'https://user:password@app.mandible.localhost:19420/issues',
    `${PRODUCTION_ORIGIN}/api/health`,
    `${PRODUCTION_ORIGIN}/dist/app.js`,
    `${PRODUCTION_ORIGIN}/r/issue/acc7589`,
    `${PRODUCTION_ORIGIN}/no-such-route`,
  ])('refuses %s as a handover target', href => {
    expect(ownedDesktopRoute({ ...record, href }, [predecessor])).toBeNull();
  });
});
