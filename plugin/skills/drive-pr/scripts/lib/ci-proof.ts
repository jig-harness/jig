/** What a CI proof read answers, and the stop a check-runs listing cut short ends it with. */
import { fail } from "./cli.ts";
import type { ListingCutShort } from "./paged-read.ts";
import { DRIVE_EXIT } from "./status/terminal-states.ts";

/** A proof read that held, or that did not and says whether its listing was cut short. */
export type ProofRead =
  | { ok: true }
  | { ok: false; cutShort?: ListingCutShort };

/** A script's stdout record of the pages a cut-short listing read, and the drive's exit for it. */
export function listingStopExit(pagesRead: number | null): number {
  process.stdout.write(`${JSON.stringify({ listingPagesRead: pagesRead })}\n`);
  return DRIVE_EXIT.CHECK_RUNS_UNREADABLE;
}

/** The page count a script's stdout record carries with a listing stop; null when it carries none. */
export function listingPagesReadFrom(stdout: string): number | null {
  for (const line of stdout.split("\n").reverse()) {
    try {
      const record: unknown = JSON.parse(line);
      if (typeof record !== "object" || record === null) continue;
      const pages = Reflect.get(record, "listingPagesRead");
      if (typeof pages === "number") return pages;
    } catch {
      // Not the stop record.
    }
  }
  return null;
}

/** A failed read that carries its listing's classification when it has one. */
export function unreadable<T extends { reason: string }>(
  failed: T,
  cutShort: ListingCutShort | null,
): T & { ok: false; cutShort?: ListingCutShort } {
  return cutShort === null
    ? { ...failed, ok: false }
    : { ...failed, ok: false, cutShort };
}

/** Exit a command on a failed proof: the named listing stop when its listing was cut short, else `code`. */
export function exitOnProof(
  proof: { reason: string; cutShort?: ListingCutShort },
  code: number,
  message: (reason: string) => string,
): never {
  if (proof.cutShort === undefined) return fail(code, message(proof.reason));
  listingStopExit(proof.cutShort.pagesRead);
  return fail(DRIVE_EXIT.CHECK_RUNS_UNREADABLE, message(proof.cutShort.reason));
}
