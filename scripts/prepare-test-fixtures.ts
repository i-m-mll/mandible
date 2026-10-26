import { prepareSchemaSeed } from '../test/helpers/schema-seed.js';
import { MAIN_CLI_INSTANCE } from '../test/helpers/main-cli-instance.js';
import { registeredOperationRouter } from '../test/helpers/registered-operation-router.js';
import { prepareOperationCatalogSeed } from '../test/helpers/operation-catalog-seed.js';

const root = process.env.MANDIBLE_TEST_RUNTIME_ROOT;
if (!root) throw new Error('Fixture preparation requires a private test run root.');
prepareSchemaSeed(root);
prepareOperationCatalogSeed(root, { instance: MAIN_CLI_INSTANCE,
  operations: registeredOperationRouter(MAIN_CLI_INSTANCE).operationCatalog('ui-test') });
