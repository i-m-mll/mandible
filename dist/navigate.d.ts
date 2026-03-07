import type { Session } from "./types.js";
export interface NavigateResult {
    ok: boolean;
    message?: string;
}
export declare function navigateToSession(session: Session): NavigateResult;
