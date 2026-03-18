/**
 * Console session HTTP routes.
 * Bug: e980dd8
 */
import { PtyManager } from "../pty-manager.js";
import type { RouteRegistrar } from "../server.js";
export declare function registerConsoleRoutes(server: RouteRegistrar, manager: PtyManager): void;
