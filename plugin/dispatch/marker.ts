/**
 * `jig dispatch marker claim|check|done <PR>`: how a follow-up command
 * honours the follow-up marker, the follow-up stage's shared record
 * (`shared/records/shared.ts`, on the forge through `shared-forge.ts`),
 * whether a person ran it or the tick started it.
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
 *   records its result through `jig dispatch result`, and the tick writes
 *   it onto the marker.
 *
 * `--repo owner/name` names the repository; without it, the current
 * checkout's.
 *
 * Exit codes: 0 done; 1 the forge could not be read or written; 2 usage, or
 * a comment that is not a trusted marker of this pull request; 3 an earlier
 * marker holds the follow-up.
 */
import type {
  CheckAnswer,
  SharedRecords,
  SharedTarget,
} from "../shared/records/shared.ts";
import { forgeShared } from "../shared/records/shared-forge.ts";
import { localWriter } from "../shared/records/writer.ts";
import { ok, type Outcome } from "../shared/outcome.ts";
import { resolveLogin } from "../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import { repoTarget } from "./lib/forge.ts";
import { failureText } from "./lib/text.ts";

export interface MarkerArguments {
  verb: "claim" | "check" | "done";
  pr: number;
  comment: number | null;
  repo: string | null;
}

const EARLIER = 3;

async function slugOf(
  repo: string | null,
): Promise<Outcome<string, "unreadable">> {
  if (repo !== null) return ok(repo);
  const target = await repoTarget(process.cwd());
  return target.ok ? ok(target.value.slug) : target;
}

function stop(code: number, message: string): number {
  console.error(`jig dispatch marker: ${message}`);
  return code;
}

const earlier = (by: { id: number; login: string }, kept = "") =>
  stop(
    EARLIER,
    `an earlier marker (comment ${by.id} by ${by.login}) holds the follow-up; stop before acting${kept}`,
  );

async function claim(
  shared: SharedRecords,
  target: SharedTarget,
  login: string | null,
): Promise<number> {
  const { pr } = target;
  const answer = await shared.claim(target, {
    stage: "followup",
    pr,
    run: "manual",
    action: "followup",
    record: null,
    host: null,
    owner: null,
    writer: localWriter("forge", login),
  });
  if (!answer.ok)
    return stop(1, `the marker could not be posted: ${answer.failure.reason}`);
  const seen = answer.value;
  if (seen.kind === "holds") {
    console.log(JSON.stringify({ pr, comment: seen.id }));
    return 0;
  }
  if (seen.kind === "held") return earlier(seen.by);
  const { id } = seen;
  if (seen.kind === "done")
    return stop(
      1,
      `the posted marker (comment ${id}) was marked done before the read-back finished; it is kept as the completion record, so do not act`,
    );
  const deleted = await shared.release(target, id);
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
  return earlier(seen.by, kept);
}

/**
 * Whether the marker `check` and `done` were given may be acted on: its run,
 * or the exit code and message that stop the command.
 */
function ownStanding(
  { own, verdict, winner }: CheckAnswer,
  args: MarkerArguments & { comment: number },
): { refused: { code: number; message: string } } | { run: "tick" | "manual" } {
  if (own === null || !own.trusted)
    return {
      refused: {
        code: 2,
        message: `comment ${args.comment} is not a trusted follow-up marker of PR #${args.pr}`,
      },
    };
  if (!own.says.ok)
    return {
      refused: {
        code: 2,
        message: `comment ${args.comment} no longer reads as a follow-up marker: ${own.says.failure.reason}`,
      },
    };
  if (verdict === "lost-to" && winner !== null)
    return {
      refused: {
        code: EARLIER,
        message: `an earlier marker (comment ${winner.id} by ${winner.login}) holds the follow-up; stop before acting`,
      },
    };
  return { run: own.says.value.run };
}

async function checkOrDone(
  shared: SharedRecords,
  target: SharedTarget,
  args: MarkerArguments & { comment: number },
): Promise<number> {
  const seen = await shared.check(target, "followup", args.comment);
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
  const ended = await shared.end(target, "followup", args.comment, {
    state: "ended",
    at: new Date().toISOString(),
    exit: null,
    outcome: "done",
  });
  return ended.ok
    ? 0
    : stop(1, `the marker could not be marked done: ${ended.failure.reason}`);
}

export async function markerMain(args: MarkerArguments): Promise<number> {
  let named: Outcome<string, "unreadable">;
  try {
    named = await slugOf(args.repo);
  } catch (error) {
    return stop(1, `the repository cannot be named: ${failureText(error)}`);
  }
  if (!named.ok)
    return stop(1, `the repository cannot be named: ${named.failure.reason}`);
  const slug = named.value;
  const login = await resolveLogin();
  const shared = forgeShared({ login });
  const target = { repo: slug, pr: args.pr };
  if (args.verb === "claim") return claim(shared, target, login);
  if (args.comment === null)
    return stop(2, `${args.verb} needs --comment <id>, the id claim printed`);
  return checkOrDone(shared, target, { ...args, comment: args.comment });
}
