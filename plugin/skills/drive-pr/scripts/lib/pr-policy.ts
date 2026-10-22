/**
 * The consumer repository's pull-request policy: how agents open and stack
 * pull requests. Declared values come from the `pull_requests`
 * section of `.config/jig.yaml`; the facts a repository already
 * states elsewhere (its default branch, pull-request template, title
 * convention, delete-branch-on-merge setting, code owners) are derived
 * here instead of being asked for twice.
 *
 * Every declared field is optional and has a default, so a repository without
 * the section still gets one explicit, conservative policy: no stacking, draft
 * pull requests, a human merges (merging is not configurable). Unlike the
 * other overlay sections, an unknown key inside `pull_requests` is an error: a
 * misspelt `stacking` would otherwise silently fall back to the default it was
 * written to change.
 *
 * `do-item`'s `pr-plan.ts` applies the policy when a pull request is opened.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { withSource } from "../../../../shared/consumer.ts";
import { tidyBranchName } from "../../../do-item/scripts/lib/tracker/keys.ts";
import { readOptionalOverlay } from "./overlay.ts";
import { ghCall, git } from "./proc.ts";
import { isRecord } from "../../../../shared/guards.ts";

export const STACKING_MODES = ["none", "native", "branch"] as const;
export type Stacking = (typeof STACKING_MODES)[number];
export const OPEN_AS = ["draft", "ready"] as const;
export type OpenAs = (typeof OPEN_AS)[number];
export const ISSUE_LINKS = ["closes", "refs", "none"] as const;
export type IssueLink = (typeof ISSUE_LINKS)[number];
export const TITLE_FORMATS = ["conventional", "free"] as const;
/** When the drive marks a draft Ready: after round N, at convergence, or never. */
export type MarkReady = number | "converged" | "never";
export type TitleFormat = (typeof TITLE_FORMATS)[number];

/** The branch-name pattern used when `pull_requests.branch_name` is unset. */
export const DEFAULT_BRANCH_PATTERN = "{key_lower}-{slug}";

/** The placeholders a branch-name pattern may use. */
export const BRANCH_PLACEHOLDERS = ["key", "key_lower", "slug"] as const;

/** The longest title slug a branch name carries, in characters. */
export const SLUG_MAX = 40;

export interface PrPolicy {
  stacking: Stacking;
  /** Most pull requests one stack may hold, this one included; `null` = no cap. */
  maxStackDepth: number | null;
  /** `null` = not declared; `resolveOpenAs` derives it. */
  openAs: OpenAs | null;
  /** When a drive marks a draft Ready; default 1 (after the first round). */
  markReady: MarkReady;
  branchName: string;
  issueLink: IssueLink;
  /** Changed-line budget per pull request; `null` = no budget. */
  sizeBudget: number | null;
  labels: string[];
  /** `null` = not declared; `detectTitleFormat` derives it. */
  titleFormat: TitleFormat | null;
}

/** The fields `pull_requests` may hold; any other key is refused. */
export const KNOWN_KEYS = [
  "stacking",
  "max_stack_depth",
  "open_as",
  "mark_ready",
  "branch_name",
  "issue_link",
  "size_budget",
  "labels",
  "title_format",
] as const;

function oneOf<T extends string>(
  section: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | null {
  const value = section[key];
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    !(allowed as readonly string[]).includes(value)
  )
    throw new Error(
      `pull_requests.${key} must be one of ${allowed.join(", ")} (got ${JSON.stringify(value)})`,
    );
  return value as T;
}

function positiveInt(
  section: Record<string, unknown>,
  key: string,
): number | null {
  const value = section[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error(
      `pull_requests.${key} must be a whole number of at least 1 (got ${JSON.stringify(value)})`,
    );
  return value;
}

/** Throws unless `pattern` is a usable branch-name pattern. */
export function validateBranchPattern(pattern: string): void {
  const placeholders = [...pattern.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
  for (const name of placeholders)
    if (!(BRANCH_PLACEHOLDERS as readonly string[]).includes(name ?? ""))
      throw new Error(
        `pull_requests.branch_name uses an unknown placeholder {${name}}; the placeholders are ${BRANCH_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}`,
      );
  if (!placeholders.includes("key") && !placeholders.includes("key_lower"))
    throw new Error(
      "pull_requests.branch_name must contain {key} or {key_lower}: the issue key in the branch name is what links the pull request to its issue",
    );
  if (/[{}]/.test(pattern.replace(/\{[a-z_]+\}/g, "")))
    throw new Error(
      `pull_requests.branch_name has an unbalanced brace: ${JSON.stringify(pattern)}`,
    );
  if (pattern.includes("}{"))
    throw new Error(
      `pull_requests.branch_name puts two placeholders side by side: ${JSON.stringify(pattern)}; separate them with a character such as \`-\` or \`/\`, or the key cannot be read back from a branch`,
    );
}

/** Validate the `pull_requests` section of a parsed overlay. */
export function parsePrPolicy(overlay: Record<string, unknown>): PrPolicy {
  const raw = overlay.pull_requests;
  if (raw !== undefined && raw !== null && !isRecord(raw))
    throw new Error("pull_requests must be a mapping");
  const section = (raw ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(section))
    if (!(KNOWN_KEYS as readonly string[]).includes(key))
      throw new Error(
        `pull_requests.${key} is not a known field (${KNOWN_KEYS.join(", ")})`,
      );

  const branchName = section.branch_name ?? DEFAULT_BRANCH_PATTERN;
  if (typeof branchName !== "string" || branchName.trim() === "")
    throw new Error("pull_requests.branch_name must be a nonempty string");
  validateBranchPattern(branchName);

  const labels = section.labels ?? [];
  if (
    !Array.isArray(labels) ||
    labels.some((l) => typeof l !== "string" || l.trim() === "") ||
    new Set(labels).size !== labels.length
  )
    throw new Error(
      "pull_requests.labels must be a list of distinct nonempty label names",
    );

  const stacking = oneOf(section, "stacking", STACKING_MODES) ?? "none";
  const maxStackDepth = positiveInt(section, "max_stack_depth");
  if (maxStackDepth !== null && stacking === "none")
    throw new Error(
      "pull_requests.max_stack_depth needs pull_requests.stacking set to native or branch",
    );

  const rawMarkReady = section.mark_ready ?? 1;
  if (
    !(
      rawMarkReady === "converged" ||
      rawMarkReady === "never" ||
      (typeof rawMarkReady === "number" &&
        Number.isSafeInteger(rawMarkReady) &&
        rawMarkReady >= 1)
    )
  )
    throw new Error(
      `pull_requests.mark_ready must be a round number of at least 1, converged or never (got ${JSON.stringify(rawMarkReady)})`,
    );

  return {
    stacking,
    maxStackDepth,
    openAs: oneOf(section, "open_as", OPEN_AS),
    markReady: rawMarkReady as MarkReady,
    branchName,
    issueLink: oneOf(section, "issue_link", ISSUE_LINKS) ?? "closes",
    sizeBudget: positiveInt(section, "size_budget"),
    labels: labels as string[],
    titleFormat: oneOf(section, "title_format", TITLE_FORMATS),
  };
}

/**
 * The repository's pull-request policy; when invalid, throws naming the file
 * or variable that set the field at fault.
 */
export function prPolicy(): PrPolicy {
  const overlay = readOptionalOverlay();
  try {
    return parsePrPolicy(overlay);
  } catch (e) {
    throw withSource(overlay, "pull_requests", e);
  }
}

/**
 * Whether a new pull request opens as a draft or Ready, and why. Declared
 * `open_as` wins. Otherwise a repository whose AI reviewer is declared not to
 * review drafts (`drive.reviews_drafts: false`) opens Ready, since a draft
 * there would wait for a review that never comes; every other repository
 * opens drafts, which the drive marks Ready at the point `mark_ready` declares.
 */
export function resolveOpenAs(
  policy: PrPolicy,
  reviewsDrafts: boolean | undefined,
): { value: OpenAs; source: string } {
  if (policy.openAs !== null)
    return { value: policy.openAs, source: "pull_requests.open_as" };
  if (reviewsDrafts === false)
    return {
      value: "ready",
      source: "derived: drive.reviews_drafts is false",
    };
  return { value: "draft", source: "default" };
}

/**
 * Is marking a draft Ready due once round `round` has completed? Only a
 * numeric `mark_ready` is ever due after a round; `converged` waits for the
 * convergence path, which marks any still-unmarked draft whatever the
 * setting (a draft that converges before round N would otherwise never be
 * seen by the reviewers that skip drafts), and `never` is never due.
 */
export function markReadyDueAfterRound(
  markReady: MarkReady,
  round: number,
): boolean {
  return typeof markReady === "number" && round >= markReady;
}

/** A title as a branch-name segment: lowercase words joined by `-`, at most `SLUG_MAX` characters. */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= SLUG_MAX) return slug;
  const cut = slug.slice(0, SLUG_MAX);
  const lastDash = cut.lastIndexOf("-");
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/, "");
}

/**
 * The branch name for an issue under `pattern`. `branchKey` is the key as a
 * branch carries it (`IssueKeys.toBranch`: `ENG-123`, `123` for `#123`).
 */
export function renderBranchName(
  pattern: string,
  branchKey: string,
  title: string,
): string {
  const slug = slugify(title);
  return tidyBranchName(
    pattern
      .replaceAll("{key_lower}", branchKey.toLowerCase())
      .replaceAll("{key}", branchKey)
      .replaceAll("{slug}", slug),
  );
}

/** The line that links the pull request to its issue, or `null` for `none`. */
export function issueLinkLine(link: IssueLink, key: string): string | null {
  if (link === "closes") return `Closes ${key}`;
  if (link === "refs") return `Refs ${key}`;
  return null;
}

// ---------------------------------------------------------------------------
// Derived repository facts
// ---------------------------------------------------------------------------

const TEMPLATE_DIRS = ["", ".github", "docs"];

/**
 * The pull-request templates GitHub would offer, as repository-relative
 * paths: `pull_request_template.md` (or `.txt`, any letter case) in the root,
 * `.github/` or `docs/`, and every file in a `PULL_REQUEST_TEMPLATE/`
 * directory there.
 */
export function findPrTemplates(root: string): string[] {
  const found: string[] = [];
  for (const dir of TEMPLATE_DIRS) {
    const abs = join(root, dir);
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      const lower = name.toLowerCase();
      const rel = dir === "" ? name : `${dir}/${name}`;
      if (
        lower === "pull_request_template.md" ||
        lower === "pull_request_template.txt"
      ) {
        if (statSync(join(abs, name)).isFile()) found.push(rel);
      } else if (lower === "pull_request_template") {
        const sub = join(abs, name);
        if (!statSync(sub).isDirectory()) continue;
        for (const file of readdirSync(sub).sort())
          if (/\.(md|txt)$/i.test(file) && statSync(join(sub, file)).isFile())
            found.push(`${rel}/${file}`);
      }
    }
  }
  return found;
}

const CODEOWNERS_PATHS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
];

/** The `CODEOWNERS` file GitHub reads (first match wins), or `null`. */
export function findCodeowners(root: string): string | null {
  return CODEOWNERS_PATHS.find((p) => existsSync(join(root, p))) ?? null;
}

const COMMITLINT_FILES = [
  ".commitlintrc",
  ".commitlintrc.json",
  ".commitlintrc.yaml",
  ".commitlintrc.yml",
  ".commitlintrc.js",
  ".commitlintrc.cjs",
  ".commitlintrc.mjs",
  ".commitlintrc.ts",
  ".commitlintrc.cts",
  "commitlint.config.js",
  "commitlint.config.cjs",
  "commitlint.config.mjs",
  "commitlint.config.ts",
  "commitlint.config.cts",
];

/** A commitlint configuration at the repository root, or `null`. */
export function findCommitlintConfig(root: string): string | null {
  const file = COMMITLINT_FILES.find((f) => existsSync(join(root, f)));
  if (file !== undefined) return file;
  try {
    const pkg = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    if (isRecord(pkg) && pkg.commitlint !== undefined)
      return "package.json (commitlint)";
  } catch {
    // no package.json, or not JSON: no commitlint configuration there
  }
  return null;
}

/**
 * The commitlint configuration when it names the Conventional Commits rules
 * (`@commitlint/config-conventional` or a preset built on it), else `null`.
 * A commitlint configuration alone proves commits are linted, not which
 * convention they follow.
 */
export function conventionalCommitlintConfig(root: string): string | null {
  const found = findCommitlintConfig(root);
  if (found === null) return null;
  let text: string;
  try {
    if (found === "package.json (commitlint)") {
      const pkg = JSON.parse(
        readFileSync(join(root, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      text = JSON.stringify(pkg.commitlint);
    } else {
      text = readFileSync(join(root, found), "utf8");
    }
  } catch {
    return null;
  }
  return /conventional/i.test(text) ? found : null;
}

/** A Conventional Commits subject: `type(scope)!: description`. */
export const CONVENTIONAL_SUBJECT = /^[a-z]+(\([^()\s][^()]*\))?!?: \S/;

/** Share of recent trunk subjects that must be conventional to infer the convention. */
export const CONVENTIONAL_SHARE = 0.8;

/**
 * Which title convention recent trunk history follows. Merge commits are
 * skipped (their subjects are generated); fewer than five remaining subjects
 * is too little history to infer anything, so the answer is `free`.
 */
export function inferTitleFormat(subjects: string[]): TitleFormat {
  const own = subjects.filter(
    (s) =>
      s.trim() !== "" &&
      !/^Merge (pull request|branch|remote-tracking)/.test(s),
  );
  if (own.length < 5) return "free";
  const conventional = own.filter((s) => CONVENTIONAL_SUBJECT.test(s)).length;
  return conventional / own.length >= CONVENTIONAL_SHARE
    ? "conventional"
    : "free";
}

/** The title convention and where it came from. */
export async function detectTitleFormat(
  root: string,
  policy: PrPolicy,
  trunkRef: string | null,
): Promise<{ value: TitleFormat; source: string }> {
  if (policy.titleFormat !== null)
    return { value: policy.titleFormat, source: "pull_requests.title_format" };
  const commitlint = conventionalCommitlintConfig(root);
  if (commitlint !== null)
    return { value: "conventional", source: `derived: ${commitlint}` };
  if (trunkRef === null) return { value: "free", source: "default" };
  const log = await git(
    ["-C", root, "log", "--no-merges", "--format=%s", "-n", "30", trunkRef],
    { stderr: "ignore" },
  );
  if (log.code !== 0) return { value: "free", source: "default" };
  const value = inferTitleFormat(log.stdout.split("\n"));
  return {
    value,
    source: `derived: recent subjects on ${trunkRef}`,
  };
}

export interface RepoSettings {
  /** `null` when GitHub did not say (no permission to read it). */
  deleteBranchOnMerge: boolean | null;
}

/** Parse `gh api repos/{owner}/{repo}` into the settings this policy reads. */
export function parseRepoSettings(json: unknown): RepoSettings {
  const r = isRecord(json) ? json : {};
  return {
    deleteBranchOnMerge:
      typeof r.delete_branch_on_merge === "boolean"
        ? r.delete_branch_on_merge
        : null,
  };
}

/** The repository's settings this policy reads, or `null` when GitHub cannot be read. */
export async function readRepoSettings(
  root: string,
): Promise<RepoSettings | null> {
  const r = await ghCall(["api", "repos/{owner}/{repo}"], {
    cwd: root,
    stderr: "ignore",
  });
  if (r.code !== 0) return null;
  try {
    return parseRepoSettings(JSON.parse(r.stdout));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stacks
// ---------------------------------------------------------------------------

export interface OpenPull {
  number: number;
  /** The pull request's web URL, what `gh stack link` is given for it. */
  url: string;
  headRefName: string;
  baseRefName: string;
  isCrossRepository: boolean;
}

/** The longest chain walked before giving up: a guard against cycles and runaway stacks. */
export const MAX_CHAIN_WALK = 50;

export type ChainResult =
  | {
      ok: true;
      /** The open pull requests below, nearest first. */
      layers: number[];
    }
  | { ok: false; reason: string };

/**
 * Walk from `branch` down to `trunk` through open pull requests. Each hop
 * needs exactly one open, same-repository pull request whose head is the
 * current branch; its base is the next hop. This is the same chain base-scoped
 * tooling (an AI reviewer that reads its configuration from the trunk, say)
 * has to resolve, so a chain this walk rejects is one such tooling cannot see
 * through either.
 */
export function walkChain(
  branch: string,
  trunk: string,
  pulls: OpenPull[],
): ChainResult {
  const layers: number[] = [];
  const seen = new Set<string>();
  let current = branch;
  while (current !== trunk) {
    if (seen.has(current))
      return { ok: false, reason: `the chain loops back to ${current}` };
    if (layers.length >= MAX_CHAIN_WALK)
      return {
        ok: false,
        reason: `the chain is longer than ${MAX_CHAIN_WALK} pull requests`,
      };
    seen.add(current);
    const owners = pulls.filter((p) => p.headRefName === current);
    const sameRepo = owners.filter((p) => !p.isCrossRepository);
    if (owners.length === 0)
      return {
        ok: false,
        reason: `no open pull request has ${current} as its head, so nothing links it to ${trunk}`,
      };
    if (sameRepo.length === 0)
      return {
        ok: false,
        reason: `${current} belongs only to a pull request from a fork`,
      };
    if (sameRepo.length > 1)
      return {
        ok: false,
        reason: `${current} is the head of several open pull requests (${sameRepo.map((p) => `#${p.number}`).join(", ")})`,
      };
    const owner = sameRepo[0] as OpenPull;
    layers.push(owner.number);
    current = owner.baseRefName;
  }
  return { ok: true, layers };
}

/**
 * The branch a stack bottoms out on, walking down from `branch` (a pull
 * request's base) through open pull requests until a branch that no open,
 * same-repository pull request has as its head, or `trunk`. A pull request
 * that is not stacked gets its own base back with no layers. Stops at
 * `trunk` even when an open pull request has it as its head (a release pull
 * request from the integration branch, say): that is the trunk, not a layer.
 */
export function stackRoot(
  branch: string,
  trunk: string,
  pulls: OpenPull[],
):
  | { ok: true; root: string; layers: number[] }
  | { ok: false; reason: string } {
  const layers: number[] = [];
  const seen = new Set<string>();
  let current = branch;
  while (current !== trunk) {
    if (seen.has(current))
      return { ok: false, reason: `the chain loops back to ${current}` };
    seen.add(current);
    const owners = pulls.filter(
      (p) => p.headRefName === current && !p.isCrossRepository,
    );
    if (owners.length === 0) break;
    if (owners.length > 1)
      return {
        ok: false,
        reason: `${current} is the head of several open pull requests (${owners.map((p) => `#${p.number}`).join(", ")})`,
      };
    // Checked only when another hop would be taken, so a root without an
    // owning pull request is reached at the same depth as `trunk`.
    if (layers.length >= MAX_CHAIN_WALK)
      return {
        ok: false,
        reason: `the chain is longer than ${MAX_CHAIN_WALK} pull requests`,
      };
    const owner = owners[0] as OpenPull;
    layers.push(owner.number);
    current = owner.baseRefName;
  }
  return { ok: true, root: current, layers };
}

/** Parse `gh pr list --json number,url,headRefName,baseRefName,isCrossRepository`. */
export function parseOpenPulls(json: unknown): OpenPull[] {
  if (!Array.isArray(json))
    throw new Error("expected a JSON array of pull requests");
  return json.map((p, i) => {
    if (
      !isRecord(p) ||
      typeof p.number !== "number" ||
      typeof p.url !== "string" ||
      typeof p.headRefName !== "string" ||
      typeof p.baseRefName !== "string" ||
      typeof p.isCrossRepository !== "boolean"
    )
      throw new Error(
        `pull request ${i} is missing number, url, headRefName, baseRefName or isCrossRepository`,
      );
    return {
      number: p.number,
      url: p.url,
      headRefName: p.headRefName,
      baseRefName: p.baseRefName,
      isCrossRepository: p.isCrossRepository,
    };
  });
}

/** The most open pull requests `listOpenPulls` reads. */
export const OPEN_PULLS_LIMIT = 1000;

/**
 * Every open pull request of the repository, or `null` when unreadable or
 * when the listing reaches `OPEN_PULLS_LIMIT`: a truncated census cannot
 * prove that a chain owner exists or that it is the only one, so it counts
 * as unreadable rather than as complete.
 */
export async function listOpenPulls(root: string): Promise<OpenPull[] | null> {
  const r = await ghCall(
    [
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      String(OPEN_PULLS_LIMIT),
      "--json",
      "number,url,headRefName,baseRefName,isCrossRepository",
    ],
    { cwd: root, stderr: "ignore" },
  );
  if (r.code !== 0) return null;
  let pulls: OpenPull[];
  try {
    pulls = parseOpenPulls(JSON.parse(r.stdout));
  } catch {
    return null;
  }
  return pulls.length >= OPEN_PULLS_LIMIT ? null : pulls;
}

/**
 * A native stack as GitHub's Stacks REST API records it: the stack's own
 * number (what `gh stack link <number> …` appends to), the branch its bottom
 * layer targets, and every member bottom to top, merged and closed ones
 * included. The open-PR chain cannot stand in for this list: it drops merged
 * members and upper layers, and gh-stack refuses an update that omits any
 * member it already has.
 */
export interface NativeStack {
  number: number;
  baseRef: string;
  pulls: NativeStackMember[];
}

/**
 * One member of a native stack. `merged` and `closed` are kept apart from
 * `open` because only open members appear in the chain of bases, while
 * gh-stack carries every member forward when it appends.
 */
export interface NativeStackMember {
  number: number;
  state: "open" | "merged" | "closed";
}

/**
 * Parse `gh api --paginate --slurp repos/{owner}/{repo}/stacks`: an array
 * of pages, each an array of stacks.
 */
export function parseNativeStacks(json: unknown): NativeStack[] {
  if (!Array.isArray(json)) throw new Error("expected a JSON array of pages");
  return json.flatMap((page, p) => {
    if (!Array.isArray(page))
      throw new Error(`page ${p} is not an array of stacks`);
    return page.map((s, i) => {
      if (
        !isRecord(s) ||
        typeof s.number !== "number" ||
        !isRecord(s.base) ||
        typeof s.base.ref !== "string" ||
        !Array.isArray(s.pull_requests)
      )
        throw new Error(
          `stack ${i} of page ${p} is missing number, base.ref or pull_requests`,
        );
      return {
        number: s.number,
        baseRef: s.base.ref,
        pulls: s.pull_requests.map((pr, j): NativeStackMember => {
          if (
            !isRecord(pr) ||
            typeof pr.number !== "number" ||
            (pr.state !== "open" && pr.state !== "closed") ||
            (pr.merged_at !== null && typeof pr.merged_at !== "string")
          )
            throw new Error(
              `stack #${s.number} member ${j} is missing number, state or merged_at`,
            );
          return {
            number: pr.number,
            state:
              pr.state === "open"
                ? "open"
                : pr.merged_at === null
                  ? "closed"
                  : "merged",
          };
        }),
      };
    });
  });
}

/**
 * Every native stack of the repository, or `null` when GitHub's Stacks API
 * cannot be read (it answers 404 where stacked pull requests are not
 * enabled). Unreadable is never "no stacks": treating it so would plan a new
 * stack over a predecessor that already belongs to one.
 */
export async function listNativeStacks(
  root: string,
): Promise<NativeStack[] | null> {
  const r = await ghCall(
    [
      "api",
      "--paginate",
      "--slurp",
      "repos/{owner}/{repo}/stacks?per_page=100",
    ],
    { cwd: root, stderr: "ignore" },
  );
  if (r.code !== 0) return null;
  try {
    return parseNativeStacks(JSON.parse(r.stdout));
  } catch {
    return null;
  }
}

export type NativeLinkPlan =
  | {
      ok: true;
      linkArgs: string[];
      depth: number;
      /**
       * The stack the first argument names when appending, or `null` for a
       * new stack. gh-stack reads that argument as a branch instead when a
       * local branch has the same name, so the caller checks for one. Every
       * other argument is a pull-request URL, which gh-stack never reads as a
       * branch: a bare number naming a local branch would be pushed.
       */
      appendsTo: number | null;
      /**
       * The existing pull requests this link adds to a stack. gh-stack
       * refuses each one that has auto-merge enabled or sits in a merge
       * queue, so the caller checks them (`readLinkEligibility`).
       */
      newlyLinked: number[];
    }
  | { ok: false; reason: string; remedy: string };

/**
 * The `gh stack link` arguments that add a new pull request (`newPr`, a
 * placeholder for its URL until it exists) on top of `layers` (the open chain
 * below it, nearest first, each given to gh-stack as `urlOf` its number),
 * decided from the native stacks GitHub already records rather than from the
 * chain alone.
 *
 * - The predecessor already belongs to a stack: the new pull request is
 *   appended to that stack by number, so gh-stack itself carries every
 *   existing member forward. Only the top can be built on (gh-stack appends,
 *   it does not branch), the stack must land on `trunk`, and the stack's
 *   open members, bottom to top, must be exactly the open chain: the same
 *   pull requests in the same order. Merged and closed members are absent
 *   from the chain but stay in the stack.
 * - No layer belongs to a stack: the chain becomes a new stack based on
 *   `trunk`, every layer bottom to top.
 * - Anything else (a lower layer in a stack the predecessor is not in) is a
 *   topology gh-stack would reject after the pull request was created, so it
 *   is refused before.
 *
 * `depth` is how many pull requests the stack holds once the new one is
 * linked, the new one included: the chain plus one for a new stack, every
 * recorded member plus one for an append. It is what `max_stack_depth` caps.
 */
export function planNativeLink(
  layers: number[],
  trunk: string,
  stacks: NativeStack[],
  newPr: string,
  urlOf: (pr: number) => string,
): NativeLinkPlan {
  const owner = new Map<number, NativeStack>();
  for (const s of stacks) for (const m of s.pulls) owner.set(m.number, s);
  const predecessor = layers[0];
  if (predecessor === undefined)
    return {
      ok: false,
      reason: "there is no predecessor pull request to stack on",
      remedy: `Open the pull request against ${trunk}.`,
    };
  const stack = owner.get(predecessor);
  if (stack === undefined) {
    const linked = layers.filter((n) => owner.has(n));
    if (linked.length > 0)
      return {
        ok: false,
        reason: `#${predecessor} is in no native stack, but ${linked.map((n) => `#${n} (stack #${owner.get(n)?.number})`).join(", ")} below it is`,
        remedy: `Link #${predecessor} into that stack first (gh stack link <stack number> ${predecessor}), then re-run.`,
      };
    return {
      ok: true,
      linkArgs: ["--base", trunk, ...layers.toReversed().map(urlOf), newPr],
      depth: layers.length + 1,
      appendsTo: null,
      newlyLinked: layers.toReversed(),
    };
  }
  if (stack.baseRef !== trunk)
    return {
      ok: false,
      reason: `#${predecessor} is in native stack #${stack.number}, which lands on ${stack.baseRef}, not ${trunk}`,
      remedy: `Stack only on a stack that lands on ${trunk}; otherwise open this pull request against ${trunk}.`,
    };
  const top = stack.pulls[stack.pulls.length - 1]?.number;
  if (top !== predecessor)
    return {
      ok: false,
      reason: `#${predecessor} is not the top of native stack #${stack.number} (#${top} is), and gh-stack only adds pull requests on top`,
      remedy: `Stack on the head branch of #${top} instead, or open this pull request against ${trunk}.`,
    };
  const remedy = `Repair the stack so its members and the chain of bases agree (gh stack link), then re-run.`;
  const outside = layers.filter((n) => owner.get(n) !== stack);
  if (outside.length > 0)
    return {
      ok: false,
      reason: `the open chain below #${predecessor} passes through ${outside.map((n) => `#${n}`).join(", ")}, which native stack #${stack.number} does not contain`,
      remedy,
    };
  const members = stack.pulls
    .filter((m) => m.state === "open")
    .map((m) => m.number);
  const chain = layers.toReversed();
  if (members.length !== chain.length || members.some((n, i) => n !== chain[i]))
    return {
      ok: false,
      reason: `native stack #${stack.number} holds the open pull requests ${members.map((n) => `#${n}`).join(", ")} bottom to top, but the chain of bases runs ${chain.map((n) => `#${n}`).join(", ")}`,
      remedy,
    };
  return {
    ok: true,
    linkArgs: [String(stack.number), newPr],
    depth: stack.pulls.length + 1,
    appendsTo: stack.number,
    newlyLinked: [],
  };
}

/**
 * Parse the `readLinkEligibility` query's answer: the pull requests among
 * `numbers` that gh-stack refuses to add to a stack, each with the reason.
 * Throws when any of them is missing from the answer.
 */
export function parseLinkEligibility(
  json: unknown,
  numbers: number[],
): Map<number, string> {
  const repo =
    isRecord(json) && isRecord(json.data) ? json.data.repository : undefined;
  if (!isRecord(repo)) throw new Error("expected data.repository");
  const ineligible = new Map<number, string>();
  for (const n of numbers) {
    const pr = repo[`p${n}`];
    if (
      !isRecord(pr) ||
      !("autoMergeRequest" in pr) ||
      !("mergeQueueEntry" in pr)
    )
      throw new Error(`pull request #${n} is missing from the answer`);
    if (pr.mergeQueueEntry !== null)
      ineligible.set(n, "it is queued for merge");
    else if (pr.autoMergeRequest !== null)
      ineligible.set(n, "it has auto-merge enabled");
  }
  return ineligible;
}

/**
 * The pull requests among `numbers` that gh-stack's `link` refuses to add to
 * a stack (queued for merge, or auto-merge enabled: its
 * `validatePREligibility`), or `null` when GitHub cannot be read. Read before
 * the new pull request is created, because gh-stack only checks them after.
 */
export async function readLinkEligibility(
  root: string,
  numbers: number[],
): Promise<Map<number, string> | null> {
  if (numbers.length === 0) return new Map();
  const fields = numbers
    .map(
      (n) =>
        `p${n}: pullRequest(number: ${n}) { autoMergeRequest { enabledAt } mergeQueueEntry { id } }`,
    )
    .join(" ");
  const r = await ghCall(
    [
      "api",
      "graphql",
      "-F",
      "owner={owner}",
      "-F",
      "name={repo}",
      "-f",
      `query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
    ],
    { cwd: root, stderr: "ignore" },
  );
  if (r.code !== 0) return null;
  try {
    return parseLinkEligibility(JSON.parse(r.stdout), numbers);
  } catch {
    return null;
  }
}
