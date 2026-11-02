/**
 * The framing a stored parked item carries (`framed-park.ts`), the decision
 * class and the decision record, and how a framed decision is printed. Kept
 * apart from `framed-park.ts` so the state schema and the handoff import no
 * command code.
 */
import type { ParkedItem } from "./schema.ts";

/** The framing fields: absent on a park from before framing, else well-formed. */
export function isOptionalFrame(e: Record<string, unknown>): boolean {
  return (
    (e.class === undefined ||
      (typeof e.class === "string" && /^[a-z][a-z0-9-]*$/.test(e.class))) &&
    (e.record === undefined ||
      (typeof e.record === "string" && e.record.trim() !== ""))
  );
}

/**
 * One parked decision in full, for the stop, the handoff and the ledger
 * reader: its key, kind, class and round, then the record. A park written
 * before parks were framed prints its reason.
 */
export function framedDecisionLines(p: ParkedItem): string[] {
  const head = `[${p.kind}] ${p.key} · class ${p.class ?? "(none recorded)"} · parked at round ${p.round}`;
  if (p.record === undefined) return [head, `  ${p.reason}`];
  return [head, ...p.record.split("\n").map((l) => (l === "" ? "" : `  ${l}`))];
}
