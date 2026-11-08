/**
 * What a converged drive waits on, from the Ready predicate the dispatcher's
 * tick places it with (`skills/drive-pr/scripts/lib/merge-ready.ts`), so
 * `jig ask` names the same lane and act as the pull request's card: merge
 * now, approve first or update next, or the act that settles it in Needs
 * you. The forge's facts come from the board's own query
 * (`merge-facts.ts`), the repository's rules from its configuration in a
 * checkout here; without one, the rules are not known and the answer says
 * so rather than guess at a reviewer.
 */
import { readMergeFacts } from "../../skills/drive-pr/scripts/lib/merge-facts.ts";
import {
  type Act,
  readiness,
  type ReadyRules,
} from "../../skills/drive-pr/scripts/lib/merge-ready.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { rulesOf } from "../../dispatch/lib/board.ts";
import { layeredConfig } from "../../shared/consumer.ts";
import { attempt } from "../../shared/outcome.ts";
import type { PersonAct, WaitsOn } from "./answer.ts";
import type { PullDoc } from "./forge.ts";
import { within } from "./reading.ts";
import type { AskContext } from "./station.ts";

/** The person's act `jig ask` names for each of the predicate's. */
const PERSON: Record<Act, PersonAct> = {
  merge: "merge",
  approve: "approve",
  "request-review": "request a review",
  "update-branch": "update the branch",
  answer: "answer",
  "re-arm": "re-arm",
  "re-run-check": "re-run a check",
  "mark-ready": "mark it ready",
  "remove-label": "remove the label",
  "open-pr": "open the pull request",
};

/** The repository's Ready rules from its configuration in the checkout here; `null` where there is none or it does not read. */
export function readyRulesAt(checkout: string | null): ReadyRules | null {
  if (checkout === null) return null;
  const read = attempt("unreadable", "", () =>
    rulesOf(layeredConfig(checkout).values),
  );
  return read.ok ? read.value : null;
}

/**
 * The converged drive's wait from the predicate; `null` for a drive that has
 * not converged, which the ledger's class answers.
 */
export async function convergedWait(
  ctx: AskContext,
  ledger: Ledger | null,
  doc: PullDoc,
): Promise<WaitsOn | null> {
  const converged =
    ledger?.driver.state === "stopped" &&
    ledger.driver.exit === DRIVE_EXIT.CONVERGED;
  if (ledger === null || !converged || doc.state !== "OPEN") return null;
  const rules = readyRulesAt(ctx.checkout);
  if (rules === null)
    return {
      person: "merge",
      why: "converged; no checkout here names the repository's review rules, so whether its review is witnessed, an approval is owed or the branch must be updated is not read",
    };
  ctx.reading.forgeCall();
  const read = await within(ctx.reading.sourceSec(), () =>
    readMergeFacts(ctx.address.repo, [doc.number], ctx.reading.sourceSec()),
  ).catch((error: unknown) => ({ failed: String(error) }));
  const facts =
    read !== null && "value" in read
      ? read.value.pulls.get(doc.number)
      : undefined;
  ctx.reading.note({
    record: "merge facts",
    read: facts !== undefined,
    ...(facts === undefined
      ? {
          detail:
            read !== null && "failed" in read
              ? read.failed
              : "the forge did not give them in time",
        }
      : {}),
  });
  if (facts === undefined)
    return { waiting: "the forge's merge facts did not read" };
  const answer = readiness(
    {
      ...facts,
      slug: ctx.address.repo,
      converged: true,
      verifiedSha: ledger.verifiedSha,
      held:
        ctx.labelPrefix !== null &&
        doc.labels.includes(`${ctx.labelPrefix}hold`),
    },
    rules,
  );
  const lane = answer.lane === null ? "" : `${answer.lane}: `;
  const why = `${lane}${answer.says}${answer.command === null ? "" : `; ${answer.command}`}`;
  return answer.waitsOn.kind === "waiting"
    ? { waiting: why }
    : { person: PERSON[answer.waitsOn.act], why };
}
