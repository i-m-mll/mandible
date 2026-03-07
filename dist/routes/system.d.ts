import type { WorkScanner } from "../work-scanner.js";
export interface SystemServer {
    get(path: string, handler: (req: any, res: any) => void | Promise<void>): void;
    post(path: string, handler: (req: any, res: any) => void | Promise<void>): void;
}
export declare function registerSystemRoutes(server: SystemServer, workScanner: WorkScanner): void;
