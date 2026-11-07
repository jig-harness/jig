/** A failure as one line of a report. */
export function failureText(error: unknown): string {
  let message: string;
  try {
    message = error instanceof Error ? String(error.message) : String(error);
  } catch {
    // A value with no text form (a null-prototype object, a throwing toString) is still a failure to report.
    message = "";
  }
  return message.split("\n")[0]?.trim() || "an unknown failure";
}

/** Whole minutes between two instants, rounded down. */
export function minutesBetween(fromMs: number, toMs: number): number {
  return Math.floor((toMs - fromMs) / 60_000);
}

/** A failed subprocess probe with the diagnostic that explains the refusal. */
export function probeFailure(
  command: string,
  done: { code: number; timedOut: boolean; stderr: string; stdout: string },
): string {
  const reason = (done.stderr || done.stdout).trim().slice(0, 300);
  return `${command} failed (${done.timedOut ? "deadline exceeded, " : ""}exit ${done.code})${reason === "" ? "" : `: ${reason}`}`;
}
