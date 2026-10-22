/**
 * Testing Library for gate tests. Its async utilities (`waitFor`, `findBy*`)
 * give up after one second by default, which a loaded machine exceeds; here
 * they share the state deadline in ./wait-until.ts instead.
 */
import { configure } from '@testing-library/preact';
import { STATE_DEADLINE_MS } from './wait-until.js';

configure({ asyncUtilTimeout: STATE_DEADLINE_MS });

export * from '@testing-library/preact';
