/**
 * `jig dispatch marker claim|check|done <PR>`: how a follow-up command
 * honours the follow-up marker (`lib/followup-marker.ts`), whether a person
 * ran it or the tick started it.
 *
 * - `claim` posts a manual run's marker and reads the markers back: when an
 *   earlier trusted marker is there, it deletes its own and exits 3, and
 *   the run stops before it acts. It prints the marker's comment id.
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
import { resolveLogin } from "../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import {
  deleteMarker,
  earlierThan,
  readBack,
  editMarker,
  manualMarker,
  postMarker,
  readMarkers,
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
  const posted = await postMarker(slug, pr, manualMarker(false));
  if (typeof posted === "string")
    return stop(1, `the marker could not be posted: ${posted}`);
  const seen = readBack(await readMarkers(slug, pr, login), posted);
  if (seen.kind === "stands") {
    console.log(JSON.stringify({ pr, comment: posted }));
    return 0;
  }
  const deleted = await deleteMarker(slug, posted);
  const kept =
    deleted === ""
      ? ""
      : `; its own marker (comment ${posted}) could not be deleted (${deleted}): delete it by hand`;
  if (seen.kind === "unreadable")
    return stop(1, `the markers could not be read back: ${seen.reason}${kept}`);
  if (seen.kind === "missing")
    return stop(
      1,
      `the read-back does not list the posted marker (comment ${posted}); retry${kept}`,
    );
  return stop(
    EARLIER,
    `an earlier marker (comment ${seen.marker.id} by ${seen.marker.login}) holds the follow-up; stop before acting${kept}`,
  );
}

async function checkOrDone(
  slug: string,
  args: MarkerArguments & { comment: number },
): Promise<number> {
  const markers = await readMarkers(slug, args.pr, await resolveLogin());
  if ("unreadable" in markers)
    return stop(1, `the markers could not be read: ${markers.unreadable}`);
  const own = markers.find((m) => m.id === args.comment && m.trusted);
  if (own === undefined)
    return stop(
      2,
      `comment ${args.comment} is not a trusted follow-up marker of PR #${args.pr}`,
    );
  const earlier = earlierThan(markers, args.comment);
  if (earlier !== null)
    return stop(
      EARLIER,
      `an earlier marker (comment ${earlier.id} by ${earlier.login}) holds the follow-up; stop before acting`,
    );
  if (args.verb === "check") return 0;
  if (own.run.kind !== "manual")
    return stop(
      2,
      `comment ${args.comment} is the tick's marker: its session records its result through jig dispatch result`,
    );
  const edited = await editMarker(slug, args.comment, manualMarker(true));
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
