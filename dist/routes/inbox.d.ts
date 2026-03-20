import type { IssueScanner } from "../issue-scanner.js";
import type { SessionRegistry } from "../registry.js";
import type { SessionManager } from "../session-manager.js";
export interface InboxRouteServer {
    get(path: string, handler: (req: unknown, res: unknown) => void): void;
    post(path: string, handler: (req: unknown, res: unknown) => void): void;
}
export declare function registerInboxRoutes(server: InboxRouteServer, sessionRegistry: SessionRegistry, issueScanner: IssueScanner, sessionManager?: SessionManager): void;
