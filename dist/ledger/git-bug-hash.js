import { createHash } from "node:crypto";
export function stableJson(value) {
    if (Array.isArray(value)) {
        return value.map(stableJson);
    }
    if (value && typeof value === "object") {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            out[key] = stableJson(value[key]);
        }
        return out;
    }
    return value;
}
export function stableJsonStringify(value) {
    return JSON.stringify(stableJson(value));
}
export function hashGitBugPayload(value) {
    return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}
