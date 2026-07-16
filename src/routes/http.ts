import type { RequestLike } from "../server.js";

export function readBody<T>(req: RequestLike): T {
  return (req.body ?? {}) as T;
}

export function sendJson(res: unknown, code: number, payload: unknown): void {
  if (!res || typeof res !== "object") {
    return;
  }
  const record = res as Record<string, unknown>;
  if (typeof record.status === "function") {
    (record.status as (status: number) => void)(code);
  } else if (typeof record.code === "function") {
    (record.code as (status: number) => void)(code);
  }

  if (typeof record.json === "function") {
    (record.json as (body: unknown) => void)(payload);
    return;
  }
  if (typeof record.send === "function") {
    (record.send as (body: unknown) => void)(payload);
    return;
  }
  if (typeof record.end === "function") {
    (record.end as (body: string) => void)(JSON.stringify(payload));
  }
}

export function queryString(req: RequestLike, key: string): string | undefined {
  const value = req.query[key];
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

export function queryNumber(
  req: RequestLike,
  key: string,
  options: { defaultValue: number; min?: number; max?: number },
): number {
  const raw = Number(queryString(req, key) ?? String(options.defaultValue));
  const finite = Number.isFinite(raw) ? raw : options.defaultValue;
  const minBounded = options.min === undefined ? finite : Math.max(options.min, finite);
  return options.max === undefined ? minBounded : Math.min(options.max, minBounded);
}
