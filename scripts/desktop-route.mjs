import { parseAppPath } from '../src/app-routes.ts';
import { PRODUCTION_ORIGIN } from '../src/canonical-origin.ts';

export function ownedDesktopRoute(record, prior) {
  if (record?.schema !== 'mandible-desktop-route@1'
      || typeof record.href !== 'string' || record.href.length > 4096
      || !Number.isFinite(record.desktop_started_at_ms)) return null;
  const observed = prior.find(process => process.pid === record.pid && process.imageInode
    && process.imageInode === record.image_inode && record.desktop_started_at_ms >= Date.parse(process.startedAt));
  if (!observed) return null;
  let target;
  try { target = new URL(record.href); } catch { return null; }
  if (target.origin !== PRODUCTION_ORIGIN || target.username || target.password
      || parseAppPath(target.pathname).kind === 'not_found') return null;
  return { href: target.href, predecessor: { pid: observed.pid, startedAt: observed.startedAt, imageInode: observed.imageInode } };
}
