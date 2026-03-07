import { WorkScanner, type BranchData } from "../work-scanner.js";
export interface RouteHandler<Request = any, Response = any> {
    (req: Request, res: Response): void | Promise<void>;
}
export interface WorkServer {
    get(path: string, handler: RouteHandler): void;
    post(path: string, handler: RouteHandler): void;
}
export declare function filterAndSortBranches(branches: BranchData[], options: {
    sort?: string;
    filter?: string;
}): BranchData[];
export declare function registerWorkRoutes(server: WorkServer, scanner?: WorkScanner): WorkScanner;
