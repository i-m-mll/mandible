import { PRODUCTION_EFFECTS } from '../../src/security/operation-policy.js';
import type { InstanceInfo } from '../../src/types.js';

export const MAIN_CLI_INSTANCE: InstanceInfo = {
  role: 'main', instance_id: 'cli-fixture', installation_id: 'test-installation',
  public_origin: 'https://app.mandible.localhost:19420', backend_generation: 'cli-fixture-generation',
  allowed_effects: PRODUCTION_EFFECTS, writable_roots: [],
  user_preferences_root: '/tmp/mandible-cli-fixture-preferences',
  db_path: '/tmp/mandible-cli-fixture.db', db_path_source: 'env',
};
