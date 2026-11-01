import { ClientAuthzError, isOperator, requireIdentity } from "../client-auth/authz.js";
import type { Db } from "../db.js";
import type { RequestLike } from "../server.js";
import { publisherMayPostInventory } from "../task-inventory.js";
import { getUserById } from "../users/store.js";

export interface AgentPublisherOptions {
  agentCode: string;
  agentMessage: string;
  allowOperator?: boolean;
}

/** Local claims and authenticated boundary transports resolve to one active publisher. */
export function requireAgentPublisher(
  db: Db,
  req: RequestLike,
  options: AgentPublisherOptions,
): { userId: string; slug: string; administrative: boolean } {
  const identity = requireIdentity(req);
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
 * The admitted identity must resolve to an active agent and that agent's slug must be
 * explicitly mapped to the exact executor name. Inventory retains its existing
 * operator administrative exception; command fetch/events do not enable it.
 */
export function requireMappedTaskExecutor(
  db: Db,
  req: RequestLike,
  executorName: string,
  options: MappedTaskExecutorOptions = {},
): { userId: string; slug: string; administrative: boolean } {
  const publisher = requireAgentPublisher(db, req, {
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
