#!/usr/bin/env node
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { UndeliveredAuthResult } from "./types.js";
/**
 * Bug: 4e32923 — exported (with injectable deps) for unit testing. Walks the
 * list of undelivered auth_results owned by this session id, sends each as a
 * channel event, and POSTs delivery acknowledgement back to Mandible. Best
 * effort: any single failure (network, daemon down, missing row) is logged
 * and skipped — never propagated, so bridge startup is never blocked.
 */
export declare function runStartupCatchUp(args: {
    sessionId: string;
    mcpServer: Server;
    fetchUndelivered: (sessionId: string) => Promise<UndeliveredAuthResult[]>;
    markDelivered: (requestId: string) => Promise<void>;
    log: (line: string) => void;
}): Promise<void>;
