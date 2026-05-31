import type { RequestLike, ResponseLike } from "../server.js";

export function readBody<T>(req: RequestLike): T {
  return (req.body ?? {}) as T;
}

export function sendJson(res: ResponseLike, code: number, payload: unknown): void {
  res.status(code).json(payload);
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
