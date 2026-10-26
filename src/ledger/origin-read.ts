import { requestOriginForRequest, type RequestOrigin } from "../request-origin.js";

export function requestOriginFromRow(row: { request_origin_json?: unknown }): RequestOrigin | null {
  return requestOriginForRequest({ ambient_identity: typeof row.request_origin_json === "string"
    ? JSON.parse(row.request_origin_json) : null });
}
