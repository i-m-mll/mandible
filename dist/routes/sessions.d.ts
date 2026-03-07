import { SessionRegistry } from "../registry.js";
import type { IssueScanner } from "../issue-scanner.js";
import type { SessionDiscovery } from "../session-discovery.js";
import type { RouteRegistrar } from "../server.js";
export declare function registerSessionRoutes(server: RouteRegistrar, registry?: SessionRegistry, discovery?: SessionDiscovery, issueScanner?: IssueScanner): void;
