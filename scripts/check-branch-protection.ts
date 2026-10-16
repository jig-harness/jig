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
  return rulesets.filter(object).map((r) => {
    const bypass = Array.isArray(r.bypass)
      ? r.bypass.join(", ") || "none"
      : "unknown (GitHub omits them without write access to the ruleset)";
    const about = [
      r.name,
      r.enforcement,
      `rules: ${(r.rules as string[]).join(", ") || "none"}`,
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
/** A ruleset bypass actor, named as far as its id allows, with the mode it bypasses in. */
function bypassName(actor: Json): string {
  const id = String(actor.actor_id ?? "");
  const who = (() => {
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
  })();
  return `${who} (${String(actor.bypass_mode ?? "mode unknown")})`;
}

/** What was read: classic protection, and the rules and rulesets that apply to the branch. */
interface Source {
  /** The branch's classic protection; null when it has none. */
  classic: Json | null;
  /** Every rule of every ruleset that applies, each carrying its `ruleset_id`. */
  rules: Json[];
  /** The rulesets by id; one may lack `bypass_actors`, which GitHub omits without write access. */
  rulesets: Json[];
}

function objects(value: unknown, what: string): Json[] {
  if (value == null) return [];
  if (!Array.isArray(value) || !value.every(object))
    throw new Error(`ruleset input: ${what} must be an array of objects`);
  return value;
}

/** The modes a ruleset is in; only `active` enforces anything. */
const ENFORCEMENTS = ["active", "evaluate", "disabled"];

/**
 * Throw unless every rule names the ruleset it comes from and every ruleset
 * has an id and, when it says, a known enforcement mode. A ruleset without
 * `enforcement` is one GitHub would not describe; the rules endpoint lists
 * only active rules, so its rules count.
 */
function checkRulesets(rules: Json[], rulesets: Json[]): void {
  const isId = (value: unknown) =>
    (typeof value === "number" && Number.isInteger(value)) ||
    (typeof value === "string" && /^\d+$/.test(value));
  if (!rules.every((r) => isId(r.ruleset_id)))
    throw new Error("ruleset input: every rule needs its ruleset_id");
  for (const ruleset of rulesets) {
    if (!isId(ruleset.id))
      throw new Error("ruleset input: every ruleset needs its id");
    if (
      "enforcement" in ruleset &&
      !ENFORCEMENTS.includes(ruleset.enforcement as string)
    )
      throw new Error(
        `ruleset input: enforcement of ruleset ${String(ruleset.id)} is one of ${ENFORCEMENTS.join(", ")}`,
      );
  }
}

/** The sources of an `--input` document or a live read; a bare object is classic protection. */
function sourceOf(parsed: Json): Source {
  if (!("rules" in parsed || "rulesets" in parsed || "classic" in parsed))
    return { classic: parsed, rules: [], rulesets: [] };
  if ("bypass_actors" in parsed)
    throw new Error(
      "ruleset input: bypass_actors belong to a ruleset; list them under rulesets[] with the ruleset's id",
    );
  const classic = parsed.classic ?? null;
  if (classic !== null && !object(classic))
    throw new Error("ruleset input: classic must be an object or null");
  const rules = objects(parsed.rules, "rules");
  const rulesets = objects(parsed.rulesets, "rulesets");
  checkRulesets(rules, rulesets);
  return { classic, rules, rulesets };
}

const parametersOf = (rule: Json): Json =>
  object(rule.parameters) ? rule.parameters : {};

/** The check names a `required_status_checks` rule's parameters list. */
function contextsOf(parameters: Json): string[] {
  const checks = parameters.required_status_checks;
  if (checks === undefined) return [];
  if (!Array.isArray(checks) || !checks.every(object))
    throw new Error(
      "ruleset input: required_status_checks must be an array of objects",
    );
  return checks.flatMap((c) =>
    typeof c.context === "string" ? [c.context] : [],
  );
}

/**
 * Classic protection and every rule that applies, combined the way GitHub
 * layers them (a control holds when any source provides it; checks add up;
 * the strictest review count wins), in the shape the policy is evaluated on,
 * with each ruleset's own bypass list beside it.
 */
export function combine(source: Source): Json {
  const { classic, rulesets } = source;
  // A ruleset in evaluate or disabled mode enforces nothing.
  const inactive = new Set(
    rulesets
      .filter((r) => "enforcement" in r && r.enforcement !== "active")
      .map((r) => String(r.id)),
  );
  const rules = source.rules.filter((r) => !inactive.has(String(r.ruleset_id)));
  const base: Json = classic ?? {};
  checkTypes(base);
  const ofType = (type: string) =>
    rules.filter((r) => r.type === type).map(parametersOf);
  const checkRules = ofType("required_status_checks");
  const reviewRules = ofType("pull_request");
  const classicChecks = object(base.required_status_checks)
    ? base.required_status_checks
    : null;
  const classicReviews = object(base.required_pull_request_reviews)
    ? base.required_pull_request_reviews
    : null;
  const approvals = [
    classicReviews?.required_approving_review_count,
    ...reviewRules.map((r) => r.required_approving_review_count),
  ].filter((n): n is number => typeof n === "number");
  const ids = [
    ...new Set([
      ...rules.map((r) => String(r.ruleset_id)),
      ...rulesets.map((r) => String(r.id)),
    ]),
  ];
  return {
    ...base,
    classic_protected: classic !== null,
    required_status_checks:
      classicChecks || checkRules.length
        ? {
            ...classicChecks,
            strict:
              classicChecks?.strict === true ||
              checkRules.some(
                (r) => r.strict_required_status_checks_policy === true,
              ),
            contexts: [
              ...new Set([
                ...contexts(base),
                ...checkRules.flatMap(contextsOf),
              ]),
            ],
          }
        : null,
    required_pull_request_reviews:
      classicReviews || reviewRules.length
        ? {
            ...classicReviews,
            required_approving_review_count: Math.max(0, ...approvals),
          }
        : null,
    required_conversation_resolution: {
      enabled:
        field(base, "required_conversation_resolution.enabled") === true ||
        reviewRules.some((r) => r.required_review_thread_resolution === true),
    },
    allow_force_pushes: {
      enabled: !(
        field(base, "allow_force_pushes.enabled") === false ||
        ofType("non_fast_forward").length
      ),
    },
    allow_deletions: {
      enabled: !(
        field(base, "allow_deletions.enabled") === false ||
        ofType("deletion").length
      ),
    },
    rulesets: ids.map((id) => {
      const ruleset = rulesets.find((r) => String(r.id) === id);
      const bypass = ruleset?.bypass_actors;
      if (bypass !== undefined && bypass !== null)
        if (!Array.isArray(bypass) || !bypass.every(object))
          throw new Error(
            `ruleset input: bypass_actors of ruleset ${id} must be an array of objects`,
          );
      return {
        id,
        name: typeof ruleset?.name === "string" ? ruleset.name : null,
        enforcement:
          typeof ruleset?.enforcement === "string" ? ruleset.enforcement : null,
        rules: [
          ...new Set(
            rules
              .filter((r) => String(r.ruleset_id) === id)
              .map((r) => String(r.type)),
          ),
        ],
        // null where GitHub did not say: unknown, never an empty list.
        bypass: Array.isArray(bypass) ? bypass.map(bypassName) : null,
      };
    }),
  };
}

/** A `gh api` call; a failure throws unless `tolerate404` and GitHub said 404. */
function gh(args: string[], tolerate404 = false) {
  const result = Bun.spawnSync(["gh", "api", ...args], { timeout: 15000 });
  if (
    result.exitCode !== 0 &&
    !(tolerate404 && result.stderr.toString().includes("HTTP 404"))
  )
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
/** A `gh api` response as JSON; null for a tolerated 404. */
function ghJson(args: string[], tolerate404 = false): unknown {
  const result = gh(args, tolerate404);
  return result.exitCode === 0
    ? JSON.parse(result.stdout.toString() || "null")
    : null;
}
/**
 * The branch's classic protection; null when it has none. GitHub answers
 * "Branch not protected" for an unprotected branch but a bare 404 to a reader
 * who may not see protection, so any other 404 is checked against the
 * branch's own `protected` flag, which every reader sees, and fails when the
 * branch is protected.
 */
function classicProtection(repo: string, encoded: string): unknown {
  const result = gh([`repos/${repo}/branches/${encoded}/protection`], true);
  if (result.exitCode === 0) return JSON.parse(result.stdout.toString());
  if (result.stderr.toString().includes("Branch not protected")) return null;
  const branch = ghJson([`repos/${repo}/branches/${encoded}`]);
  if (object(branch) && branch.protected === false) return null;
  throw new Error(
    `cannot read the classic protection of ${repo}@${decodeURIComponent(encoded)}, which is protected: an administrator's gh login is needed`,
  );
}
/**
 * The live protection of `branch` (its default branch when empty): its
 * classic protection, every page of the rules that apply to it, and each
 * ruleset behind those rules, as the document `--input` takes.
 */
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
  const encoded = encodeURIComponent(name);
  // The endpoint returns 30 rules a page by default; --slurp wraps the pages.
  const pages = ghJson([
    "--paginate",
    "--slurp",
    `repos/${repo}/rules/branches/${encoded}?per_page=100`,
  ]);
  const rules = (Array.isArray(pages) ? pages.flat() : []).filter(object);
  const ids = [...new Set(rules.map((r) => String(r.ruleset_id)))];
  const rulesets = ids.map((id) => {
    // A ruleset GitHub will not describe keeps its id, and its bypass list
    // stays unknown.
    const ruleset = ghJson([`repos/${repo}/rulesets/${id}`], true);
    return object(ruleset) ? ruleset : { id };
  });
  const classic = classicProtection(repo, encoded);
  return {
    branch: name,
    raw: JSON.stringify({
      classic: object(classic) ? classic : null,
      rules,
      rulesets,
    }),
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
  if (!object(parsed))
    throw new Error(
      "expected a JSON object from the branch-protection response",
    );
  const source = sourceOf(parsed);
  const value = combine(source);
  const result = evaluateProtection(value);
  const rulesets = source.rules.length > 0 || source.rulesets.length > 0;
  console.log(
    `${rulesets ? (source.classic ? "Branch protection and ruleset" : "Ruleset") : "Branch protection"} recheck — ${repo}@${branch}\n${result.lines.join("\n")}`,
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
