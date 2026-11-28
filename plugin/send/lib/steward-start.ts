/**
 * `start` to a steward address: a request for one steward pass of the
 * repository, kept on the dispatcher host that owns it
 * (`dispatch/lib/steward-requests.ts`), which that host's next tick reads.
 *
 * It is checked against what the tick checks: this machine owns the
 * repository and runs its steward, and neither rule a pass the judgment
 * backlog starts is held to refuses one now (a steward pass holds the
 * repository, or the host's hourly budget is spent); a refusal names the
 * rule. The tick checks both rules again before it starts the pass, and a
 * request either refuses then is taken with the rule named on the tick's
 * receipt, on the dashboard and in the outcome log. A request already
 * pending stands with its first sender.
 */
import type { KnownRepository } from "../../shared/address.ts";
import { ok, type Outcome } from "../../shared/outcome.ts";
import { currentMs } from "../../shared/time.ts";
import type { MachineConfig } from "../../dispatch/lib/machine-config.ts";
import { readOnlyStateDb, statePath } from "../../dispatch/lib/state.ts";
import { stewardRuns } from "../../dispatch/lib/steward.ts";
import {
  answersStewardRequest,
  keepStewardRequest,
  pendingStewardRequest,
  requestRow,
  type StewardRequest,
  stewardRefusal,
} from "../../dispatch/lib/steward-requests.ts";
import type { AskContext } from "../../ask/lib/station.ts";
import { launchesWhere, ownsRepository } from "../../ask/lib/local.ts";
import { NEXT_TICK, type Planned, refused, type TickReader } from "./plan.ts";

const TICK: TickReader = { stage: "steward", reader: (tick) => tick };

/** Whether this machine runs the steward for `repo`: the steward is enabled and a checkout of it is dispatched with the steward stage. */
function runsSteward(
  machine: MachineConfig | null,
  known: readonly KnownRepository[],
  repo: string,
): boolean {
  if (machine?.steward?.enabled !== true) return false;
  const paths = new Set(
    known
      .filter((k) => k.slug?.toLowerCase() === repo.toLowerCase())
      .map((k) => k.path),
  );
  return machine.repositories.some(
    (r) => paths.has(r.path) && r.owner && r.stages.includes("steward"),
  );
}

/** The request already pending for `repo`, an already-answered one awaiting tick cleanup, or the rule that refuses a pass now; nothing under a root that never dispatched. */
async function standingAt(
  root: string | null,
  repo: string,
): Promise<
  Outcome<
    {
      pending: StewardRequest | null;
      answeredBy: { request: StewardRequest; launch: string } | null;
      refusal: string | null;
    },
    "refused"
  >
> {
  if (root === null)
    return ok({ pending: null, answeredBy: null, refusal: null });
  const launches = await launchesWhere(
    root,
    (r) => r.record.action === "steward",
  );
  if (!launches.ok)
    return refused(
      `whether a steward pass holds ${repo} is not known: ${launches.failure.reason}`,
    );
  const opened = readOnlyStateDb(root);
  if (!opened.ok || opened.value === null)
    return refused(
      `the steward's runs were not read, so whether the host's hourly budget allows a pass is not known${opened.ok ? "" : `: ${opened.failure.reason}`}`,
    );
  const { db } = opened.value;
  try {
    const refusal = stewardRefusal(
      launches.value.records,
      stewardRuns(null, root, db),
      repo,
      currentMs(),
    );
    const rawPending = pendingStewardRequest(db, repo);
    const answered =
      rawPending === null
        ? undefined
        : launches.value.records.find((r) =>
            answersStewardRequest(r, rawPending),
          );
    return ok({
      pending: answered === undefined ? rawPending : null,
      answeredBy:
        rawPending !== null && answered !== undefined
          ? { request: rawPending, launch: answered.record.id }
          : null,
      refusal: refusal?.reason ?? null,
    });
  } finally {
    db.close();
  }
}

export async function planStewardStart(
  ctx: AskContext,
  machine: MachineConfig | null,
  known: readonly KnownRepository[],
  writer: { login: string; writesAs: string },
): Promise<Planned> {
  const { repo } = ctx.address;
  const owner = ownsRepository(repo);
  if (!owner.ok) return refused(owner.failure.reason);
  if (!owner.value)
    return refused(
      `run this command on the dispatcher host that owns ${repo}: only its dispatcher starts the repository's steward`,
    );
  if (!runsSteward(machine, known, repo))
    return refused(
      `this host does not run the steward for ${repo}: its dispatch file needs steward.enabled and the steward stage on the repository`,
    );
  const root = ctx.dispatcher;
  const standing = await standingAt(root, repo);
  if (!standing.ok) return standing;
  const { pending, answeredBy, refusal } = standing.value;
  if (refusal !== null)
    return refused(
      `${refusal}, so the dispatcher would refuse the pass; send it again once that has changed`,
    );
  const where = statePath(root ?? undefined);
  return ok({
    address: ctx.name,
    repo,
    verb: "start",
    writesAs: writer.writesAs,
    record:
      pending === null
        ? "a request for one steward pass, whatever the judgment backlog holds"
        : `the request ${pending.by} sent at ${pending.at} for one steward pass, which stands`,
    where,
    reader: TICK.reader(NEXT_TICK),
    tick: TICK,
    undo: "nothing takes it back: the tick takes it once it starts the pass or a rule refuses it",
    notice:
      "The tick checks the rules again before it starts the pass: when a steward pass holds the repository or the hourly budget is spent by then, it refuses the request and names the rule on its receipt and the dashboard.",
    write: async () => {
      const kept = keepStewardRequest(
        repo,
        writer.login,
        root ?? undefined,
        answeredBy === null
          ? undefined
          : {
              request: answeredBy.request,
              row: requestRow(answeredBy.request, repo, {
                started: answeredBy.launch,
              }),
            },
      );
      return kept.ok ? ok(where) : kept;
    },
  });
}
