/**
 * What a converged drive waits on, from the Ready predicate the dispatcher's
 * tick places it with (`skills/drive-pr/scripts/lib/merge-ready.ts`), so
 * `jig ask` names the same lane and act as the pull request's card: merge
 * now, approve first or update next, or the act that settles it in Needs
 * you. The forge's facts come from the board's own query
 * (`merge-facts.ts`), the repository's rules from its configuration on the
 * default branch, read in the same query, as the tick reads them; when that
 * does not read, the answer says so rather than guess at a reviewer.
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
import { parseConfigText } from "../../shared/config-layers.ts";
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

/** The repository's Ready rules from its configuration on the default branch; `null` when it did not read. */
function rulesFrom(
  config: string | null | undefined,
  repo: string,
): ReadyRules | null {
  if (config === undefined) return null;
  const read = attempt("unreadable", "", () =>
    rulesOf(
      config === null
        ? {}
        : parseConfigText(config, `${repo}:.config/jig.yaml`),
    ),
  );
  return read.ok ? read.value : null;
}

/**
 * The converged drive's wait from the predicate; for a drive that has not
 * converged, which the ledger's class answers, a merge it never reaches.
 */
export async function convergedWait(
  ctx: AskContext,
  ledger: Ledger | null,
  doc: PullDoc,
): Promise<WaitsOn> {
  const converged =
    ledger?.driver.state === "stopped" &&
    ledger.driver.exit === DRIVE_EXIT.CONVERGED;
  if (ledger === null || !converged || doc.state !== "OPEN")
    return { person: "merge", why: "its drive has not converged" };
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
  const rules = rulesFrom(
    read !== null && "value" in read ? read.value.config : undefined,
    ctx.address.repo,
  );
  if (rules === null)
    return {
      waiting:
        "the repository's review rules on its default branch did not read, so whether its review is witnessed is not known",
    };
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
