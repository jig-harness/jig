/**
 * Helpers for the two things a `catch` usually needs: the error's system code,
 * and a way to drop an error on purpose without losing it.
 *
 * Dropping an error and answering with a default (`catch { return null; }`)
 * turns a failure into an ordinary answer, and nothing records why. Where the
 * default really is the right answer (a cache entry that cannot be read is
 * read fresh), `swallow(err, reason)` says so in the code and writes the
 * error at debug level, so `JIG_LOG=debug` shows what was dropped and why.
 */
import { type Fields, log, MAX_CAUSE_DEPTH } from "./log.ts";

/** The `code` of a system error (`ENOENT`, `EACCES`, ...), if it has one. */
export function errnoCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err))
    return undefined;
  return typeof err.code === "string" ? err.code : undefined;
}

/**
 * What a log line shows of a failure: the error with its stack, each cause
 * (`cause`, `cause2`, ... up to `MAX_CAUSE_DEPTH`), and the error output a
 * failed child left (`stderrTail`, see `proc.ts`), the innermost one found.
 */
export function failureFields(err: unknown): Fields {
  const fields: Record<string, unknown> = { error: err };
  let at: unknown = err;
  for (
    let depth = 0;
    at instanceof Error && depth <= MAX_CAUSE_DEPTH;
    depth++
  ) {
    if (
      "stderrTail" in at &&
      typeof at.stderrTail === "string" &&
      at.stderrTail !== ""
    )
      fields.stderrTail = at.stderrTail;
    const cause: unknown = at.cause;
    if (cause === undefined || depth === MAX_CAUSE_DEPTH) break;
    fields[depth === 0 ? "cause" : `cause${depth + 1}`] = cause;
    at = cause;
  }
  return fields;
}

/**
 * Drop `err` deliberately: `reason` says why carrying on is right. Written at
 * debug level as the boundary reports a failure: the error, its causes and a
 * failed child's error output.
 */
export function swallow(err: unknown, reason: string): void {
  log.debug(reason, failureFields(err));
}

/**
 * A bug or a broken invariant, such as a caller passing an argument no correct
 * caller passes. Never caught to drive control flow; its type says "defect"
 * so no caller has to read the message to tell.
 */
export class Defect extends Error {
  override name = "Defect";
}
