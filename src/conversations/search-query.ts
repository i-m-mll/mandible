export function parseSinceQuery(value: string | undefined): string | null {
  if (!value) return null;
  if (/^\d+d$/.test(value)) {
    const days = Number(value.slice(0, -1));
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  }
  return value;
}

export function sourceFromQuery(value: string | undefined): string | null {
  if (!value || value === "all") return null;
  return value === "claude" ? "claude_code" : value;
}

export function blockTypeFromRole(value: string | undefined): string | null {
  if (value === "user") return "user_message";
  if (value === "assistant") return "assistant_message";
  return null;
}
