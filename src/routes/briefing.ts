import { randomUUID } from "node:crypto";

import { ClientAuthzError, isOperator, requireIdentity } from "../client-auth/authz.js";
import { getDb, type Db } from "../db.js";
import {
  applyBriefingAnnotations,
  applyBriefingAnswers,
  BriefingStoreError,
  exportBriefingSubmissionMarkdown,
  listBriefings,
  parseBriefingRunRequest,
  publishBriefingFromArtifactVersion,
  publishBriefingRun,
  readBriefing,
  submitBriefingRound,
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
  listBriefingBundles,
  readBriefingBundle,
  replaceBriefingBundleLayout,
  updateBriefingBundleName,
} from "../feedback/briefing-bundles.js";
import {
  addBriefingGroupUpdate,
  createBriefingGroup,
  listBriefingGroups,
  readBriefingGroup,
  updateBriefingGroupName,
} from "../feedback/briefing-groups.js";
import { requireDurableAgentPublisher } from "./agent-publisher-auth.js";
import { sendJson } from "./http.js";

function handleError(res: ResponseLike, error: unknown): void {
  if (error instanceof ClientAuthzError || error instanceof BriefingStoreError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
}

function activeHuman(db: Db, req: RequestLike) {
  const identity = requireIdentity(req);
  const user = getUserById(db, identity.user_id);
  if (!user || user.status !== "active" || user.kind !== "human") {
    throw new ClientAuthzError(403, "human_responder_required", "Briefing responses require an active human credential.");
  }
  return { identity, user, operator: isOperator(db, identity) };
}

type PublicationPrincipal = {
  publisherUserId: string;
  kind: "human" | "agent";
  operator: boolean;
};

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
  if (caller?.status === "active" && caller.kind === "human") {
    return { publisherUserId: caller.id, kind: "human", operator: isOperator(db, identity) };
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
  const identity = requireIdentity(req);
  if (identity.method !== "api_token") {
    throw new ClientAuthzError(403, "briefing_group_update_publisher_credential_required",
      "Briefing group updates require a durable API token, not a session credential.");
  }
  const caller = getUserById(db, identity.user_id);
  if (caller?.status === "active" && caller.kind === "human") {
    if (!isOperator(db, identity)) {
      throw new ClientAuthzError(403, "briefing_group_update_operator_required",
        "Briefing group updates require the configured human operator or a durable agent publisher.");
    }
    return { userId: caller.id, operator: true };
  }
  requireDurableAgentPublisher(db, req, {
    credentialCode: "briefing_group_update_publisher_credential_required",
    credentialMessage: "Briefing group updates require a durable API token, not a session credential.",
    agentCode: "briefing_group_update_publisher_agent_required",
    agentMessage: "Briefing group updates require an active agent identity.",
  });
  return { userId: configuredHumanOperator(db, "briefing_group_update_operator_required",
    "Briefing group updates by an agent require a configured active human operator.").id, operator: true };
}

function bundleMembershipViewer(db: Db, req: RequestLike): { userId: string; operator: true } {
  const identity = requireIdentity(req);
  if (identity.method !== "api_token") {
    throw new ClientAuthzError(
      403,
      "briefing_bundle_membership_publisher_credential_required",
      "Briefing bundle membership replacement requires a durable API token, not a session credential.",
    );
  }
  const caller = getUserById(db, identity.user_id);
  if (caller?.status === "active" && caller.kind === "human") {
    if (!isOperator(db, identity)) {
      throw new ClientAuthzError(
        403,
        "briefing_bundle_membership_operator_required",
        "Briefing bundle membership replacement requires the configured human operator or a durable agent publisher.",
      );
    }
    return { userId: caller.id, operator: true };
  }
  const publisher = requireDurableAgentPublisher(db, req, {
    credentialCode: "briefing_bundle_membership_publisher_credential_required",
    credentialMessage: "Briefing bundle membership replacement requires a durable API token, not a session credential.",
    agentCode: "briefing_bundle_membership_publisher_agent_required",
    agentMessage: "Briefing bundle membership replacement requires an active agent identity.",
  });
  return { userId: configuredHumanOperator(
    db,
    "briefing_bundle_membership_operator_required",
    "Briefing bundle membership replacement by an agent requires a configured active human operator.",
  ).id, operator: true };
}

function publicationPrincipalAndResponder(db: Db, req: RequestLike): {
  publisherUserId: string;
  responderUserId: string;
} {
  const publisher = publicationPrincipal(db, req, {
    credentialCode: "briefing_publisher_credential_required",
    credentialMessage: "Exact-version Briefing publication requires a durable API token, not a session credential.",
    agentCode: "briefing_publisher_agent_required",
    agentMessage: "Exact-version Briefing publication requires an active agent identity.",
  });
  if (publisher.kind === "human") {
    return { publisherUserId: publisher.publisherUserId, responderUserId: publisher.publisherUserId };
  }
  const operator = configuredHumanOperator(
    db,
    "briefing_publication_operator_required",
    "Exact-version Briefing publication by an agent requires a configured active human operator responder.",
  );
  return { publisherUserId: publisher.publisherUserId, responderUserId: operator.id };
}

function body(req: RequestLike): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new BriefingStoreError("request body must be an object");
  }
  return req.body as Record<string, unknown>;
}

/** Canonical plural Briefing API. Singular /api/briefing and /api/asks do not exist. */
export function registerBriefingRoutes(server: RouteRegistrar, db: Db = getDb()): void {
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
      const unexpected = Object.keys(requestBody).filter((key) => key !== "name" && key !== "bundle_refs");
      if (unexpected.length) throw new BriefingStoreError(`request body contains unsupported field '${unexpected[0]}'`);
      const group = createBriefingGroup(db, { name: typeof requestBody.name === "string" ? requestBody.name : "",
        bundleRefs: requestBody.bundle_refs as string[], viewer });
      broadcast(BRIEFING_EVENTS.groupCreated, { group_id: group.id });
      sendJson(res, 201, { group });
    } catch (error) { handleError(res, error); }
  }, { fileRpc: "allow" });

  server.post("/api/briefing-groups/:groupId/updates", (req, res) => {
    try {
      const viewer = groupUpdateViewer(db, req);
      const requestBody = body(req);
      const unexpected = Object.keys(requestBody).filter((key) => key !== "bundle_ref");
      if (unexpected.length) throw new BriefingStoreError(`request body contains unsupported field '${unexpected[0]}'`);
      const result = addBriefingGroupUpdate(db, req.params.groupId,
        typeof requestBody.bundle_ref === "string" ? requestBody.bundle_ref : "", viewer);
      if (result.added) broadcast(BRIEFING_EVENTS.groupUpdateAdded, {
        group_id: result.group.id, bundle_id: result.group.updates.at(-1)?.id,
      });
      sendJson(res, 200, result);
    } catch (error) { handleError(res, error); }
  }, { fileRpc: "allow" });

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
  }, { fileRpc: "allow" });

  server.get("/api/briefing-groups", (req, res) => {
    try {
      const identity = requireIdentity(req);
      sendJson(res, 200, { groups: listBriefingGroups(db, { userId: identity.user_id,
        operator: isOperator(db, identity) }) });
    } catch (error) { handleError(res, error); }
  }, { fileRpc: "allow" });

  server.get("/api/briefing-groups/:groupId", (req, res) => {
    try {
      const identity = requireIdentity(req);
      sendJson(res, 200, { group: readBriefingGroup(db, req.params.groupId, { userId: identity.user_id,
        operator: isOperator(db, identity) }) });
    } catch (error) { handleError(res, error); }
  }, { fileRpc: "allow" });

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
      const unexpected = Object.keys(requestBody).filter((key) => key !== "name" && key !== "briefing_refs");
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
      });
      broadcast(BRIEFING_EVENTS.bundleCreated, { bundle_id: bundle.id });
      sendJson(res, 201, { bundle });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  server.post("/api/briefing-bundles/:bundleId/briefings", (req, res) => {
    try {
      const actor = activeHuman(db, req);
      const requestBody = body(req);
      const unexpected = Object.keys(requestBody).filter((key) => key !== "briefing_ref");
      if (unexpected.length > 0) {
        throw new BriefingStoreError(`request body contains unsupported field '${unexpected[0]}'`);
      }
      const result = addBriefingBundleMember(
        db,
        req.params.bundleId,
        typeof requestBody.briefing_ref === "string" ? requestBody.briefing_ref : "",
        { userId: actor.user.id, operator: actor.operator },
      );
      if (result.added) broadcast(BRIEFING_EVENTS.bundleMemberAdded, {
        bundle_id: result.bundle.id,
        briefing_id: result.bundle.members.at(-1)?.briefing.id,
      });
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  server.patch("/api/briefing-bundles/:bundleId", (req, res) => {
    try {
      const replacesMembership = !!req.body && typeof req.body === "object" && !Array.isArray(req.body)
        && (Object.hasOwn(req.body, "briefing_refs") || Object.hasOwn(req.body, "layout"));
      const viewer = replacesMembership
        ? bundleMembershipViewer(db, req)
        : renameViewer(db, req, "Briefing bundle");
      const requestBody = body(req);
      const unexpected = Object.keys(requestBody)
        .filter((key) => key !== "name" && key !== "briefing_refs" && key !== "layout");
      if (unexpected.length > 0) {
        throw new BriefingStoreError(`request body contains unsupported field '${unexpected[0]}'`);
      }
      if (requestBody.name === undefined && requestBody.briefing_refs === undefined && requestBody.layout === undefined) {
        throw new BriefingStoreError("request body must contain name, briefing_refs, or layout");
      }
      if (requestBody.briefing_refs !== undefined && requestBody.layout !== undefined) {
        throw new BriefingStoreError("request body cannot contain both briefing_refs and layout");
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
          : replaceBriefingBundleLayout(db, req.params.bundleId, { briefingRefs, layout }, viewer);
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
  }, { fileRpc: "allow" });

  server.get("/api/briefing-bundles", (req, res) => {
    try {
      const identity = requireIdentity(req);
      sendJson(res, 200, { bundles: listBriefingBundles(db, {
        userId: identity.user_id,
        operator: isOperator(db, identity),
      }) });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  server.get("/api/briefing-bundles/:bundleId", (req, res) => {
    try {
      const identity = requireIdentity(req);
      sendJson(res, 200, { bundle: readBriefingBundle(db, req.params.bundleId, {
        userId: identity.user_id,
        operator: isOperator(db, identity),
      }) });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  server.post("/api/briefings", (req, res) => {
    try {
      const publication = publicationPrincipalAndResponder(db, req);
      const requestBody = body(req);
      const unexpected = Object.keys(requestBody)
        .filter((key) => key !== "artifact_version_ref" && key !== "comparison_base_artifact_version_ref" && key !== "title");
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
      if (!artifactVersionRef) throw new BriefingStoreError("artifact_version_ref must be a nonblank exact artifact-version ref");
      if (requestBody.comparison_base_artifact_version_ref !== undefined && !comparisonBaseArtifactVersionRef) {
        throw new BriefingStoreError("comparison_base_artifact_version_ref must be a nonblank exact artifact-version ref");
      }
      if (!title) throw new BriefingStoreError("title must be a nonblank string");
      const receipt = publishBriefingFromArtifactVersion(db, {
        briefing_key: `manual:${randomUUID()}`,
        title,
        artifact_version_ref: artifactVersionRef,
        comparison_base_artifact_version_ref: comparisonBaseArtifactVersionRef,
        profile: "mandible-briefing.v3",
        responder_user_ids: [publication.responderUserId],
      });
      broadcast(BRIEFING_EVENTS.created, { briefing_id: receipt.briefing_id });
      broadcast(BRIEFING_EVENTS.roundPublished, {
        briefing_id: receipt.briefing_id,
        round_id: receipt.round_id,
      });
      sendJson(res, 201, receipt);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  server.post("/api/briefings/runs", (req, res) => {
    try {
      requireIdentity(req);
      const request = parseBriefingRunRequest(req.body);
      const publisher = requireDurableAgentPublisher(db, req, {
        credentialCode: "briefing_publisher_credential_required",
        credentialMessage: "Briefing publication requires a durable API token, not a session credential.",
        agentCode: "briefing_publisher_agent_required",
        agentMessage: "Briefing publication requires an agent identity.",
      });
      if (!publisherMayIngest(db, publisher.slug, request.task_identity, [request.source_health.source])) {
        throw new ClientAuthzError(403, "source_namespace_forbidden",
          `Identity '${publisher.slug}' is not permitted to publish '${request.task_identity}' to '${request.source_health.source}'.`);
      }
      const existed = Boolean(db.prepare("SELECT 1 FROM briefings WHERE briefing_key = ?").get(request.briefing_key));
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
  }, { fileRpc: "allow" });

  server.get("/api/briefings", (req, res) => {
    try {
      const identity = requireIdentity(req);
      sendJson(res, 200, { briefings: listBriefings(db, {
        userId: identity.user_id,
        operator: isOperator(db, identity),
      }) });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  server.get("/api/briefings/:briefingId", (req, res) => {
    try {
      const actor = activeHuman(db, req);
      const values = new URL(req.url, "http://localhost").searchParams.getAll("round");
      const submissionValues = new URL(req.url, "http://localhost").searchParams.getAll("submission");
      if (values.length > 1 || (values.length === 1 && !values[0])) {
        throw new BriefingStoreError("round must be one nonblank round id");
      }
      if (submissionValues.length > 1 || (submissionValues.length === 1 && !submissionValues[0])) {
        throw new BriefingStoreError("submission must be one nonblank submission id");
      }
      const projection = readBriefing(db, req.params.briefingId, {
        ...(values[0] ? { roundId: values[0] } : {}),
        ...(submissionValues[0] ? { submissionId: submissionValues[0] } : {}),
        actorUserId: actor.user.id,
        operator: actor.operator,
      });
      if (!projection) throw new BriefingStoreError("briefing not found", 404, "not_found");
      sendJson(res, 200, projection);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  server.patch("/api/briefings/:briefingId", (req, res) => {
    try {
      const viewer = renameViewer(db, req, "Briefing");
      const requestBody = body(req);
      const unexpected = Object.keys(requestBody).filter((key) => key !== "title");
      if (unexpected.length > 0) {
        throw new BriefingStoreError(`request body contains unsupported field '${unexpected[0]}'`);
      }
      const result = updateBriefingTitle(db, req.params.briefingId, requestBody.title, viewer);
      if (result.changed) broadcast(BRIEFING_EVENTS.titleUpdated, { briefing_id: result.briefing_id });
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

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
  }, { fileRpc: "deny" });

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
  }, { fileRpc: "deny" });

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
  }, { fileRpc: "deny" });

  server.get("/api/briefings/:briefingId/rounds/:roundId/submissions/:submissionId/export", (req, res) => {
    try {
      const actor = activeHuman(db, req);
      sendJson(res, 200, exportBriefingSubmissionMarkdown(db, req.params.briefingId, req.params.roundId,
        req.params.submissionId, actor.user.id));
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });
}
