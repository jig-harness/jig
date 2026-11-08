/**
 * The framing a stored parked item carries (`framed-park.ts`), the decision
 * class and the decision record, and how a framed decision is printed. Kept
 * apart from `framed-park.ts` so the state schema and the handoff import no
 * command code.
 */
import type { ParkedItem } from "./schema.ts";

/** A forge login, excluding whitespace and mention syntax. */
export function isPerson(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})(?:\[bot\])?$/.test(value)
  );
}

/** A parked item every reader can match and render (`ParkedItem`). */
export function isParkedItem(p: unknown): boolean {
  if (typeof p !== "object" || p === null) return false;
  const e = p as Record<string, unknown>;
  return (
    typeof e.key === "string" &&
    e.key.length > 0 &&
    !/[\n\r]/.test(e.key) &&
    (e.kind === "thread" || e.kind === "finding") &&
    typeof e.reason === "string" &&
    e.reason.length > 0 &&
    (e.person === undefined || isPerson(e.person)) &&
    isOptionalFrame(e) &&
    typeof e.round === "number" &&
    Number.isInteger(e.round) &&
    e.round >= 0 &&
    (e.at === undefined ||
      (typeof e.at === "string" && Number.isFinite(Date.parse(e.at))))
  );
}

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
