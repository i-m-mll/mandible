import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/preact';
import { afterAll, describe, expect, it } from 'vitest';

import { CollectionsSidebar } from '../../ui/src/views/feedback/CollectionsSidebar.js';
import type { BriefingBundle, BriefingGroup } from '../../ui/src/api.js';
import type { FeedbackCollection } from '../../ui/src/views/feedback/collection-model.js';

/**
 * Group membership is ledger state: a bundle belongs to at most one group, and
 * its Base-versus-proposal standing depends on which. This gate asserts the
 * sidebar tells the truth about that state — that a bundle owned by nothing is
 * legibly outside the group rendered above it (issue 62eb325).
 *
 * It measures a real Chromium layout rather than class names, because the
 * defect was never a class: the two cases carried identical presentation props
 * and were separated only by a 12px pad in a view-local stylesheet. Only
 * rendered geometry can say whether a reader can tell them apart.
 */

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate): candidate is string => Boolean(candidate));

const chrome = CHROME_CANDIDATES.find(existsSync);

const styles = readFileSync(resolve('ui/src/style.css'), 'utf8')
  .split('\n')
  .flatMap((line) => {
    const href = line.match(/^@import\s+"\.\/(.+\.css)"/)?.[1];
    return href ? [readFileSync(resolve('ui/src', href), 'utf8')] : [];
  })
  .join('\n');

const GROUP_ID = 'group-sara';
const UNGROUPED_BUNDLE_ID = 'bundle-ledger-audit';

function briefing(id: string, label: string): FeedbackCollection {
  return {
    id: `briefing:${id}`,
    collectionId: id,
    label,
    unansweredDirectiveCount: 0,
    latestRoundId: `round-${id}`,
    createdAt: 1,
    updatedAt: 2,
  };
}

const owned = [briefing('owned-a', 'Skill breakdown'), briefing('owned-b', 'Skill rubric')];
const unowned = [briefing('free-a', 'Ledger design audit'), briefing('free-b', 'Ledger custody')];
const collections = [...owned, ...unowned];

function bundle(id: string, name: string, layoutName: string, briefings: FeedbackCollection[]): BriefingBundle {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 2,
    members: briefings.map((entry, position) => ({ position, briefing: entry })),
    layout: [{ kind: 'subgroup', name: layoutName, briefings }],
  };
}

const group: BriefingGroup = {
  id: GROUP_ID,
  name: "Sara's skill, breakdown",
  createdAt: 1,
  updatedAt: 2,
  current: bundle('bundle-base', 'Base', 'Review', owned),
  updates: [],
};

const ungrouped: BriefingBundle = {
  id: UNGROUPED_BUNDLE_ID,
  name: 'Ledger design audit',
  createdAt: 1,
  updatedAt: 2,
  members: unowned.map((entry, position) => ({ position, briefing: entry })),
  layout: unowned.map((entry) => ({ kind: 'briefing' as const, briefing: entry })),
};

function renderSidebarMarkup(): string {
  const view = render(<CollectionsSidebar
    collections={collections}
    bundles={[ungrouped]}
    groups={[group]}
    selectedCollectionId={null}
    viewState={{
      collectionSourceFilter: '',
      pinnedOnly: false,
      collectionSort: 'activity',
      pinnedCollectionIds: [],
      pinnedSectionCollapsed: false,
      collapsedBundleIds: [],
      collapsedGroupIds: [],
      collapsedGroupSubgroupKeys: [],
      selectedGroupUpdateIds: {},
      selectedGroupId: null,
      selectedCollectionId: null,
      selectedRoundIds: {},
    }}
    setViewState={() => undefined}
    onSelect={() => undefined}
  />);
  return view.container.innerHTML;
}

type Rect = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>;

type DepthGeometry = {
  subgroupIcon: Rect;
  ungroupedIcon: Rect;
  ownedRow: number;
  unownedRow: number;
  groupRegion: Rect;
  spineLeft: string;
  spineWidth: string;
  spineBackground: string;
};

function measure(markup: string): DepthGeometry {
  if (!chrome) throw new Error('A Chromium browser is required for the Briefings sidebar depth gate.');

  const payload = JSON.stringify({ markup, styles }).replaceAll('<', '\\u003c');
  const html = `<!doctype html><html><body><script>
    const { markup, styles } = ${payload};
    const frame = document.createElement('iframe');
    frame.style.cssText = 'display:block;border:0;width:320px;height:600px';
    frame.addEventListener('load', () => {
      const doc = frame.contentDocument;
      const rect = (selector) => {
        const node = doc.querySelector(selector);
        if (!node) throw new Error('missing node: ' + selector);
        const bounds = node.getBoundingClientRect();
        return Object.fromEntries(['left','top','right','bottom','width','height'].map((k) => [k, bounds[k]]));
      };
      // The title column starts after the row button's own inset, and the
      // button itself spans the full pane width.
      const textLeft = (selector) => {
        const node = doc.querySelector(selector);
        if (!node) throw new Error('missing node: ' + selector);
        return node.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(node).paddingLeft);
      };
      const subgroup = '#briefing-subgroup-${GROUP_ID}-0';
      const bundleNode = '#briefing-bundle-${UNGROUPED_BUNDLE_ID}';
      const region = doc.querySelector(subgroup + '-body').closest('.sidebar-group-node--category')
        .querySelector(':scope > .sidebar-disclosure-region');
      const spine = getComputedStyle(region, '::before');
      const regionBounds = region.getBoundingClientRect();
      document.title = btoa(JSON.stringify({
        subgroupIcon: rect(subgroup + '-heading .sidebar-group-node__leading'),
        ungroupedIcon: rect(bundleNode + '-heading .sidebar-group-node__leading'),
        ownedRow: textLeft(subgroup + '-body .sidebar-item-row__select'),
        unownedRow: textLeft(bundleNode + '-body .sidebar-item-row__select'),
        groupRegion: Object.fromEntries(['left','top','right','bottom','width','height'].map((k) => [k, regionBounds[k]])),
        spineLeft: spine.left,
        spineWidth: spine.width,
        spineBackground: spine.backgroundColor,
      }));
    }, { once: true });
    frame.srcdoc = '<!doctype html><html data-theme="dark"><head><style>' + styles + '</style></head><body>' + markup + '</body></html>';
    document.body.append(frame);
  </script></body></html>`;

  const rendered = spawnSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--dump-dom',
    '--window-size=420,900',
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  ], { encoding: 'utf8', maxBuffer: 20_000_000 });
  if (rendered.status !== 0) throw new Error(`Chromium Briefings sidebar fixture failed: ${rendered.stderr}`);
  const encoded = rendered.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
  if (!encoded) throw new Error('Chromium Briefings sidebar fixture did not return measurements.');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as DepthGeometry;
}

const geometry = measure(renderSidebarMarkup());

afterAll(() => cleanup());

describe('Briefings sidebar ownership depth', () => {
  it('indents a group-owned subgroup past a bundle that belongs to no group', () => {
    expect(geometry.subgroupIcon.left - geometry.ungroupedIcon.left).toBeGreaterThanOrEqual(12);
    expect(geometry.ownedRow - geometry.unownedRow).toBeGreaterThanOrEqual(12);
  });

  it('draws the group extent and leaves an ungrouped bundle outside it', () => {
    const spine = geometry.groupRegion.left + Number.parseFloat(geometry.spineLeft);

    expect(Number.parseFloat(geometry.spineWidth)).toBeGreaterThan(0);
    expect(geometry.spineBackground).not.toBe('rgba(0, 0, 0, 0)');
    expect(geometry.groupRegion.height).toBeGreaterThan(0);

    // Everything the group owns sits right of its spine; the unowned bundle
    // starts left of it, so the drawn extent excludes it.
    expect(geometry.subgroupIcon.left).toBeGreaterThan(spine);
    expect(geometry.ownedRow).toBeGreaterThan(spine);
    expect(geometry.ungroupedIcon.left).toBeLessThan(spine);
  });
});
