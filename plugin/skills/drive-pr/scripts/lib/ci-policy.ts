/**
 * What continuous integration the drive waits for before it certifies a head,
 * and whether it may suppress CI on intermediate pushes.
 *
 * Required checks come from `ci.required_checks` when the repository declares
 * them, else from the protection of the pull request's base branch on GitHub
 * (classic branch protection and rulesets together), so a repository whose
 * protection already names its required checks configures nothing.
 *
 * The hold is opt-in. A repository whose workflows skip their expensive jobs
 * while a label is present, and run them in full when it is removed, names
 * that label in `ci.hold_label` and lists `ci.required_checks`: after a
 * release the drive waits for every required check to run again, so the list
 * must hold only checks that rerun on the unlabel, which branch protection
 * cannot tell. Without a hold label every push runs normal CI and the drive
 * never touches labels.
 */
import { consumerRoot } from "../../../resolve-review-comments/scripts/lib/consumer.ts";
import {
  baseBranch,
  ciHoldLabelSetting,
  requiredChecksSetting,
} from "./overlay.ts";
import { ghCall } from "./proc.ts";

export interface CiPolicy {
  /** Check names that must complete on the exact head. */
  readonly requiredChecks: readonly string[];
  /**
   * The GitHub Apps each pinned required check must come from, by check name.
   * Branch protection and rulesets can pin a check to an app; a same-named
   * check from another app does not satisfy it. A check pinned to several
   * apps (classic protection to one, a ruleset to another) needs a passing
   * result from each. Empty for configured checks.
   */
  readonly requiredApps: ReadonlyMap<string, readonly number[]>;
  /**
   * Whether `requiredChecks` came from branch protection rather than
   * configuration. An empty derived list means "nothing declared", not "no
   * CI": the head must still carry some CI evidence before it is certified.
   */
  readonly derived: boolean;
  /** The label workflows honour to skip intermediate CI; `null` when none. */
  readonly holdLabel: string | null;
}

/** One required check: its name and the app it is pinned to, if any. */
export interface RequiredCheck {
  readonly context: string;
  readonly appId: number | null;
}

/**
 * `ci.hold_label`, validated against its precondition. Needs no network, so
 * the hold transitions of a repository without a hold never depend on
 * reading branch protection.
 */
export function holdLabelPolicy(): string | null {
  const holdLabel = ciHoldLabelSetting() ?? null;
  if (holdLabel === null) return null;
  const configured = requiredChecksSetting();
  if (configured === undefined || configured.length === 0)
    throw new Error(
      "ci.hold_label needs ci.required_checks: the checks that run again when the hold is removed and prove full CI on the final head",
    );
  return holdLabel;
}

/** A pinned app id from a protection payload: a positive integer, or `null` for any app. */
function appIdOf(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  // -1 is GitHub's explicit "any app".
  if (value === -1) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

/**
 * Checks a classic branch-protection payload (`GET /branches/{branch}`)
 * requires, or `null` when malformed. GitHub always returns the
 * `protection.required_status_checks` object, with `enforcement_level: off`
 * when nothing is required, so a missing member is malformed rather than
 * "requires nothing".
 */
export function protectionContexts(raw: unknown): RequiredCheck[] | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const branch = raw as Record<string, unknown>;
  const protection = branch.protection;
  if (branch.protected === false && protection === undefined) return [];
  if (
    typeof protection !== "object" ||
    protection === null ||
    Array.isArray(protection)
  )
    return null;
  const record = protection as Record<string, unknown>;
  if (record.enabled === false) return [];
  if (record.enabled !== true) return null;
  const checks = record.required_status_checks;
  if (typeof checks !== "object" || checks === null || Array.isArray(checks))
    return null;
  const required = checks as Record<string, unknown>;
  if (required.enforcement_level === "off") return [];
  if (Array.isArray(required.checks)) {
    const result: RequiredCheck[] = [];
    for (const check of required.checks) {
      if (typeof check !== "object" || check === null || Array.isArray(check))
        return null;
      const value = check as Record<string, unknown>;
      const appId = appIdOf(value.app_id);
      if (
        typeof value.context !== "string" ||
        value.context === "" ||
        appId === undefined
      )
        return null;
      result.push({ context: value.context, appId });
    }
    return result;
  }
  const contexts = required.contexts;
  if (
    !Array.isArray(contexts) ||
    contexts.some((name) => typeof name !== "string" || name === "")
  )
    return null;
  return (contexts as string[]).map((context) => ({ context, appId: null }));
}

/**
 * Checks the rulesets active on a branch require, or `null` when
 * malformed. Accepts one page (an array of rules) or `--slurp`ed pages (an
 * array of such arrays).
 */
export function rulesetContexts(raw: unknown): RequiredCheck[] | null {
  if (!Array.isArray(raw)) return null;
  const rules = raw.every(Array.isArray) ? raw.flat() : raw;
  const result: RequiredCheck[] = [];
  for (const rule of rules) {
    if (typeof rule !== "object" || rule === null || Array.isArray(rule))
      return null;
    const value = rule as Record<string, unknown>;
    if (value.type !== "required_status_checks") continue;
    const parameters = value.parameters as Record<string, unknown> | undefined;
    const checks = parameters?.required_status_checks;
    if (!Array.isArray(checks)) return null;
    for (const check of checks) {
      const entry = check as Record<string, unknown> | null;
      const context = entry?.context;
      const appId = appIdOf(entry?.integration_id);
      if (typeof context !== "string" || context === "" || appId === undefined)
        return null;
      result.push({ context, appId });
    }
  }
  return result;
}

/**
 * One list from both sources, as GitHub layers them: every obligation
 * applies. A check required from any app and pinned elsewhere keeps the pin,
 * since a run from the pinned app meets both; a check pinned to several apps
 * keeps every pin, each to be met by its own app's run.
 */
export function mergeRequiredChecks(
  sources: readonly (readonly RequiredCheck[])[],
): { names: string[]; apps: Map<string, number[]> } {
  const pins = new Map<string, number[]>();
  for (const source of sources)
    for (const { context, appId } of source) {
      const known = pins.get(context) ?? [];
      if (appId !== null && !known.includes(appId)) known.push(appId);
      pins.set(context, known);
    }
  const apps = new Map<string, number[]>();
  for (const [context, appIds] of pins)
    if (appIds.length > 0) apps.set(context, appIds);
  return { names: [...pins.keys()], apps };
}

async function ghJson(
  args: string[],
  root: string,
): Promise<{ value: unknown } | { error: string }> {
  const result = await ghCall(["api", ...args], { cwd: root, stderr: "pipe" });
  if (result.code !== 0)
    return {
      error: result.stderr.trim().split("\n")[0] || `gh exited ${result.code}`,
    };
  try {
    return { value: JSON.parse(result.stdout) as unknown };
  } catch {
    return { error: "unparseable response" };
  }
}

/**
 * The checks the branch's protection requires. Throws naming what could not
 * be read. Both sources are read on every call: a ruleset and classic
 * protection can each require checks, and either may be absent.
 */
async function derivedRequiredChecks(
  root: string,
  branch: string,
): Promise<{ names: string[]; apps: Map<string, number[]> }> {
  const encoded = encodeURIComponent(branch);
  const [branchInfo, rules] = await Promise.all([
    ghJson([`repos/{owner}/{repo}/branches/${encoded}`], root),
    ghJson(
      [
        "--paginate",
        "--slurp",
        `repos/{owner}/{repo}/rules/branches/${encoded}?per_page=100`,
      ],
      root,
    ),
  ]);
  const failure = (what: string, reason: string): Error =>
    new Error(
      `cannot read the required checks of '${branch}' from its ${what} (${reason}); list them in ci.required_checks in .config/groundwork-overlay.yaml`,
    );
  if ("error" in branchInfo)
    throw failure("branch protection", branchInfo.error);
  if ("error" in rules) throw failure("rulesets", rules.error);
  const classic = protectionContexts(branchInfo.value);
  if (classic === null) throw failure("branch protection", "malformed");
  const fromRules = rulesetContexts(rules.value);
  if (fromRules === null) throw failure("rulesets", "malformed");
  return mergeRequiredChecks([classic, fromRules]);
}

/** The pull request's base branch, or `null` when it cannot be read. */
async function prBaseBranch(pr: string, root: string): Promise<string | null> {
  const view = await ghCall(
    ["pr", "view", pr, "--json", "baseRefName", "-q", ".baseRefName"],
    { cwd: root, stderr: "ignore" },
  );
  const name = view.stdout.trim();
  return view.code === 0 && name !== "" ? name : null;
}

const cache = new Map<string, CiPolicy>();

/**
 * The repository's CI policy for pull request `pr`. Throws with an
 * operator-facing message when the configuration is invalid or the required
 * checks can be neither read from configuration nor derived; callers fail
 * closed on it. Checks are derived from the protection of the pull request's
 * base branch; an unreadable base is an error, never a fallback to another
 * branch's protection, which may require less. Without `pr`, they are
 * derived from the repository's base branch (`repository.base_branch` or the
 * default branch).
 */
export async function ciPolicy(
  pr?: string,
  root = consumerRoot(),
): Promise<CiPolicy> {
  const holdLabel = holdLabelPolicy();
  const configured = requiredChecksSetting();
  if (configured !== undefined)
    return {
      requiredChecks: configured,
      requiredApps: new Map(),
      derived: false,
      holdLabel,
    };
  const branch =
    pr === undefined ? await baseBranch(root) : await prBaseBranch(pr, root);
  if (branch === null)
    throw new Error(
      pr === undefined
        ? "cannot tell which branch's protection names the required checks; list them in ci.required_checks in .config/groundwork-overlay.yaml"
        : `cannot read the base branch of pull request #${pr}, whose protection names the required checks; retry, or list them in ci.required_checks in .config/groundwork-overlay.yaml`,
    );
  const key = `${root}\0${branch}`;
  const cached = cache.get(key);
  if (cached !== undefined) return { ...cached, holdLabel };
  const derived = await derivedRequiredChecks(root, branch);
  const policy = {
    requiredChecks: derived.names,
    requiredApps: derived.apps,
    derived: true,
    holdLabel,
  };
  cache.set(key, policy);
  return policy;
}
