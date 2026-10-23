// What only the hosting service knows, behind one interface so a second
// service can be added without touching the commands: the repository's
// default branch, whether the last release run on the integration branch
// succeeded, the checks a branch's rules require, the checks a commit has
// and a way to run a cancelled check again. GitHub is read through `gh`;
// without `gh`, or on another host, each answer degrades to "unknown" and no
// command fails for it.
import {
  mergeRequiredChecks,
  protectionContexts,
  rulesetContexts,
} from "../../drive-pr/scripts/lib/ci-policy.ts";
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

/** An answer the service gave, or why it gave none. */
export type Answer<T> =
  | { known: true; value: T }
  | { known: false; detail: string };

/** A check a branch's rules require: its name, and the apps it must come from (none: any). */
export interface RequiredCheck {
  name: string;
  /** The ids of the apps the check is pinned to; each must report it. Empty for any app. */
  apps: number[];
}

/** What a check's newest result says, in words no host owns. */
export type CheckOutcome = "passed" | "failed" | "pending" | "cancelled";

/** The newest result of one check on one commit, from one app. */
export interface CommitCheck {
  name: string;
  /** A check run (with an app) or a commit status (without one). */
  kind: "check-run" | "status";
  outcome: CheckOutcome;
  /** The service's own word for the result, for a person (`timed_out`, `error`). */
  conclusion: string;
  /** The app that reported a check run; null for a commit status. */
  app: number | null;
  /** The workflow run a check run belongs to, when a workflow ran it. */
  run?: {
    id: number;
    /** Which attempt of the run this is: 1 until the run is re-run. */
    attempt: number;
    /** Whether the whole run has ended, so it can be re-run. */
    completed: boolean;
    /** How the whole run ended (`success`, `cancelled`, `failure`); absent while it runs. */
    conclusion?: string;
  };
  url?: string;
}

/** A hosting service the commands can ask. */
export interface Hosting {
  name: string;
  /** The repository's default branch; null when the service does not say. */
  defaultBranch(): string | null;
  /** The newest release run still going on `branch`, else the newest release run. */
  lastReleaseRun(branch: string): ReleaseRun;
  /** The checks `branch`'s rules require, every source of rules combined. */
  requiredChecks(branch: string): Answer<RequiredCheck[]>;
  /** The newest result of each check on `commit` itself, check runs and commit statuses both. */
  commitChecks(commit: string): Answer<CommitCheck[]>;
  /** Run the failed and cancelled jobs of workflow run `run` again; null when asked, else why not. */
  rerun(run: number): string | null;
}

/** The text of a field of a run `gh` listed; undefined when it is not text. */
const text = (run: Record<string, unknown>, key: string): string | undefined =>
  typeof run[key] === "string" ? run[key] : undefined;

/** How many workflows, and runs of one listing, `gh` is asked for. */
const WORKFLOW_LIMIT = 1000;
const RUN_LIMIT = 100;
/** The fields of a run `gh` is asked for. */
const RUN_FIELDS = "databaseId,status,conclusion,url,headSha,createdAt,event";
/**
 * The events a release run starts on. A release workflow also runs its tag
 * jobs on `workflow_run` and `schedule`, and its branch check on
 * `pull_request`; none of those runs releases anything.
 */
const RELEASE_EVENTS = new Set(["push", "workflow_dispatch"]);
/** Whether a listed run released, or tried to; a run `gh` gave no event for counts. */
const releasing = (run: Record<string, unknown>): boolean => {
  const event = text(run, "event");
  return event === undefined || RELEASE_EVENTS.has(event);
};
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
 * The release workflows: those named exactly `release` or `changelog` (the
 * `name:` of a release.yml, or of the workflow `/jig:changelog setup` copies
 * in), in any letter case. A workflow that only mentions the word, such as a
 * release-notes drafter, is not one.
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
    /^(release|changelog)$/i.test(text(w, "name")?.trim() ?? ""),
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
    for (const run of listed) runs.set(runKey(run, runs.size), run);
    if (listed.length < RUN_LIMIT) return [...runs.values()].filter(releasing);
    const next = reachBack(listed, until);
    if (typeof next !== "string") return next;
    until = next;
  }
  return truncated("listings of release runs");
}

/** What tells one listed run from another: its id, else its address. */
const runKey = (run: Record<string, unknown>, size: number): string =>
  String(run.databaseId ?? text(run, "url") ?? `unnamed ${size}`);

/**
 * The creation time the listing after `listed` reaches back from, the oldest
 * `listed` holds; the unknown answer when a run has none or the time is
 * `until` again, so the next listing could not reach further.
 */
function reachBack(
  listed: Record<string, unknown>[],
  until: string | undefined,
): string | ReleaseRun {
  const created = listed.map((run) => text(run, "createdAt"));
  if (created.includes(undefined))
    return {
      state: "unknown",
      detail: "gh listed a release run without its creation time",
    };
  const oldest = created.toSorted()[0] as string;
  return oldest === until
    ? truncated("release runs created in one second")
    : oldest;
}

/**
 * A workflow's newest release run on `branch`, of any age: the newest of each
 * event a release starts on, read apart so no number of tag runs can push it
 * out of the listing.
 */
function newestRun(
  ask: ReturnType<typeof asker>,
  workflow: unknown,
  branch: string,
): Listing {
  const found: Record<string, unknown>[] = [];
  for (const event of RELEASE_EVENTS) {
    const listed = ask(
      [
        "run",
        "list",
        "--workflow",
        String(workflow),
        "--branch",
        branch,
        "--event",
        event,
        "--limit",
        "1",
        "--json",
        RUN_FIELDS,
      ],
      "gh run list",
    );
    if (!Array.isArray(listed)) return listed;
    found.push(...listed);
  }
  return found;
}

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

/** `gh api` with `args`, every page read: the pages, or why there are none. */
function apiPages(gh: Gh, root: string, path: string): Answer<unknown[]> {
  const out = gh(["api", "--paginate", "--slurp", path], root);
  if (out === null)
    return {
      known: false,
      detail: `gh could not read ${path.replace(/\?.*$/, "")} (not installed, not signed in, offline, or not allowed)`,
    };
  try {
    const pages: unknown = JSON.parse(out);
    if (Array.isArray(pages)) return { known: true, value: pages };
  } catch (error) {
    swallow(error, `gh api ${path} answered with something unreadable`);
  }
  return {
    known: false,
    detail: `gh answered ${path.replace(/\?.*$/, "")} with something unreadable`,
  };
}

/** The records under `key` of every page; null when a page does not hold them. */
function recordsIn(
  pages: unknown[],
  key: string,
): Record<string, unknown>[] | null {
  const found: Record<string, unknown>[] = [];
  for (const page of pages) {
    const list = isRecord(page) ? page[key] : undefined;
    if (!isRecords(list)) return null;
    found.push(...list);
  }
  return found;
}

/** A positive whole number, or undefined. */
const whole = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;

/**
 * What a check run's status and conclusion say. A run that was stopped by a
 * person or a newer run is cancelled, which the tag job may run again; any
 * ending but success, neutral and skipped fails.
 */
function checkRunOutcome(
  status: string | undefined,
  conclusion: string | undefined,
  run: CommitCheck["run"],
): CheckOutcome {
  if (status !== "completed") return "pending";
  if (conclusion === "success") return "passed";
  if (conclusion === "neutral" || conclusion === "skipped")
    return unfinishedOutcome(run);
  return conclusion === "cancelled" ? "cancelled" : "failed";
}

/**
 * What a neutral or skipped check run says, which did not do its work. GitHub
 * counts it as passing a required check, and so does the tag when no workflow
 * run reported it (another app's). A workflow's job counts as its workflow run
 * ended: a job that runs unless the run is cancelled (`if: ${{ !cancelled() }}`)
 * is skipped in a cancelled run, which is that run's cancellation, not a pass.
 */
function unfinishedOutcome(run: CommitCheck["run"]): CheckOutcome {
  if (!run) return "passed";
  if (!run.completed) return "pending";
  if (run.conclusion === "success") return "passed";
  return run.conclusion === "cancelled" ? "cancelled" : "failed";
}

/** What a commit status's state says: `error` and `failure` fail, `pending` waits. */
function statusOutcome(state: string | undefined): CheckOutcome {
  if (state === "success") return "passed";
  return state === "pending" ? "pending" : "failed";
}

/**
 * The result of each check name from each app, with the workflow run it
 * belongs to. A re-run adds new check runs to the same check suite, and a
 * check run's id grows with each one created, so the highest id per name and
 * app is the newest result. A neutral or skipped check run did no work, so
 * one that did work answers before it, however old; with only those, see
 * `skippedAnswer`.
 */
function newestCheckRuns(
  checkRuns: Record<string, unknown>[],
  runs: Record<string, unknown>[],
): CommitCheck[] {
  const bySuite = new Map<number, Record<string, unknown>>();
  for (const run of runs) {
    const suite = whole(run.check_suite_id);
    if (suite !== undefined) bySuite.set(suite, run);
  }
  const groups = new Map<string, Ranked[]>();
  for (const checkRun of checkRuns) {
    const name = text(checkRun, "name");
    if (!name) continue;
    const check = checkRunCheck(checkRun, name, bySuite);
    const key = `${name}\0${check.app ?? ""}`;
    const ranked = {
      id: whole(checkRun.id) ?? 0,
      check,
      worked: worked(checkRun),
    };
    groups.set(key, [...(groups.get(key) ?? []), ranked]);
  }
  return [...groups.values()].map(answerOfGroup);
}

/** A check run with its id, and whether it did its work (any ending but neutral and skipped). */
interface Ranked {
  id: number;
  check: CommitCheck;
  worked: boolean;
}

const worked = (checkRun: Record<string, unknown>): boolean =>
  !(
    text(checkRun, "status") === "completed" &&
    ["neutral", "skipped"].includes(text(checkRun, "conclusion") ?? "")
  );

/** The newest of `group`. */
const newestOf = (group: Ranked[]): Ranked =>
  group.reduce((a, b) => (b.id > a.id ? b : a));

/** What one name and app's check runs say: the newest that did work, else `skippedAnswer`. */
function answerOfGroup(group: Ranked[]): CommitCheck {
  const did = group.filter((r) => r.worked);
  return did.length ? newestOf(did).check : skippedAnswer(group);
}

/**
 * What check runs that were all neutral or skipped say: passed when one
 * passed by its workflow run (`unfinishedOutcome`), else pending, cancelled or
 * failed in that order, the newest of that outcome answering. A job that runs
 * only on pull requests is skipped in every run on the integration branch,
 * one that failed for another reason included, and the run that released
 * the commit is enough for it.
 */
function skippedAnswer(group: Ranked[]): CommitCheck {
  for (const outcome of ["passed", "pending", "cancelled"] as const) {
    const found = group.filter((r) => r.check.outcome === outcome);
    if (found.length) return newestOf(found).check;
  }
  return newestOf(group).check;
}

/** What one check run named `name` says, with the workflow run its check suite is in `bySuite`. */
function checkRunCheck(
  checkRun: Record<string, unknown>,
  name: string,
  bySuite: Map<number, Record<string, unknown>>,
): CommitCheck {
  const status = text(checkRun, "status");
  const conclusion = text(checkRun, "conclusion");
  const url = text(checkRun, "html_url") ?? text(checkRun, "details_url");
  const workflowRun = workflowRunOf(checkRun, bySuite);
  return {
    name,
    kind: "check-run",
    outcome: checkRunOutcome(status, conclusion, workflowRun.run),
    conclusion:
      status === "completed" ? (conclusion ?? "none") : (status ?? "unknown"),
    app: isRecord(checkRun.app) ? (whole(checkRun.app.id) ?? null) : null,
    ...workflowRun,
    ...(url ? { url } : {}),
  };
}

/** The workflow run a check run belongs to, as a `run` field; empty when none in `bySuite` is. */
function workflowRunOf(
  checkRun: Record<string, unknown>,
  bySuite: Map<number, Record<string, unknown>>,
): Pick<CommitCheck, "run"> {
  const suite = isRecord(checkRun.check_suite)
    ? whole(checkRun.check_suite.id)
    : undefined;
  const workflowRun = suite === undefined ? undefined : bySuite.get(suite);
  const runId = workflowRun ? whole(workflowRun.id) : undefined;
  if (!workflowRun || runId === undefined) return {};
  const conclusion = text(workflowRun, "conclusion");
  return {
    run: {
      id: runId,
      attempt: whole(workflowRun.run_attempt) ?? 1,
      completed: text(workflowRun, "status") === "completed",
      ...(conclusion ? { conclusion } : {}),
    },
  };
}

/** The newest status of each context, as the combined status lists them. */
function newestStatuses(statuses: Record<string, unknown>[]): CommitCheck[] {
  const seen = new Map<string, CommitCheck>();
  for (const status of statuses) {
    const name = text(status, "context");
    if (!name || seen.has(name)) continue;
    const state = text(status, "state");
    const url = text(status, "target_url");
    seen.set(name, {
      name,
      kind: "status",
      outcome: statusOutcome(state),
      conclusion: state ?? "unknown",
      app: null,
      ...(url ? { url } : {}),
    });
  }
  return [...seen.values()];
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
    requiredChecks(branch) {
      // Classic branch protection and the rulesets active on the branch each
      // can require checks; every obligation applies, so both are read.
      const encoded = encodeURIComponent(branch);
      const out = gh(["api", `repos/{owner}/{repo}/branches/${encoded}`], root);
      if (out === null)
        return {
          known: false,
          detail: `gh could not read the protection of ${branch}`,
        };
      let classic: ReturnType<typeof protectionContexts> = null;
      try {
        classic = protectionContexts(JSON.parse(out));
      } catch (error) {
        swallow(error, "the branch's protection is not readable JSON");
      }
      if (classic === null)
        return {
          known: false,
          detail: `gh answered the protection of ${branch} with something unreadable`,
        };
      const rules = apiPages(
        gh,
        root,
        `repos/{owner}/{repo}/rules/branches/${encoded}?per_page=100`,
      );
      if (!rules.known) return rules;
      const fromRules = rulesetContexts(rules.value);
      if (fromRules === null)
        return {
          known: false,
          detail: `gh answered the rules of ${branch} with something unreadable`,
        };
      const merged = mergeRequiredChecks([classic, fromRules]);
      return {
        known: true,
        value: merged.names.map((name) => ({
          name,
          apps: merged.apps.get(name) ?? [],
        })),
      };
    },
    commitChecks(commit) {
      const at = encodeURIComponent(commit);
      const checkRuns = apiPages(
        gh,
        root,
        `repos/{owner}/{repo}/commits/${at}/check-runs?filter=all&per_page=100`,
      );
      if (!checkRuns.known) return checkRuns;
      const runs = apiPages(
        gh,
        root,
        `repos/{owner}/{repo}/actions/runs?head_sha=${at}&per_page=100`,
      );
      if (!runs.known) return runs;
      const statuses = apiPages(
        gh,
        root,
        `repos/{owner}/{repo}/commits/${at}/status?per_page=100`,
      );
      if (!statuses.known) return statuses;
      const checkRunList = recordsIn(checkRuns.value, "check_runs");
      const runList = recordsIn(runs.value, "workflow_runs");
      const statusList = recordsIn(statuses.value, "statuses");
      if (checkRunList === null || runList === null || statusList === null)
        return {
          known: false,
          detail: `gh answered the checks of ${commit.slice(0, 7)} with something unreadable`,
        };
      return {
        known: true,
        value: [
          ...newestCheckRuns(checkRunList, runList),
          ...newestStatuses(statusList),
        ],
      };
    },
    rerun(run) {
      // The failed jobs and those cancelled, with the jobs that depend on
      // them; jobs that passed keep their result.
      const out = gh(
        [
          "api",
          "--method",
          "POST",
          `repos/{owner}/{repo}/actions/runs/${run}/rerun-failed-jobs`,
        ],
        root,
      );
      return out === null
        ? `gh could not re-run workflow run ${run} (it needs a token with Actions write)`
        : null;
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
