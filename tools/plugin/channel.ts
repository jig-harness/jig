#!/usr/bin/env bun
/**
 * The `jig` plugin's release channels: `latest` carries every tagged
 * version, `stable` the versions a person promoted once they had proven
 * themselves on `latest`. Each channel is a branch of generated commits, each
 * holding the plugin as installed (tools/plugin/artifact.ts) built from one
 * version's tag, on top of the channel's previous commit, so a channel's
 * history is the record of what it carried. Trailers name the channel, the
 * action, the version and the tagged commit.
 *
 * Usage:
 *   bun tools/plugin/channel.ts status
 *   bun tools/plugin/channel.ts check <version>            the promotion rule, read-only
 *   bun tools/plugin/channel.ts promote <version> --bundle <file>
 *   bun tools/plugin/channel.ts rollback <version> --bundle <file>
 *   bun tools/plugin/channel.ts latest --bundle <file>
 *   options: --remote <name>   the remote the channels and tags are read from (origin)
 *            --repo <owner/name>  the GitHub repository for checks and issues
 *                                 ($GITHUB_REPOSITORY, else origin's)
 *
 * `promote`, `rollback` and `latest` write the channel's next commit into
 * the local repository and a git bundle of it; they push nothing. The
 * `channels` workflow (.github/workflows/channels.yml) hands the bundle to a
 * job that pushes it. Under GitHub Actions they also write `changed`,
 * `channel`, `start` and `commit` to $GITHUB_OUTPUT.
 *
 * Exit codes: 0 done (or nothing to do), 3 the rule refuses, 2 a fact could
 * not be read or usage.
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { cli, strictOptions } from "../../lib/cli.ts";
import {
  artifactTree,
  ChannelError,
  channelReadme,
  git,
  gitEnv,
  runChecked,
} from "./artifact.ts";
import { spawnSync } from "../../plugin/shared/guarded-git-spawn.ts";

export const CHANNELS = ["latest", "stable"] as const;
export type Channel = (typeof CHANNELS)[number];

/** How long a version must have been on `latest` before it may be promoted. */
export const SOAK_HOURS = 72;

/** The check main's ruleset requires; a version's tagged commit must pass it. */
export const REQUIRED_CHECK = "gates";

/** The App that reports {@link REQUIRED_CHECK}: the gates workflow runs in GitHub Actions. */
export const REQUIRED_CHECK_APP = "github-actions";

/** The label that marks an issue as a regression in a released version. */
export const REGRESSION_LABEL = "regression";

const TRAILER = /^Jig-(Channel|Action|Version|Source|Withdrawn): (\S+)$/gm;
const VERSION = /^\d+\.\d+\.\d+$/;
const MENTION = /(?<![\w.])v?(\d+\.\d+\.\d+)(?![\w.]*\d)/g;

export type Action = "promote" | "rollback" | "latest";

/** One commit of a channel branch, from its trailers. */
export interface ChannelCommit {
  commit: string;
  action: Action;
  version: string;
  source: string;
  date: Date;
  /** The versions a rollback took off the channel; never promoted again. */
  withdrawn: string[];
}

/** Compare two `major.minor.patch` versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The versions of `released` above `from` (exclusive) and up to `to`, oldest first. */
export function versionsBetween(
  released: string[],
  from: string | null,
  to: string,
): string[] {
  return released
    .filter(
      (v) =>
        compareVersions(v, to) <= 0 &&
        (from === null || compareVersions(v, from) > 0),
    )
    .sort(compareVersions);
}

/** The trailers of a channel commit's message, or null when it has none. */
export function parseTrailers(message: string): {
  channel: string;
  action: string;
  version: string;
  source: string;
  withdrawn: string[];
} | null {
  const found: Record<string, string> = {};
  for (const match of message.matchAll(TRAILER))
    found[(match[1] as string).toLowerCase()] = match[2] as string;
  const { channel, action, version, source } = found;
  if (!channel || !action || !version || !source) return null;
  const withdrawn = found.withdrawn ? found.withdrawn.split(",") : [];
  return { channel, action, version, source, withdrawn };
}

/** The versions a text names. */
export function mentionedVersions(text: string): string[] {
  return [...new Set([...text.matchAll(MENTION)].map((m) => m[1] as string))];
}

/**
 * The versions a regression issue is filed against: the bug form's "Plugin
 * version" field when the issue has one, else what its title names. A body's
 * other mentions ("it worked in 0.58.0") are not the version it is against.
 */
export function regressionVersions(title: string, body: string): string[] {
  const field = body.match(/^###\s*Plugin version\s*\n+([\s\S]*?)(?=\n###|$)/m);
  return mentionedVersions(field ? (field[1] as string) : title);
}

/** Whether going from `a` down to `b` crosses a breaking release. */
export function crossesBreaking(a: string, b: string): boolean {
  const [am = 0, an = 0] = a.split(".").map(Number);
  const [bm = 0, bn = 0] = b.split(".").map(Number);
  return am !== bm || (am === 0 && an !== bn);
}

/**
 * When `version` reached `latest`: the date of the first `latest` commit that
 * carried it or a later version. A version tagged before `latest` existed was
 * on `main`, the only address then, from its tag. Null when it is not on
 * `latest` yet.
 */
export function soakStart(
  version: string,
  tag: Tag,
  latestHistory: ChannelCommit[],
): Date | null {
  const oldestFirst = [...latestHistory].reverse();
  const first = oldestFirst[0];
  if (!first || tag.madeAt.getTime() < first.date.getTime()) return tag.madeAt;
  const reached = oldestFirst.find(
    (entry) => compareVersions(entry.version, version) >= 0,
  );
  return reached ? reached.date : null;
}

/** A tagged version, as the remote has it. */
export interface Tag {
  version: string;
  commit: string;
  /** When the tag was made: an annotated tag's date, else its commit's. */
  madeAt: Date;
  onMain: boolean;
}

/** An open issue labelled as a regression. */
export interface Regression {
  number: number;
  title: string;
  versions: string[];
}

export interface PromotionFacts {
  candidate: string;
  tag: Tag | null;
  /** The required check's conclusion on the tagged commit, or null if absent. */
  gates: string | null;
  /** When the version reached `latest` ({@link soakStart}). */
  soakStart: Date | null;
  stable: string | null;
  /** Versions a rollback withdrew from `stable`. */
  withdrawn: string[];
  regressions: Regression[];
  now: Date;
}

/** What the promotion rule says about promoting `facts.candidate` to stable. */
export function evaluatePromotion(facts: PromotionFacts): string[] {
  const { candidate, stable } = facts;
  const failures = [...tagFailures(facts), ...regressionFailures(facts)];
  if (facts.withdrawn.includes(candidate))
    failures.push(
      `v${candidate} was withdrawn from stable by a rollback; ship the fix as a new version`,
    );
  if (stable !== null && compareVersions(candidate, stable) <= 0)
    failures.push(
      `v${candidate} is not newer than stable's v${stable}; to go back, roll back`,
    );
  return failures;
}

/** The required check on a tagged commit, unless it passed. */
function gatesFailure(
  version: string,
  tag: Tag,
  gates: string | null,
): string | null {
  if (gates === "success") return null;
  return `${REQUIRED_CHECK} on v${version}'s commit ${tag.commit.slice(0, 12)} is ${gates ?? "missing"}, not success`;
}

/** The conditions on the candidate's tag: on main, gates green, soaked. */
function tagFailures(facts: PromotionFacts): string[] {
  const { candidate, tag } = facts;
  if (!tag) return [`v${candidate} is not tagged`];
  const failures: string[] = [];
  if (!tag.onMain) failures.push(`v${candidate}'s commit is not on main`);
  const gates = gatesFailure(candidate, tag, facts.gates);
  if (gates) failures.push(gates);
  if (facts.soakStart === null) {
    failures.push(`v${candidate} is not on latest yet`);
    return failures;
  }
  const hours = (facts.now.getTime() - facts.soakStart.getTime()) / 3_600_000;
  if (hours < SOAK_HOURS)
    failures.push(
      `v${candidate} has been on latest for ${Math.max(0, Math.floor(hours))} hours, under the ${SOAK_HOURS} it must soak`,
    );
  return failures;
}

/** The open regressions in a version this promotion would bring to stable. */
function regressionFailures(facts: PromotionFacts): string[] {
  const { candidate, stable } = facts;
  const shipped = (v: string) =>
    compareVersions(v, candidate) <= 0 &&
    (stable === null || compareVersions(v, stable) > 0);
  return facts.regressions.flatMap((issue) => {
    if (!issue.versions.length)
      return [
        `#${issue.number} (${REGRESSION_LABEL}) names no version, so it may be in this one: ${issue.title}`,
      ];
    const hit = issue.versions.filter(shipped);
    return hit.length
      ? [
          `#${issue.number} (${REGRESSION_LABEL}) names v${hit.join(", v")}, which this promotion would ship: ${issue.title}`,
        ]
      : [];
  });
}

/** What the rule says about rolling stable back to `candidate`. */
export function evaluateRollback(
  candidate: string,
  tag: Tag | null,
  gates: string | null,
  history: ChannelCommit[],
  acrossBreaking: boolean,
): string[] {
  const failures: string[] = [];
  const current = history[0]?.version ?? null;
  if (!tag) failures.push(`v${candidate} is not tagged`);
  else {
    const failed = gatesFailure(candidate, tag, gates);
    if (failed) failures.push(failed);
  }
  if (current === null) failures.push("stable carries no version yet");
  else if (compareVersions(candidate, current) >= 0)
    failures.push(
      `v${candidate} is not older than stable's v${current}; to go forward, promote`,
    );
  else if (!acrossBreaking && crossesBreaking(current, candidate))
    failures.push(
      `going from v${current} back to v${candidate} crosses a breaking release, whose configuration changes repositories may have made already; fix forward, or pass --across-breaking`,
    );
  if (
    !history.some(
      (entry) => entry.action === "promote" && entry.version === candidate,
    )
  )
    failures.push(
      `stable never carried v${candidate}; a rollback returns only to a version promoted before`,
    );
  if (history.some((entry) => entry.withdrawn.includes(candidate)))
    failures.push(
      `v${candidate} was withdrawn from stable by a rollback; it never returns`,
    );
  return failures;
}

/** The facts a command reads from the remote and from GitHub. */
export interface Sources {
  tags(): Tag[];
  channel(channel: Channel): { tip: string | null; history: ChannelCommit[] };
  gates(commit: string): string | null;
  regressions(): Regression[];
}

/** Where gitSources keeps the remote's tags. */
const TAGS = "refs/jig-channel/tags/";

/** How long one git call to the remote may take. */
export const REMOTE_TIMEOUT_MS = 300_000;

/** A git call that talks to the remote: bounded, and never waits on a prompt. */
function remoteGit(repo: string, args: string[]): string {
  return runChecked("git", ["-C", repo, ...args], {
    env: gitEnv({ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }),
    timeout: REMOTE_TIMEOUT_MS,
  });
}

/** Read the channels and tags from `remote` of `repo`, fetching them first. */
export function gitSources(
  repo: string,
  remote: string,
  github: Pick<Sources, "gates" | "regressions">,
): Sources {
  // The remote's tags, in a namespace of their own and pruned to what the
  // remote has: a tag made or kept only locally is not a release.
  remoteGit(repo, [
    "fetch",
    "-q",
    "--force",
    "--prune",
    "--no-tags",
    remote,
    "+refs/heads/main:refs/jig-channel/main",
    `+refs/tags/*:${TAGS}*`,
  ]);
  const heads = remoteGit(repo, ["ls-remote", "--heads", remote]);
  for (const channel of CHANNELS)
    if (
      heads.includes(`\trefs/heads/${channel}\n`) ||
      heads.endsWith(`\trefs/heads/${channel}`)
    )
      remoteGit(repo, [
        "fetch",
        "-q",
        "--no-tags",
        remote,
        `+refs/heads/${channel}:refs/jig-channel/remote/${channel}`,
      ]);
    else git(repo, ["update-ref", "-d", `refs/jig-channel/remote/${channel}`]);
  return {
    tags: () => readTags(repo),
    channel: (channel) =>
      readChannel(repo, `refs/jig-channel/remote/${channel}`),
    ...github,
  };
}

function readTags(repo: string): Tag[] {
  const listing = git(repo, [
    "for-each-ref",
    "--format=%(refname:strip=3)%00%(*objectname)%00%(objectname)%00%(taggerdate:unix)%00%(*committerdate:unix)%00%(committerdate:unix)",
    `${TAGS}v*`,
  ]);
  const tags: Tag[] = [];
  for (const line of listing.split("\n")) {
    if (!line) continue;
    const [name = "", peeled, object = "", tagged, peeledDate, ownDate] =
      line.split("\0");
    const version = name.slice(1);
    if (!VERSION.test(version)) continue;
    const commit = peeled || object;
    const seconds = Number(tagged || peeledDate || ownDate);
    const onMain =
      spawnSync(
        "git",
        [
          "-C",
          repo,
          "merge-base",
          "--is-ancestor",
          commit,
          "refs/jig-channel/main",
        ],
        {
          env: gitEnv(),
        },
      ).status === 0;
    tags.push({ version, commit, madeAt: new Date(seconds * 1000), onMain });
  }
  return tags.sort((a, b) => compareVersions(a.version, b.version));
}

/** A channel branch's commits, newest first, from their trailers. */
export function readChannel(
  repo: string,
  ref: string,
): { tip: string | null; history: ChannelCommit[] } {
  const exists =
    spawnSync(
      "git",
      ["-C", repo, "rev-parse", "--verify", "-q", `${ref}^{commit}`],
      {
        env: gitEnv(),
      },
    ).status === 0;
  if (!exists) return { tip: null, history: [] };
  const log = git(repo, [
    "log",
    "--first-parent",
    "--format=%H%x00%ct%x00%B%x1e",
    ref,
  ]);
  const history: ChannelCommit[] = [];
  for (const record of log.split("\x1e")) {
    const [commit = "", date = "", message = ""] = record.trim().split("\0");
    if (!commit) continue;
    const trailers = parseTrailers(message);
    if (!trailers)
      throw new ChannelError(
        `${ref} commit ${commit} carries no channel trailers; only the channel tooling writes this branch`,
      );
    history.push({
      commit,
      action: trailers.action as Action,
      version: trailers.version,
      source: trailers.source,
      date: new Date(Number(date) * 1000),
      withdrawn: trailers.withdrawn,
    });
  }
  return { tip: history[0]?.commit ?? null, history };
}

/**
 * The required check's result among a commit's check runs named
 * {@link REQUIRED_CHECK}: its conclusion once completed, else its status;
 * null when there is none. Any App that may write checks can name one
 * `gates`; only the gates workflow's, reported through GitHub Actions, is
 * the required check.
 */
export function requiredCheckResult(runs: unknown[]): string | null {
  const run = runs.find(
    (entry) =>
      (entry as { app?: { slug?: unknown } } | null)?.app?.slug ===
      REQUIRED_CHECK_APP,
  );
  if (run === undefined) return null;
  const { status, conclusion } = run as Record<string, unknown>;
  if (status !== "completed") return String(status);
  return typeof conclusion === "string" ? conclusion : "unknown";
}

/** The GitHub facts, through the `gh` command-line tool. */
export function ghSources(
  repo: string,
): Pick<Sources, "gates" | "regressions"> {
  const gh = (args: string[]) => runChecked("gh", args, { timeout: 60_000 });
  return {
    gates: (commit) => {
      const runs: unknown = JSON.parse(
        gh([
          "api",
          `repos/${repo}/commits/${commit}/check-runs?check_name=${REQUIRED_CHECK}&filter=latest&per_page=100`,
        ]),
      );
      const list = (runs as { check_runs?: unknown })?.check_runs;
      if (!Array.isArray(list))
        throw new ChannelError(
          `GitHub answered no check-run list for ${commit}`,
        );
      return requiredCheckResult(list);
    },
    regressions: () => {
      const issues: unknown = JSON.parse(
        gh([
          "issue",
          "list",
          "--repo",
          repo,
          "--state",
          "open",
          "--label",
          REGRESSION_LABEL,
          "--limit",
          "1000",
          "--json",
          "number,title,body",
        ]),
      );
      if (!Array.isArray(issues))
        throw new ChannelError("GitHub answered no issue list");
      return issues.map((issue: unknown) => {
        const { number, title, body } = issue as Record<string, unknown>;
        if (typeof number !== "number" || typeof title !== "string")
          throw new ChannelError(`unreadable issue: ${JSON.stringify(issue)}`);
        const text = typeof body === "string" ? body : "";
        return { number, title, versions: regressionVersions(title, text) };
      });
    },
  };
}

/** The channel commit a command writes, before it is written. */
export interface Plan {
  channel: Channel;
  action: Action;
  tag: Tag;
  parent: string | null;
  message: string;
}

/** The message of a channel commit: a subject, what it adds, the trailers. */
export function commitMessage(
  channel: Channel,
  action: Action,
  tag: Tag,
  body: string,
  withdrawn: string[] = [],
): string {
  return [
    `${channel}: ${action === "latest" ? "release" : action} v${tag.version}`,
    "",
    body,
    "",
    `Jig-Channel: ${channel}`,
    `Jig-Action: ${action}`,
    `Jig-Version: ${tag.version}`,
    `Jig-Source: ${tag.commit}`,
    ...(withdrawn.length ? [`Jig-Withdrawn: ${withdrawn.join(",")}`] : []),
    "",
  ].join("\n");
}

/** Write the planned commit into `repo`; return its sha. */
export function writeCommit(repo: string, plan: Plan): string {
  const tree = artifactTree(repo, plan.tag.commit, {
    "README.md": channelReadme(plan.channel, plan.tag.version),
  });
  const args = [
    "commit-tree",
    tree,
    ...(plan.parent ? ["-p", plan.parent] : []),
  ];
  return git(repo, args, plan.message).trim();
}

/** Write a bundle of `commit`, holding only what is not in `parent`. */
export function writeBundle(
  repo: string,
  channel: Channel,
  commit: string,
  parent: string | null,
  file: string,
): void {
  const ref = `refs/jig-channel/out/${channel}`;
  git(repo, ["update-ref", ref, commit]);
  git(repo, [
    "bundle",
    "create",
    "-q",
    file,
    ref,
    ...(parent ? [`^${parent}`] : []),
  ]);
}

const USAGE =
  "usage: bun tools/plugin/channel.ts status | check <version> | promote <version> --bundle <file> | rollback <version> --bundle <file> [--across-breaking] | latest --bundle <file> [--remote <name>] [--repo <owner/name>]";

/** Which commands take a version, and which write a bundle. */
const COMMANDS: Record<string, { version: boolean; bundle: boolean }> = {
  status: { version: false, bundle: false },
  check: { version: true, bundle: false },
  promote: { version: true, bundle: true },
  rollback: { version: true, bundle: true },
  latest: { version: false, bundle: true },
};

export interface Args {
  command: string;
  version: string | null;
  bundle: string | null;
  remote: string;
  repo: string | null;
  acrossBreaking: boolean;
}

export function parseArgs(argv: string[]): Args {
  const { values, positionals } = strictOptions(
    {
      args: argv,
      allowPositionals: true,
      options: {
        bundle: { type: "string" },
        remote: { type: "string", default: "origin" },
        repo: { type: "string" },
        "across-breaking": { type: "boolean", default: false },
      },
    },
    USAGE,
  );
  const [command = "", version, ...extra] = positionals;
  const shape = COMMANDS[command];
  if (!shape || extra.length) throw new ChannelError(USAGE);
  const args: Args = {
    command,
    version: version?.replace(/^v/, "") ?? null,
    bundle: values.bundle ?? null,
    remote: values.remote,
    repo: values.repo ?? null,
    acrossBreaking: values["across-breaking"],
  };
  requireShape(args, shape);
  return args;
}

/** Refuse arguments the command does not take, or lacks. */
function requireShape(
  args: Args,
  shape: { version: boolean; bundle: boolean },
): void {
  const refuse = (problem: string) => {
    throw new ChannelError(`${args.command} ${problem}\n${USAGE}`);
  };
  if (shape.version !== (args.version !== null))
    refuse(`${shape.version ? "needs" : "takes no"} version`);
  if (args.version !== null && !VERSION.test(args.version))
    throw new ChannelError(
      `${args.version} is not a major.minor.patch version`,
    );
  if (shape.bundle !== (args.bundle !== null))
    refuse(`${shape.bundle ? "needs" : "takes no"} --bundle`);
  if (args.acrossBreaking && args.command !== "rollback")
    refuse("does not take --across-breaking, which applies to rollback only");
}

/** The GitHub repository: the flag, Actions' variable, or origin's URL. */
function githubRepository(
  repo: string,
  remote: string,
  flag: string | null,
): string {
  if (flag) return flag;
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = git(repo, ["remote", "get-url", remote]).trim();
  const match = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match)
    throw new ChannelError(
      `cannot tell the GitHub repository from ${remote} (${url}); pass --repo`,
    );
  return match[1] as string;
}

/** What every command reads first: the tags and both channels. */
interface State {
  tags: Tag[];
  released: string[];
  latest: { tip: string | null; history: ChannelCommit[] };
  stable: { tip: string | null; history: ChannelCommit[] };
  stableVersion: string | null;
}

function readState(sources: Sources): State {
  const tags = sources.tags();
  const stable = sources.channel("stable");
  return {
    tags,
    released: tags.map((tag) => tag.version),
    latest: sources.channel("latest"),
    stable,
    stableVersion: stable.history[0]?.version ?? null,
  };
}

function printStatus(state: State): void {
  for (const name of CHANNELS) {
    const head = state[name].history[0];
    console.log(
      head
        ? `${name}: v${head.version} (${head.action}, ${head.date.toISOString()}, from ${head.source.slice(0, 12)})`
        : `${name}: not published yet`,
    );
  }
  const newest = state.latest.history[0]?.version;
  if (!newest) return;
  const ahead = versionsBetween(state.released, state.stableVersion, newest);
  console.log(
    ahead.length
      ? `on latest, not yet on stable: v${ahead.join(", v")}`
      : "stable carries latest's version",
  );
}

/** A command's outcome before anything is written: a plan, or an exit code. */
type Planned = Plan | { exit: number };

/** Every version a rollback withdrew from stable. */
function withdrawnFrom(state: State): string[] {
  return state.stable.history.flatMap((entry) => entry.withdrawn);
}

/** `latest`'s next commit: the newest tagged version, if latest lacks it. */
function planLatest(
  state: State,
  sources: Sources,
  output: (key: string, value: string) => void,
): Planned {
  const newest = state.tags.filter((tag) => tag.onMain).at(-1);
  if (!newest) throw new ChannelError("no version tag on main");
  const current = state.latest.history[0]?.version ?? null;
  if (current !== null && compareVersions(newest.version, current) <= 0) {
    console.log(
      `latest carries v${current}, the newest tagged version; nothing to write`,
    );
    output("changed", "false");
    return { exit: 0 };
  }
  const gates = sources.gates(newest.commit);
  if (gates !== "success") {
    console.error(
      `latest: ${REQUIRED_CHECK} on v${newest.version}'s commit is ${gates ?? "missing"}, not success`,
    );
    return { exit: 3 };
  }
  const added = versionsBetween(state.released, current, newest.version);
  return {
    channel: "latest",
    action: "latest",
    tag: newest,
    parent: state.latest.tip,
    message: commitMessage(
      "latest",
      "latest",
      newest,
      `Versions this commit adds, oldest first: ${added.join(", ")}.`,
    ),
  };
}

/** What the rule says about the stable command `args` asks for. */
function stableFailures(
  args: Args,
  state: State,
  sources: Sources,
  tag: Tag | null,
  now: Date,
): string[] {
  const version = args.version as string;
  const gates = tag ? sources.gates(tag.commit) : null;
  if (args.command === "rollback")
    return evaluateRollback(
      version,
      tag,
      gates,
      state.stable.history,
      args.acrossBreaking,
    );
  return evaluatePromotion({
    candidate: version,
    tag,
    gates,
    soakStart: tag ? soakStart(version, tag, state.latest.history) : null,
    stable: state.stableVersion,
    withdrawn: withdrawnFrom(state),
    regressions: sources.regressions(),
    now,
  });
}

/** `stable`'s next commit for a promotion or a rollback, once the rule allows it. */
function planStable(
  args: Args,
  state: State,
  sources: Sources,
  now: Date,
): Planned {
  const version = args.version as string;
  const tag = state.tags.find((t) => t.version === version) ?? null;
  const rollback = args.command === "rollback";
  const verb = rollback ? "roll stable back to" : "promote";
  const failures = stableFailures(args, state, sources, tag, now);
  if (failures.length) {
    console.error(`refused: cannot ${verb} v${version}:`);
    for (const failure of failures) console.error(`- ${failure}`);
    return { exit: 3 };
  }
  console.log(`the rule allows: ${verb} v${version}`);
  if (args.command === "check") return { exit: 0 };
  const from = state.stableVersion;
  const withdrawn = rollback
    ? state.released.filter(
        (v) =>
          compareVersions(v, version) > 0 &&
          compareVersions(v, from as string) <= 0,
      )
    : [];
  const body = rollback
    ? `Rolls stable back from v${from} to v${version}, withdrawing v${withdrawn.join(", v")}.`
    : `Versions this promotion adds, oldest first: ${versionsBetween(
        state.released,
        from,
        version,
      )
        .filter((v) => !withdrawnFrom(state).includes(v))
        .join(", ")}.`;
  const action = args.command as Action;
  return {
    channel: "stable",
    action,
    tag: tag as Tag,
    parent: state.stable.tip,
    message: commitMessage("stable", action, tag as Tag, body, withdrawn),
  };
}

/** Write the planned commit and its bundle; report them. */
function emit(
  repo: string,
  plan: Plan,
  bundle: string,
  output: (key: string, value: string) => void,
): void {
  const commit = writeCommit(repo, plan);
  writeBundle(repo, plan.channel, commit, plan.parent, resolve(bundle));
  console.log(
    `${plan.channel}: wrote ${commit} (v${plan.tag.version}) on top of ${plan.parent ?? "nothing: the branch's first commit"}`,
  );
  output("changed", "true");
  output("channel", plan.channel);
  output("start", plan.parent ?? "");
  output("commit", commit);
}

/** Run one command against `sources`; print what it decided; return the exit code. */
export function run(
  args: Args,
  repo: string,
  sources: Sources,
  now: Date,
  output: (key: string, value: string) => void,
): number {
  const state = readState(sources);
  if (args.command === "status") {
    printStatus(state);
    return 0;
  }
  const planned =
    args.command === "latest"
      ? planLatest(state, sources, output)
      : planStable(args, state, sources, now);
  if ("exit" in planned) return planned.exit;
  emit(repo, planned, args.bundle as string, output);
  return 0;
}

if (import.meta.main)
  cli(() => {
    const args = parseArgs(process.argv.slice(2));
    const repo = resolve(import.meta.dir, "../..");
    const github = githubRepository(repo, args.remote, args.repo);
    const sources = gitSources(repo, args.remote, ghSources(github));
    const file = process.env.GITHUB_OUTPUT;
    return run(args, repo, sources, new Date(), (key, value) => {
      if (file) appendFileSync(file, `${key}=${value}\n`);
    });
  });
