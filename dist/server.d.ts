import http from "node:http";
import { SseManager } from "./sse.js";
import type { Db } from "./db.js";
import type { Logger, StartupCommitInfo } from "./types.js";
export interface RequestLike {
    method: string;
    url: string;
    params: Record<string, string>;
    query: Record<string, string>;
    body: unknown;
}
export interface ResponseLike {
    status(code: number): ResponseLike;
    json(payload: unknown): void;
}
export type RouteHandler = (req: RequestLike, res: ResponseLike) => unknown;
export interface RouteRegistrar {
    get(path: string, handler: RouteHandler): void;
    post(path: string, handler: RouteHandler): void;
    put(path: string, handler: RouteHandler): void;
    patch(path: string, handler: RouteHandler): void;
    delete(path: string, handler: RouteHandler): void;
}
export declare class Router implements RouteRegistrar {
    private routes;
    get(path: string, handler: RouteHandler): void;
    post(path: string, handler: RouteHandler): void;
    put(path: string, handler: RouteHandler): void;
    patch(path: string, handler: RouteHandler): void;
    delete(path: string, handler: RouteHandler): void;
    private addRoute;
    handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>;
}
export interface ServerOptions {
    db: Db;
    sse: SseManager;
    logger: Logger;
    version: string;
    router: Router;
    getStartupInfo: () => StartupCommitInfo | null;
}
export declare function createServer(options: ServerOptions): http.Server;
export interface StartServerOptions {
    logger?: Logger;
}
/**
 * Attach a WebSocket upgrade handler to an existing http.Server.
 * Keeps server.ts generic — it accepts a raw upgrade callback and
 * has no knowledge of WebSocket or PTY internals.
 * Bug: e980dd8
 */
export declare function attachWebSocketUpgrade(server: http.Server, handleUpgrade: (req: http.IncomingMessage, socket: import("stream").Duplex, head: Buffer) => void): void;
export declare function startServer(server: http.Server, port: number, options?: StartServerOptions): Promise<number>;
