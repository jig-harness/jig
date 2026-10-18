// Read-only host audit of `main`'s branch protection against Jig's policy.
// Prints proposed remediation; never changes settings. Offline JSON fixtures
// need neither a network connection nor a Git origin. Reading the live setting
// needs an administrator's `gh` login, which CI's token lacks, so this runs by
// hand rather than in the gates.
//
// The policy: the `gates` check is required, every review thread is resolved
// before merging, and `main` cannot be force-pushed or deleted. Deliberately
// not required: an approving review (a person merges, and is the reviewer who
// approves; docs/adr/ADR-0003-a-person-merges.md), administrator enforcement,
// and an up-to-date branch ("strict" checks), which turns every merge into a
// pull, a push and another full CI run on each open pull request. Those
// settings are reported, never failed, and remediation keeps them as they are.
//
// The policy may live in branch protection, in repository rulesets, or in
// both: GitHub applies them together and the most restrictive setting wins,
// so the audit reads classic protection and every page of the rules that
// apply to the branch, and a control holds when any of them provides it. Only a
// ruleset can let a named actor past every rule, which the release App that
// pushes the release commit needs (docs/adr/ADR-0004-change-notes-released-
// after-the-merge.md), so Jig's lives in one. Each ruleset is reported with its
// own bypass list and each actor's mode; GitHub omits the list from a reader
// without write access to the ruleset, and that is reported as unknown, never
// as none. Offline, `--input` takes either a classic protection response, or
// `{ "classic": {...}|null, "rules": [...], "rulesets": [{ "id", "name",
// "enforcement", "bypass_actors" }] }`. A failing ruleset gets the rules to
// add, not a payload.
//
// Reading and combining classic protection and rulesets is the changelog
// skill's (plugin/skills/changelog/scripts/github-rules.ts), which its
// release-access check reads the same way; this file holds Jig's policy, its
// report and its remediation.
import { readFileSync } from "node:fs";
import { cli } from "../lib/cli.ts";
import {
  checkTypes,
  combine,
  contexts,
  defaultBranchOf,
  describeActor,
  documentOf,
  field,
  ghApi,
  type Json,
  type RulesetView,
  readBranch,
  sourceOf,
} from "../plugin/skills/changelog/scripts/github-rules.ts";

function object(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** The settings Jig's policy requires, each with whether it holds. */
function controls(value: Json): [string, boolean][] {
  return [
    [
      "required CI status check(s) configured",
      contexts(value).includes("gates"),
    ],
    [
      "required conversation resolution",
      field(value, "required_conversation_resolution.enabled") === true,
    ],
    [
      "force-push disallowed",
      field(value, "allow_force_pushes.enabled") === false,
    ],
    [
      "branch deletion disallowed",
      field(value, "allow_deletions.enabled") === false,
    ],
  ];
}
const onOff = (on: boolean) => (on ? "on" : "off");
/** The settings the policy leaves free, reported as they are. */
function unrequired(value: Json): string {
  const reviews = (field(
    value,
    "required_pull_request_reviews.required_approving_review_count",
  ) ?? 0) as number;
  // Administrator enforcement is classic protection's; a ruleset's bypass list
  // is reported ruleset by ruleset.
  const admins =
    value.classic_protected === false
      ? ""
      : `, administrator enforcement ${onOff(field(value, "enforce_admins.enabled") === true)}`;
  return `  not required by policy: strict checks ${onOff(field(value, "required_status_checks.strict") === true)}, approving reviews ${reviews}${admins}`;
}
/** The users, teams and apps an actor map at `path` names. */
function actorNames(value: Json, path: string): string[] {
  const actors = field(value, path);
  if (actors == null) return [];
  if (!object(actors)) throw new Error(`invalid actors: ${path}`);
  return ["users", "teams", "apps"].flatMap((key) => {
    const entries = actors[key] ?? [];
    if (!Array.isArray(entries))
      throw new Error(`${path}.${key} must be an array`);
    return entries.map((entry) => {
      if (!object(entry)) throw new Error(`invalid ${path}.${key} actor`);
      return String(entry[key === "users" ? "login" : "slug"] ?? "");
    });
  });
}
const BYPASS_ACTORS = [
  ["restrictions", "restrictions"],
  [
    "PR review bypass_pull_request_allowances",
    "required_pull_request_reviews.bypass_pull_request_allowances",
  ],
] as const;
/** One line per ruleset: what it holds and who may bypass it, in which mode. */
function rulesetLines(value: Json): string[] {
  const rulesets = value.rulesets ?? [];
  if (!Array.isArray(rulesets)) throw new Error("rulesets must be an array");
  return (rulesets as RulesetView[]).filter(object).map((r) => {
    const bypass = Array.isArray(r.bypass)
      ? r.bypass.map(describeActor).join(", ") || "none"
      : "unknown (GitHub omits them without write access to the ruleset)";
    const about = [
      r.name,
      r.enforcement,
      `rules: ${r.rules.join(", ") || "none"}`,
    ]
      .filter(Boolean)
      .join("; ");
    return `  ruleset ${String(r.id)} (${about}): bypass actors: ${bypass}`;
  });
}
export function evaluateProtection(value: unknown): {
  status: number;
  lines: string[];
} {
  if (!object(value))
    throw new Error(
      "expected a JSON object from the branch-protection response",
    );
  checkTypes(value);
  const checks = controls(value);
  const lines = [
    ...checks.map(([label, pass]) => `  ${pass ? "PASS" : "FAIL"}  ${label}`),
    `  required checks: ${contexts(value).join(", ") || "none"}`,
    unrequired(value),
    ...(value.classic_protected === false
      ? []
      : BYPASS_ACTORS.map(
          ([label, path]) =>
            `  bypass actors (${label}): ${actorNames(value, path).join(", ") || "none"}`,
        )),
    ...rulesetLines(value),
  ];
  const satisfied = checks.filter(([, pass]) => pass).length;
  lines.push(`${satisfied}/${checks.length} controls satisfied`);
  return { status: satisfied === checks.length ? 0 : 1, lines };
}
export function remediation(value: Json): Json {
  const checks = object(value.required_status_checks)
    ? value.required_status_checks
    : {};
  const reviews = object(value.required_pull_request_reviews)
    ? value.required_pull_request_reviews
    : null;
  const actors = (source: unknown): unknown => {
    if (source == null) return null;
    if (!object(source)) throw new Error("invalid actor map");
    return Object.fromEntries(
      ["users", "teams", "apps"].map((key) => [
        key,
        ((source[key] ?? []) as Json[]).map(
          (actor) => actor[key === "users" ? "login" : "slug"],
        ),
      ]),
    );
  };
  const existing = (checks.checks ??
    ((checks.contexts ?? []) as string[]).map((context) => ({
      context,
      app_id: null,
    }))) as Json[];
  return {
    required_status_checks: {
      strict: checks.strict ?? false,
      contexts: [
        ...new Set([...((checks.contexts ?? []) as string[]), "gates"]),
      ].sort(),
      checks: existing.some((check) => check.context === "gates")
        ? existing
        : [...existing, { context: "gates", app_id: null }],
    },
    enforce_admins: field(value, "enforce_admins.enabled") ?? false,
    // `null` keeps pull-request review protection off; an object turns it on.
    required_pull_request_reviews: reviews && {
      required_approving_review_count:
        (reviews.required_approving_review_count ?? 0) as number,
      dismiss_stale_reviews: reviews.dismiss_stale_reviews ?? false,
      require_code_owner_reviews: reviews.require_code_owner_reviews ?? false,
      require_last_push_approval: reviews.require_last_push_approval ?? false,
      ...(reviews.bypass_pull_request_allowances
        ? {
            bypass_pull_request_allowances: actors(
              reviews.bypass_pull_request_allowances,
            ),
          }
        : {}),
      ...(reviews.dismissal_restrictions
        ? { dismissal_restrictions: actors(reviews.dismissal_restrictions) }
        : {}),
    },
    required_conversation_resolution: true,
    restrictions: actors(value.restrictions),
    allow_force_pushes: false,
    allow_deletions: false,
    ...Object.fromEntries(
      [
        "required_linear_history",
        "block_creations",
        "lock_branch",
        "allow_fork_syncing",
      ].map((key) => [key, field(value, `${key}.enabled`) ?? false]),
    ),
  };
}
/** The `--input` file and the positional owner/repo and branch. */
function parseArgs(args: string[]): { input: string; positional: string[] } {
  let input = "";
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "--input") {
      positional.push(args[index] ?? "");
      continue;
    }
    input = args[++index] ?? "";
    if (!input) throw new Error("--input requires a file");
  }
  if (positional.length > 2 || positional.some((arg) => arg.startsWith("-")))
    throw new Error(
      "usage: check-branch-protection.ts [--input FILE|-] [owner/repo] [branch]",
    );
  return { input, positional };
}
/** The owner/repo of the `origin` remote. */
function originRepo(): string {
  const remote = Bun.spawnSync(["git", "remote", "get-url", "origin"]);
  if (remote.exitCode !== 0)
    throw new Error("cannot determine origin; pass owner/repo explicitly");
  return remote.stdout
    .toString()
    .trim()
    .replace(
      /^(git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)/,
      "",
    )
    .replace(/\.git$/, "");
}
/**
 * The live protection of `branch` (its default branch when empty), as the
 * document `--input` takes.
 */
function fetchProtection(
  repo: string,
  branch: string,
): { branch: string; raw: string } {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo))
    throw new Error("could not parse an owner/repo from origin");
  const gh = ghApi();
  const name = branch || defaultBranchOf(gh, repo);
  return {
    branch: name,
    raw: JSON.stringify(documentOf(readBranch(gh, repo, name))),
  };
}
function printRemediation(repo: string, branch: string, value: Json): void {
  console.log("Recommended remediation — review, then a human runs:");
  console.log(
    `gh api --method PUT repos/${repo}/branches/${encodeURIComponent(branch)}/protection --input protection-remediation.json`,
  );
  console.log("Save this payload as protection-remediation.json:");
  console.log(JSON.stringify(remediation(value), null, 2));
}
/** Where the protection comes from: the `--input` file, or the forge. */
function protectionSource(
  input: string,
  [repoArg, branchArg]: string[],
): { repo: string; branch: string; raw: string } {
  if (input)
    return {
      repo: repoArg || "(offline input)",
      branch: branchArg || "main",
      raw: readFileSync(input === "-" ? 0 : input, "utf8"),
    };
  const repo = repoArg || originRepo();
  return { repo, ...fetchProtection(repo, branchArg ?? "") };
}
/** What the recheck's heading calls the protection: classic, rulesets, or both. */
function recheckTitle(rulesets: boolean, classic: boolean): string {
  if (!rulesets) return "Branch protection";
  return classic ? "Branch protection and ruleset" : "Ruleset";
}
export function checkProtection(args: string[]): number {
  const { input, positional } = parseArgs(args);
  const { repo, branch, raw } = protectionSource(input, positional);
  const parsed: unknown = JSON.parse(raw);
  if (!object(parsed))
    throw new Error(
      "expected a JSON object from the branch-protection response",
    );
  const source = sourceOf(parsed);
  const value = combine(source);
  const result = evaluateProtection(value);
  const rulesets = source.rules.length > 0 || source.rulesets.length > 0;
  console.log(
    `${recheckTitle(rulesets, Boolean(source.classic))} recheck — ${repo}@${branch}\n${result.lines.join("\n")}`,
  );
  if (result.status && rulesets)
    console.log(
      "Recommended remediation — a human adds to the branch's ruleset the rules marked FAIL above: required status check `gates`, required review thread resolution (pull_request rule), block force pushes (non_fast_forward), restrict deletions (deletion).",
    );
  else if (result.status && !input)
    printRemediation(repo, branch, source.classic ?? {});
  return result.status;
}
if (import.meta.main) cli(() => checkProtection(process.argv.slice(2)));
