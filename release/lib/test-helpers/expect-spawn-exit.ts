/**
 * A bare `expect(result.exitCode).toBe(N)` on a spawned subprocess discards its
 * stdout/stderr on mismatch, leaving only `Expected: N, Received: M` in the
 * test report. That is indistinguishable from a transient spawn abort under CI
 * contention (a fork failure, a scheduling delay) versus a genuine regression,
 * and has caused flaky-CI misdiagnoses. Route every spawned-subprocess
 * exit-code assertion through these helpers so a mismatch carries the
 * process's own diagnostic output.
 *
 * Diagnostics only: they never change what passes or fails, only what a
 * failure reports. `stdout`/`stderr` are required (though nullable) so a caller
 * whose spawn result never captured them has to say so explicitly (`null`)
 * rather than the property silently being absent. The spawn call itself must
 * still capture `stdout: "pipe"` / `stderr: "pipe"` for there to be anything
 * to surface.
 */
export interface SpawnResult {
  exitCode: number | null;
  stdout: string | Buffer | Uint8Array | null;
  stderr: string | Buffer | Uint8Array | null;
}

// `Uint8Array.prototype.toString()` joins the byte values ("79,85,84"), so
// bytes (Buffer included) are decoded explicitly rather than stringified.
function text(output: SpawnResult["stdout"]): string {
  if (output == null) return "";
  return typeof output === "string" ? output : new TextDecoder().decode(output);
}

function diagnostics(result: SpawnResult): string {
  const stdout = text(result.stdout);
  const stderr = text(result.stderr);
  return `\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;
}

function prefixed(label: string | undefined): string {
  return label ? `${label}: ` : "";
}

export function expectSpawnExit(
  result: SpawnResult,
  expected: number,
  label?: string,
): void {
  if (result.exitCode !== expected)
    throw new Error(
      `${prefixed(label)}expected exit ${expected}, got ${result.exitCode}${diagnostics(result)}`,
    );
}

/** Same diagnostic for assertions that a run did NOT exit with a given code. */
export function expectSpawnExitNot(
  result: SpawnResult,
  forbidden: number,
  label?: string,
): void {
  if (result.exitCode === forbidden)
    throw new Error(
      `${prefixed(label)}expected exit code other than ${forbidden}, got ${result.exitCode}${diagnostics(result)}`,
    );
}

/**
 * Same diagnostic for a run terminated by a signal (no numeric exit code). If
 * a timeout or cancellation path unexpectedly returns a numeric code instead,
 * a bare assertion would report only the value and discard the captured output
 * needed to diagnose why.
 */
export function expectSpawnKilled(result: SpawnResult, label?: string): void {
  if (result.exitCode !== null)
    throw new Error(
      `${prefixed(label)}expected a signal-killed run (null exit code), got ${result.exitCode}${diagnostics(result)}`,
    );
}
