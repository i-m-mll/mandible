import type { RouteRegistrar } from "../server.js";
import type { SessionRegistry } from "../registry.js";
import type { SessionManager } from "../session-manager.js";
import { type WorkUnitLiveness, type WorkUnitWithLiveness } from "../work-unit-utils.js";
export type { WorkUnitLiveness, WorkUnitWithLiveness };
export declare function registerWorkUnitRoutes(server: RouteRegistrar, sessionRegistry: SessionRegistry, sessionManager: SessionManager): void;
