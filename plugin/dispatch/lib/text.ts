/** A failure as one line of a report. */
export function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]?.trim() || "an unknown failure";
}

/** Whole minutes between two instants, rounded down. */
export function minutesBetween(fromMs: number, toMs: number): number {
  return Math.floor((toMs - fromMs) / 60_000);
}
