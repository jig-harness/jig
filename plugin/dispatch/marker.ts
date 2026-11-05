/**
 * `jig dispatch marker claim|check|done <PR>`: how a follow-up command
 * honours the follow-up marker (`lib/followup-marker.ts`), a claim of the
 * shared forge-claims module (`shared/records/forge-claims.ts`), whether a
 * person ran it or the tick started it.
 *
 * - `claim` posts a manual run's marker and reads the markers back, again a
 *   few times while the listing does not show it yet: when an earlier
 *   trusted marker is there, it deletes its own and exits 3, and the run
 *   stops before it acts. It prints the marker's comment id.
 * - `check --comment <id>` reads the markers again before an act that
 *   writes outside the pull request: it exits 3 when a trusted marker
 *   earlier than `<id>` has appeared, and the run stops.
 * - `done --comment <id>` marks a manual run's marker done once its last
 *   act succeeded. A marker the tick posted is not marked: its session
 *   records its result through `jig dispatch result`.
 *
 * `--repo owner/name` names the repository; without it, the current
 * checkout's.
 *
 * Exit codes: 0 done; 1 the forge could not be read or written; 2 usage, or
 * a comment that is not a trusted marker of this pull request; 3 an earlier
 * marker holds the follow-up.
 */
import { check, post, withdraw } from "../shared/records/forge-claims.ts";
import { localWriter } from "../shared/records/writer.ts";
import { resolveLogin } from "../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import {
  editMarker,
  FOLLOWUP_CLAIM,
  FOLLOWUP_KEY,
  followupTarget,
  manualClaim,
  manualMarker,
  markerStanding,
} from "./lib/followup-marker.ts";
import { repoTarget } from "./lib/forge.ts";
import { failureText } from "./lib/text.ts";

export interface MarkerArguments {
  verb: "claim" | "check" | "done";
  pr: number;
  comment: number | null;
  repo: string | null;
}

const EARLIER = 3;

async function slugOf(repo: string | null): Promise<string> {
  return repo ?? (await repoTarget(process.cwd())).slug;
}

function stop(code: number, message: string): number {
  console.error(`jig dispatch marker: ${message}`);
  return code;
}

async function claim(slug: string, pr: number): Promise<number> {
  const login = await resolveLogin();
  const target = followupTarget(slug, pr);
  const posted = await post(
    target,
    FOLLOWUP_CLAIM,
    manualClaim(false, { pr, writer: localWriter("forge", login) }),
    { self: login },
  );
  if (!posted.ok)
    return stop(1, `the marker could not be posted: ${posted.failure.reason}`);
  const { id } = posted.value;
  const seen = markerStanding(posted.value.standing, { kind: "manual" });
  if (seen.kind === "stands") {
    console.log(JSON.stringify({ pr, comment: id }));
    return 0;
  }
  if (seen.kind === "done")
    return stop(
      1,
      `the posted marker (comment ${id}) was marked done before the read-back finished; it is kept as the completion record, so do not act`,
    );
  const deleted = await withdraw(target, id);
  const kept = deleted.ok
    ? ""
    : `; its own marker (comment ${id}) could not be deleted (${deleted.failure.reason}): delete it by hand`;
  if (seen.kind === "unreadable")
    return stop(1, `the markers could not be read back: ${seen.reason}${kept}`);
  if (seen.kind === "missing")
    return stop(
      1,
      `the read-back does not list the posted marker (comment ${id}); retry${kept}`,
    );
  if (seen.kind === "altered")
    return stop(
      1,
      `the posted marker (comment ${id}) no longer reads as a manual run's marker${kept}`,
    );
  return stop(
    EARLIER,
    `an earlier marker (comment ${seen.marker.id} by ${seen.marker.login}) holds the follow-up; stop before acting${kept}`,
  );
}

type Seen = Extract<Awaited<ReturnType<typeof check>>, { ok: true }>["value"];

/**
 * Whether the marker `check` and `done` were given may be acted on: its run,
 * or the exit code and message that stop the command.
 */
function ownStanding(
  { own, verdict, winner }: Seen,
  args: MarkerArguments & { comment: number },
): { refused: { code: number; message: string } } | { run: unknown } {
  if (own === null || !own.trusted)
    return {
      refused: {
        code: 2,
        message: `comment ${args.comment} is not a trusted follow-up marker of PR #${args.pr}`,
      },
    };
  if (!own.record.ok)
    return {
      refused: {
        code: 2,
        message: `comment ${args.comment} no longer reads as a follow-up marker: ${own.record.failure.reason}`,
      },
    };
  if (verdict === "lost-to" && winner !== null)
    return {
      refused: {
        code: EARLIER,
        message: `an earlier marker (comment ${winner.id} by ${winner.login}) holds the follow-up; stop before acting`,
      },
    };
  return { run: own.record.value.payload.run };
}

async function checkOrDone(
  slug: string,
  args: MarkerArguments & { comment: number },
): Promise<number> {
  const login = await resolveLogin();
  const seen = await check(
    followupTarget(slug, args.pr),
    FOLLOWUP_CLAIM,
    FOLLOWUP_KEY,
    args.comment,
    { self: login },
  );
  if (!seen.ok)
    return stop(1, `the markers could not be read: ${seen.failure.reason}`);
  const standing = ownStanding(seen.value, args);
  if ("refused" in standing)
    return stop(standing.refused.code, standing.refused.message);
  if (args.verb === "check") return 0;
  if (standing.run !== "manual")
    return stop(
      2,
      `comment ${args.comment} is the tick's marker: its session records its result through jig dispatch result`,
    );
  const edited = await editMarker(
    slug,
    args.comment,
    manualMarker(true, { pr: args.pr, writer: localWriter("forge", login) }),
  );
  return edited === ""
    ? 0
    : stop(1, `the marker could not be marked done: ${edited}`);
}

export async function markerMain(args: MarkerArguments): Promise<number> {
  let slug: string;
  try {
    slug = await slugOf(args.repo);
  } catch (error) {
    return stop(1, `the repository cannot be named: ${failureText(error)}`);
  }
  if (args.verb === "claim") return claim(slug, args.pr);
  if (args.comment === null)
    return stop(2, `${args.verb} needs --comment <id>, the id claim printed`);
  return checkOrDone(slug, { ...args, comment: args.comment });
}
