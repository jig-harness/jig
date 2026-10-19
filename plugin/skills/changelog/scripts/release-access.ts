// Whether the release identity, a GitHub App, can reach the integration branch
// in the configured mode (`changelog.release.push`), and whether force pushes
// and deletion of that branch stay blocked for it. It reads GitHub's rulesets
// and classic branch protection (through github-rules.ts) and changes nothing.
//
// What is checked, by mode:
// - `direct`: the release pushes its commit onto the integration branch, so
//   every active ruleset with a rule that would stop that push must list the
//   App (`Integration`, by the App's id) as a bypass actor in mode `always`
//   (or `exempt`); `pull_request` mode lets it past only by merging a pull
//   request. Classic branch protection has no such bypass for an App beyond
//   its push restrictions and review allowances, so required checks, signed
//   commits or a locked branch there stop the push.
// - `pull-request`: no bypass is asked for on the integration branch; the App
//   must be able to create, push and force-push `changelog.release.branch`,
//   which the release regenerates from scratch. That branch's rules are read
//   even before it exists; its classic protection cannot be until it does.
// - both: force pushes and deletion of the integration branch stay blocked
//   for the App: by classic protection, or by a `non_fast_forward` or
//   `deletion` rule in an active ruleset that does not list the App as a
//   bypass actor. Only an `Integration` entry with the App's id names the App:
//   repository roles, teams, organization administrators and deploy keys name
//   people and keys, and GitHub gives an App's token none of them.
//
// The rules that do not stop the release's push to the integration branch,
// one fast-forward commit onto a branch that exists: `non_fast_forward`,
// `deletion`, `creation`, `required_linear_history` (the commit is not a
// merge) and `copilot_code_review` (pull requests only). Every other rule
// does, a rule this file does not know included: `pull_request`,
// `required_status_checks` and `required_deployments` (the new commit has
// passed nothing), `required_signatures` (the pushed commit is unsigned),
// `update`, `merge_queue`, `workflows`, `code_scanning`, the commit message
// and e-mail patterns and the file path, extension and size rules (the
// commit is not written yet, so they cannot be judged on it). On the release
// branch, `creation` and `non_fast_forward` stop it as well.
//
// What depends on a bypass list GitHub withheld from the reader, or on
// classic protection it could not read, is "unknown": reported as such,
// never passed or failed. Every organization ruleset that covers the
// integration branch is listed apart (`organizationRulesets`): a repository
// setting cannot change it, so a requirement it fails is an organization
// owner's to settle; one that fails none needs nothing.
//
// Usage: bun release-access.ts (--app <slug> | --app-id <id>)... [--root <dir>]
//   [--repo <owner/repo>] [--input <file>|-] [--json]
// The identity is `--app-id`, else the id `gh api apps/<slug>` gives. The
// repository is `--repo`, else the `origin` remote's. `--input` reads an
// offline document instead of GitHub: the shape check-branch-protection's
// `--input` takes (`classic`, `rules`, `rulesets`, for the integration
// branch; `classic` may also be "unreadable" or "missing"), with optional
// `release_branch` (the same shape, for the release branch), `app`
// (`{ "id", "slug" }`) and `repo`; `release_branch` is required in
// `pull-request` mode, since a missing reading is not an unprotected branch.
// Offline, the integration branch comes from
// `repository.base_branch` or the clone's `origin/HEAD`.
// Exit: 0 every requirement holds (also when the repository has not turned
// the skill on); 1 a requirement fails; 3 none fails but one is unknown, which
// a person with more access must look at (an administrator's login reads what
// GitHub withheld) rather than a change to the settings; 2 a usage error, an
// invalid configuration, or GitHub could not be read.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fail, runMain } from "../../../shared/cli.ts";
import { consumerRoot } from "../../../shared/consumer.ts";
import { isRecord } from "../../../shared/guards.ts";
import { pluginVersion } from "../../../shared/plugin-version.ts";
import { banner } from "./banner.ts";
import { integrationBranch } from "./branches.ts";
import { loadResolved } from "./config.ts";
import {
  type BypassActor,
  combine,
  describeActor,
  field,
  type GhApi,
  ghApi,
  type Json,
  type RulesetView,
  readBranch,
  type Source,
  sourceOf,
} from "./github-rules.ts";
import { type Hosting, hostingFor } from "./hosting.ts";
import { tryGit } from "./notes-dir.ts";
import { parseRemote } from "./remote.ts";

type Env = Record<string, string | undefined>;
type Mode = "direct" | "pull-request";

export type Verdict = "pass" | "fail" | "unknown";

/** The release identity: a GitHub App, by its id and, where known, its slug. */
export interface Identity {
  id: number;
  slug: string | null;
}

/** One thing the release needs, and whether it holds. */
export interface Requirement {
  id: "push" | "release-branch" | "force-push-blocked" | "deletion-blocked";
  status: Verdict;
  summary: string;
  /** Each source that decided it, one line each. */
  reasons: string[];
}

/** What was read about the branches the release touches. */
export interface Protection {
  integration: Source;
  /** The release branch's; null in `direct` mode. */
  releaseBranch: Source | null;
}

export interface AccessReport {
  plugin: string | null;
  configured: true;
  mode: Mode;
  repo: string;
  identity: Identity;
  integrationBranch: string;
  releaseBranch: string | null;
  status: Verdict;
  requirements: Requirement[];
  /** Every ruleset read, with the branch it covers. */
  rulesets: (RulesetView & { branch: string })[];
  /** The organization rulesets that cover the integration branch. */
  organizationRulesets: { id: string; name: string | null }[];
}

/** A branch nothing protects. */
const NO_PROTECTION: Source = { classic: null, rules: [], rulesets: [] };

/** The rules that do not stop one fast-forward commit onto an existing branch. */
const HARMLESS_TO_PUSH = new Set([
  "non_fast_forward",
  "deletion",
  "creation",
  "required_linear_history",
  "copilot_code_review",
]);
/** The rules that do not stop creating, pushing and force-pushing the release branch. */
const HARMLESS_TO_RELEASE_BRANCH = new Set([
  "deletion",
  "required_linear_history",
  "copilot_code_review",
]);
/** The bypass modes that let an actor push straight past a ruleset. */
const PUSH_MODES = new Set(["always", "exempt"]);

const worst = (verdicts: Verdict[]): Verdict =>
  verdicts.includes("fail")
    ? "fail"
    : verdicts.includes("unknown")
      ? "unknown"
      : "pass";

/** Whether a bypass entry names the App. */
const namesApp = (actor: BypassActor, app: Identity): boolean =>
  actor.actor_type === "Integration" &&
  String(actor.actor_id) === String(app.id);

const enforced = (r: RulesetView): boolean =>
  r.enforcement === null || r.enforcement === "active";

const label = (r: RulesetView): string =>
  `${r.source === "Organization" ? "organization ruleset" : "ruleset"} ${r.id}${r.name ? ` (${r.name})` : ""}`;

const appName = (app: Identity): string =>
  `app ${app.id}${app.slug ? ` (${app.slug})` : ""}`;

/** Whether the App passes `ruleset`'s rules `blocking` with a push, and why. */
function passes(
  ruleset: RulesetView,
  blocking: string[],
  app: Identity,
): [Verdict, string] {
  const what = `${label(ruleset)} has ${blocking.join(", ")}`;
  const owner =
    ruleset.source === "Organization"
      ? "; only an organization owner can change its bypass list"
      : "";
  if (ruleset.bypass === null)
    return [
      "unknown",
      `${what}, and GitHub withheld its bypass list from this reader (it shows it to those who may edit the ruleset)`,
    ];
  const entries = ruleset.bypass.filter((a) => namesApp(a, app));
  if (entries.some((a) => PUSH_MODES.has(a.bypass_mode ?? "")))
    return ["pass", `${what}; ${appName(app)} bypasses it always`];
  if (entries.length)
    return [
      "fail",
      `${what}; ${appName(app)} bypasses it only as ${entries.map(describeActor).join(", ")}, which needs a pull request: set its bypass mode to always${owner}`,
    ];
  return [
    "fail",
    `${what}, and does not list ${appName(app)} as a bypass actor${owner}`,
  ];
}

/** Whether the App is in an actor map (`{ users, teams, apps }`) of classic protection. */
function inActors(actors: unknown, app: Identity): boolean {
  const apps = isRecord(actors) ? actors.apps : undefined;
  return (
    Array.isArray(apps) &&
    apps.some(
      (a) =>
        isRecord(a) &&
        (String(a.id) === String(app.id) ||
          (app.slug !== null && a.slug === app.slug)),
    )
  );
}

/** Whether a classic `required_status_checks` setting requires any check. */
function requiresChecks(checks: unknown): boolean {
  return (
    isRecord(checks) &&
    [checks.contexts, checks.checks].some((l) => Array.isArray(l) && l.length)
  );
}

/** The settings of classic protection that stop the App pushing whatever it pushes, each by name. */
const CLASSIC_BLOCKERS: [string, (classic: Json, app: Identity) => boolean][] =
  [
    [
      "required status checks",
      (classic) => requiresChecks(classic.required_status_checks),
    ],
    [
      "required pull request reviews without the App among those allowed to bypass them",
      (classic, app) =>
        isRecord(classic.required_pull_request_reviews) &&
        !inActors(
          classic.required_pull_request_reviews.bypass_pull_request_allowances,
          app,
        ),
    ],
    [
      "push restrictions that do not list the App",
      (classic, app) =>
        isRecord(classic.restrictions) && !inActors(classic.restrictions, app),
    ],
    [
      "required signed commits",
      (classic) => field(classic, "required_signatures.enabled") === true,
    ],
    [
      "a locked branch",
      (classic) => field(classic, "lock_branch.enabled") === true,
    ],
  ];

/** The settings of classic protection that stop the App pushing, `force` asking about a force push too. */
function classicBlockers(
  classic: Json,
  app: Identity,
  force: boolean,
): string[] {
  const out = CLASSIC_BLOCKERS.filter(([, blocks]) => blocks(classic, app)).map(
    ([name]) => name,
  );
  if (force && field(classic, "allow_force_pushes.enabled") !== true)
    out.push("force pushes not allowed");
  return out;
}

/** What classic protection says about the App pushing, as a verdict and a reason. */
function classicPush(
  source: Source,
  branch: string,
  app: Identity,
  force: boolean,
): [Verdict, string] | null {
  if (source.classicUnknown === "missing")
    return [
      "unknown",
      `${branch} does not exist yet, so the classic protection a branch name pattern may give it cannot be read until it does`,
    ];
  if (source.classicUnknown === "unreadable")
    return [
      "unknown",
      `${branch} has classic protection this reader may not see: an administrator's gh login reads it`,
    ];
  if (source.classic === null) return null;
  const blockers = classicBlockers(source.classic, app, force);
  return blockers.length
    ? [
        "fail",
        `classic branch protection of ${branch} stops the App: ${blockers.join("; ")} (classic protection has no bypass for an App; move these rules into a ruleset that lists it)`,
      ]
    : ["pass", `classic branch protection of ${branch} lets the App push`];
}

/** Whether the App can push past every rule of `branch`, ignoring those in `harmless`. */
function pushRequirement(
  id: "push" | "release-branch",
  summary: string,
  source: Source,
  rulesets: RulesetView[],
  branch: string,
  app: Identity,
  harmless: Set<string>,
): Requirement {
  const decided: [Verdict, string][] = [];
  for (const ruleset of rulesets.filter(enforced)) {
    const blocking = ruleset.rules.filter((r) => !harmless.has(r));
    if (blocking.length) decided.push(passes(ruleset, blocking, app));
  }
  const classic = classicPush(source, branch, app, id === "release-branch");
  if (classic) decided.push(classic);
  if (!decided.length)
    return {
      id,
      status: "pass",
      summary,
      reasons: [`no rule on ${branch} stops the push`],
    };
  return {
    id,
    status: worst(decided.map(([v]) => v)),
    summary,
    reasons: decided.map(([, r]) => r),
  };
}

/** The rule, the classic setting and the words for each push a requirement keeps blocked. */
const BLOCKED = {
  "force-push-blocked": {
    rule: "non_fast_forward",
    setting: "allow_force_pushes",
    what: "force pushes to",
  },
  "deletion-blocked": {
    rule: "deletion",
    setting: "allow_deletions",
    what: "deletion of",
  },
} as const;

/** What the sources say of a rule for the App: what blocks it, what may, and what lists the App as bypassing it. */
interface RuleReasons {
  blocks: string[];
  maybe: string[];
  passedBy: string[];
}

/** Which of `RuleReasons` a ruleset that has `rule` adds to, and why. */
function rulesetReason(
  ruleset: RulesetView,
  rule: string,
  app: Identity,
): [keyof RuleReasons, string] {
  if (ruleset.bypass === null)
    return [
      "maybe",
      `${label(ruleset)} has ${rule}, but GitHub withheld its bypass list, so whether it lists the App is unknown`,
    ];
  if (ruleset.bypass.some((a) => namesApp(a, app)))
    return [
      "passedBy",
      `${label(ruleset)} has ${rule}, but lists ${appName(app)} as a bypass actor, so it does not bind the App`,
    ];
  return ["blocks", `${label(ruleset)} has ${rule} and does not list the App`];
}

/** What classic protection and `rulesets` say of `blocked`'s rule on `branch` for the App. */
function ruleReasons(
  blocked: (typeof BLOCKED)[keyof typeof BLOCKED],
  source: Source,
  rulesets: RulesetView[],
  branch: string,
  app: Identity,
): RuleReasons {
  const { rule, setting, what } = blocked;
  const reasons: RuleReasons = { blocks: [], maybe: [], passedBy: [] };
  if (source.classic && field(source.classic, `${setting}.enabled`) !== true)
    reasons.blocks.push(`classic branch protection blocks ${what} ${branch}`);
  if (source.classicUnknown === "unreadable")
    reasons.maybe.push(
      `classic protection of ${branch} may block it, but cannot be read`,
    );
  for (const ruleset of rulesets.filter(enforced)) {
    if (!ruleset.rules.includes(rule)) continue;
    const [kind, reason] = rulesetReason(ruleset, rule, app);
    reasons[kind].push(reason);
  }
  return reasons;
}

/**
 * Whether `rule` (`non_fast_forward` or `deletion`) stays binding for the App
 * on `branch`: it holds when one source blocks it for the App, is unknown
 * when only a source that may block it does, and fails otherwise.
 */
function blockedRequirement(
  id: "force-push-blocked" | "deletion-blocked",
  source: Source,
  rulesets: RulesetView[],
  branch: string,
  app: Identity,
): Requirement {
  const { rule, what } = BLOCKED[id];
  const summary = `${what} ${branch} stay blocked for the App`;
  const { blocks, maybe, passedBy } = ruleReasons(
    BLOCKED[id],
    source,
    rulesets,
    branch,
    app,
  );
  if (blocks.length)
    return { id, status: "pass", summary, reasons: [...blocks, ...passedBy] };
  if (maybe.length)
    return { id, status: "unknown", summary, reasons: [...maybe, ...passedBy] };
  return {
    id,
    status: "fail",
    summary,
    reasons: passedBy.length
      ? [
          ...passedBy,
          `put ${rule} in a ruleset of its own, with no bypass actor the App is`,
        ]
      : [`nothing blocks ${what} ${branch}: add a ruleset with ${rule}`],
  };
}

/** The rulesets of `source` as the combined view lists them. */
const viewsOf = (source: Source): RulesetView[] =>
  combine(source).rulesets as RulesetView[];

/** What the release needs of `protection`, judged for `app` in `mode`. */
export function evaluateAccess(input: {
  mode: Mode;
  repo: string;
  identity: Identity;
  integrationBranch: string;
  releaseBranch: string;
  protection: Protection;
}): AccessReport {
  const { mode, identity: app, protection } = input;
  const main = input.integrationBranch;
  const mainRulesets = viewsOf(protection.integration);
  const requirements: Requirement[] = [];
  const rulesets: AccessReport["rulesets"] = mainRulesets.map((r) => ({
    ...r,
    branch: main,
  }));
  if (mode === "direct")
    requirements.push(
      pushRequirement(
        "push",
        `the App can push the release commit to ${main} past every rule`,
        protection.integration,
        mainRulesets,
        main,
        app,
        HARMLESS_TO_PUSH,
      ),
    );
  else {
    const source = protection.releaseBranch ?? NO_PROTECTION;
    const views = viewsOf(source);
    rulesets.push(...views.map((r) => ({ ...r, branch: input.releaseBranch })));
    requirements.push(
      pushRequirement(
        "release-branch",
        `the App can create, push and force-push ${input.releaseBranch}`,
        source,
        views,
        input.releaseBranch,
        app,
        HARMLESS_TO_RELEASE_BRANCH,
      ),
    );
  }
  requirements.push(
    blockedRequirement(
      "force-push-blocked",
      protection.integration,
      mainRulesets,
      main,
      app,
    ),
    blockedRequirement(
      "deletion-blocked",
      protection.integration,
      mainRulesets,
      main,
      app,
    ),
  );
  return {
    plugin: pluginVersion(),
    configured: true,
    mode,
    repo: input.repo,
    identity: app,
    integrationBranch: main,
    releaseBranch: mode === "pull-request" ? input.releaseBranch : null,
    status: worst(requirements.map((r) => r.status)),
    requirements,
    rulesets,
    organizationRulesets: mainRulesets
      .filter((r) => r.source === "Organization" && enforced(r))
      .map((r) => ({ id: r.id, name: r.name })),
  };
}

const STATUS_WORD: Record<Verdict, string> = {
  pass: "PASS   ",
  fail: "FAIL   ",
  unknown: "UNKNOWN",
};

function describe(report: AccessReport): string[] {
  const lines = [
    banner("release-access"),
    `${report.repo}: release identity ${appName(report.identity)}, mode ${report.mode}, integration branch ${report.integrationBranch}${report.releaseBranch ? `, release branch ${report.releaseBranch}` : ""}`,
  ];
  for (const r of report.requirements) {
    lines.push(`${STATUS_WORD[r.status]}  ${r.id}: ${r.summary}`);
    for (const reason of r.reasons) lines.push(`           ${reason}`);
  }
  for (const r of report.organizationRulesets)
    lines.push(
      `note: organization ruleset ${r.id}${r.name ? ` (${r.name})` : ""} covers ${report.integrationBranch}; only an organization owner can change it, so a requirement it fails stops setup`,
    );
  const held = report.requirements.filter((r) => r.status === "pass").length;
  const failed = report.requirements.filter((r) => r.status === "fail").length;
  const unknown = report.requirements.length - held - failed;
  lines.push(
    `${held} of ${report.requirements.length} requirements hold${failed ? `; ${failed} fail` : ""}${unknown ? `; ${unknown} unknown` : ""}`,
  );
  return lines;
}

export const EXIT: Record<Verdict, number> = { pass: 0, fail: 1, unknown: 3 };

/** What the command line asked for. */
export interface AccessOptions {
  appSlug: string | null;
  appId: string | null;
  repo: string | null;
  /** The offline document's text; null to read GitHub. */
  input: string | null;
  json: boolean;
}

/** A usage, configuration or reading error: exit 2. */
class AccessError extends Error {}

/** An App's id written as a positive whole number; null when `value` is not one. */
const appIdFrom = (value: unknown): number | null =>
  (typeof value === "number" || typeof value === "string") &&
  /^[1-9]\d*$/.test(String(value))
    ? Number(value)
    : null;

/** The id `--app-id` gives. */
function givenAppId(appId: string): number {
  const id = appIdFrom(appId);
  if (id === null)
    throw new AccessError(`--app-id must be a GitHub App's id: ${appId}`);
  return id;
}

/** The id of the offline document's app, when it is the App `--app` names (or `--app` names none). */
function documentAppId(
  options: AccessOptions,
  document: Json | null,
  given: Json,
): number | null {
  if (!document) return null;
  return options.appSlug === null || given.slug === options.appSlug
    ? appIdFrom(given.id)
    : null;
}

/** The id GitHub gives for the App `slug`. */
function askedAppId(gh: GhApi, slug: string): number {
  const answer = gh([`apps/${slug}`]);
  const app: unknown = answer.ok ? JSON.parse(answer.stdout || "null") : null;
  const id = isRecord(app) ? appIdFrom(app.id) : null;
  if (id === null)
    throw new AccessError(
      `GitHub did not give the id of app ${slug} (${answer.stderr.trim() || "no id in its answer"}): pass --app-id`,
    );
  return id;
}

/** The App by id: `--app-id`, the offline document's, else GitHub's answer for the slug. */
function identityOf(
  options: AccessOptions,
  document: Json | null,
  gh: GhApi,
): Identity {
  const given = isRecord(document?.app) ? document.app : {};
  const slug =
    options.appSlug ?? (typeof given.slug === "string" ? given.slug : null);
  if (options.appId !== null) return { id: givenAppId(options.appId), slug };
  const known = documentAppId(options, document, given);
  if (known !== null) return { id: known, slug };
  if (slug === null)
    throw new AccessError(
      "name the release identity: --app <slug> or --app-id <id>",
    );
  if (document)
    throw new AccessError(
      `offline, the id of app ${slug} comes from --app-id or the document's app.id`,
    );
  return { id: askedAppId(gh, slug), slug };
}

/** The `owner/repo` of the `origin` remote on GitHub; null when it is not one. */
function originRepo(root: string): string | null {
  const address = tryGit(root, ["remote", "get-url", "origin"])?.trim();
  const remote = address ? parseRemote(address) : null;
  return remote && /(^|\.)github/.test(remote.host) ? remote.path : null;
}

/**
 * A source of the offline document: the integration branch's from its own
 * fields (`key` null), the release branch's from `release_branch`. Either may
 * be a bare classic protection response, as check-branch-protection's input.
 * A keyed part must be an object: null, like a missing field, is no reading,
 * never an unprotected branch.
 */
function documentSource(document: Json, key: string | null): Source {
  const part =
    key === null
      ? Object.fromEntries(
          Object.entries(document).filter(
            ([k]) => !["app", "repo", "release_branch"].includes(k),
          ),
        )
      : document[key];
  if (!isRecord(part))
    throw new AccessError(`release-access input: ${key} must be an object`);
  return Object.keys(part).length ? sourceOf(part, true) : NO_PROTECTION;
}

/** The offline document `input` holds; null to read GitHub. */
function parseDocument(input: string | null): Json | null {
  if (input === null) return null;
  const parsed: unknown = JSON.parse(input);
  if (!isRecord(parsed))
    throw new AccessError("release-access input: expected a JSON object");
  return parsed;
}

/** The repository reported on: `--repo`, the offline document's, else the origin remote's. */
function repoOf(
  root: string,
  options: AccessOptions,
  document: Json | null,
): string {
  const repo =
    options.repo ??
    (typeof document?.repo === "string" ? document.repo : null) ??
    (document ? "(offline input)" : originRepo(root));
  if (repo === null)
    throw new AccessError(
      "the origin remote is not on GitHub: pass --repo <owner/repo>",
    );
  return repo;
}

/** The integration branch; offline, it is never asked of the hosting service. */
function branchOf(
  root: string,
  env: Env,
  document: Json | null,
  hosting: Hosting | null | undefined,
): string {
  const branch = integrationBranch(
    root,
    env,
    hosting === undefined ? (document ? null : hostingFor(root)) : hosting,
  );
  if (branch === null)
    throw new AccessError(
      "cannot tell the integration branch: set repository.base_branch in .config/jig.yaml",
    );
  return branch;
}

/** The protection of both branches, from the offline document or read from GitHub. */
function protectionOf(
  document: Json | null,
  read: (name: string) => Source,
  mode: Mode,
  branch: string,
  releaseBranch: string,
): Protection {
  if (document) {
    if (mode === "pull-request" && !("release_branch" in document))
      throw new AccessError(
        "release-access input: pull-request mode needs release_branch, the release branch's protection; write it out even when nothing protects it",
      );
    return {
      integration: documentSource(document, null),
      releaseBranch:
        mode === "pull-request"
          ? documentSource(document, "release_branch")
          : null,
    };
  }
  return {
    integration: read(branch),
    releaseBranch: mode === "pull-request" ? read(releaseBranch) : null,
  };
}

/** Say that the repository does not configure a changelog. */
function reportNotConfigured(json: boolean): void {
  if (json)
    console.log(JSON.stringify({ plugin: pluginVersion(), configured: false }));
  else
    console.log(
      `${banner("release-access")}\nnot configured (no changelog.file in .config/jig.yaml)`,
    );
}

/** Report on the repository at `root`; the exit status for the command line. */
export function runReleaseAccess(
  root: string,
  options: AccessOptions,
  env: Env = process.env,
  gh: GhApi = ghApi(root),
  hosting: Hosting | null | undefined = undefined,
): number {
  const resolved = loadResolved(root, env);
  if (resolved === null) {
    reportNotConfigured(options.json);
    return 0;
  }
  const document = parseDocument(options.input);
  const identity = identityOf(options, document, gh);
  const repo = repoOf(root, options, document);
  const branch = branchOf(root, env, document, hosting);
  const { push: mode, branch: releaseBranch } = resolved.config.release;
  const read = (name: string): Source =>
    readBranch(gh, repo, name, { classicUnreadable: "unknown" });
  const report = evaluateAccess({
    mode,
    repo,
    identity,
    integrationBranch: branch,
    releaseBranch,
    protection: protectionOf(document, read, mode, branch, releaseBranch),
  });
  if (options.json) console.log(JSON.stringify(report));
  else for (const line of describe(report)) console.log(line);
  return EXIT[report.status];
}

if (import.meta.main)
  runMain("release-access", async () => {
    try {
      const { values } = parseArgs({
        options: {
          root: { type: "string" },
          app: { type: "string" },
          "app-id": { type: "string" },
          repo: { type: "string" },
          input: { type: "string" },
          json: { type: "boolean", default: false },
        },
      });
      return runReleaseAccess(
        values.root ? resolve(values.root) : consumerRoot(),
        {
          appSlug: values.app ?? null,
          appId: values["app-id"] ?? null,
          repo: values.repo ?? null,
          input:
            values.input === undefined
              ? null
              : readFileSync(values.input === "-" ? 0 : values.input, "utf8"),
          json: values.json,
        },
      );
    } catch (error) {
      fail(2, error instanceof Error ? error.message : String(error));
    }
  });
