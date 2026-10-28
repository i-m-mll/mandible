import { mandibleSet } from './mandible-set';
import type { IconSet } from './types';

const defaultSet: IconSet = mandibleSet;
const overrides = {
  historyBack: mandibleSet.historyBack,
  historyForward: mandibleSet.historyForward,
  chatSubmit: mandibleSet.chatSubmit,
} satisfies Partial<IconSet>;

export const appIcons: IconSet = { ...defaultSet, ...overrides };
