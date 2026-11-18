/** The repository owner files releases carried by another host's follow-up marker. */
import { valueAt } from "../../shared/config-layers.ts";
import {
  facetsOf,
  type TrackerConfig,
} from "../../skills/do-item/scripts/lib/tracker/config.ts";
import { usable } from "../../skills/do-item/scripts/lib/tracker/facets/config.ts";
import { canonical } from "../../skills/do-item/scripts/lib/tracker/facets/values.ts";
import { openTracker } from "../../skills/do-item/scripts/lib/tracker/index.ts";
import type {
  NewIssue,
  Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import type { Level } from "../../skills/followup/scripts/lib/authority.ts";
import { parseFollowupSettings } from "../../skills/followup/scripts/lib/settings.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { stateRoot } from "../receipts.ts";
import { taggedReleases } from "./release-gates.ts";
import {
  nextReleaseHandoff,
  recordTagged,
  releaseNeedActions,
  reserveRelease,
} from "./release-needs.ts";
import { trackerConfigOf } from "./section.ts";
import { ended, type TickBound } from "./sources/bounded.ts";
import { failureText } from "./text.ts";
import type { RepoReport, RepoTarget } from "./types.ts";

interface HandoffInputs {
  repo: RepoTarget;
  values: Record<string, unknown>;
  report: RepoReport;
  now: number;
  bound?: TickBound | undefined;
  root?: string;
}

/** An owner that handles notifications can settle release handoffs without launching follow-ups. */
export function releaseStationOn(host: {
  owner: boolean;
  stages: ReadonlySet<string>;
  values: Record<string, unknown>;
}): boolean {
  return (
    host.owner &&
    (host.stages.has("followup") ||
      (host.stages.has("notify") &&
        typeof valueAt(host.values, "changelog.file") === "string"))
  );
}

export async function settleReleaseHandoff({
  repo,
  values,
  report,
  now,
  bound,
  root = stateRoot(),
}: HandoffInputs): Promise<void> {
  if (ended(bound)) return;
  const due = nextReleaseHandoff(repo.slug, now, root);
  if (due === null) return;
  const { tag, launch } = due;
  const target = `Release ${tag}`;
  function unplaced(reason: string): void {
    report.unplaced.push({ target, record: "tracker", reason });
  }

  const tags = await taggedReleases(repo, [tag], bound);
  if (!tags.ok) return unplaced(tags.failure.reason);
  if (tags.value.has(tag)) return recordTagged(repo.slug, [tag], root);
  const settings = parseFollowupSettings(values);
  if (!settings.ok) return unplaced(settings.failure.reason);

  try {
    if (ended(bound))
      return unplaced(
        "the tick ran out of time before opening the release tracker",
      );
    const config = trackerConfigOf(values, repo.slug);
    const tracker = openTracker(config, repo.path, bound?.signal);
    const issue = releaseIssue(
      repo.slug,
      tag,
      launch.slice("shared:".length),
      config,
      repo.path,
    );
    const item = await ensureReleaseItem(
      tracker,
      issue,
      settings.value.authority["file-items"],
      bound,
    );
    if (!item.ok) return unplaced(item.failure.reason);
    const attached = reserveRelease(repo.slug, tag, launch, item.value, root);
    if (!attached.ok) return unplaced(attached.failure.reason);
    if (attached.value.status === "recorded")
      report.actions.push(
        ...releaseNeedActions([{ ...due, item: attached.value.item }]),
      );
  } catch (error) {
    unplaced(failureText(error));
  }
}

function releaseIssue(
  repo: string,
  tag: string,
  source: string,
  config: TrackerConfig,
  root: string,
): NewIssue {
  const facets = facetsOf(config, root);
  const type = !usable(facets.type)
    ? {}
    : {
        type:
          canonical(facets.type.values, "chore") ??
          canonical(facets.type.values, "task") ??
          "task",
      };
  return {
    title: `Release ${repo} ${tag} owes a tag`,
    description: `[person-owed] release ${tag} owed\n\nThe follow-up of PR #${source} reported that this release still needs its tag. Check the releasing commit and its required gates before creating the tag.`,
    ...type,
    priority: 2,
    ...(usable(facets.size) ? { size: "small" } : {}),
    labels: [],
  };
}

/** Search even when filing is reserved for a person, so a manual filing can satisfy the handoff. */
async function ensureReleaseItem(
  tracker: Tracker,
  issue: NewIssue,
  authority: Level | undefined,
  bound: TickBound | undefined,
): Promise<Outcome<string, "refused">> {
  const exact = (
    await tracker.searchIssues(issue.title, { includeClosed: true })
  ).filter((found) => found.title === issue.title);
  if (exact.length > 1)
    return failed(
      "refused",
      "more than one tracker item has the release title",
    );
  const [known] = exact;
  if (known !== undefined) return ok(known.identifier);
  if ((authority ?? "own") !== "own")
    return failed(
      "refused",
      "a person must file the release item under followup.authority.file-items",
    );
  if (ended(bound))
    return failed(
      "refused",
      "the tick ran out of time before filing the release item",
    );
  const filed = await tracker.createIssue(issue);
  return ok(filed.identifier);
}
