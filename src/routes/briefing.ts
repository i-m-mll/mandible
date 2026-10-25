import type { LedgerReader } from "../ledger-reads/index.js";
import { attributionForRequest, ClientAuthzError, isLocalHumanRequest, isOperator, requireIdentity } from "../client-auth/authz.js";
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../canonical-json.js";
import { artifactRequiredProjects, getArtifactCurrentSource } from "../artifact-source.js";
import type { Db } from "../db.js";
import {
  applyBriefingAnnotations,
  applyBriefingAnswers,
  BriefingStoreError,
  exportBriefingSubmissionMarkdown,
  parseBriefingRunRequest,
  publishBriefingFromArtifactVersion,
  publishBriefingRun,
  publishBriefingReportRound,
  readBriefing,
  resolveBriefingId,
  setBriefingArchived,
  submitBriefingRound,
  updateBriefingDescription,
  updateBriefingTitle,
} from "../feedback/briefings.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import { broadcast } from "../sse.js";
import { getOperator, getUserById } from "../users/store.js";
import { publisherMayIngest } from "../briefing.js";
import { BRIEFING_EVENTS } from "../contracts.js";
import {
  addBriefingBundleMember,
  createBriefingBundle,
  deleteEmptyBriefingBundle,
  listBriefingBundles,
  readBriefingBundle,
  replaceBriefingBundleLayout,
  updateBriefingBundleName,
} from "../feedback/briefing-bundles.js";
import {
  addBriefingGroupUpdate,
  bindBriefingDestinationOwner,
  configureBriefingGroup,
  createBriefingGroup,
  dispositionBriefingGroupProposalByHumanReview,
  listBriefingGroups,
  previewBriefingGroupReviewCandidate,
  readBriefingGroup,
  promoteBriefingGroupProposal,
  setBriefingGroupArchived,
  updateBriefingGroupName,
} from "../feedback/briefing-groups.js";
import type { BriefingGroupDestinationChangeInput } from "../feedback/briefing-groups.js";
import { requireDurableAgentPublisher } from "./agent-publisher-auth.js";
import { evaluateProjectAccess, PermissionError, requireProjectAccess } from "../permissions/store.js";
import { resolveArtifactProject } from "../permissions/resources.js";
import { resolveArtifactIdentity } from "../provider-artifacts.js";
import { placeBriefingReport } from "../feedback/briefing-report-destinations.js";
import { sendJson } from "./http.js";
import {
  BRIEFING_COMPOSITION_SCHEMA,
  inspectBriefingDestinationRoutes,
  parseBriefingCompositionRequest,
  parseBriefingDestinationRouteManifest,
  planBriefingDestinationRoutes,
  publishBriefingCompositionRun,
  reconcileBriefingDestinationRoutes,
} from "../feedback/briefing-composer.js";
import { entityRefs } from "../entity-refs.js";

function handleError(res: ResponseLike, error: unknown): void {
  if (error instanceof ClientAuthzError || error instanceof BriefingStoreError || error instanceof PermissionError) {
    sendJson(res, error.status, { error: error.message, code: error.code,
      ...(error instanceof BriefingStoreError && error.details ? error.details : {}) });
    return;
  }
  sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
}

function activeHuman(db: Db, req: RequestLike) {
  const identity = requireIdentity(req);
  const user = getUserById(db, identity.user_id);
  if (!user || user.status !== "active" || user.kind !== "human"
      || (identity.method === "local_socket" && !isLocalHumanRequest(req))) {
    throw new ClientAuthzError(403, "human_responder_required", "Briefing responses require an active human credential.");
  }
  return { identity, user, operator: isOperator(db, identity) };
}

type PublicationPrincipal = {
  publisherUserId: string;
  kind: "human" | "agent";
  operator: boolean;
};

function localAgent(db: Db, req: RequestLike): boolean {
  const identity = req.client_identity;
  if (identity?.method !== "local_socket") return false;
  const user = getUserById(db, identity.user_id);
  const attribution = attributionForRequest(db, req);
  return user?.status === "active" && user.kind === "agent"
    && attribution?.evidence_method === "session_claim"
    && attribution.user_id === user.id;
}

function publicationPrincipal(
  db: Db,
  req: RequestLike,
  messages: {
    credentialCode: string;
    credentialMessage: string;
    agentCode: string;
    agentMessage: string;
  },
): PublicationPrincipal {
  const identity = requireIdentity(req);
  const caller = getUserById(db, identity.user_id);
  if (caller?.status === "active" && caller.kind === "human"
      && (identity.method === "api_token" || identity.method === "local_os_user"
        || isLocalHumanRequest(req))) {
    return { publisherUserId: caller.id, kind: "human", operator: isOperator(db, identity) };
  }
  if (localAgent(db, req)) {
    return { publisherUserId: caller!.id, kind: "agent", operator: false };
  }
  if (caller?.status === "active" && caller.kind === "human"
      && req.body && typeof req.body === "object" && !Array.isArray(req.body)
      && "sharing_reason" in req.body) {
    throw new ClientAuthzError(403, "briefing_collection_sharing_credential_required",
      "Intentional cross-collection sharing requires a durable API token.");
  }
  const publisher = requireDurableAgentPublisher(db, req, messages);
  return { publisherUserId: publisher.userId, kind: "agent", operator: false };
}

function configuredHumanOperator(db: Db, code: string, message: string) {
  const operator = getOperator(db);
  if (!operator || operator.status !== "active" || operator.kind !== "human") {
    throw new ClientAuthzError(403, code, message);
  }
  return operator;
}

function destinationPrincipal(db: Db, req: RequestLike) {
  if (localAgent(db, req)) {
    throw new ClientAuthzError(403, "briefing_destination_route_credential_required",
      "Briefing destination receipts require a durable API token.");
  }
  const principal = publicationPrincipal(db, req, {
    credentialCode: "briefing_destination_route_credential_required",
    credentialMessage: "Agent destination writes require a durable API token.",
    agentCode: "briefing_destination_actor_required",
    agentMessage: "Destination writes require an active agent or the configured operator.",
  });
  if (principal.kind === "human" && !principal.operator) {
    throw new ClientAuthzError(403, "briefing_destination_actor_required",
      "Destination writes require an active agent or the configured operator.");
  }
  return { userId: principal.publisherUserId, credentialId: req.client_identity?.credential_id ?? null };
}

function artifactPublisherAccess(db: Db, req: RequestLike, artifactId: string): void {
  const scope = resolveArtifactProject(db, artifactId);
  if (!scope.ok && scope.reason !== "unassociated") {
    throw new BriefingStoreError("Artifact project ownership is ambiguous", 409, "ambiguous_project");
  }
  if (scope.ok) requireProjectAccess(db, req, scope.project_id, "write");
  const current = getArtifactCurrentSource(db, artifactId);
  for (const project of artifactRequiredProjects(db, artifactId, current?.source ?? null)) {
    requireProjectAccess(db, req, project, "write");
  }
}

function artifactProjectForWrite(db: Db, req: RequestLike, artifactRef: string):
  { logicalArtifactId: string; projectId: string } {
  const resolved = resolveArtifactIdentity(db, artifactRef, "strict-read");
  if (resolved.status !== "resolved" || resolved.target_type !== "artifact" || !resolved.target_id) {
    throw new BriefingStoreError("Provide one exact logical Artifact ref", 404, "artifact_not_found");
  }
  const scope = resolveArtifactProject(db, resolved.target_id);
  if (!scope.ok) throw new BriefingStoreError(
    scope.reason === "unassociated"
      ? "Associate this logical Artifact with one canonical project before changing its destination"
      : "Logical Artifact project ownership is ambiguous", 409, "briefing_destination_project_unresolved",
    { logical_artifact_id: resolved.target_id, reason: scope.reason });
  requireProjectAccess(db, req, scope.project_id, "write");
  return { logicalArtifactId: resolved.target_id, projectId: scope.project_id };
}

function routeProjectsForWrite(db: Db, req: RequestLike, manifest: ReturnType<typeof parseBriefingDestinationRouteManifest>) {
  return manifest.routes.map((route) => artifactProjectForWrite(db, req, route.logical_artifact_ref));
}

function renameViewer(
  db: Db,
  req: RequestLike,
  subject: "Briefing" | "Briefing bundle" | "Briefing group",
): { userId: string; operator: true } {
  const prefix = subject === "Briefing" ? "briefing_title"
    : subject === "Briefing bundle" ? "briefing_bundle_name" : "briefing_group_name";
  const principal = publicationPrincipal(db, req, {
    credentialCode: `${prefix}_publisher_credential_required`,
    credentialMessage: `${subject} renames by an agent require a durable API token, not a session credential.`,
    agentCode: `${prefix}_publisher_agent_required`,
    agentMessage: `${subject} renames by an agent require an active agent identity.`,
  });
  if (principal.kind === "human") {
    if (!principal.operator) {
      throw new ClientAuthzError(403, `${prefix}_operator_required`,
        `${subject} renames require the configured human operator or a durable agent publisher.`);
    }
    return { userId: principal.publisherUserId, operator: true };
  }
  return { userId: configuredHumanOperator(
    db,
    `${prefix}_operator_required`,
    `${subject} renames by an agent require a configured active human operator.`,
  ).id, operator: true };
}

function groupUpdateViewer(db: Db, req: RequestLike): { userId: string; operator: true } {
  const principal = publicationPrincipal(db, req, {
    credentialCode: "briefing_group_update_publisher_credential_required",
    credentialMessage: "Agent Briefing group updates require a durable API token.",
    agentCode: "briefing_group_update_publisher_agent_required",
    agentMessage: "Briefing group updates require an active agent identity.",
  });
  if (principal.kind === "human") {
    if (!principal.operator) {
      throw new ClientAuthzError(403, "briefing_group_update_operator_required",
        "Briefing group updates require the configured human operator or a durable agent publisher.");
    }
    return { userId: principal.publisherUserId, operator: true };
  }
  return { userId: configuredHumanOperator(db, "briefing_group_update_operator_required",
    "Briefing group updates by an agent require a configured active human operator.").id, operator: true };
}

function humanReviewOperator(db: Db, req: RequestLike) {
  const identity = requireIdentity(req);
  if (identity.method !== "api_token") {
    throw new ClientAuthzError(403, "briefing_group_review_credential_required",
      "Briefing proposal disposition requires the configured human operator's durable API token.");
  }
  const caller = getUserById(db, identity.user_id);
  if (!caller || caller.status !== "active" || caller.kind !== "human" || !isOperator(db, identity)) {
    throw new ClientAuthzError(403, "briefing_group_review_operator_required",
      "Only the configured active human operator may accept or reject a Briefing proposal.");
  }
  return {
    actor: { userId: caller.id, evidenceMethod: "api_token" as const, credentialId: identity.credential_id },
    viewer: { userId: caller.id, operator: true as const, humanReviewOperator: true as const },
  };
}

function destinationChanges(value: unknown): BriefingGroupDestinationChangeInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new BriefingStoreError("destination_changes must be an array");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new BriefingStoreError(`destination_changes[${index}] must be an object`);
    }
    const item = entry as Record<string, unknown>;
    const unexpected = Object.keys(item).filter((key) => key !== "logical_artifact_ref" && key !== "expected_group_ref");
    if (unexpected.length) throw new BriefingStoreError(
      `destination_changes[${index}] contains unsupported field '${unexpected[0]}'`,
    );
    if (typeof item.logical_artifact_ref !== "string" || !item.logical_artifact_ref.trim()) {
      throw new BriefingStoreError(`destination_changes[${index}].logical_artifact_ref must be nonblank`);
    }
    if (item.expected_group_ref !== null
        && (typeof item.expected_group_ref !== "string" || !item.expected_group_ref.trim())) {
      throw new BriefingStoreError(`destination_changes[${index}].expected_group_ref must be nonblank or null`);
    }
    return { logicalArtifactRef: item.logical_artifact_ref,
      expectedGroupRef: item.expected_group_ref as string | null };
  });
}

function briefingOrganizationViewer(db: Db, req: RequestLike): { userId: string; operator: true } {
  const principal = publicationPrincipal(db, req, {
    credentialCode: "briefing_organization_publisher_credential_required",
    credentialMessage: "Agent Briefing Archive and Restore require a durable API token.",
    agentCode: "briefing_organization_publisher_agent_required",
    agentMessage: "Briefing Archive and Restore require an active agent identity.",
  });
  if (principal.kind === "human") {
    if (!principal.operator) {
      throw new ClientAuthzError(403, "briefing_organization_operator_required",
        "Briefing Archive and Restore require the configured human operator or a durable agent publisher.");
    }
    return { userId: principal.publisherUserId, operator: true };
  }
  return { userId: configuredHumanOperator(db, "briefing_organization_operator_required",
    "Briefing Archive and Restore by an agent require a configured active human operator.").id, operator: true };
}

function bundleMembershipViewer(db: Db, req: RequestLike): { userId: string; operator: true } {
  const principal = publicationPrincipal(db, req, {
    credentialCode: "briefing_bundle_membership_publisher_credential_required",
    credentialMessage: "Agent Briefing bundle membership replacement requires a durable API token.",
    agentCode: "briefing_bundle_membership_publisher_agent_required",
    agentMessage: "Briefing bundle membership replacement requires an active agent identity.",
  });
  if (principal.kind === "human") {
    if (!principal.operator) {
      throw new ClientAuthzError(
        403,
        "briefing_bundle_membership_operator_required",
        "Briefing bundle membership replacement requires the configured human operator or a durable agent publisher.",
      );
    }
    return { userId: principal.publisherUserId, operator: true };
  }
  return { userId: configuredHumanOperator(
    db,
    "briefing_bundle_membership_operator_required",
    "Briefing bundle membership replacement by an agent requires a configured active human operator.",
  ).id, operator: true };
}

function briefingLayoutViewer(db: Db, req: RequestLike): {
  userId: string; operator: boolean; humanReviewOperator: boolean;
} {
  const identity = requireIdentity(req);
  const socketAgent = localAgent(db, req);
  if (identity.method === "local_socket" && !isLocalHumanRequest(req) && !socketAgent) {
    throw new ClientAuthzError(403, "briefing_layout_operator_required",
      "Operator-visible Briefing layout reads require an authenticated publisher.");
  }
  const caller = getUserById(db, identity.user_id);
  if ((identity.method === "api_token" || socketAgent)
      && caller?.status === "active" && caller.kind === "agent") {
    if (!socketAgent) requireDurableAgentPublisher(db, req, {
      credentialCode: "briefing_layout_publisher_credential_required",
      credentialMessage: "Operator-visible Briefing layout reads require a durable API token.",
      agentCode: "briefing_layout_publisher_agent_required",
      agentMessage: "Operator-visible Briefing layout reads require an active agent identity.",
    });
    return { userId: configuredHumanOperator(
      db,
      "briefing_layout_operator_required",
      "Operator-visible Briefing layout reads require a configured active human operator.",
    ).id, operator: true, humanReviewOperator: false };
  }
  const operator = isOperator(db, identity);
  return {
    userId: identity.user_id,
    operator,
    humanReviewOperator: identity.method === "api_token"
      && caller?.status === "active" && caller.kind === "human" && operator,
  };
}

export function briefingReadViewer(db: Db, req: RequestLike) {
  if (!localAgent(db, req)) {
    const actor = activeHuman(db, req);
    return { userId: actor.user.id, operator: actor.operator, projectScoped: false };
  }
  const operator = configuredHumanOperator(db, "briefing_layout_operator_required",
    "Agent Briefing reads require a configured active human responder.");
  return { userId: operator.id, operator: true, projectScoped: true };
}

function agentMayReadBriefing(db: Db, req: RequestLike, artifactId: string | null): boolean {
  if (!artifactId) return false;
  const scope = resolveArtifactProject(db, artifactId);
  if (!scope.ok) return false;
  return evaluateProjectAccess(db, { identity: req.client_identity ?? null,
    project_id: scope.project_id, required_role: "read" }).allowed;
}

function publicationPrincipalAndResponder(db: Db, req: RequestLike): {
  publisherUserId: string;
  responderUserId: string;
  operator: boolean;
  evidenceMethod: "api_token" | "local_default" | "session_claim";
  credentialId: string | null;
} {
  const identity = requireIdentity(req);
  const publisher = publicationPrincipal(db, req, {
    credentialCode: "briefing_publisher_credential_required",
    credentialMessage: "Exact-version Briefing publication requires a durable API token, not a session credential.",
    agentCode: "briefing_publisher_agent_required",
    agentMessage: "Exact-version Briefing publication requires an active agent identity.",
  });
  if (publisher.kind === "human") {
    return {
      publisherUserId: publisher.publisherUserId,
      responderUserId: publisher.publisherUserId,
      operator: publisher.operator,
      evidenceMethod: identity.method === "api_token" ? "api_token" : "local_default",
      credentialId: identity.credential_id,
    };
  }
  const operator = configuredHumanOperator(
    db,
    "briefing_publication_operator_required",
    "Exact-version Briefing publication by an agent requires a configured active human operator responder.",
  );
  return {
    publisherUserId: publisher.publisherUserId,
    responderUserId: operator.id,
    operator: true,
    evidenceMethod: identity.method === "api_token" ? "api_token" : "session_claim",
    credentialId: identity.credential_id,
  };
}

function body(req: RequestLike): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new BriefingStoreError("request body must be an object");
  }
  return req.body as Record<string, unknown>;
}

function placementOverride(req: RequestLike, requestBody: Record<string, unknown>, actorUserId: string) {
  if (requestBody.sharing_reason === undefined) return undefined;
  const identity = requireIdentity(req);
  if (identity.method !== "api_token") {
    throw new ClientAuthzError(403, "briefing_collection_sharing_credential_required",
      "Intentional cross-collection sharing requires a durable API token.");
  }
  if (typeof requestBody.sharing_reason !== "string" || !requestBody.sharing_reason.trim()) {
    throw new BriefingStoreError("sharing_reason must be a nonblank string");
  }
  return { reason: requestBody.sharing_reason, actorUserId,
    evidenceMethod: identity.method, credentialId: identity.credential_id };
}

/** Canonical plural Briefing API. Singular /api/briefing and /api/asks do not exist. */
export function registerBriefingRoutes(server: RouteRegistrar, db: Db, reader: LedgerReader): void {
  server.get("/api/briefing-destination-routes", (req, res) => {
    try {
      destinationPrincipal(db, req);
      const routes = [] as ReturnType<typeof inspectBriefingDestinationRoutes>["routes"];
      let omittedCount = 0;
      let unresolvedCount = 0;
      for (const route of inspectBriefingDestinationRoutes(db).routes) {
        const scope = resolveArtifactProject(db, route.logical_artifact_id);
        if (!scope.ok) { unresolvedCount++; continue; }
        if (!evaluateProjectAccess(db, { identity: req.client_identity ?? null,
          project_id: scope.project_id, required_role: "write" }).allowed) { omittedCount++; continue; }
        routes.push(route);
      }
      sendJson(res, 200, { routes, omitted_count: omittedCount, unresolved_count: unresolvedCount });
    } catch (error) { handleError(res, error); }
  }, { operation: { id: "get:/api/briefing-destination-routes", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.get("/api/briefing-destination-routes/:routeKey", (req, res) => {
    try {
      destinationPrincipal(db, req);
      const route = inspectBriefingDestinationRoutes(db, req.params.routeKey);
      for (const entry of route.routes) artifactProjectForWrite(db, req, entry.logical_artifact_id);
      sendJson(res, 200, route);
    } catch (error) { handleError(res, error); }
  }, { operation: { id: "get:/api/briefing-destination-routes/:routeKey", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.post("/api/briefing-destination-routes/plan", (req, res) => {
    try {
      destinationPrincipal(db, req);
      const manifest = parseBriefingDestinationRouteManifest(req.body);
      routeProjectsForWrite(db, req, manifest);
      sendJson(res, 200, planBriefingDestinationRoutes(db, manifest));
    } catch (error) { handleError(res, error); }
  }, { operation: { id: "post:/api/briefing-destination-routes/plan", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.post("/api/briefing-destination-routes", (req, res) => {
    try {
      const actor = destinationPrincipal(db, req);
      const manifest = parseBriefingDestinationRouteManifest(req.body);
      const scopes = routeProjectsForWrite(db, req, manifest);
      const scopeByArtifact = new Map(scopes.map((scope) => [scope.logicalArtifactId, scope.projectId]));
      const result = db.transaction(() => {
        const before = new Map(inspectBriefingDestinationRoutes(db).routes.map((route) => [route.route_key, route]));
        const plan = reconcileBriefingDestinationRoutes(db, manifest);
        const after = new Map(inspectBriefingDestinationRoutes(db).routes.map((route) => [route.route_key, route]));
        if (plan.changed) for (const route of plan.routes) {
          if (route.action === "unchanged") continue;
          const id = randomUUID();
          db.prepare(`INSERT INTO briefing_destination_mutations
            (id, operation_key, operation_kind, request_digest, logical_artifact_id, project_id,
             actor_user_id, credential_id, before_json, after_json, created_at)
            VALUES (?, ?, 'route', ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, id,
            createHash("sha256").update(canonicalJson(route)).digest("hex"),
            route.logical_artifact_id, scopeByArtifact.get(route.logical_artifact_id), actor.userId, actor.credentialId,
            canonicalJson(before.get(route.route_key) ?? null), canonicalJson(after.get(route.route_key) ?? null), Date.now());
        }
        return plan;
      }).immediate();
      if (result.changed) for (const route of result.routes) {
        if (route.action !== "unchanged") broadcast(BRIEFING_EVENTS.groupConfigurationUpdated,
          { group_id: route.group_id });
      }
      sendJson(res, 200, result);
    } catch (error) { handleError(res, error); }
  }, { operation: { id: "post:/api/briefing-destination-routes", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "allow" });

  server.post("/api/briefing-groups/:groupId/report-placement", (req, res) => {
    try {
      const actor = destinationPrincipal(db, req);
      const requestBody = body(req);
      const allowed = ["operation_key", "logical_artifact_ref", "briefing_ref",
        "expected_owner_group_ref", "expected_target_base_ref", "expected_source_base_ref", "route"];
      const unexpected = Object.keys(requestBody).find((key) => !allowed.includes(key));
      if (unexpected) throw new BriefingStoreError(`request body contains unsupported field '${unexpected}'`);
      const artifactRef = typeof requestBody.logical_artifact_ref === "string" ? requestBody.logical_artifact_ref : "";
      const scope = artifactProjectForWrite(db, req, artifactRef);
      const route = requestBody.route === undefined ? undefined : parseBriefingDestinationRouteManifest({
        schema: "mandible-briefing-destination-routes@3", routes: [requestBody.route],
      });
      const viewer = { userId: configuredHumanOperator(db, "briefing_group_update_operator_required",
        "Briefing placement requires a configured human recipient.").id, operator: true as const };
      const result = placeBriefingReport(db, {
        operationKey: typeof requestBody.operation_key === "string" ? requestBody.operation_key : "",
        logicalArtifactRef: artifactRef,
        briefingRef: typeof requestBody.briefing_ref === "string" ? requestBody.briefing_ref : "",
        groupRef: req.params.groupId,
        expectedOwnerGroupRef: typeof requestBody.expected_owner_group_ref === "string"
          ? requestBody.expected_owner_group_ref : null,
        expectedTargetBaseRef: typeof requestBody.expected_target_base_ref === "string"
          ? requestBody.expected_target_base_ref : null,
        expectedSourceBaseRef: typeof requestBody.expected_source_base_ref === "string"
          ? requestBody.expected_source_base_ref : null,
        routeManifest: route,
      }, { userId: actor.userId, credentialId: actor.credentialId, projectId: scope.projectId }, viewer);
      if (result.changed) {
        broadcast(BRIEFING_EVENTS.groupConfigurationUpdated, { group_id: result.group_id });
        if (result.source_group_id) broadcast(BRIEFING_EVENTS.groupConfigurationUpdated,
          { group_id: result.source_group_id });
      }
      sendJson(res, 200, result);
    } catch (error) { handleError(res, error); }
  }, { operation: { id: "post:/api/briefing-groups/:groupId/report-placement", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "allow" });

  server.post("/api/briefings/:briefingId/report-rounds", (req, res) => {
    try {
      const actor = destinationPrincipal(db, req);
      const briefingId = resolveBriefingId(db, req.params.briefingId, {
        userId: configuredHumanOperator(db, "briefing_publication_operator_required",
          "Report publication requires a configured human recipient.").id, operator: true,
      });
      const requestBody = body(req);
      const allowed = ["operation_key", "artifact_version_ref", "expected_current_round_id",
        "expected_current_artifact_version_ref"];
      const unexpected = Object.keys(requestBody).find((key) => !allowed.includes(key));
      if (unexpected) throw new BriefingStoreError(`request body contains unsupported field '${unexpected}'`);
      const briefing = db.prepare("SELECT logical_artifact_id FROM briefings WHERE id = ? AND archived_at IS NULL")
        .get(briefingId) as { logical_artifact_id: string | null } | undefined;
      if (!briefing?.logical_artifact_id) throw new BriefingStoreError("Report Briefing not found", 404, "not_found");
      const scope = artifactProjectForWrite(db, req, briefing.logical_artifact_id);
      const published = db.prepare(`SELECT 1 FROM briefing_destination_routes route
        JOIN briefing_destination_policies policy ON policy.route_key = route.route_key
        JOIN briefing_destination_owners owner ON owner.logical_artifact_id = route.logical_artifact_id
        WHERE route.logical_artifact_id = ? AND policy.publication_mode = 'published-report' LIMIT 1`)
        .get(scope.logicalArtifactId);
      if (!published) throw new BriefingStoreError("Briefing has no published-report destination route", 409,
        "briefing_report_route_required");
      const operationKey = typeof requestBody.operation_key === "string" ? requestBody.operation_key.trim() : "";
      if (!operationKey) throw new BriefingStoreError("operation_key must be nonblank");
      const versionRef = typeof requestBody.artifact_version_ref === "string" ? requestBody.artifact_version_ref : "";
      const expectedRound = typeof requestBody.expected_current_round_id === "string"
        ? requestBody.expected_current_round_id : "";
      const expectedVersion = typeof requestBody.expected_current_artifact_version_ref === "string"
        ? requestBody.expected_current_artifact_version_ref : "";
      const newVersion = resolveArtifactIdentity(db, versionRef, "strict-read");
      const oldVersion = resolveArtifactIdentity(db, expectedVersion, "strict-read");
      if (newVersion.status === "resolved" && oldVersion.status === "resolved"
          && newVersion.target_type === "artifact_version" && oldVersion.target_type === "artifact_version"
          && newVersion.target_id === oldVersion.target_id) throw new BriefingStoreError(
        "Report Current already uses this exact Artifact version", 409, "briefing_report_unchanged_version");
      const digest = createHash("sha256").update(canonicalJson({ briefing_id: briefingId,
        artifact_version_ref: versionRef, expected_current_round_id: expectedRound,
        expected_current_artifact_version_ref: expectedVersion })).digest("hex");
      const result = db.transaction(() => {
        const replay = db.prepare(`SELECT id, request_digest, after_json FROM briefing_destination_mutations
          WHERE operation_kind = 'report_round' AND actor_user_id = ? AND operation_key = ?`)
          .get(actor.userId, operationKey) as { id: string; request_digest: string; after_json: string } | undefined;
        if (replay) {
          if (replay.request_digest !== digest) throw new BriefingStoreError(
            "operation_key was already used with different report content", 409, "briefing_destination_replay_conflict");
          return { ...JSON.parse(replay.after_json) as Record<string, unknown>, changed: false };
        }
        const responders = (db.prepare("SELECT user_id FROM briefing_members WHERE briefing_id = ? ORDER BY user_id")
          .all(briefingId) as Array<{ user_id: string }>).map((row) => row.user_id);
        const current = db.prepare("SELECT latest_round_id FROM briefings WHERE id = ?")
          .get(briefingId) as { latest_round_id: string };
        const result = publishBriefingReportRound(db, { briefing_id: briefingId,
          artifact_version_ref: versionRef, expected_current_round_id: expectedRound,
          expected_current_artifact_version_ref: expectedVersion, responder_user_ids: responders });
        const receiptId = randomUUID();
        const after = { ...result, changed: true, receipt_id: receiptId };
        db.prepare(`INSERT INTO briefing_destination_mutations
          (id, operation_key, operation_kind, request_digest, logical_artifact_id, project_id,
           actor_user_id, credential_id, before_json, after_json, created_at)
          VALUES (?, ?, 'report_round', ?, ?, ?, ?, ?, ?, ?, ?)`).run(receiptId, operationKey,
          digest, scope.logicalArtifactId, scope.projectId, actor.userId, actor.credentialId,
          canonicalJson({ current_round_id: current.latest_round_id }), canonicalJson(after), Date.now());
        return after;
      }).immediate();
      if (result.changed && "round_id" in result) broadcast(BRIEFING_EVENTS.roundPublished, {
        briefing_id: briefingId, round_id: result.round_id });
      sendJson(res, 200, result);
    } catch (error) { handleError(res, error); }
  }, { operation: { id: "post:/api/briefings/:briefingId/report-rounds", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "allow",
    refs: { body: { expected_current_round_id: entityRefs.briefingRound } } });

  server.post("/api/briefing-groups", (req, res) => {
    try {
      const publisher = publicationPrincipal(db, req, {
        credentialCode: "briefing_group_publisher_credential_required",
        credentialMessage: "Briefing group publication requires a durable API token, not a session credential.",
        agentCode: "briefing_group_publisher_agent_required",
        agentMessage: "Briefing group publication requires an active agent identity.",
      });
      const viewer = publisher.kind === "human"
        ? { userId: publisher.publisherUserId, operator: publisher.operator }
        : { userId: configuredHumanOperator(db, "briefing_group_publication_operator_required",
          "Briefing group publication by an agent requires a configured active human operator.").id, operator: true };
      const requestBody = body(req);
      const unexpected = Object.keys(requestBody)
        .filter((key) => key !== "key" && key !== "name" && key !== "current_bundle_ref"
          && key !== "bundle_refs" && key !== "sharing_reason");
      if (unexpected.length) throw new BriefingStoreError(`request body contains unsupported field '${unexpected[0]}'`);
      if (requestBody.current_bundle_ref !== undefined && requestBody.current_bundle_ref !== null
          && (typeof requestBody.current_bundle_ref !== "string" || !requestBody.current_bundle_ref.trim())) {
        throw new BriefingStoreError("current_bundle_ref must be a nonblank Briefing bundle ref or null");
      }
      const group = createBriefingGroup(db, { key: typeof requestBody.key === "string" ? requestBody.key : "",
        name: typeof requestBody.name === "string" ? requestBody.name : "",
        currentBundleRef: requestBody.current_bundle_ref as string | null | undefined,
        bundleRefs: requestBody.bundle_refs as string[], viewer,
        placementOverride: placementOverride(req, requestBody, publisher.publisherUserId) });
      broadcast(BRIEFING_EVENTS.groupCreated, { group_id: group.id });
      sendJson(res, 201, { group });
    } catch (error) { handleError(res, error); }
  }, { operation: { id: "post:/api/briefing-groups", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "allow" });

  server.put("/api/briefing-groups/:groupId/configuration", (req, res) => {
    try {
      const viewer = groupUpdateViewer(db, req);
      const requestBody = body(req);
      const unexpected = Object.keys(requestBody)
        .filter((key) => key !== "current_bundle_ref" && key !== "bundle_refs" && key !== "sharing_reason");
      if (unexpected.length) throw new BriefingStoreError(`request body contains unsupported field '${unexpected[0]}'`);
      if (!Object.hasOwn(requestBody, "current_bundle_ref") || !Object.hasOwn(requestBody, "bundle_refs")) {
        throw new BriefingStoreError("configuration requires current_bundle_ref and bundle_refs");
      }
      if (requestBody.current_bundle_ref !== null
          && (typeof requestBody.current_bundle_ref !== "string" || !requestBody.current_bundle_ref.trim())) {
        throw new BriefingStoreError("current_bundle_ref must be a nonblank Briefing bundle ref or null");
      }
      if (!Array.isArray(requestBody.bundle_refs)
          || !requestBody.bundle_refs.every((ref) => typeof ref === "string" && ref.trim())) {
        throw new BriefingStoreError("bundle_refs must be an array of nonblank Briefing bundle refs");
      }
      const result = configureBriefingGroup(db, req.params.groupId, {
        currentBundleRef: requestBody.current_bundle_ref as string | null,
        bundleRefs: requestBody.bundle_refs,
        placementOverride: placementOverride(req, requestBody, requireIdentity(req).user_id),
      }, viewer);
      if (result.changed) broadcast(BRIEFING_EVENTS.groupConfigurationUpdated, { group_id: result.group.id });
      sendJson(res, 200, result);
    } catch (error) { handleError(res, error); }
  }, { operation: { id: "put:/api/briefing-groups/:groupId/configuration", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "allow" });

  server.post("/api/briefing-groups/:groupId/updates", (req, res) => {
    try {
      const viewer = groupUpdateViewer(db, req);
      const requestBody = body(req);
      const unexpected = Object.keys(requestBody).filter((key) => key !== "bundle_ref" && key !== "sharing_reason");
      if (unexpected.length) throw new BriefingStoreError(`request body contains unsupported field '${unexpected[0]}'`);
      const result = addBriefingGroupUpdate(db, req.params.groupId,
        typeof requestBody.bundle_ref === "string" ? requestBody.bundle_ref : "", viewer, Date.now(),
        placementOverride(req, requestBody, requireIdentity(req).user_id));
      if (result.added) broadcast(BRIEFING_EVENTS.groupUpdateAdded, {
        group_id: result.group.id, bundle_id: result.group.updates.at(-1)?.id,
      });
      sendJson(res, 200, result);
    } catch (error) { handleError(res, error); }
  }, { operation: { id: "post:/api/briefing-groups/:groupId/updates", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "allow" });

  server.post("/api/briefing-groups/:groupId/promotions/apply", (req, res) => {
    try {
      const viewer = groupUpdateViewer(db, req);
      const requestBody = body(req);
      const allowed = ["expected_base_bundle_ref", "proposal_bundle_ref", "auth_request_ref", "merge_head_sha"];
      const unexpected = Object.keys(requestBody).filter((key) => !allowed.includes(key));
      if (unexpected.length) throw new BriefingStoreError(`request body contains unsupported field '${unexpected[0]}'`);
      const result = promoteBriefingGroupProposal(db, {
        groupRef: req.params.groupId,
        expectedBaseBundleRef: typeof requestBody.expected_base_bundle_ref === "string"
          ? requestBody.expected_base_bundle_ref : "",
        proposalBundleRef: typeof requestBody.proposal_bundle_ref === "string"
          ? requestBody.proposal_bundle_ref : "",
        authRequestRef: typeof requestBody.auth_request_ref === "string" ? requestBody.auth_request_ref : "",
        mergeHeadSha: typeof requestBody.merge_head_sha === "string" ? requestBody.merge_head_sha : "",
      }, viewer);
      if (result.changed) broadcast(BRIEFING_EVENTS.groupProposalPromoted, {
        group_id: result.group.id,
        proposal_bundle_id: result.disposition.proposal.id,
        prior_base_bundle_id: result.disposition.prior_base?.id ?? null,
      });
      sendJson(res, 200, result);
    } catch (error) { handleError(res, error); }
  }, { operation: { id: "post:/api/briefing-groups/:groupId/promotions/apply", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "allow" });

  server.post("/api/briefing-groups/:groupId/review-dispositions", (req, res) => {
    try {
      const principal = humanReviewOperator(db, req);
      const requestBody = body(req);
      const allowed = ["decision", "expected_base_bundle_ref", "proposal_bundle_ref", "binding_digest",
        "destination_changes"];
      const unexpected = Object.keys(requestBody).filter((key) => !allowed.includes(key));
      if (unexpected.length) throw new BriefingStoreError(`request body contains unsupported field '${unexpected[0]}'`);
      if (requestBody.decision !== "accepted" && requestBody.decision !== "rejected") {
        throw new BriefingStoreError("decision must be 'accepted' or 'rejected'");
      }
      const result = dispositionBriefingGroupProposalByHumanReview(db, {
        groupRef: req.params.groupId,
        expectedBaseBundleRef: typeof requestBody.expected_base_bundle_ref === "string"
          ? requestBody.expected_base_bundle_ref : "",
        proposalBundleRef: typeof requestBody.proposal_bundle_ref === "string"
          ? requestBody.proposal_bundle_ref : "",
        decision: requestBody.decision,
        bindingDigest: typeof requestBody.binding_digest === "string" ? requestBody.binding_digest : "",
        destinationChanges: destinationChanges(requestBody.destination_changes),
      }, principal.actor, principal.viewer);
      if (result.changed) broadcast(result.disposition.kind === "accepted"
        ? BRIEFING_EVENTS.groupProposalAccepted : BRIEFING_EVENTS.groupProposalRejected, {
        group_id: result.group.id,
        proposal_bundle_id: result.disposition.proposal.id,
        prior_base_bundle_id: result.disposition.prior_base?.id ?? null,
        review_binding_digest: result.disposition.review_binding_digest,
      });
      sendJson(res, 200, result);
    } catch (error) { handleError(res, error); }
  }, { operation: { id: "post:/api/briefing-groups/:groupId/review-dispositions", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "allow" });

  server.post("/api/briefing-groups/:groupId/review-candidates", (req, res) => {
    try {
      const principal = humanReviewOperator(db, req);
      const requestBody = body(req);
      const allowed = ["expected_base_bundle_ref", "proposal_bundle_ref", "destination_changes"];
      const unexpected = Object.keys(requestBody).filter((key) => !allowed.includes(key));
      if (unexpected.length) throw new BriefingStoreError(`request body contains unsupported field '${unexpected[0]}'`);
      const candidate = previewBriefingGroupReviewCandidate(db, {
        groupRef: req.params.groupId,
        expectedBaseBundleRef: typeof requestBody.expected_base_bundle_ref === "string"
          ? requestBody.expected_base_bundle_ref : "",
        proposalBundleRef: typeof requestBody.proposal_bundle_ref === "string"
          ? requestBody.proposal_bundle_ref : "",
        destinationChanges: destinationChanges(requestBody.destination_changes),
      }, principal.actor.userId);
      sendJson(res, 200, { candidate });
    } catch (error) { handleError(res, error); }
  }, { operation: { id: "post:/api/briefing-groups/:groupId/review-candidates", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "allow" });

  server.post("/api/briefing-groups/:groupId/destinations", (req, res) => {
    try {
      const principal = humanReviewOperator(db, req);
      const requestBody = body(req);
      const unexpected = Object.keys(requestBody).filter((key) => key !== "logical_artifact_ref");
      if (unexpected.length) throw new BriefingStoreError(`request body contains unsupported field '${unexpected[0]}'`);
      const result = bindBriefingDestinationOwner(db, {
        groupRef: req.params.groupId,
        logicalArtifactRef: typeof requestBody.logical_artifact_ref === "string"
          ? requestBody.logical_artifact_ref : "",
      }, principal.actor, principal.viewer);
      sendJson(res, result.changed ? 201 : 200, result);
    } catch (error) { handleError(res, error); }
  }, { operation: { id: "post:/api/briefing-groups/:groupId/destinations", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "allow" });

  server.patch("/api/briefing-groups/:groupId", (req, res) => {
    try {
      const viewer = renameViewer(db, req, "Briefing group");
      const requestBody = body(req);
      const unexpected = Object.keys(requestBody).filter((key) => key !== "name");
      if (unexpected.length) throw new BriefingStoreError(`request body contains unsupported field '${unexpected[0]}'`);
      const result = updateBriefingGroupName(db, req.params.groupId, requestBody.name, viewer);
      if (result.changed) broadcast(BRIEFING_EVENTS.groupNameUpdated, { group_id: result.group.id });
      sendJson(res, 200, result);
    } catch (error) { handleError(res, error); }
  }, { operation: { id: "patch:/api/briefing-groups/:groupId", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "allow" });

  const setGroupArchiveState = (archived: boolean) => (req: RequestLike, res: ResponseLike) => {
      try {
        const viewer = briefingOrganizationViewer(db, req);
        const requestBody = body(req);
        if (Object.keys(requestBody).length) throw new BriefingStoreError("request body must be empty");
        const result = setBriefingGroupArchived(db, req.params.groupId, archived, viewer);
        if (result.changed) broadcast(archived ? BRIEFING_EVENTS.groupArchived : BRIEFING_EVENTS.groupRestored,
          { group_id: result.group.id });
        sendJson(res, 200, result);
      } catch (error) { handleError(res, error); }
    };
  server.post("/api/briefing-groups/:groupId/archive", setGroupArchiveState(true), { operation: { id: "post:/api/briefing-groups/:groupId/archive", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "allow" });
  server.post("/api/briefing-groups/:groupId/restore", setGroupArchiveState(false), { operation: { id: "post:/api/briefing-groups/:groupId/restore", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "allow" });

  server.get("/api/briefing-groups", (req, res) => {
    try {
      sendJson(res, 200, { groups: listBriefingGroups(db, briefingLayoutViewer(db, req)) });
    } catch (error) { handleError(res, error); }
  }, { operation: { id: "get:/api/briefing-groups", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.get("/api/briefing-groups/:groupId", (req, res) => {
    try {
      sendJson(res, 200, { group: readBriefingGroup(db, req.params.groupId, briefingLayoutViewer(db, req)) });
    } catch (error) { handleError(res, error); }
  }, { operation: { id: "get:/api/briefing-groups/:groupId", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.post("/api/briefing-bundles", (req, res) => {
    try {
      const publisher = publicationPrincipal(db, req, {
        credentialCode: "briefing_bundle_publisher_credential_required",
        credentialMessage: "Briefing bundle publication requires a durable API token, not a session credential.",
        agentCode: "briefing_bundle_publisher_agent_required",
        agentMessage: "Briefing bundle publication requires an active agent identity.",
      });
      const viewer = publisher.kind === "human"
        ? { userId: publisher.publisherUserId, operator: publisher.operator }
        : { userId: configuredHumanOperator(
          db,
          "briefing_bundle_publication_operator_required",
          "Briefing bundle publication by an agent requires a configured active human operator.",
        ).id, operator: true };
      const requestBody = body(req);
      const unexpected = Object.keys(requestBody).filter((key) => key !== "name" && key !== "briefing_refs" && key !== "sharing_reason");
      if (unexpected.length > 0) {
        throw new BriefingStoreError(`request body contains unsupported field '${unexpected[0]}'`);
      }
      if (!Array.isArray(requestBody.briefing_refs)
          || !requestBody.briefing_refs.every((ref) => typeof ref === "string" && ref.trim())) {
        throw new BriefingStoreError("briefing_refs must be an array of nonblank Briefing refs");
      }
      const bundle = createBriefingBundle(db, {
        name: typeof requestBody.name === "string" ? requestBody.name : "",
        briefingRefs: requestBody.briefing_refs,
        viewer,
        placementOverride: placementOverride(req, requestBody, publisher.publisherUserId),
      });
      broadcast(BRIEFING_EVENTS.bundleCreated, { bundle_id: bundle.id });
      sendJson(res, 201, { bundle });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/briefing-bundles", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "allow" });

  server.post("/api/briefing-bundles/:bundleId/briefings", (req, res) => {
    try {
      const requestBody = body(req);
      const sharing = requestBody.sharing_reason !== undefined;
      const actor = sharing ? null : activeHuman(db, req);
      const viewer = sharing ? bundleMembershipViewer(db, req) : { userId: actor!.user.id, operator: actor!.operator };
      const unexpected = Object.keys(requestBody).filter((key) => key !== "briefing_ref" && key !== "sharing_reason");
      if (unexpected.length > 0) {
        throw new BriefingStoreError(`request body contains unsupported field '${unexpected[0]}'`);
      }
      const result = addBriefingBundleMember(
        db,
        req.params.bundleId,
        typeof requestBody.briefing_ref === "string" ? requestBody.briefing_ref : "",
        viewer,
        Date.now(),
        placementOverride(req, requestBody, requireIdentity(req).user_id),
      );
      if (result.added) broadcast(BRIEFING_EVENTS.bundleMemberAdded, {
        bundle_id: result.bundle.id,
        briefing_id: result.bundle.members.at(-1)?.briefing.id,
      });
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/briefing-bundles/:bundleId/briefings", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "allow" });

  server.patch("/api/briefing-bundles/:bundleId", (req, res) => {
    try {
      const replacesMembership = !!req.body && typeof req.body === "object" && !Array.isArray(req.body)
        && (Object.hasOwn(req.body, "briefing_refs") || Object.hasOwn(req.body, "layout"));
      const viewer = replacesMembership
        ? bundleMembershipViewer(db, req)
        : renameViewer(db, req, "Briefing bundle");
      const requestBody = body(req);
      const unexpected = Object.keys(requestBody)
        .filter((key) => key !== "name" && key !== "briefing_refs" && key !== "layout" && key !== "sharing_reason");
      if (unexpected.length > 0) {
        throw new BriefingStoreError(`request body contains unsupported field '${unexpected[0]}'`);
      }
      if (requestBody.name === undefined && requestBody.briefing_refs === undefined && requestBody.layout === undefined) {
        throw new BriefingStoreError("request body must contain name, briefing_refs, or layout");
      }
      if (requestBody.briefing_refs !== undefined && requestBody.layout !== undefined) {
        throw new BriefingStoreError("request body cannot contain both briefing_refs and layout");
      }
      if (requestBody.sharing_reason !== undefined
          && requestBody.briefing_refs === undefined && requestBody.layout === undefined) {
        throw new BriefingStoreError("sharing_reason requires a bundle membership change");
      }
      if (requestBody.briefing_refs !== undefined
          && (!Array.isArray(requestBody.briefing_refs)
            || !requestBody.briefing_refs.every((ref) => typeof ref === "string" && ref.trim()))) {
        throw new BriefingStoreError("briefing_refs must be an array of nonblank Briefing refs");
      }
      const briefingRefs = requestBody.briefing_refs as readonly string[] | undefined;
      const layout = requestBody.layout;
      const result = db.transaction(() => {
        const renamed = requestBody.name === undefined
          ? { bundle: readBriefingBundle(db, req.params.bundleId, viewer), changed: false }
          : updateBriefingBundleName(db, req.params.bundleId, requestBody.name, viewer);
        const replaced = briefingRefs === undefined && layout === undefined
          ? { bundle: renamed.bundle, changed: false }
          : replaceBriefingBundleLayout(db, req.params.bundleId, { briefingRefs, layout }, viewer, Date.now(),
            placementOverride(req, requestBody, requireIdentity(req).user_id));
        return {
          bundle: replaced.bundle,
          changed: renamed.changed || replaced.changed,
          name_changed: renamed.changed,
          membership_changed: replaced.changed,
          layout_changed: replaced.changed,
        };
      }).immediate();
      if (result.name_changed) broadcast(BRIEFING_EVENTS.bundleNameUpdated, { bundle_id: result.bundle.id });
      if (result.membership_changed) {
        broadcast(BRIEFING_EVENTS.bundleMembersReplaced, { bundle_id: result.bundle.id });
      }
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "patch:/api/briefing-bundles/:bundleId", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "allow" });

  server.delete("/api/briefing-bundles/:bundleId", (req, res) => {
    try {
      renameViewer(db, req, "Briefing bundle");
      const requestBody = req.body === undefined ? {} : body(req);
      const unexpected = Object.keys(requestBody);
      if (unexpected.length > 0) {
        throw new BriefingStoreError(`request body contains unsupported field '${unexpected[0]}'`);
      }
      const result = deleteEmptyBriefingBundle(db, req.params.bundleId);
      broadcast(BRIEFING_EVENTS.bundleDeleted, { bundle_id: result.bundle_id });
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "delete:/api/briefing-bundles/:bundleId", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "allow" });

  server.get("/api/briefing-bundles", (req, res) => {
    try {
      sendJson(res, 200, { bundles: listBriefingBundles(db, briefingLayoutViewer(db, req)) });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/briefing-bundles", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.get("/api/briefing-bundles/:bundleId", (req, res) => {
    try {
      sendJson(res, 200, { bundle: readBriefingBundle(db, req.params.bundleId, briefingLayoutViewer(db, req)) });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/briefing-bundles/:bundleId", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.post("/api/briefings", (req, res) => {
    try {
      const publication = publicationPrincipalAndResponder(db, req);
      const requestBody = body(req);
      const unexpected = Object.keys(requestBody)
        .filter((key) => key !== "artifact_version_ref" && key !== "comparison_base_artifact_version_ref"
          && key !== "target_briefing_ref" && key !== "distinct_reason"
          && key !== "title" && key !== "description");
      if (unexpected.length > 0) {
        throw new BriefingStoreError(`request body contains unsupported field '${unexpected[0]}'`);
      }
      const artifactVersionRef = typeof requestBody.artifact_version_ref === "string"
        ? requestBody.artifact_version_ref.trim() : "";
      const title = typeof requestBody.title === "string" ? requestBody.title.trim() : "";
      const comparisonBaseArtifactVersionRef = requestBody.comparison_base_artifact_version_ref === undefined
        ? null
        : typeof requestBody.comparison_base_artifact_version_ref === "string"
          ? requestBody.comparison_base_artifact_version_ref.trim() : "";
      const targetBriefingRef = requestBody.target_briefing_ref === undefined
        ? null
        : typeof requestBody.target_briefing_ref === "string"
          ? requestBody.target_briefing_ref.trim() : "";
      if (!artifactVersionRef) throw new BriefingStoreError("artifact_version_ref must be a nonblank exact artifact-version ref");
      if (requestBody.comparison_base_artifact_version_ref !== undefined && !comparisonBaseArtifactVersionRef) {
        throw new BriefingStoreError("comparison_base_artifact_version_ref must be a nonblank exact artifact-version ref");
      }
      if (requestBody.target_briefing_ref !== undefined && !targetBriefingRef) {
        throw new BriefingStoreError("target_briefing_ref must be a nonblank Briefing ref");
      }
      if (!title) throw new BriefingStoreError("title must be a nonblank string");
      if (getUserById(db, publication.publisherUserId)?.kind === "agent") {
        const version = resolveArtifactIdentity(db, artifactVersionRef, "strict-read");
        if (version.status !== "resolved" || version.target_type !== "artifact_version" || !version.target_id) {
          throw new BriefingStoreError("Briefing creation requires one exact Artifact version", 404,
            "artifact_version_not_found");
        }
        const logical = db.prepare("SELECT artifact_id FROM artifact_version WHERE id = ?")
          .get(version.target_id) as { artifact_id: string } | undefined;
        if (!logical) throw new BriefingStoreError("Artifact version not found", 404, "artifact_version_not_found");
        artifactProjectForWrite(db, req, logical.artifact_id);
      }
      const result = publishBriefingFromArtifactVersion(db, {
        title,
        ...(Object.hasOwn(requestBody, "description") ? { description: requestBody.description } : {}),
        artifact_version_ref: artifactVersionRef,
        comparison_base_artifact_version_ref: comparisonBaseArtifactVersionRef,
        ...(targetBriefingRef ? { target_briefing_ref: targetBriefingRef } : {}),
        ...(Object.hasOwn(requestBody, "distinct_reason")
          ? { distinct_reason: requestBody.distinct_reason }
          : {}),
        profile: "mandible-briefing.v3",
        responder_user_ids: [publication.responderUserId],
        viewer: { userId: publication.responderUserId, operator: publication.operator },
        creation_provenance: {
          actor_user_id: publication.publisherUserId,
          evidence_method: publication.evidenceMethod,
          credential_id: publication.credentialId,
        },
      });
      if (result.outcome === "active_candidates") {
        sendJson(res, 409, {
          error: "An active Briefing already owns this logical Artifact",
          code: "briefing_active_candidates",
          ...result,
        });
        return;
      }
      if (result.outcome === "created" || result.outcome === "created_distinct") {
        broadcast(BRIEFING_EVENTS.created, { briefing_id: result.briefing_id });
      }
      if (result.outcome !== "round_reused") {
        broadcast(BRIEFING_EVENTS.roundPublished, {
          briefing_id: result.briefing_id,
          round_id: result.round_id,
        });
      }
      sendJson(res, result.outcome === "round_reused" ? 200 : 201, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/briefings", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "allow" });

  server.post("/api/briefings/runs", (req, res) => {
    try {
      requireIdentity(req);
      const publisher = requireDurableAgentPublisher(db, req, {
        credentialCode: "briefing_publisher_credential_required",
        credentialMessage: "Briefing publication requires a durable API token, not a session credential.",
        agentCode: "briefing_publisher_agent_required",
        agentMessage: "Briefing publication requires an agent identity.",
      });
      const schema = req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>).schema : null;
      if (schema === BRIEFING_COMPOSITION_SCHEMA) {
        const request = parseBriefingCompositionRequest(req.body);
        if (!publisherMayIngest(db, publisher.slug, request.task_identity, [request.source_health.source])) {
          throw new ClientAuthzError(403, "source_namespace_forbidden",
            `Identity '${publisher.slug}' is not permitted to publish '${request.task_identity}' to '${request.source_health.source}'.`);
        }
        for (const input of request.inputs) {
          const route = inspectBriefingDestinationRoutes(db, input.route_key);
          for (const entry of route.routes) artifactPublisherAccess(db, req, entry.logical_artifact_id);
        }
        const replayed = Boolean(db.prepare(
          "SELECT 1 FROM briefing_composition_runs WHERE publisher_user_id = ? AND task_identity = ? AND run_key = ?",
        ).get(publisher.userId, request.task_identity, request.run_key));
        const receipt = publishBriefingCompositionRun(db, request, publisher.userId);
        if (!replayed) {
          for (const target of receipt.targets) {
            if (target.outcome === "proposed" && target.proposal_bundle_id) {
              broadcast(BRIEFING_EVENTS.groupUpdateAdded, {
                group_id: target.group_id, bundle_id: target.proposal_bundle_id,
              });
            }
            if (target.publication_mode === "published-report" && target.outcome === "published") {
              broadcast(BRIEFING_EVENTS.roundPublished, {
                briefing_id: target.briefing_id, round_id: target.current_round_id,
              });
            }
          }
        }
        sendJson(res, 200, receipt);
        return;
      }
      const request = parseBriefingRunRequest(req.body);
      if (!publisherMayIngest(db, publisher.slug, request.task_identity, [request.source_health.source])) {
        throw new ClientAuthzError(403, "source_namespace_forbidden",
          `Identity '${publisher.slug}' is not permitted to publish '${request.task_identity}' to '${request.source_health.source}'.`);
      }
      const existing = db.prepare("SELECT logical_artifact_id FROM briefings WHERE briefing_key = ?")
        .get(request.briefing_key) as { logical_artifact_id: string | null } | undefined;
      if (existing?.logical_artifact_id) artifactPublisherAccess(db, req, existing.logical_artifact_id);
      const existed = Boolean(existing);
      const replayed = Boolean(db.prepare(
        "SELECT 1 FROM briefing_runs WHERE publisher_user_id = ? AND task_identity = ? AND run_key = ?",
      ).get(publisher.userId, request.task_identity, request.run_key));
      const receipt = publishBriefingRun(db, request, publisher.userId);
      if (!replayed && !existed) broadcast(BRIEFING_EVENTS.created, { briefing_id: receipt.briefing_id });
      if (!replayed && receipt.round_id) broadcast(BRIEFING_EVENTS.roundPublished, {
        briefing_id: receipt.briefing_id, round_id: receipt.round_id,
      });
      sendJson(res, 200, receipt);
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/briefings/runs", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "allow" });

  server.get("/api/briefings", async (req, res) => {
    try {
      const viewer = briefingReadViewer(db, req);
      sendJson(res, 200, await reader.run("briefings_list", { viewer, identity: req.client_identity ?? null }));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/briefings", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.get("/api/briefings/:briefingId", (req, res) => {
    try {
      const viewer = briefingReadViewer(db, req);
      const values = new URL(req.url, "http://localhost").searchParams.getAll("round");
      const submissionValues = new URL(req.url, "http://localhost").searchParams.getAll("submission");
      const groupValues = new URL(req.url, "http://localhost").searchParams.getAll("group");
      const proposalValues = new URL(req.url, "http://localhost").searchParams.getAll("proposal");
      if (values.length > 1 || (values.length === 1 && !values[0])) {
        throw new BriefingStoreError("round must be one nonblank round id");
      }
      if (submissionValues.length > 1 || (submissionValues.length === 1 && !submissionValues[0])) {
        throw new BriefingStoreError("submission must be one nonblank submission id");
      }
      if (groupValues.length > 1 || (groupValues.length === 1 && !groupValues[0])) {
        throw new BriefingStoreError("group must be one nonblank Briefing group id");
      }
      if (proposalValues.length > 1 || (proposalValues.length === 1 && !proposalValues[0])) {
        throw new BriefingStoreError("proposal must be one nonblank Briefing bundle id");
      }
      if (proposalValues.length > 0 && groupValues.length === 0) {
        throw new BriefingStoreError("proposal display context requires group");
      }
      const projection = readBriefing(db, req.params.briefingId, {
        ...(values[0] ? { roundId: values[0] } : {}),
        ...(submissionValues[0] ? { submissionId: submissionValues[0] } : {}),
        ...(groupValues[0] ? { displayGroup: {
          groupRef: groupValues[0],
          proposalBundleRef: proposalValues[0] ?? null,
        } } : {}),
        actorUserId: viewer.userId,
        operator: viewer.operator,
      });
      if (!projection) throw new BriefingStoreError("briefing not found", 404, "not_found");
      if (viewer.projectScoped && !agentMayReadBriefing(db, req,
        projection.briefing.logical_artifact_id as string | null)) {
        throw new ClientAuthzError(403, "project_permission_required", "Project read permission is required.");
      }
      sendJson(res, 200, projection);
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/briefings/:briefingId", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.patch("/api/briefings/:briefingId", (req, res) => {
    try {
      const viewer = renameViewer(db, req, "Briefing");
      const requestBody = body(req);
      const unexpected = Object.keys(requestBody).filter((key) => key !== "title" && key !== "description");
      if (unexpected.length > 0) {
        throw new BriefingStoreError(`request body contains unsupported field '${unexpected[0]}'`);
      }
      if (!Object.hasOwn(requestBody, "title") && !Object.hasOwn(requestBody, "description")) {
        throw new BriefingStoreError("request body must contain title or description");
      }
      const titleResult = Object.hasOwn(requestBody, "title")
        ? updateBriefingTitle(db, req.params.briefingId, requestBody.title, viewer)
        : null;
      const descriptionResult = Object.hasOwn(requestBody, "description")
        ? updateBriefingDescription(db, req.params.briefingId, requestBody.description, viewer)
        : null;
      const briefingId = titleResult?.briefing_id ?? descriptionResult!.briefing_id;
      if (titleResult?.changed) broadcast(BRIEFING_EVENTS.titleUpdated, { briefing_id: briefingId });
      if (descriptionResult?.changed) broadcast(BRIEFING_EVENTS.descriptionUpdated, { briefing_id: briefingId });
      sendJson(res, 200, {
        briefing_id: briefingId,
        ...(titleResult ? { title: titleResult.title } : {}),
        ...(descriptionResult ? { description: descriptionResult.description } : {}),
        changed: Boolean(titleResult?.changed || descriptionResult?.changed),
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "patch:/api/briefings/:briefingId", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "allow" });

  const setArchiveState = (archived: boolean) => (req: RequestLike, res: ResponseLike) => {
    try {
      const viewer = briefingOrganizationViewer(db, req);
      const requestBody = body(req);
      const unexpected = Object.keys(requestBody);
      if (unexpected.length) throw new BriefingStoreError(`request body contains unsupported field '${unexpected[0]}'`);
      const result = setBriefingArchived(db, req.params.briefingId, archived, viewer);
      if (result.changed) broadcast(archived ? BRIEFING_EVENTS.archived : BRIEFING_EVENTS.restored, {
        briefing_id: result.briefing_id,
      });
      sendJson(res, 200, result);
    } catch (error) { handleError(res, error); }
  };

  server.post("/api/briefings/:briefingId/archive", setArchiveState(true), { operation: { id: "post:/api/briefings/:briefingId/archive", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "allow" });
  server.post("/api/briefings/:briefingId/restore", setArchiveState(false), { operation: { id: "post:/api/briefings/:briefingId/restore", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "allow" });

  server.post("/api/briefings/:briefingId/rounds/:roundId/answers", (req, res) => {
    try {
      const actor = activeHuman(db, req);
      const result = applyBriefingAnswers(db, req.params.briefingId, req.params.roundId,
        actor.user.id, body(req).answers);
      if (result.answer_event_ids.length > 0) {
        broadcast(BRIEFING_EVENTS.answered, { briefing_id: req.params.briefingId, round_id: req.params.roundId });
      }
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/briefings/:briefingId/rounds/:roundId/answers", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "deny" });

  server.post("/api/briefings/:briefingId/rounds/:roundId/annotations", (req, res) => {
    try {
      const actor = activeHuman(db, req);
      const result = applyBriefingAnnotations(db, req.params.briefingId, req.params.roundId,
        actor.user.id, body(req).annotations);
      if (result.annotation_event_ids.length > 0) {
        broadcast(BRIEFING_EVENTS.annotated, { briefing_id: req.params.briefingId, round_id: req.params.roundId });
      }
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/briefings/:briefingId/rounds/:roundId/annotations", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "deny" });

  server.post("/api/briefings/:briefingId/rounds/:roundId/submit", (req, res) => {
    try {
      const actor = activeHuman(db, req);
      const submission = submitBriefingRound(db, req.params.briefingId, req.params.roundId,
        actor.user.id, body(req));
      broadcast(BRIEFING_EVENTS.submitted, { briefing_id: req.params.briefingId,
        round_id: req.params.roundId });
      sendJson(res, 200, submission);
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/briefings/:briefingId/rounds/:roundId/submit", effects: ["ledger:write"], requestSchema: null, reportingCategory: "briefing" }, fileRpc: "deny" });

  server.get("/api/briefings/:briefingId/rounds/:roundId/submissions/:submissionId/export", (req, res) => {
    try {
      const actor = activeHuman(db, req);
      sendJson(res, 200, exportBriefingSubmissionMarkdown(db, req.params.briefingId, req.params.roundId,
        req.params.submissionId, actor.user.id));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/briefings/:briefingId/rounds/:roundId/submissions/:submissionId/export", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });
}
