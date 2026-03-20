import { IssueScanner } from "../issue-scanner.js";
import { WorkScanner } from "../work-scanner.js";
export interface RouteHandler<Request = unknown, Response = unknown> {
    (req: Request, res: Response): void | Promise<void>;
}
export interface IssueServer {
    get(path: string, handler: RouteHandler): void;
    post(path: string, handler: RouteHandler): void;
    put?(path: string, handler: RouteHandler): void;
}
export declare function registerIssueRoutes(server: IssueServer, workScanner: WorkScanner, deps?: {
    sessionRegistry?: import("../registry.js").SessionRegistry;
    sessionManager?: import("../session-manager.js").SessionManager;
}): IssueScanner;
