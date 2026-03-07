import type { IssueScanner } from "../issue-scanner.js";
import type { SessionRegistry } from "../registry.js";
export interface InboxRouteServer {
    get(path: string, handler: (req: unknown, res: unknown) => void): void;
    post(path: string, handler: (req: unknown, res: unknown) => void): void;
}
export declare function registerInboxRoutes(server: InboxRouteServer, _sessionRegistry: SessionRegistry, issueScanner: IssueScanner): void;
