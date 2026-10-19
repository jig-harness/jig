// How GitHub protects a branch, read and combined: classic branch protection,
// every rule of every ruleset that applies to the branch, and each ruleset
// behind those rules with its bypass list. GitHub applies classic protection
// and rulesets together and the most restrictive setting wins, so the
// combined view holds a control when any source provides it, adds required
// checks up, and takes the strictest review count. Each ruleset keeps its own
// bypass actors, each with its type, id and mode: GitHub omits the list from a
// reader without write access to the ruleset, and that list is unknown
// (null), never empty.
//
// `release-access.ts` reads a branch through this file, and so does Jig's own
// branch-protection check (`scripts/check-branch-protection.ts`), which adds
// its policy on top. GitHub is reached through `gh api`, behind the `GhApi`
// function type, so tests inject a fake and another host adds its own reader.
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import { isRecord } from "../../../shared/guards.ts";
import { gitEnv } from "./notes-dir.ts";

export type Json = Record<string, unknown>;

/** What one `gh api` call answered. */
export interface GhResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Runs `gh api` with `args` (the words after `api`). */
export type GhApi = (args: string[]) => GhResult;

const GH_TIMEOUT_MS = 30_000;

/** `gh api` in `cwd`, with a deadline and a clean environment. */
export function ghApi(cwd: string = process.cwd()): GhApi {
  return (args) => {
    const result = spawnSync("gh", ["api", ...args], {
      cwd,
      env: gitEnv(),
      timeout: GH_TIMEOUT_MS,
    });
    return {
      ok: !result.error && result.status === 0,
      stdout: result.stdout ?? "",
      stderr:
        result.stderr ||
        (result.error ? String(result.error.message) : "") ||
        (result.status === null ? "gh api timed out" : ""),
    };
  };
}

/** What GitHub says about a branch could not be read, or does not read as protection. */
export class RulesReadError extends Error {}

/** The value at a dotted `path` of `root`; throws when a parent is not an object. */
export function field(root: Json, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (value == null) return undefined;
    if (!isRecord(value))
      throw new RulesReadError(`unexpected parent type for ${path}`);
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
  "required_signatures.enabled": "boolean",
  "lock_branch.enabled": "boolean",
  restrictions: "object",
  "required_pull_request_reviews.bypass_pull_request_allowances": "object",
};
function hasType(found: unknown, type: string): boolean {
  if (type === "array") return Array.isArray(found);
  if (type === "object") return isRecord(found);
  return typeof found === type;
}
/** Throw when a field of classic protection that is read has the wrong type. */
export function checkTypes(value: Json): void {
  for (const [path, type] of Object.entries(FIELD_TYPES)) {
    const found = field(value, path);
    if (found != null && !hasType(found, type))
      throw new RulesReadError(
        `branch-protection JSON has unexpected field types: ${path} must be ${type}`,
      );
  }
}

/** The required check names of classic protection (or of the combined view). */
export const contexts = (value: Json): unknown[] =>
  (field(value, "required_status_checks.contexts") ?? []) as unknown[];

/** One entry of a ruleset's bypass list, as GitHub gives it. */
export interface BypassActor {
  actor_type: string;
  /** The App's id for `Integration`, the role's for `RepositoryRole`; null for deploy keys. */
  actor_id: number | string | null;
  /** `always`, `pull_request` (only by merging a pull request) or `exempt`. */
  bypass_mode: string | null;
}

/** A bypass actor, named as far as its id allows, with the mode it bypasses in. */
export function describeActor(actor: BypassActor): string {
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

/** Why classic protection could not be read, where it could not. */
export type ClassicUnknown = "unreadable" | "missing";

/** What was read: classic protection, and the rules and rulesets that apply to the branch. */
export interface Source {
  /** The branch's classic protection; null when it has none or it is unknown. */
  classic: Json | null;
  /**
   * Set when classic protection is unknown: `unreadable` for a protected
   * branch whose protection the reader may not see, `missing` for a branch
   * that does not exist yet, whose protection a name pattern may give it.
   */
  classicUnknown?: ClassicUnknown;
  /** Every rule of every ruleset that applies, each carrying its `ruleset_id`. */
  rules: Json[];
  /** The rulesets by id; one may lack `bypass_actors`, which GitHub omits without write access. */
  rulesets: Json[];
}

function objects(value: unknown, what: string): Json[] {
  if (value == null) return [];
  if (!Array.isArray(value) || !value.every(isRecord))
    throw new RulesReadError(
      `ruleset input: ${what} must be an array of objects`,
    );
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
    throw new RulesReadError("ruleset input: every rule needs its ruleset_id");
  for (const ruleset of rulesets) {
    if (!isId(ruleset.id))
      throw new RulesReadError("ruleset input: every ruleset needs its id");
    if (
      "enforcement" in ruleset &&
      !ENFORCEMENTS.includes(ruleset.enforcement as string)
    )
      throw new RulesReadError(
        `ruleset input: enforcement of ruleset ${String(ruleset.id)} is one of ${ENFORCEMENTS.join(", ")}`,
      );
  }
}

const CLASSIC_UNKNOWN: readonly string[] = ["unreadable", "missing"];

/**
 * The sources of an offline document or a live read:
 * `{ "classic": {...}|null, "rules": [...], "rulesets": [...] }`, or a bare
 * classic protection response. With `allowUnknownClassic`, `classic` may also
 * be `"unreadable"` or `"missing"` (see `Source.classicUnknown`).
 */
export function sourceOf(parsed: Json, allowUnknownClassic = false): Source {
  if (!("rules" in parsed || "rulesets" in parsed || "classic" in parsed))
    return { classic: parsed, rules: [], rulesets: [] };
  if ("bypass_actors" in parsed)
    throw new RulesReadError(
      "ruleset input: bypass_actors belong to a ruleset; list them under rulesets[] with the ruleset's id",
    );
  const classic = parsed.classic ?? null;
  const rules = objects(parsed.rules, "rules");
  const rulesets = objects(parsed.rulesets, "rulesets");
  checkRulesets(rules, rulesets);
  if (
    allowUnknownClassic &&
    typeof classic === "string" &&
    CLASSIC_UNKNOWN.includes(classic)
  )
    return {
      classic: null,
      classicUnknown: classic as ClassicUnknown,
      rules,
      rulesets,
    };
  if (classic !== null && !isRecord(classic))
    throw new RulesReadError(
      allowUnknownClassic
        ? 'ruleset input: classic must be an object, null, "unreadable" or "missing"'
        : "ruleset input: classic must be an object or null",
    );
  return { classic, rules, rulesets };
}

/** A source as the document `sourceOf` reads back. */
export function documentOf(source: Source): Json {
  return {
    classic: source.classicUnknown ?? source.classic,
    rules: source.rules,
    rulesets: source.rulesets,
  };
}

const parametersOf = (rule: Json): Json =>
  isRecord(rule.parameters) ? rule.parameters : {};

/** The check names a `required_status_checks` rule's parameters list. */
function contextsOf(parameters: Json): string[] {
  const checks = parameters.required_status_checks;
  if (checks === undefined) return [];
  if (!Array.isArray(checks) || !checks.every(isRecord))
    throw new RulesReadError(
      "ruleset input: required_status_checks must be an array of objects",
    );
  return checks.flatMap((c) =>
    typeof c.context === "string" ? [c.context] : [],
  );
}

/** A ruleset that applies to the branch, as the combined view lists it. */
export interface RulesetView {
  id: string;
  name: string | null;
  /** `active`, `evaluate` or `disabled`; null where GitHub did not describe the ruleset. */
  enforcement: string | null;
  /** `Repository` or `Organization` (or another level GitHub names); null where not said. */
  source: string | null;
  /** The types of its rules that are enforced on the branch. */
  rules: string[];
  /** Its bypass list; null where GitHub withheld it: unknown, never empty. */
  bypass: BypassActor[] | null;
}

/** A ruleset's bypass list as GitHub gave it; null when withheld. */
function bypassOf(ruleset: Json | undefined, id: string): BypassActor[] | null {
  const bypass = ruleset?.bypass_actors;
  if (bypass === undefined || bypass === null) return null;
  if (!Array.isArray(bypass) || !bypass.every(isRecord))
    throw new RulesReadError(
      `ruleset input: bypass_actors of ruleset ${id} must be an array of objects`,
    );
  return bypass.map((actor) => ({
    actor_type: String(actor.actor_type),
    actor_id:
      typeof actor.actor_id === "number" || typeof actor.actor_id === "string"
        ? actor.actor_id
        : null,
    bypass_mode:
      typeof actor.bypass_mode === "string" ? actor.bypass_mode : null,
  }));
}

const text = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/**
 * Classic protection and every rule that applies, combined the way GitHub
 * layers them (a control holds when any source provides it; checks add up;
 * the strictest review count wins), in the shape of classic protection, with
 * `classic_protected` and each ruleset's own view (`RulesetView`) beside it.
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
  const classicChecks = isRecord(base.required_status_checks)
    ? base.required_status_checks
    : null;
  const classicReviews = isRecord(base.required_pull_request_reviews)
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
  const views: RulesetView[] = ids.map((id) => {
    const ruleset = rulesets.find((r) => String(r.id) === id);
    const own = rules.filter((r) => String(r.ruleset_id) === id);
    return {
      id,
      name: text(ruleset?.name),
      enforcement: text(ruleset?.enforcement),
      source:
        text(ruleset?.source_type) ??
        own.map((r) => text(r.ruleset_source_type)).find(Boolean) ??
        null,
      rules: [...new Set(own.map((r) => String(r.type)))],
      bypass: bypassOf(ruleset, id),
    };
  });
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
    rulesets: views,
  };
}

/** A call's output as JSON; null for a tolerated 404. Throws on any other failure. */
function ask(gh: GhApi, args: string[], tolerate404 = false): GhResult {
  const result = gh(args);
  if (!result.ok && !(tolerate404 && result.stderr.includes("HTTP 404")))
    throw new RulesReadError(result.stderr || "gh api failed or timed out");
  return result;
}
function askJson(gh: GhApi, args: string[], tolerate404 = false): unknown {
  const result = ask(gh, args, tolerate404);
  return result.ok ? JSON.parse(result.stdout || "null") : null;
}

/** The repository's default branch, as GitHub names it. */
export function defaultBranchOf(gh: GhApi, repo: string): string {
  return ask(gh, [`repos/${repo}`, "--jq", ".default_branch"]).stdout.trim();
}

/** What to do where classic protection cannot be read. */
export interface ReadOptions {
  /**
   * `throw` (the default) fails the read; `unknown` records it as
   * `Source.classicUnknown`, as it does for a branch that does not exist yet.
   */
  classicUnreadable?: "throw" | "unknown";
}

/**
 * The branch's classic protection; null when it has none. GitHub answers
 * "Branch not protected" for an unprotected branch but a bare 404 to a reader
 * who may not see protection, so any other 404 is checked against the
 * branch's own `protected` flag, which every reader sees. A protected branch
 * whose protection cannot be read fails the read, or is `unreadable` under
 * `classicUnreadable: "unknown"`, where a branch that does not exist is
 * `missing`.
 */
function classicProtection(
  gh: GhApi,
  repo: string,
  encoded: string,
  options: ReadOptions,
): Json | null | ClassicUnknown {
  const result = ask(
    gh,
    [`repos/${repo}/branches/${encoded}/protection`],
    true,
  );
  if (result.ok) {
    const parsed: unknown = JSON.parse(result.stdout);
    return isRecord(parsed) ? parsed : null;
  }
  if (result.stderr.includes("Branch not protected")) return null;
  const tolerant = options.classicUnreadable === "unknown";
  const branch = askJson(gh, [`repos/${repo}/branches/${encoded}`], tolerant);
  if (branch === null) return "missing";
  if (isRecord(branch) && branch.protected === false) return null;
  if (tolerant) return "unreadable";
  throw new RulesReadError(
    `cannot read the classic protection of ${repo}@${decodeURIComponent(encoded)}, which is protected: an administrator's gh login is needed`,
  );
}

/**
 * The live protection of `branch` in `repo`: its classic protection, every
 * page of the rules that apply to it (the endpoint answers for a branch name
 * that does not exist yet too), and each ruleset behind those rules.
 */
export function readBranch(
  gh: GhApi,
  repo: string,
  branch: string,
  options: ReadOptions = {},
): Source {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo))
    throw new RulesReadError(`not an owner/repo: ${repo}`);
  const encoded = encodeURIComponent(branch);
  // The endpoint returns 30 rules a page by default; --slurp wraps the pages.
  const pages = askJson(gh, [
    "--paginate",
    "--slurp",
    `repos/${repo}/rules/branches/${encoded}?per_page=100`,
  ]);
  // A page or a rule that does not read as one is a rule unknown, never one
  // absent: the read fails rather than narrowing what applies.
  if (!Array.isArray(pages) || !pages.every(Array.isArray))
    throw new RulesReadError(
      `the rules of ${repo}@${branch} did not read as pages of rules`,
    );
  const rules = objects(pages.flat(), "rules");
  checkRulesets(rules, []);
  const ids = [...new Set(rules.map((r) => String(r.ruleset_id)))];
  const rulesets = ids.map((id) => {
    // A ruleset GitHub will not describe keeps its id, and its bypass list
    // stays unknown.
    const ruleset = askJson(gh, [`repos/${repo}/rulesets/${id}`], true);
    if (ruleset === null) return { id };
    if (!isRecord(ruleset))
      throw new RulesReadError(`ruleset ${id} of ${repo} did not read as one`);
    return ruleset;
  });
  const classic = classicProtection(gh, repo, encoded, options);
  return typeof classic === "string"
    ? { classic: null, classicUnknown: classic, rules, rulesets }
    : { classic, rules, rulesets };
}
