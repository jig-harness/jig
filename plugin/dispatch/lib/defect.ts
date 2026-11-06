/**
 * A defect as a tick records it (`Defect` in types.ts): on the receipt, its
 * code, the phase it was thrown in and a sentence for a person; on the
 * tick's error output, which the timer's journal keeps, that sentence with
 * the error's stack. The stack never goes on the receipt
 * ([ADR-0012](../../../docs/adr/ADR-0012-failures-as-values.md)).
 */
import { failureText } from "./text.ts";
import type { Defect } from "./types.ts";

/** The defect `error` is, thrown in `phase`. */
export function defectOf(phase: string, error: unknown): Defect {
  const what =
    error instanceof Error
      ? `a ${error.name} was thrown`
      : "something that is not an error was thrown";
  return {
    code: "defect",
    phase,
    reason: `${what} in the ${phase} phase: ${failureText(error)}`,
  };
}

/** Say on the error output what a defect stopped, with the error's stack. */
export function logDefect(
  stopped: string,
  defect: Defect,
  error: unknown,
): void {
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(
    `jig dispatch: a defect stopped ${stopped}: ${defect.reason}${stack === undefined ? "" : `\n${stack}`}`,
  );
}
