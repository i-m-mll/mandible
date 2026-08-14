import { ClientAuthzError, isOperator, requireIdentity } from "../client-auth/authz.js";
import type { Db } from "../db.js";
import type { RequestLike } from "../server.js";
import { getUserById } from "../users/store.js";

export interface DurableAgentPublisherOptions {
  credentialCode: string;
  credentialMessage: string;
  agentCode: string;
  agentMessage: string;
  allowOperator?: boolean;
}

/**
 * Shared write-boundary authentication for unattended publishers.
 *
 * Route-specific registration checks remain with their owning contract, but
 * credential durability, active-user lookup, agent-kind enforcement, and
 * authenticated-principal attribution must not drift between inventory and
 * Briefing or between HTTP and file-RPC transports.
 */
export function requireDurableAgentPublisher(
  db: Db,
  req: RequestLike,
  options: DurableAgentPublisherOptions,
): { userId: string; slug: string; administrative: boolean } {
  const identity = requireIdentity(req);
  if (identity.method !== "api_token") {
    throw new ClientAuthzError(
      403,
      options.credentialCode,
      options.credentialMessage,
    );
  }
  const user = getUserById(db, identity.user_id);
  if (!user || user.status !== "active") {
    throw new ClientAuthzError(403, "forbidden", "The authenticated user is not active.");
  }
  if (options.allowOperator && isOperator(db, identity)) {
    return { userId: user.id, slug: user.slug, administrative: true };
  }
  if (user.kind !== "agent") {
    throw new ClientAuthzError(403, options.agentCode, options.agentMessage);
  }
  return { userId: user.id, slug: user.slug, administrative: false };
}
