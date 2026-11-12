/** Classification shared by the tick and a session reporting after its tick. */
import type { SessionResult } from "./launches.ts";
import type { OutcomeClass } from "./log.ts";
import { questionIn } from "./session.ts";

/** The recorded result and question have the same precedence at every logging boundary. */
export function sessionResultClass(
  result: SessionResult | null,
  said: unknown,
): { class: OutcomeClass; reason: string } | null {
  if (result === "done") return { class: "converged", reason: "result done" };
  if (result === "waits")
    return {
      class: "quota wall",
      reason:
        "result waits: the tracker's rate limit stopped it; it starts again after the reset",
    };
  const question = typeof said === "string" ? questionIn(said) : null;
  if (question !== null)
    return {
      class: "parked for a person",
      reason: `stopped on a question: ${question}`,
    };
  if (result === "failed")
    return { class: "gates failed", reason: "result failed" };
  return null;
}
