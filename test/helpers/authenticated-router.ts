import { PRODUCTION_EFFECTS } from "../../src/security/effect-policy.js";
import {
  Router,
  type ClientAuthGate,
  type ResolvedClientIdentity,
  type RouterOptions,
} from "../../src/server.js";

type TestUser = { id: string; slug: string };

export function authenticatedTestIdentity(
  user: TestUser,
  options: { credentialId?: string } = {},
): ResolvedClientIdentity {
  return {
    user_id: user.id,
    slug: user.slug,
    method: "api_token",
    credential_id: options.credentialId ?? "test-credential",
    source: "in_process",
    effect_ceiling: PRODUCTION_EFFECTS,
  };
}

export function authenticatedTestRouter(
  user: TestUser,
  options: Omit<RouterOptions, "clientAuth"> & { credentialId?: string } = {},
): Router {
  const { credentialId, ...routerOptions } = options;
  const identity = authenticatedTestIdentity(user, { credentialId });
  const gate: ClientAuthGate = {
    authenticate: () => identity,
    mode: () => "strict",
    recordUnattributedWrite: () => undefined,
  };
  return new Router({ ...routerOptions, clientAuth: gate });
}
