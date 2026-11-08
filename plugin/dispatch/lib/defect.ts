/**
 * A defect as a tick records it (`Defect` in types.ts): on the receipt, its
 * code, the phase it was thrown in (and the stage, for one a stage's
 * boundary caught) and a sentence for a person; in the outcome log, for a
 * stage's, the same; on the tick's error output, which the timer's journal
 * keeps, that sentence with the error's stack. The stack never goes on the
 * receipt or in the log
 * ([ADR-0012](../../../docs/adr/ADR-0012-failures-as-values.md)).
 */
import { attempt } from "../../shared/outcome.ts";
import { stateRoot } from "../receipts.ts";
import { writeRow } from "./log.ts";
import { failureText } from "./text.ts";
import type { ApplyStage, Defect } from "./types.ts";

/** The defect `error` is, thrown in `phase`, and in `stage` of it when a stage's boundary caught it. */
export function defectOf(
  phase: string,
  error: unknown,
  stage?: ApplyStage,
): Defect {
  const what =
    error instanceof Error
      ? `a ${error.name} was thrown`
      : "something that is not an error was thrown";
  const where =
    stage === undefined
      ? `the ${phase} phase`
      : `the ${stage} stage of the ${phase} phase`;
  return {
    code: "defect",
    phase,
    ...(stage === undefined ? {} : { stage }),
    reason: `${what} in ${where}: ${failureText(error)}`,
  };
}

/**
 * A defect one stage's boundary caught, as a row of the outcome log: an
 * event in the repository's log, under the stage it stopped, with the
 * defect's sentence and no stack. True when this call wrote it; a write
 * that fails is said on the error output, and the receipt still carries
 * the defect.
 */
export function logStageDefect(
  repo: string,
  defect: Defect & { stage: ApplyStage },
  at = new Date().toISOString(),
  root = stateRoot(),
): boolean {
  const written = attempt("unwritten", "the outcome log", () =>
    writeRow(
      {
        kind: "event",
        key: `defect ${repo} ${defect.stage} ${at}`,
        at,
        repo,
        stage: defect.stage,
        target: "",
        event: "defect",
        account: null,
        class: null,
        reason: defect.reason,
      },
      root,
    ),
  );
  if (written.ok) return written.value;
  console.error(
    `jig dispatch: the ${defect.stage} stage's defect is not in the outcome log: ${written.failure.reason}`,
  );
  return false;
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
