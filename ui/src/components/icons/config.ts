import { mandibleSet } from './mandible-set';
import { lucideSet } from './lucide-set';
import type { IconSet } from './types';

const defaultSet = mandibleSet;
const overrides = {
  ...lucideSet,
  historyBack: mandibleSet.historyBack,
  historyForward: mandibleSet.historyForward,
  chatSubmit: mandibleSet.chatSubmit,
} satisfies Partial<IconSet>;

export const appIcons: IconSet = { ...defaultSet, ...overrides };
