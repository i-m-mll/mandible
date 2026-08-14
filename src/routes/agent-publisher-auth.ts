import { ClientAuthzError, isOperator, requireIdentity } from "../client-auth/authz.js";
import type { Db } from "../db.js";
import type { RequestLike } from "../server.js";
import { publisherMayPostInventory } from "../task-inventory.js";
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

export interface MappedTaskExecutorOptions {
  allowOperator?: boolean;
}

/**
 * Inventory and command receipts share one exact executor boundary.
 *
 * A durable token must resolve to an active agent and that agent's slug must be
 * explicitly mapped to the exact executor name. Inventory retains its existing
 * operator administrative exception; command fetch/events do not enable it.
 */
export function requireMappedTaskExecutor(
  db: Db,
  req: RequestLike,
  executorName: string,
  options: MappedTaskExecutorOptions = {},
): { userId: string; slug: string; administrative: boolean } {
  const publisher = requireDurableAgentPublisher(db, req, {
    credentialCode: "executor_credential_required",
    credentialMessage:
      "Executor access requires a durable API token, not a session credential.",
    agentCode: "executor_agent_required",
    agentMessage: "Executor access requires an agent identity.",
    allowOperator: options.allowOperator === true,
  });
  if (!publisher.administrative
    && !publisherMayPostInventory(db, publisher.slug, executorName)) {
    throw new ClientAuthzError(
      403,
      "executor_identity_forbidden",
      `Identity '${publisher.slug}' is not mapped to executor '${executorName}'.`,
    );
  }
  return publisher;
}
