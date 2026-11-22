export class BriefingStoreError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "invalid_briefing",
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BriefingStoreError";
  }
}
