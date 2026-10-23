/**
 * Testing Library for gate tests. Its async utilities (`waitFor`, `findBy*`)
 * give up after one second by default, which a loaded machine exceeds; here
 * they share the state deadline in ./wait-until.ts instead.
 */
import { configure, createEvent, fireEvent as libraryFireEvent } from '@testing-library/preact';
import { STATE_DEADLINE_MS } from './wait-until.js';

configure({ asyncUtilTimeout: STATE_DEADLINE_MS });

export * from '@testing-library/preact';

// The library redirects change to input under compat even for native selects.
export const fireEvent: typeof libraryFireEvent = Object.assign(
  ((...args: Parameters<typeof libraryFireEvent>) => libraryFireEvent(...args)),
  libraryFireEvent,
  { change: (...[node, init]: Parameters<typeof libraryFireEvent.change>) => node instanceof HTMLSelectElement
    ? libraryFireEvent(node, createEvent.change(node, init))
    : libraryFireEvent.change(node, init) },
);
