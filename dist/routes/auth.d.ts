import { AuthQueue } from "../auth-queue.js";
import { AuthAutoApproveManager } from "../auth-auto-approve.js";
import type { RouteRegistrar } from "../server.js";
export declare function registerAuthRoutes(app: RouteRegistrar, queue?: AuthQueue, autoApprove?: AuthAutoApproveManager): AuthQueue;
