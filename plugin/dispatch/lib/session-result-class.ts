/** Classification shared by the tick and a session reporting after its tick. */
import { armWords, type WaitFor } from "./wait-for.ts";
import type { FramedResult } from "./framed-result.ts";
import type { SessionResult } from "./session-result-types.ts";
import type { OutcomeClass } from "./log.ts";
import { questionIn } from "./session.ts";

/**
 * The recorded result and question have the same precedence at every
 * logging boundary. A follow-up that waits on an arm still pending is `arm
 * pending`, its reason naming the arm; a pass parked on the decision it
 * framed is `parked for a person`, its reason naming the decision's
 * question. Neither is a stage finishing badly. A pickup that waits on the
 * host's test lock is a limit's wall, as a rate limit's wait is: a host
 * whose lock keeps running out shows as a recurring class.
 */
export function sessionResultClass(
  result: SessionResult | null,
  said: unknown,
  wait?: WaitFor,
  framed?: FramedResult,
): { class: OutcomeClass; reason: string } | null {
  if (result === "done") return { class: "converged", reason: "result done" };
  if (result === "waits" && wait?.reason === "pending")
    return {
      class: "arm pending",
      reason: `result waits: ${armWords(wait)} is still pending, as of the time it named`,
    };
  if (result === "waits" && wait?.reason === "test-lock")
    return {
      class: "quota wall",
      reason:
        "result waits: the host's test lock held its push past the pre-push hook's wait; it is relaunched in its tree once the host's validation capacity admits it",
    };
  if (result === "waits")
    return {
      class: "quota wall",
      reason:
        "result waits: the issue service's rate limit stopped it; it starts again after the reset",
    };
  const question = typeof said === "string" ? questionIn(said) : null;
  const decided = framed?.decision.call.question ?? null;
  if (result === "parked")
    return {
      class: "parked for a person",
      reason: `result parked: stopped on a question: ${decided ?? question ?? "the decision it framed does not read"}`,
    };
  if (question !== null)
    return {
      class: "parked for a person",
      reason: `stopped on a question: ${question}`,
    };
  if (result === "failed")
    return { class: "gates failed", reason: "result failed" };
  return null;
}
