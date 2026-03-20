/**
 * Webhook ingestion routes.
 * Bug: 9f66ad9 — accept structured events from external systems (CI, monitoring,
 * GitHub) and route them to the appropriate agent session.
 */
import type { RouteRegistrar } from "../server.js";
import type { SessionRegistry } from "../registry.js";
import type { SessionManager } from "../session-manager.js";
export declare function registerWebhookRoutes(server: RouteRegistrar, sessionRegistry: SessionRegistry, sessionManager: SessionManager): void;
