/**
 * Auth hooks CRUD routes.
 * Bug: 4afab83
 */
import { AuthHookManager } from "../auth-hooks.js";
import type { RouteRegistrar } from "../server.js";
export declare function registerAuthHookRoutes(app: RouteRegistrar, manager?: AuthHookManager): AuthHookManager;
