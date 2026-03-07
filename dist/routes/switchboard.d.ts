import type { RouteRegistrar } from "../server.js";
export interface HookTemplate {
    id: string;
    name: string;
    hook_setup?: string;
    hook_teardown?: string;
    builtin?: boolean;
}
export declare function registerSwitchboardRoutes(server: RouteRegistrar): void;
