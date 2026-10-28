/** A declined code-scanning finding can close only after dismissal is verified. */
export function mayResolveDeclinedAlert(alert: unknown): boolean {
  if (alert === undefined) return true;
  if (typeof alert !== "object" || alert === null || Array.isArray(alert))
    return false;
  const record = alert as Record<string, unknown>;
  return record.state === "dismissed" && record.unreadable === undefined;
}
