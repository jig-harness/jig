/** A confirmation is valid only for the destination, the token that sends to it (`credentialOf`) and the exact answers the person saw. */
import type { NeedView } from "./needs-view.ts";
import type { RowAnswer } from "./picking.ts";

export function confirmationSignature(
  need: NeedView,
  answers: RowAnswer[],
  credential: string,
  /** On a question group's card, the targets left out: the targets an answer covers are part of what was confirmed. */
  left: ReadonlySet<string> = new Set(),
): string {
  return JSON.stringify({
    group: need.group?.members
      .filter((m) => !left.has(m.rowKey))
      .map((m) => ({
        card: m.rowKey,
        url: m.url,
        to: m.send,
        rows: m.rows.map((row) => ({ key: row.key, framing: row.framing })),
      })),
    repo: need.repo,
    target: need.target,
    url: need.url,
    to: need.send,
    credential,
    rows: need.rows.map((row) => ({ key: row.key, framing: row.framing })),
    answers: answers.map((a) => ({
      active: a.active,
      pick: a.pick?.name,
      note: a.note,
      free: a.free,
    })),
  });
}

/** Every Send confirms; Copy confirms only guarded picks. */
export function needsConfirmation(
  how: "send" | "copy",
  guarded: number,
): boolean {
  return how === "send" || guarded > 0;
}
