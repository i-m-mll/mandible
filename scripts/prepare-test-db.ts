import { prepareSchemaSeed } from '../test/helpers/schema-seed.js';

const root = process.env.MANDIBLE_TEST_RUNTIME_ROOT;
if (!root) throw new Error('Schema preparation requires a private test run root.');
prepareSchemaSeed(root);
