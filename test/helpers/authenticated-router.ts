import { PRODUCTION_EFFECTS } from "../../src/security/effect-policy.js";
import {
  Router,
  type ClientAuthGate,
  type ResolvedClientIdentity,
  type RouterOptions,
} from "../../src/server.js";

type TestUser = { id: string; slug: string };

export function authenticatedTestIdentity(user: TestUser): ResolvedClientIdentity {
  return {
    user_id: user.id,
    slug: user.slug,
    method: "api_token",
    credential_id: "test-credential",
    source: "in_process",
    effect_ceiling: PRODUCTION_EFFECTS,
  };
}

export function authenticatedTestRouter(user: TestUser, options: Omit<RouterOptions, "clientAuth"> = {}): Router {
  const identity = authenticatedTestIdentity(user);
  const gate: ClientAuthGate = {
    authenticate: () => identity,
    mode: () => "strict",
    recordUnattributedWrite: () => undefined,
  };
  return new Router({ ...options, clientAuth: gate });
}
