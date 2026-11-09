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
  type ForgeFacts,
  readiness,
  type ReadyRules,
} from "../../skills/drive-pr/scripts/lib/merge-ready.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { updateQueueWait } from "./merge-queue.ts";
import { rulesOf } from "../../dispatch/lib/board.ts";
import { isRecord } from "../../shared/guards.ts";
import { parseConfigText } from "../../shared/config-layers.ts";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
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

/** The facts and rules of PR `number`, read in one query within the answer's deadline, or why they did not read; the read is noted among the answer's sources. */
async function readFor(
  ctx: AskContext,
  number: number,
): Promise<
  Outcome<
    { facts: ForgeFacts; rules: ReadyRules; values: Record<string, unknown> },
    "unreadable"
  >
> {
  ctx.reading.forgeCall();
  const bounded = await within(ctx.reading.sourceSec(), () =>
    readMergeFacts(ctx.address.repo, [number], ctx.reading.sourceSec()),
  );
  const read =
    bounded?.value ??
    failed("unreadable", "the forge did not give them in time");
  const facts = read.ok ? read.value.pulls.get(number) : undefined;
  const rules = read.ok ? rulesFrom(read.value.config, ctx.address.repo) : null;
  const parsed = read.ok
    ? attempt(
        "unreadable",
        "the default branch configuration did not read",
        () =>
          read.value.config == null
            ? {}
            : parseConfigText(
                read.value.config,
                `${ctx.address.repo}:.config/jig.yaml`,
              ),
      )
    : null;
  const values = parsed?.ok ? parsed.value : null;
  const found = facts !== undefined && rules !== null && values !== null;
  const why = whyUnread(read, facts !== undefined);
  ctx.reading.note({
    record: "merge facts",
    read: found,
    ...(found ? {} : { detail: why }),
  });
  return found ? ok({ facts, rules, values }) : failed("unreadable", why);
}

/** Why the facts or rules did not read. */
function whyUnread(
  read: Outcome<unknown, "unreadable">,
  given: boolean,
): string {
  if (!read.ok) return read.failure.reason;
  return given
    ? "the repository's review rules on its default branch did not read"
    : "the forge did not give this pull request";
}

/** The enabled label scope from the same default-branch facts as the Ready rules. */
function dispatchLabels(values: Record<string, unknown>): {
  prefix: string | null;
  onlyLabeled: boolean;
} {
  const labels = isRecord(values.dispatch) ? values.dispatch.labels : null;
  if (!isRecord(labels) || labels.enabled !== true)
    return { prefix: null, onlyLabeled: false };
  return {
    prefix: typeof labels.prefix === "string" ? labels.prefix : "jig:",
    onlyLabeled: labels.only_labeled === true,
  };
}

/** Whether the ledger stopped converged on an open pull request. */
function convergedOpen(ledger: Ledger | null, doc: PullDoc): ledger is Ledger {
  return (
    ledger?.driver.state === "stopped" &&
    ledger.driver.exit === DRIVE_EXIT.CONVERGED &&
    doc.state === "OPEN"
  );
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
  if (!convergedOpen(ledger, doc))
    return { person: "merge", why: "its drive has not converged" };
  const read = await readFor(ctx, doc.number);
  if (!read.ok)
    return { waiting: `the merge facts did not read: ${read.failure.reason}` };
  const { prefix, onlyLabeled } = dispatchLabels(read.value.values);
  const answer = readiness(
    {
      ...read.value.facts,
      slug: ctx.address.repo,
      converged: true,
      verifiedSha: ledger.verifiedSha,
      held:
        prefix !== null && read.value.facts.labels.includes(`${prefix}hold`),
    },
    read.value.rules,
  );
  if (answer.lane === "update-next")
    return await updateQueueWait(
      ctx,
      ledger,
      read.value.facts,
      read.value.rules,
      prefix,
      answer,
      typeof read.value.values.drive === "object" &&
        read.value.values.drive !== null &&
        "change_areas_catalog" in read.value.values.drive,
      onlyLabeled,
    );
  const lane = answer.lane === null ? "" : `${answer.lane}: `;
  const command = answer.command === null ? "" : `; ${answer.command}`;
  const why = `${lane}${answer.says}${command}`;
  return answer.waitsOn.kind === "waiting"
    ? { waiting: why }
    : { person: PERSON[answer.waitsOn.act], why };
}
