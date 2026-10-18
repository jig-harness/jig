// What only the hosting service knows, behind one interface so a second
// service can be added without touching the commands: the repository's
// default branch, and whether the last release run on the integration branch
// succeeded. GitHub is read through `gh`; without `gh`, or on another host,
// each answer degrades to "unknown" and no command fails for it.
import { swallow } from "../../../shared/errors.ts";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import { decodeJson, isRecord } from "../../../shared/guards.ts";
import { gitEnv, tryGit } from "./notes-dir.ts";
import { parseRemote } from "./remote.ts";

/** Runs `gh` with `args` in `cwd`; its output, or null when it cannot answer. */
export type Gh = (args: string[], cwd: string) => string | null;

const GH_TIMEOUT_MS = 30_000;

/** `gh`, with a deadline; null when it is missing, signed out or fails. */
export const runGh: Gh = (args, cwd) => {
  const result = spawnSync("gh", args, {
    cwd,
    env: gitEnv(),
    timeout: GH_TIMEOUT_MS,
  });
  return result.error || result.status !== 0 ? null : result.stdout;
};

export type RunState = "success" | "failure" | "running" | "none" | "unknown";

/** The release workflow's newest run still going on the integration branch, else its newest run. */
export interface ReleaseRun {
  state: RunState;
  /** One sentence for a person. */
  detail: string;
  url?: string;
}

/** A hosting service the commands can ask. */
export interface Hosting {
  name: string;
  /** The repository's default branch; null when the service does not say. */
  defaultBranch(): string | null;
  /** The newest release run still going on `branch`, else the newest release run. */
  lastReleaseRun(branch: string): ReleaseRun;
}

/** The text of a field of a run `gh` listed; undefined when it is not text. */
const text = (run: Record<string, unknown>, key: string): string | undefined =>
  typeof run[key] === "string" ? run[key] : undefined;

/** How many workflows, and runs of one listing, `gh` is asked for. */
const WORKFLOW_LIMIT = 1000;
const RUN_LIMIT = 100;
/** The fields of a run `gh` is asked for. */
const RUN_FIELDS = "databaseId,status,conclusion,url,headSha,createdAt";
/** How many listings of runs one workflow's read may take. */
const RUN_PAGES = 20;

/**
 * How far back a run can still be going. GitHub ends a run 35 days after it
 * starts, waiting and approval included, and re-runs one at most 30 days
 * after it was created; a day more covers a clock that is off.
 */
const ACTIVE_HORIZON_DAYS = 30 + 35 + 1;

/** The unknown answer for a listing `gh` cut short at its limit. */
const truncated = (what: string): ReleaseRun => ({
  state: "unknown",
  detail: `gh listed as many ${what} as asked for, so the listing may be incomplete`,
});

function isRecords(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord);
}

type Listing = Record<string, unknown>[] | ReleaseRun;

/** Asks `gh` in `root` for a listing: its records, or the unknown answer when it cannot. */
const asker =
  (gh: Gh, root: string) =>
  (args: string[], what: string): Listing => {
    const out = gh(args, root);
    if (out === null)
      return {
        state: "unknown",
        detail:
          "gh could not answer (not installed, not signed in, or offline)",
      };
    try {
      return decodeJson(out, isRecords, what);
    } catch (error) {
      swallow(error, `${what} answered with something unreadable`);
      return {
        state: "unknown",
        detail: "gh answered with something unreadable",
      };
    }
  };

/**
 * The release workflows: those named exactly `release` (the `name:` of a
 * release.yml), in any letter case. A workflow that only mentions the word,
 * such as a release-notes drafter, is not one.
 */
function releaseWorkflows(ask: ReturnType<typeof asker>): Listing {
  const workflows = ask(
    [
      "workflow",
      "list",
      "--all",
      "--limit",
      String(WORKFLOW_LIMIT),
      "--json",
      "id,name",
    ],
    "gh workflow list",
  );
  if (!Array.isArray(workflows)) return workflows;
  // `--limit` is a maximum: a full listing may have left the release
  // workflow out, so it answers nothing.
  if (workflows.length >= WORKFLOW_LIMIT) return truncated("workflows");
  return workflows.filter((w) =>
    /^release$/i.test(text(w, "name")?.trim() ?? ""),
  );
}

/**
 * Every run of a workflow on `branch` created since `since`.
 * The listings are split by when a run was created, which never changes, and
 * never by its status, which can change between two listings: so every run is
 * listed once at least, with its status as it was then, and a run going all
 * along is listed as going. Each next listing reaches back from the oldest
 * creation time the last one held; a listing that cannot reach further, a run
 * without a creation time, or more listings than `RUN_PAGES` answer nothing.
 */
function runsOf(
  ask: ReturnType<typeof asker>,
  workflow: unknown,
  branch: string,
  since: string,
): Listing {
  const runs = new Map<string, Record<string, unknown>>();
  let until: string | undefined;
  for (let page = 0; page < RUN_PAGES; page++) {
    const listed = ask(
      [
        "run",
        "list",
        "--workflow",
        String(workflow),
        "--branch",
        branch,
        "--created",
        until ? `${since}..${until}` : `>=${since}`,
        "--limit",
        String(RUN_LIMIT),
        "--json",
        RUN_FIELDS,
      ],
      "gh run list",
    );
    if (!Array.isArray(listed)) return listed;
    for (const run of listed)
      runs.set(
        String(run.databaseId ?? text(run, "url") ?? `unnamed ${runs.size}`),
        run,
      );
    if (listed.length < RUN_LIMIT) return [...runs.values()];
    const created = listed.map((run) => text(run, "createdAt"));
    if (created.includes(undefined))
      return {
        state: "unknown",
        detail: "gh listed a release run without its creation time",
      };
    const oldest = created.toSorted()[0];
    if (oldest === until)
      return truncated("release runs created in one second");
    until = oldest;
  }
  return truncated("listings of release runs");
}

/** A workflow's newest run on `branch`, of any age. */
const newestRun = (
  ask: ReturnType<typeof asker>,
  workflow: unknown,
  branch: string,
): Listing =>
  ask(
    [
      "run",
      "list",
      "--workflow",
      String(workflow),
      "--branch",
      branch,
      "--limit",
      "1",
      "--json",
      RUN_FIELDS,
    ],
    "gh run list",
  );

/** What `run`, the release run that answers, says; `none` without one. */
function answerOf(
  run: Record<string, unknown> | undefined,
  branch: string,
): ReleaseRun {
  if (!run) return { state: "none", detail: `no release run on ${branch} yet` };
  const sha = text(run, "headSha");
  const at = sha ? ` on ${sha.slice(0, 7)}` : "";
  const link = text(run, "url");
  const url = link ? { url: link } : {};
  const conclusion = text(run, "conclusion");
  if (text(run, "status") !== "completed")
    return {
      state: "running",
      detail: `a release run${at} is still going`,
      ...url,
    };
  return conclusion === "success"
    ? {
        state: "success",
        detail: `the last release run${at} succeeded`,
        ...url,
      }
    : {
        state: "failure",
        detail: `the last release run${at} ended ${conclusion ?? "without a result"}`,
        ...url,
      };
}

/** GitHub, through `gh`. */
export function github(
  root: string,
  gh: Gh = runGh,
  now: () => Date = () => new Date(),
): Hosting {
  const ask = asker(gh, root);
  return {
    name: "GitHub",
    defaultBranch() {
      const name = gh(
        [
          "repo",
          "view",
          "--json",
          "defaultBranchRef",
          "-q",
          ".defaultBranchRef.name",
        ],
        root,
      )?.trim();
      return name && /^[^\s~^:?*[\\]+$/.test(name) ? name : null;
    },
    lastReleaseRun(branch) {
      // Each release workflow's runs are read on their own, so no number of
      // other workflows' runs can push one out of the window. Runs created
      // before the horizon have ended and are not read.
      const workflows = releaseWorkflows(ask);
      if (!Array.isArray(workflows)) return workflows;
      const since = new Date(now().getTime() - ACTIVE_HORIZON_DAYS * 86_400_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z");
      const found: Record<string, unknown>[] = [];
      for (const workflow of workflows) {
        const listed = runsOf(ask, workflow.id, branch, since);
        if (!Array.isArray(listed)) return listed;
        found.push(...listed);
      }
      // None since the horizon: every run has ended, so the newest answers.
      if (found.length === 0)
        for (const workflow of workflows) {
          const listed = newestRun(ask, workflow.id, branch);
          if (!Array.isArray(listed)) return listed;
          found.push(...listed);
        }
      // The newest run first. A release run still going is never cancelled
      // by a later one: the later run waits, and a newer one replaces the
      // waiting run, cancelling that one instead. So an older run still
      // going can yet release what a newer run that ended did not, and the
      // newest run still going is the answer while there is one. Above it
      // are only the run waiting and the waiting runs it replaced.
      found.sort((a, b) =>
        (text(b, "createdAt") ?? "").localeCompare(text(a, "createdAt") ?? ""),
      );
      return answerOf(
        found.find((r) => text(r, "status") !== "completed") ?? found[0],
        branch,
      );
    },
  };
}

/**
 * The hosting service the `origin` remote is on, when Jig can ask it; null
 * for a repository without a remote or on a host with no adapter.
 */
export function hostingFor(root: string, gh: Gh = runGh): Hosting | null {
  const address = tryGit(root, ["remote", "get-url", "origin"])?.trim();
  const host = address ? parseRemote(address)?.host : undefined;
  return host && /(^|\.)github/.test(host) ? github(root, gh) : null;
}
