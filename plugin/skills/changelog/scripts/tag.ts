// Which released versions can be tagged now: the plan the `tag` job follows.
// A version is tagged on the commit that released it and on no other: the
// first commit on the integration branch's first-parent line (its own
// history, without the commits of the branches merged into it) whose
// changelog has that version's heading. It is tagged once every required
// check on that commit itself has passed; a later commit's success never
// stands in for it.
//
// A version is owed a tag when the changelog on the integration branch has
// its release heading, origin has no `<tag_prefix><version>` tag for it, and
// it is newer than the newest `<tag_prefix>x.y.z` tag origin has. With no
// such tag on origin at all, only the newest release heading is owed. So a
// repository that adopts the workflow with untagged history never has its
// old versions tagged, and published, behind its back; `status.ts` shows what
// would be tagged before the workflow runs.
//
// Versions are tagged oldest first, because once origin has a newer tag an
// older version is no longer owed one: a version whose checks passed waits
// while an older owed version is `pending` or `rerun`. An older `failed`
// version holds nothing back. It is left for a person, its failed run of
// this plan is the report, and once a newer version is tagged it is no
// longer owed a tag, so neither this plan nor `status.ts` lists it again.
// Each version owed gets one state:
//   ready     every required check passed and no older owed version is
//             still pending or to be run again: the tag can be made
//   pending   a required check is still queued or running, or has not
//             reported yet; or every check passed and the version waits
//             for an older one (`waitsFor` names its tag)
//   rerun     a required check was cancelled, none failed, and the workflow
//             run it belongs to has not been run again: the run's attempt
//             number, which GitHub raises with every re-run, is still 1
//   failed    a required check failed, or was cancelled again once its
//             workflow run's attempt is past 1, or was cancelled outside a
//             workflow run that can be run again, or the hosting service
//             refused to run it again (GitHub refuses a run older than 30
//             days): left untagged for a person
//   imported  its heading arrived in one commit with other release headings
//             (a changelog brought in with its history), so no commit
//             released it: tagged by hand when it is owed a tag at all
//
// The required checks are `ci.required_checks` when the repository's
// `.config/jig.yaml` on the integration branch sets it (`[]` means none),
// else the checks the branch's rules require (classic protection and
// rulesets together). With neither the plan fails closed: no required checks
// known.
//
// The changelog, the `changelog:` and `ci.required_checks` configuration and
// the history are read from the integration branch, the repository's own
// file only (no person's settings, no environment variable), and the tags
// from origin, never from the working tree or this clone's tags. A shallow clone is refused: its oldest
// commit would read as the one that released every version it already names.
// It makes no tag: the template's push job creates the tags of the plan's
// `ready` list through the hosting service's API, running nothing from the
// repository.
//
// Usage: bun tag.ts [--root <dir>] [--json] [--rerun]
//   --json   print the plan as JSON: { plugin, configured, branch, ref,
//            tagPrefix, newestTag, requiredChecks: { source, names },
//            versions: [...], ready: [{ tag, commit, message }],
//            reruns: [...] }
//   --rerun  run the cancelled required checks' workflow runs again, once
//            (state `rerun`); needs a token allowed to re-run workflows
// Without --rerun it writes nothing and asks the hosting service only to read.
// Exit: 0 a plan was made (also when nothing is owed a tag, and when the
// repository has not turned the skill on); 1 a version failed: its releasing
// commit failed its required checks, or a re-run it needed was refused (the
// plan is still printed in full, its `ready` list included); 2 a usage
// error, an invalid configuration, a shallow clone, no required checks known,
// or something git or the hosting service could not answer.
import { parseArgs } from "node:util";
import { resolve as resolvePath } from "node:path";
import { fail, runMain } from "../../../shared/cli.ts";
import { valueAt } from "../../../shared/config-layers.ts";
import { consumerRoot } from "../../../shared/consumer.ts";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import { isDistinctNameList } from "../../../shared/guards.ts";
import { pluginVersion } from "../../../shared/plugin-version.ts";
import { banner } from "./banner.ts";
import { integrationBranch, remoteRef } from "./branches.ts";
import {
  configAtBase,
  loadChangelogConfig,
  overlayAt,
  type Resolved,
  resolve,
} from "./config.ts";
import { ChangelogError, ConfigurationError } from "./errors.ts";
import { type Format, releasedVersions } from "./formats.ts";
import {
  type CommitCheck,
  type Hosting,
  hostingFor,
  type RequiredCheck,
} from "./hosting.ts";
import { gitEnv } from "./notes-dir.ts";

type Env = Record<string, string | undefined>;

export type TagState = "ready" | "pending" | "rerun" | "failed" | "imported";

/** What one required check says on the releasing commit. */
export interface CheckVerdict {
  name: string;
  verdict: "passed" | "failed" | "pending" | "missing" | "rerun";
  /** One phrase for a person. */
  detail: string;
  url?: string;
  /** The workflow run to run again, for a `rerun` verdict. */
  run?: number;
}

/** A released version origin has no tag for. */
export interface TagEntry {
  version: string;
  tag: string;
  /** The releasing commit. */
  commit: string;
  state: TagState;
  /** One sentence for a person. */
  detail: string;
  checks: CheckVerdict[];
  /** The workflow runs `--rerun` runs again, for state `rerun`. */
  rerun: number[];
  /**
   * The older version's tag this one waits for: its own checks passed, but
   * it is held back (state `pending`) until that one is tagged or fails.
   */
  waitsFor?: string;
}

/** A tag the push job creates: an annotated tag `tag` on `commit`, saying `message`. */
export interface ReadyTag {
  tag: string;
  commit: string;
  message: string;
}

export interface TagPlan {
  plugin: string | null;
  configured: true;
  /** The integration branch, and the revision of it that was read. */
  branch: string;
  ref: string;
  tagPrefix: string;
  /** The newest `<tagPrefix>x.y.z` tag on origin, which only newer versions are owed after; null when origin has none. */
  newestTag: string | null;
  /** Null when no version was owed a tag, so none were read. */
  requiredChecks: {
    source: "configuration" | "branch rules";
    names: string[];
  } | null;
  /** Every version owed a tag, oldest first. */
  versions: TagEntry[];
  /** The `ready` versions' tags, oldest first: what the push job creates. */
  ready: ReadyTag[];
  /** What `--rerun` asked for; empty without it. */
  reruns: { run: number; requested: boolean; detail?: string }[];
}

/** How long one git call may take; one to origin, credential helper included, longer. */
const GIT_TIMEOUT_MS = 30_000;
const REMOTE_TIMEOUT_MS = 60_000;

/** git's output; throws, naming the call, when it fails or outlives its deadline. */
function git(root: string, args: string[], timeout = GIT_TIMEOUT_MS): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    env: gitEnv(),
    timeout,
  });
  if (result.error || result.status !== 0)
    throw new ChangelogError(
      `git ${args.join(" ")} failed: ${result.error ? `${result.error.message}; ` : ""}${String(result.stderr ?? "").trim()}`,
    );
  return String(result.stdout);
}

/** A file at a revision; null when the revision's tree has no such file. */
function fileAt(root: string, rev: string, path: string): string | null {
  if (!git(root, ["ls-tree", "--name-only", rev, "--", path]).trim())
    return null;
  return git(root, ["show", `${rev}:${path}`]);
}

/** Refuse a shallow clone, whose history does not reach the releasing commits. */
export function refuseShallow(root: string): void {
  if (git(root, ["rev-parse", "--is-shallow-repository"]).trim() !== "false")
    throw new ChangelogError(
      `${root} is a shallow clone, so the commit that released each version cannot be told: fetch the full history (\`git fetch --unshallow origin\`, or \`fetch-depth: 0\` in CI)`,
    );
}

/**
 * The tag names on origin, read from origin itself, so this clone's tags (one
 * whose push failed among them) count for nothing.
 */
export function originTags(root: string, prefix: string): Set<string> {
  const listing = git(
    root,
    ["ls-remote", "--tags", "origin", ...(prefix ? [`${prefix}*`] : [])],
    REMOTE_TIMEOUT_MS,
  );
  const names = new Set<string>();
  for (const line of listing.split("\n")) {
    const name = /^\S+\trefs\/tags\/(.+?)(?:\^\{\})?$/.exec(line)?.[1];
    if (name) names.add(name);
  }
  return names;
}

/**
 * Each version's releasing commit: the first commit, oldest first, on
 * `ref`'s first-parent line whose `file` has its heading, with how many
 * release headings that commit added at once. Only commits that changed the
 * file against their first parent can be the first to hold a heading, so only
 * those are read.
 */
export function releasingCommits(
  root: string,
  ref: string,
  file: string,
  format: Format,
  versions: readonly string[],
): Map<string, { commit: string; added: number }> {
  const wanted = new Set(versions);
  const found = new Map<string, { commit: string; added: number }>();
  const commits = git(root, [
    "log",
    "--first-parent",
    "--reverse",
    "--format=%H",
    ref,
    "--",
    file,
  ])
    .split("\n")
    .filter(Boolean);
  let before = new Set<string>();
  for (const commit of commits) {
    const text = fileAt(root, commit, file);
    const now = new Set(text === null ? [] : releasedVersions(text, format));
    const added = [...now].filter((v) => !before.has(v));
    for (const version of added)
      if (wanted.has(version) && !found.has(version))
        found.set(version, { commit, added: added.length });
    if (found.size === wanted.size) break;
    before = now;
  }
  return found;
}

/**
 * `ci.required_checks` as the repository's `.config/jig.yaml` at `ref` sets
 * it; undefined when unset. An empty list is a deliberate "none".
 */
export function configuredChecks(
  root: string,
  ref: string,
): string[] | undefined {
  return overlayAt(root, ref, (parsed) => {
    const value = parsed ? valueAt(parsed, "ci.required_checks") : undefined;
    if (value === undefined || value === null) return undefined;
    if (!isDistinctNameList(value))
      throw new ConfigurationError(
        "ci.required_checks must be a list of distinct nonempty check names",
      );
    return value;
  });
}

const RANK: Record<CheckVerdict["verdict"], number> = {
  passed: 0,
  pending: 1,
  missing: 1,
  rerun: 2,
  failed: 3,
};

/** What one reported result says for the tag, a cancelled one by its workflow run. */
function verdictOf(check: CommitCheck): CheckVerdict {
  const url = check.url ? { url: check.url } : {};
  const base = { name: check.name, ...url };
  if (check.outcome === "passed")
    return { ...base, verdict: "passed", detail: check.conclusion };
  if (check.outcome === "failed")
    return { ...base, verdict: "failed", detail: check.conclusion };
  if (check.outcome === "pending")
    return { ...base, verdict: "pending", detail: check.conclusion };
  const run = check.run;
  if (!run)
    return {
      ...base,
      verdict: "failed",
      detail:
        "cancelled, and no workflow run reported it, so it cannot be run again",
    };
  if (!run.completed)
    return {
      ...base,
      verdict: "pending",
      detail: `cancelled, in workflow run ${run.id}, which is still going`,
    };
  if (run.attempt > 1)
    return {
      ...base,
      verdict: "failed",
      detail: `cancelled again after workflow run ${run.id} was run again`,
    };
  return {
    ...base,
    verdict: "rerun",
    detail: `cancelled; workflow run ${run.id} is run again once`,
    run: run.id,
  };
}

/**
 * What a required check says on the commit: the worst of its results. A
 * check pinned to apps needs a check run from each; an unpinned one counts
 * every check run and commit status of its name. None at all is `missing`.
 */
export function judgeCheck(
  required: RequiredCheck,
  checks: readonly CommitCheck[],
): CheckVerdict {
  const named = checks.filter((c) => c.name === required.name);
  const results = required.apps.length
    ? required.apps.map((app) => {
        const found = named.find(
          (c) => c.kind === "check-run" && c.app === app,
        );
        return found
          ? verdictOf(found)
          : ({
              name: required.name,
              verdict: "missing",
              detail: `not reported by app ${app}`,
            } satisfies CheckVerdict);
      })
    : named.map(verdictOf);
  if (results.length === 0)
    return { name: required.name, verdict: "missing", detail: "not reported" };
  return results.reduce((worst, r) =>
    RANK[r.verdict] > RANK[worst.verdict] ? r : worst,
  );
}

/** A version's state from its required checks' verdicts, with a sentence saying why. */
export function stateOf(verdicts: readonly CheckVerdict[]): {
  state: Exclude<TagState, "imported">;
  detail: string;
} {
  const names = (v: CheckVerdict["verdict"][]) =>
    verdicts
      .filter((c) => v.includes(c.verdict))
      .map((c) => c.name)
      .join(", ");
  if (verdicts.some((c) => c.verdict === "failed"))
    return { state: "failed", detail: `failed: ${names(["failed"])}` };
  if (verdicts.some((c) => c.verdict === "rerun"))
    return {
      state: "rerun",
      detail: `cancelled, to be run again once: ${names(["rerun"])}`,
    };
  if (verdicts.some((c) => c.verdict === "pending" || c.verdict === "missing"))
    return {
      state: "pending",
      detail: `waiting for: ${names(["pending", "missing"])}`,
    };
  return {
    state: "ready",
    detail: verdicts.length
      ? "every required check passed"
      : "no check is required (ci.required_checks is [])",
  };
}

/** The required checks the plan holds a releasing commit to, and where they came from. */
function requiredChecksFor(
  root: string,
  branch: string,
  ref: string,
  hosting: Hosting | null,
): { source: "configuration" | "branch rules"; checks: RequiredCheck[] } {
  const configured = configuredChecks(root, ref);
  if (configured !== undefined)
    return {
      source: "configuration",
      checks: configured.map((name) => ({ name, apps: [] })),
    };
  if (!hosting)
    throw new ChangelogError(
      "no required checks known: the repository's host has no adapter to read the branch's rules from; list them in ci.required_checks in .config/jig.yaml",
    );
  const derived = hosting.requiredChecks(branch);
  if (!derived.known)
    throw new ChangelogError(
      `cannot read the checks ${branch}'s rules require (${derived.detail}); retry, or list them in ci.required_checks in .config/jig.yaml`,
    );
  if (derived.value.length === 0)
    throw new ConfigurationError(
      `no required checks known: ${branch}'s rules require none, and ci.required_checks is not set. List the checks a release must pass in ci.required_checks in .config/jig.yaml, or set it to [] to tag without any`,
    );
  return { source: "branch rules", checks: derived.value };
}

/** How the plan reads what lies outside the repository's history. */
export interface PlanSources {
  hosting: Hosting | null;
  /** Origin's tag names; `originTags` unless a test answers. */
  tags?: (root: string, prefix: string) => Set<string>;
}

/**
 * The plan for the repository at `root`: each released version origin has no
 * tag for, with its releasing commit and state. Null when the integration
 * branch's configuration does not turn the skill on. Throws a
 * `ConfigurationError` for a configuration it refuses, and a `ChangelogError`
 * for anything it cannot read.
 */
export function planTags(
  root: string,
  sources: PlanSources,
  env: Env = process.env,
): TagPlan | null {
  const { hosting } = sources;
  const branch = integrationBranch(root, env, hosting);
  if (branch === null)
    throw new ChangelogError(
      "cannot tell the integration branch: set repository.base_branch, or give the clone an origin/HEAD",
    );
  const ref = remoteRef(root, branch);
  refuseShallow(root);
  const config = configAtBase(root, ref);
  if (config === null) return null;
  const resolved: Resolved = resolve(root, config, (path) =>
    fileAt(root, ref, path),
  );
  const prefix = resolved.tagPrefix;
  const changelog = fileAt(root, ref, resolved.changelog) ?? "";
  const tagged = (sources.tags ?? originTags)(root, prefix);
  const newest = newestTag(tagged, prefix);
  const owed = owedVersions(
    releasedVersions(changelog, resolved.format),
    tagged,
    prefix,
    newest,
  );
  const plan: TagPlan = {
    plugin: pluginVersion(),
    configured: true,
    branch,
    ref,
    tagPrefix: prefix,
    newestTag: newest === null ? null : `${prefix}${newest}`,
    requiredChecks: null,
    versions: [],
    ready: [],
    reruns: [],
  };
  if (owed.length === 0) return plan;
  const releasing = releasingCommits(
    root,
    ref,
    resolved.changelog,
    resolved.format,
    owed,
  );
  const required = requiredChecksFor(root, branch, ref, hosting);
  plan.requiredChecks = {
    source: required.source,
    names: required.checks.map((c) => c.name),
  };
  const checksOf = commitChecksReader(hosting);
  plan.versions = owed.map((version) => {
    const tag = `${prefix}${version}`;
    const found = releasing.get(version);
    if (!found)
      throw new ChangelogError(
        `${tag}: no commit on ${ref}'s first-parent line has its heading, which the branch's changelog holds`,
      );
    return entryFor(version, tag, found, () =>
      required.checks.map((r) => judgeCheck(r, checksOf(found.commit))),
    );
  });
  settle(plan);
  return plan;
}

/**
 * Hold back each version whose own checks passed while an older owed version
 * is still `pending` or `rerun`, then list the `ready` tags. Versions are
 * tagged oldest first: once a newer tag is on origin, an older version is no
 * longer owed one, so tagging past one still on its way would drop it. A
 * `failed` or `imported` older version holds nothing back: it is left for a
 * person. Run again after a state changes, it first releases what it held.
 */
export function settle(plan: TagPlan): void {
  let waiting: TagEntry | undefined;
  for (const v of plan.versions) {
    if (v.waitsFor !== undefined) {
      v.state = "ready";
      v.detail = stateOf(v.checks).detail;
      delete v.waitsFor;
    }
    if (v.state === "ready" && waiting) {
      v.state = "pending";
      v.waitsFor = waiting.tag;
      v.detail = `every required check passed; waits for ${waiting.tag} (${waiting.state}), which is tagged first`;
    } else if (!waiting && (v.state === "pending" || v.state === "rerun"))
      waiting = v;
  }
  plan.ready = plan.versions
    .filter((v) => v.state === "ready")
    .map((v) => ({ tag: v.tag, commit: v.commit, message: v.tag }));
}

/** A release version, `x.y.z` with an optional pre-release and build. */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The newest version among origin's `<prefix>x.y.z` tags; null when it has none. */
export function newestTag(tags: Set<string>, prefix: string): string | null {
  const versions = [...tags]
    .filter((t) => t.startsWith(prefix))
    .map((t) => t.slice(prefix.length))
    .filter((v) => VERSION.test(v));
  return versions.toSorted((a, b) => Bun.semver.order(b, a))[0] ?? null;
}

/**
 * The released versions owed a tag, oldest first: those without one that are
 * newer than `newest`, origin's newest tagged version; only the newest
 * released version when origin has none.
 */
export function owedVersions(
  released: readonly string[],
  tagged: Set<string>,
  prefix: string,
  newest: string | null,
): string[] {
  const untagged = released
    .filter((v) => !tagged.has(`${prefix}${v}`))
    .toSorted((a, b) => Bun.semver.order(a, b));
  if (newest !== null)
    return untagged.filter((v) => Bun.semver.order(v, newest) > 0);
  const latest = released.toSorted((a, b) => Bun.semver.order(b, a))[0];
  return untagged.filter((v) => v === latest);
}

/** Reads a commit's checks from `hosting`, each commit once. */
function commitChecksReader(
  hosting: Hosting | null,
): (commit: string) => CommitCheck[] {
  const checksOf = new Map<string, CommitCheck[]>();
  return (commit) => {
    const known = checksOf.get(commit);
    if (known) return known;
    if (!hosting)
      throw new ChangelogError(
        `cannot read the checks of ${commit}: the repository's host has no adapter`,
      );
    const answer = hosting.commitChecks(commit);
    if (!answer.known)
      throw new ChangelogError(
        `cannot read the checks of ${commit.slice(0, 7)} (${answer.detail})`,
      );
    checksOf.set(commit, answer.value);
    return answer.value;
  };
}

/**
 * The plan's entry for `version`, released by `found.commit`: imported when
 * its heading arrived with others in one commit, else in the state `judge`'s
 * verdicts on the commit's required checks give.
 */
function entryFor(
  version: string,
  tag: string,
  found: { commit: string; added: number },
  judge: () => CheckVerdict[],
): TagEntry {
  const { commit, added } = found;
  if (added > 1)
    return {
      version,
      tag,
      commit,
      state: "imported",
      detail: `its heading arrived with ${added - 1} other release heading(s) in one commit, so no commit released it: tag it by hand if it is owed a tag`,
      checks: [],
      rerun: [],
    };
  const verdicts = judge();
  const { state, detail } = stateOf(verdicts);
  return {
    version,
    tag,
    commit,
    state,
    detail,
    checks: verdicts,
    rerun: [
      ...new Set(
        verdicts.flatMap((v) =>
          v.verdict === "rerun" && v.run !== undefined ? [v.run] : [],
        ),
      ),
    ],
  };
}

/**
 * Run each `rerun` version's cancelled workflow runs again, each run once;
 * records what was asked. A version whose re-run was refused fails, with the
 * reason: it stays untagged for a person, and the other versions' plan holds.
 */
export function rerunCancelled(plan: TagPlan, hosting: Hosting): void {
  const runs = new Set(
    plan.versions.flatMap((v) => (v.state === "rerun" ? v.rerun : [])),
  );
  const refusals = new Map<number, string>();
  for (const run of runs) {
    const refused = hosting.rerun(run);
    if (refused !== null) refusals.set(run, refused);
    plan.reruns.push(
      refused === null
        ? { run, requested: true }
        : { run, requested: false, detail: refused },
    );
  }
  for (const v of plan.versions) {
    const refused = v.rerun.filter((run) => refusals.has(run));
    if (v.state !== "rerun" || refused.length === 0) continue;
    v.state = "failed";
    v.detail = `a cancelled check could not be run again: ${refused.map((run) => `workflow run ${run} (${refusals.get(run)})`).join(", ")}`;
  }
  settle(plan);
}

/** The plan as a person reads it. */
export function describePlan(plan: TagPlan): string[] {
  const lines = [
    banner("tag"),
    `integration branch: ${plan.branch} (${plan.ref})`,
  ];
  if (plan.newestTag !== null)
    lines.push(
      `newest tag on origin: ${plan.newestTag} (only versions after it are owed one)`,
    );
  if (plan.versions.length === 0) {
    lines.push("nothing to tag: no released version owed a tag lacks one");
    return lines;
  }
  if (plan.requiredChecks)
    lines.push(
      `required checks (${plan.requiredChecks.source}): ${plan.requiredChecks.names.join(", ") || "none"}`,
    );
  lines.push(...plan.versions.flatMap(describeEntry));
  for (const r of plan.reruns)
    lines.push(
      r.requested
        ? `re-run requested: workflow run ${r.run}`
        : `re-run refused: workflow run ${r.run} (${r.detail})`,
    );
  return lines;
}

/** A version's line of the plan, each of its checks that did not pass beneath it. */
function describeEntry(v: TagEntry): string[] {
  return [
    `${v.tag}  ${v.state}  ${v.commit.slice(0, 12)}  ${v.detail}`,
    ...v.checks
      .filter((c) => c.verdict !== "passed")
      .map(
        (c) =>
          `  ${c.name}: ${c.verdict} (${c.detail})${c.url ? ` ${c.url}` : ""}`,
      ),
  ];
}

/** Make the plan for the repository at `root` and report it; the exit status for the command line. */
export function runTag(
  root: string,
  options: { json: boolean; rerun: boolean },
  env: Env = process.env,
  sources: PlanSources = { hosting: hostingFor(root) },
): number {
  // A repository that has not turned the skill on is told so before the
  // integration branch is looked for, which it may not be able to name.
  const plan =
    loadChangelogConfig(root, env) === null
      ? null
      : planTags(root, sources, env);
  if (plan === null) {
    console.log(
      options.json
        ? JSON.stringify({ plugin: pluginVersion(), configured: false })
        : `${banner("tag")}\nnot configured (no changelog.file in .config/jig.yaml)`,
    );
    return 0;
  }
  if (options.rerun && sources.hosting) rerunCancelled(plan, sources.hosting);
  if (options.json) console.log(JSON.stringify(plan));
  else for (const line of describePlan(plan)) console.log(line);
  return plan.versions.some((v) => v.state === "failed") ? 1 : 0;
}

if (import.meta.main)
  runMain("tag", async () => {
    try {
      const { values } = parseArgs({
        options: {
          root: { type: "string" },
          json: { type: "boolean", default: false },
          rerun: { type: "boolean", default: false },
        },
      });
      return runTag(values.root ? resolvePath(values.root) : consumerRoot(), {
        json: values.json,
        rerun: values.rerun,
      });
    } catch (error) {
      fail(2, error instanceof Error ? error.message : String(error));
    }
  });
