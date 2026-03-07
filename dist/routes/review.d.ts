import { WorkScanner } from "../work-scanner.js";
type QuerySource = Record<string, string | string[] | undefined> | undefined;
type RequestLike = {
    url?: string;
    query?: QuerySource;
};
type ResponseLike = {
    status?: (code: number) => ResponseLike;
    json?: (body: unknown) => void;
};
type RouteHandler = (req: RequestLike, res?: ResponseLike) => Promise<unknown> | unknown;
type RouteRegistrar = {
    get: (path: string, handler: RouteHandler) => void;
};
export declare const registerReviewRoutes: (server: RouteRegistrar, scanner?: WorkScanner) => void;
export {};
