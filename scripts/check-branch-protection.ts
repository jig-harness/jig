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
// The policy may live in branch protection or in a repository ruleset. Only a
// ruleset can let a named actor past every rule, which the release App that
// pushes the release commit needs (docs/adr/ADR-0004-change-notes-released-
// after-the-merge.md), so Jig's lives in one. A ruleset is read as the rules
// GitHub applies to the branch, with each ruleset's bypass list, and reported
// the same way; offline, `--input` takes `{ "rules": [...], "bypass_actors":
// [...] }` for it. A failing ruleset gets the rules to add, not a payload.
import { readFileSync } from "node:fs";
import { cli } from "../lib/cli.ts";

type Json = Record<string, unknown>;
function object(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function field(root: Json, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (value == null) return undefined;
    if (!object(value)) throw new Error(`unexpected parent type for ${path}`);
    return value[key];
  }, root);
}
const FIELD_TYPES: Record<string, string> = {
  "required_status_checks.contexts": "array",
  "required_status_checks.strict": "boolean",
  "required_pull_request_reviews.required_approving_review_count": "number",
  "required_conversation_resolution.enabled": "boolean",
  "enforce_admins.enabled": "boolean",
  "allow_force_pushes.enabled": "boolean",
  "allow_deletions.enabled": "boolean",
  restrictions: "object",
  "required_pull_request_reviews.bypass_pull_request_allowances": "object",
};
function hasType(found: unknown, type: string): boolean {
  if (type === "array") return Array.isArray(found);
  if (type === "object") return object(found);
  return typeof found === type;
}
/** Throw when a field the report reads has the wrong type. */
function checkTypes(value: Json): void {
  for (const [path, type] of Object.entries(FIELD_TYPES)) {
    const found = field(value, path);
    if (found != null && !hasType(found, type))
      throw new Error(
        `branch-protection JSON has unexpected field types: ${path} must be ${type}`,
      );
  }
}
const contexts = (value: Json) =>
  (field(value, "required_status_checks.contexts") ?? []) as unknown[];
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
  return `  not required by policy: strict checks ${onOff(field(value, "required_status_checks.strict") === true)}, approving reviews ${reviews}, administrator enforcement ${onOff(field(value, "enforce_admins.enabled") === true)}`;
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
    ...(Array.isArray(value.ruleset_bypass)
      ? [
          `  bypass actors (ruleset): ${value.ruleset_bypass.join(", ") || "none"}`,
        ]
      : BYPASS_ACTORS.map(
          ([label, path]) =>
            `  bypass actors (${label}): ${actorNames(value, path).join(", ") || "none"}`,
        )),
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
/** A rule of the branch's rulesets, by type; undefined when none applies. */
function rule(rules: Json[], type: string): Json | undefined {
  return rules.find((r) => r.type === type);
}

/** A ruleset bypass actor, named as far as its id allows. */
function bypassName(actor: Json): string {
  const id = String(actor.actor_id ?? "");
  switch (actor.actor_type) {
    case "Integration":
      return `app ${id}`;
    case "RepositoryRole":
      return id === "5" ? "repository admin" : `repository role ${id}`;
    case "OrganizationAdmin":
      return "organization admin";
    case "Team":
      return `team ${id}`;
    case "DeployKey":
      return "deploy keys";
    default:
      return `${String(actor.actor_type)} ${id}`;
  }
}

/**
 * A ruleset's rules for the branch, as the branch-protection shape the
 * policy is evaluated on. Administrator enforcement is on when no bypass
 * actor is the repository admin role.
 */
export function fromRuleset(value: Json): Json {
  if (!Array.isArray(value.rules) || !value.rules.every(object))
    throw new Error("ruleset input: rules must be an array of objects");
  const bypass = value.bypass_actors ?? [];
  if (!Array.isArray(bypass) || !bypass.every(object))
    throw new Error("ruleset input: bypass_actors must be an array of objects");
  const rules = value.rules;
  const checks = rule(rules, "required_status_checks")?.parameters;
  const review = rule(rules, "pull_request")?.parameters;
  const contextsOf = (p: unknown) =>
    object(p) && Array.isArray(p.required_status_checks)
      ? p.required_status_checks.filter(object).map((c) => c.context)
      : [];
  return {
    required_status_checks: object(checks)
      ? {
          strict: checks.strict_required_status_checks_policy === true,
          contexts: contextsOf(checks),
        }
      : null,
    required_pull_request_reviews: object(review)
      ? {
          required_approving_review_count:
            review.required_approving_review_count ?? 0,
        }
      : null,
    required_conversation_resolution: {
      enabled:
        object(review) && review.required_review_thread_resolution === true,
    },
    enforce_admins: {
      enabled: !bypass.some(
        (a) => a.actor_type === "RepositoryRole" && String(a.actor_id) === "5",
      ),
    },
    allow_force_pushes: { enabled: !rule(rules, "non_fast_forward") },
    allow_deletions: { enabled: !rule(rules, "deletion") },
    ruleset_bypass: bypass.map(bypassName),
  };
}

function gh(args: string[]) {
  const result = Bun.spawnSync(["gh", "api", ...args], { timeout: 15000 });
  if (result.exitCode !== 0 && !result.stderr.toString().includes("HTTP 404"))
    throw new Error(result.stderr.toString() || "gh api failed or timed out");
  return result;
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
/** The live protection of `branch` (its default branch when empty). */
function fetchProtection(
  repo: string,
  branch: string,
): { branch: string; raw: string } {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo))
    throw new Error("could not parse an owner/repo from origin");
  const name =
    branch ||
    gh([`repos/${repo}`, "--jq", ".default_branch"])
      .stdout.toString()
      .trim();
  const rules: unknown = JSON.parse(
    gh([
      `repos/${repo}/rules/branches/${encodeURIComponent(name)}`,
    ]).stdout.toString() || "[]",
  );
  if (Array.isArray(rules) && rules.length) {
    const ids = [
      ...new Set(rules.filter(object).map((r) => String(r.ruleset_id))),
    ];
    const bypass = ids.flatMap((id) => {
      const ruleset: unknown = JSON.parse(
        gh([`repos/${repo}/rulesets/${id}`]).stdout.toString() || "{}",
      );
      return object(ruleset) && Array.isArray(ruleset.bypass_actors)
        ? ruleset.bypass_actors
        : [];
    });
    return {
      branch: name,
      raw: JSON.stringify({ rules, bypass_actors: bypass }),
    };
  }
  const response = gh([
    `repos/${repo}/branches/${encodeURIComponent(name)}/protection`,
  ]);
  return {
    branch: name,
    raw: response.exitCode === 0 ? response.stdout.toString() : "{}",
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
export function checkProtection(args: string[]): number {
  const { input, positional } = parseArgs(args);
  const { repo, branch, raw } = protectionSource(input, positional);
  const parsed: unknown = JSON.parse(raw);
  const ruleset = object(parsed) && "rules" in parsed;
  const value = ruleset ? fromRuleset(parsed) : parsed;
  const result = evaluateProtection(value);
  console.log(
    `${ruleset ? "Ruleset" : "Branch protection"} recheck — ${repo}@${branch}\n${result.lines.join("\n")}`,
  );
  if (result.status && ruleset)
    console.log(
      "Recommended remediation — a human adds to the branch's ruleset the rules marked FAIL above: required status check `gates`, required review thread resolution (pull_request rule), block force pushes (non_fast_forward), restrict deletions (deletion).",
    );
  else if (result.status && !input && object(value))
    printRemediation(repo, branch, value);
  return result.status;
}
if (import.meta.main) cli(() => checkProtection(process.argv.slice(2)));
