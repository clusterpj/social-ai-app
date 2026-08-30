type Level = "debug" | "info" | "warn" | "error";

/**
 * Structured JSON logging to stdout (journald captures it in production).
 * Never pass tokens or full API keys in `fields`.
 */
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  // eslint-disable-next-line no-console -- single sanctioned console call
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
}

export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { error: err.message, error_name: err.name, stack: err.stack };
  }
  return { error: String(err) };
}
