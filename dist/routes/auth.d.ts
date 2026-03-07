import { AuthQueue } from "../auth-queue.js";
import type { RouteRegistrar } from "../server.js";
export declare function registerAuthRoutes(app: RouteRegistrar, queue?: AuthQueue): AuthQueue;
