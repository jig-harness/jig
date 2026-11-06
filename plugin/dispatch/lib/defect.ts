/**
 * A defect as a tick records it (`Defect` in types.ts): the phase, the
 * error's name and first line, and its stack, on the receipt; and the stack
 * on the tick's error output, which the timer's journal keeps.
 */
import { failureText } from "./text.ts";
import type { Defect } from "./types.ts";

/** The defect `error` is, thrown in `phase`. */
export function defectOf(phase: string, error: unknown): Defect {
  return {
    phase,
    message:
      error instanceof Error
        ? `${error.name}: ${failureText(error)}`
        : failureText(error),
    stack: error instanceof Error ? (error.stack ?? null) : null,
  };
}

/** Say on the error output what a defect stopped, with its stack. */
export function logDefect(stopped: string, defect: Defect): void {
  console.error(
    `jig dispatch: a defect stopped ${stopped} in its ${defect.phase} phase: ${defect.stack ?? defect.message}`,
  );
}
