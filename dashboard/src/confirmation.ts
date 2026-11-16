/** A confirmation is valid only for the destination, credential generation and exact answers the person saw. */
import type { NeedView } from "./needs-view.ts";
import type { RowAnswer } from "./picking.ts";

export function confirmationSignature(
  need: NeedView,
  answers: RowAnswer[],
  credential: number,
): string {
  return JSON.stringify({
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
