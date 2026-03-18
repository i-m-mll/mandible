/**
 * Console session HTTP routes.
 * Bug: e980dd8
 */
import { SessionManager } from "../session-manager.js";
import type { RouteRegistrar } from "../server.js";
export declare function registerConsoleRoutes(server: RouteRegistrar, manager: SessionManager): void;
