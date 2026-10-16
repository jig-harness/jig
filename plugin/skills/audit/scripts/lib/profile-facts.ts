/**
 * The observable facts a profile suggestion rests on, and the suggestion
 * itself: how many people commit to the repository, whether its CI names
 * deploy, release or publish work, and whether it keeps documents that name a
 * compliance regime.
 *
 * Every fact comes from git and the tracked files, so an offline audit has
 * them too. The facts are reported as found; only `suggestProfile` turns them
 * into a profile, and it suggests the lightest one they support: the team
 * holds the dial, and a heavier profile than the facts call for costs work
 * nobody asked for.
 */
import { isMapping } from "../../../../shared/config-layers.ts";
import { load } from "../../../../shared/yaml.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./repo.ts";

/** Distinct commit authors, people and automation counted apart. */
export interface Contributors {
  /** People who authored a commit in the last 90 days. */
  last_90_days: number;
  /** People who authored a commit in the last year. */
  last_year: number;
  /** Automation accounts that authored a commit in the last year. */
  automation_last_year: number;
  /** A shallow clone lacks older commits, so the counts may be low. */
  shallow: boolean;
}

/**
 * A CI file whose jobs name deploy, release or publish work, and what in it
 * does. The match is on words, not on what the commands do, so the matched
 * lines are reported for a reader to judge.
 */
export interface DeploySignal {
  file: string;
  matched: string[];
}

/** A tracked document whose path or first heading names a compliance regime. */
export interface ComplianceDocument {
  path: string;
  regimes: string[];
  via: "path" | "heading";
}

/** The profiles a suggestion may name; the strict one only a person chooses. */
export type SuggestableProfile = "solo-lite" | "team-standard";

export interface SuggestedProfile {
  id: SuggestableProfile;
  /** The facts behind the suggestion, one per line. */
  why: string[];
}

export interface ProfileFacts {
  /** Null when the history could not be read; `contributors_unchecked` says why. */
  contributors: Contributors | null;
  contributors_unchecked?: string;
  deploy_signals: DeploySignal[];
  /** CI files that are not valid YAML, so whether they deploy is unchecked. */
  unreadable_ci_files: string[];
  compliance_documents: ComplianceDocument[];
  /** Absent when the facts settle nothing: no history and no deploy signal. */
  suggested_profile?: SuggestedProfile;
}

const DAY_MS = 86_400_000;

/** Commit authors that are automation rather than people. */
const AUTOMATION_AUTHOR =
  /^(dependabot|renovate|github[- ]?actions?|release-please|semantic-release|mergify|codecov|netlify|vercel)(?![a-z])/i;

/**
 * Whether a commit author is automation: a forge bot account (its name or
 * address ends in `[bot]`) or a known dependency, release or CI tool.
 */
export function isAutomationAuthor(name: string, email: string): boolean {
  const local = email.split("@")[0] ?? "";
  return [name, local].some(
    (part) => /\[bot\]$/i.test(part) || AUTOMATION_AUTHOR.test(part),
  );
}

/** One commit's author and its committer time in seconds. */
export interface CommitAuthor {
  time: number;
  name: string;
  email: string;
}

/**
 * How many people the authors are. Identities are compared lowercased, and
 * two that share an address or a name are one person: someone who commits
 * from a work and a personal address under one name counts once. The
 * repository's `.mailmap`, which `git log` applies, merges the rest.
 */
export function countPeople(authors: CommitAuthor[]): number {
  const parent = new Map<string, string>();
  const root = (key: string): string => {
    const up = parent.get(key) ?? key;
    return up === key ? key : root(up);
  };
  const keysOf = (a: CommitAuthor) =>
    [`email:${a.email}`, `name:${a.name}`]
      .map((k) => k.toLowerCase())
      .filter((k) => !k.endsWith(":"));
  for (const author of authors) {
    const roots = keysOf(author).map(root);
    for (const r of roots) parent.set(r, roots[0] ?? r);
  }
  return new Set(authors.flatMap((a) => keysOf(a).slice(0, 1).map(root))).size;
}

/**
 * The authors of the commits since `since`, or why the history could not be
 * read. `--since-as-filter` visits every commit: plain `--since` stops at the
 * first older one, and a rebased or cherry-picked commit can sit, older, above
 * newer ones.
 */
function commitAuthors(
  root: string,
  since: Date,
): CommitAuthor[] | { reason: string } {
  const log = run(
    "git",
    [
      "log",
      `--since-as-filter=${since.toISOString()}`,
      "--format=%ct%x09%aN%x09%aE",
    ],
    { cwd: root },
  );
  if (log.code !== 0)
    return {
      reason:
        (log.stderr || log.stdout).trim().split("\n")[0] || `exit ${log.code}`,
    };
  return log.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [time = "", name = "", email = ""] = line.split("\t");
      return { time: Number(time), name, email };
    });
}

/**
 * The commit authors of the last year, people and automation apart. Commit
 * time is the committer date, the one `git log --since-as-filter` filters on.
 */
function contributors(
  root: string,
  now: Date,
): { counts: Contributors } | { reason: string } {
  const authors = commitAuthors(root, new Date(now.getTime() - 365 * DAY_MS));
  if (!Array.isArray(authors)) return authors;
  const cutoff = (now.getTime() - 90 * DAY_MS) / 1000;
  const people = authors.filter((a) => !isAutomationAuthor(a.name, a.email));
  const automation = authors.filter((a) => isAutomationAuthor(a.name, a.email));
  const shallow = run("git", ["rev-parse", "--is-shallow-repository"], {
    cwd: root,
  });
  return {
    counts: {
      last_90_days: countPeople(people.filter((a) => a.time >= cutoff)),
      last_year: countPeople(people),
      automation_last_year: countPeople(automation),
      shallow: shallow.stdout.trim() === "true",
    },
  };
}

/** Words that name shipping work, at the start of a word. */
const SHIPS = /(?<![a-z])(deploy|release|publish)/i;
const says = (text: string) => SHIPS.test(text);

/** GitHub Actions workflows and GitLab's pipeline file. */
const GITHUB_WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const GITLAB_PIPELINE = /^\.gitlab-ci\.ya?ml$/;

/** Top-level keys of a GitLab pipeline that configure it rather than name a job. */
const GITLAB_KEYWORDS = new Set([
  "default",
  "include",
  "stages",
  "variables",
  "workflow",
  "image",
  "services",
  "cache",
  "before_script",
  "after_script",
]);

/** A command line shortened for a one-line fact. */
const clip = (line: string) => {
  const text = line.trim();
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

/** The lines of a `run` or `script` value, a block of text or a list. */
function commandLines(value: unknown): string[] {
  if (typeof value === "string") return value.split("\n");
  if (Array.isArray(value))
    return value.flatMap((v) => (typeof v === "string" ? v.split("\n") : []));
  return [];
}

/** A job's deployment environment, by name when it has one. */
function environmentOf(job: Record<string, unknown>): string[] {
  const env = job.environment;
  if (env === undefined || env === null) return [];
  if (typeof env === "string") return [`environment: ${env}`];
  if (isMapping(env) && typeof env.name === "string")
    return [`environment: ${env.name}`];
  return ["environment"];
}

/** `value`, labelled, when it is text that names shipping work. */
function shipping(label: (text: string) => string, value: unknown): string[] {
  return typeof value === "string" && says(value) ? [label(value)] : [];
}

/** The first command line of `value` that names shipping work, labelled. */
function shippingCommand(label: string, value: unknown): string[] {
  const line = commandLines(value).find(says);
  return line === undefined ? [] : [`${label}: ${clip(line)}`];
}

/** What in one GitHub Actions step names shipping work. */
function stepSignals(step: unknown): string[] {
  if (!isMapping(step)) return [];
  return [
    ...shipping((name) => `step "${name}"`, step.name),
    ...shipping((action) => `uses ${action}`, step.uses),
    ...shippingCommand("run", step.run),
  ];
}

/** The names a GitLab job `extends`, one or a list. */
function extendsOf(job: Record<string, unknown>): string[] {
  const ext = job.extends;
  if (typeof ext === "string") return [ext];
  return Array.isArray(ext)
    ? ext.filter((e): e is string => typeof e === "string")
    : [];
}

/**
 * What in one job, GitHub's or GitLab's, declares an environment or names
 * shipping work: its own keys and steps, the reusable workflow it calls, and
 * the hidden templates of the same file it extends. `seen` holds the templates
 * already read for this job, so each is read once however many paths reach it,
 * and a cycle stops.
 */
function jobSignals(
  id: string,
  job: unknown,
  templates: Record<string, unknown> = {},
  seen: Set<string> = new Set(),
): string[] {
  if (!isMapping(job)) return [];
  const steps = Array.isArray(job.steps) ? job.steps : [];
  return [
    ...environmentOf(job),
    ...shipping((key) => `job ${key}`, id),
    ...shipping((name) => `job "${name}"`, job.name),
    ...shipping((stage) => `stage ${stage}`, job.stage),
    ...shipping((workflow) => `uses ${workflow}`, job.uses),
    ...shippingCommand("script", job.script),
    ...steps.flatMap(stepSignals),
    ...extendsOf(job).flatMap((name) => {
      if (!(name in templates) || seen.has(name)) return [];
      seen.add(name);
      return jobSignals(name, templates[name], templates, seen);
    }),
  ];
}

/** The jobs of a parsed CI file: GitHub's under `jobs`, GitLab's at the top level. */
function jobsOf(file: string, doc: unknown): [string, unknown][] {
  if (!isMapping(doc)) return [];
  if (GITLAB_PIPELINE.test(file))
    return Object.entries(doc).filter(
      ([key]) => !GITLAB_KEYWORDS.has(key) && !key.startsWith("."),
    );
  return isMapping(doc.jobs) ? Object.entries(doc.jobs) : [];
}

/**
 * The CI files that declare a deployment environment or a job or step whose
 * name or command says deploy, release or publish. A file included from
 * elsewhere (GitLab's `include`) is not followed.
 */
function deploySignals(
  root: string,
  files: string[],
): { signals: DeploySignal[]; unreadable: string[] } {
  const signals: DeploySignal[] = [];
  const unreadable: string[] = [];
  for (const file of files) {
    if (!GITHUB_WORKFLOW.test(file) && !GITLAB_PIPELINE.test(file)) continue;
    const path = join(root, file);
    if (!existsSync(path)) continue;
    let doc: unknown;
    try {
      doc = load(readFileSync(path, "utf8"));
    } catch (error) {
      unreadable.push(`${file} (${String(error).split("\n")[0]})`);
      continue;
    }
    const templates = GITLAB_PIPELINE.test(file) && isMapping(doc) ? doc : {};
    const matched = [
      ...new Set(
        jobsOf(file, doc).flatMap(([id, job]) =>
          jobSignals(id, job, templates),
        ),
      ),
    ];
    if (matched.length > 0) signals.push({ file, matched });
  }
  return { signals, unreadable };
}

/** A name a path or heading may use for a compliance regime or register. */
const REGIMES: [string, RegExp][] = [
  [
    "privacy or data-processing register",
    /privacy[-_ ]?register|data[-_ ]?processing|processing[-_ ]activities|(?<![a-z0-9])(ropa|dpia)(?![a-z0-9])/i,
  ],
  ["threat model", /threat[-_ ]?model/i],
  ["SOC 2", /(?<![a-z0-9])soc[-_ ]?2(?![0-9])/i],
  ["ISO 27001", /iso[-_ /]?(iec[-_ ]?)?27001/i],
  ["HIPAA", /(?<![a-z0-9])hipaa(?![a-z0-9])/i],
  ["GDPR", /(?<![a-z0-9])gdpr(?![a-z0-9])/i],
  ["PCI DSS", /(?<![a-z0-9])pci(?:[-_ ]?dss)?(?![a-z0-9])/i],
];

/** Files that are documents, and those whose first heading can be read. */
const DOCUMENT = /\.(md|mdx|markdown|rst|adoc|txt|pdf|docx?|odt)$/i;
const HEADED = /\.(md|mdx|markdown|adoc)$/i;
/** Test data, templates and vendored copies are not the repository's own documents. */
const NOT_OWN =
  /(^|\/)(fixtures?|templates?|vendor|node_modules|__tests__|tests?)\//i;

const regimesIn = (text: string) =>
  REGIMES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);

/** The first Markdown or AsciiDoc heading of a document, if any. */
function firstHeading(path: string): string | null {
  if (!existsSync(path)) return null;
  const head = readFileSync(path, "utf8").slice(0, 8192);
  return /^(?:#{1,6}|=+)[ \t]+(.+)$/m.exec(head)?.[1] ?? null;
}

/** The tracked documents whose path, or else first heading, names a compliance regime. */
function complianceDocuments(
  root: string,
  files: string[],
): ComplianceDocument[] {
  const found: ComplianceDocument[] = [];
  for (const path of files) {
    if (!DOCUMENT.test(path) || NOT_OWN.test(path)) continue;
    const byPath = regimesIn(path);
    if (byPath.length > 0) {
      found.push({ path, regimes: byPath, via: "path" });
      continue;
    }
    const heading = HEADED.test(path) ? firstHeading(join(root, path)) : null;
    const byHeading = heading === null ? [] : regimesIn(heading);
    if (byHeading.length > 0)
      found.push({ path, regimes: byHeading, via: "heading" });
  }
  return found;
}

/** A list cut to its first few entries, with how many were left out. */
function some(items: string[], limit = 5): string {
  const shown = items.slice(0, limit).join(", ");
  return items.length > limit
    ? `${shown} and ${items.length - limit} more`
    : shown;
}

/**
 * The lightest profile the facts support. Two or more people committing in
 * the last 90 days, or any deploy signal, make it team-standard; otherwise at
 * most one person and no deploy signal make it solo-lite, naming the CI files
 * that could not be read. Regulated-strict is never suggested: a compliance
 * document is a reason to consider it, which the team decides. Without
 * readable history and without a deploy signal the facts settle nothing, and
 * there is no suggestion.
 */
export function suggestProfile(
  facts: Pick<
    ProfileFacts,
    "contributors" | "deploy_signals" | "compliance_documents"
  > &
    Partial<Pick<ProfileFacts, "unreadable_ci_files">>,
): SuggestedProfile | undefined {
  const people = facts.contributors?.last_90_days;
  const why: string[] = [];
  if (people !== undefined && people >= 2)
    why.push(`${people} human contributors in the last 90 days`);
  if (facts.deploy_signals.length > 0)
    why.push(
      `CI names deploy, release or publish work: ${some(facts.deploy_signals.map((s) => s.file))}`,
    );
  let id: SuggestableProfile = "team-standard";
  if (why.length === 0) {
    if (people === undefined) return undefined;
    id = "solo-lite";
    const unread = facts.unreadable_ci_files ?? [];
    why.push(
      `${people === 0 ? "no human contributor" : "one human contributor"} in the last 90 days, and no ${unread.length > 0 ? "readable " : ""}CI file names deploy, release or publish work`,
    );
    if (unread.length > 0)
      why.push(
        `unchecked, as they could not be read: ${some(unread.map((u) => u.split(" (")[0] ?? u))}`,
      );
  }
  if (facts.contributors?.shallow)
    why.push("the clone is shallow, so the contributor count may be low");
  if (facts.compliance_documents.length > 0)
    why.push(
      `compliance documents found: consider regulated-strict (${some(facts.compliance_documents.map((d) => d.path))})`,
    );
  return { id, why };
}

/** Gather the profile facts of the repository at `root` from git and its tracked `files`. */
export function profileFacts(
  root: string,
  files: string[],
  now = new Date(),
): ProfileFacts {
  const history = contributors(root, now);
  const { signals, unreadable } = deploySignals(root, files);
  const facts: ProfileFacts = {
    contributors: "counts" in history ? history.counts : null,
    ...("reason" in history ? { contributors_unchecked: history.reason } : {}),
    deploy_signals: signals,
    unreadable_ci_files: unreadable,
    compliance_documents: complianceDocuments(root, files),
  };
  const suggested = suggestProfile(facts);
  return suggested === undefined
    ? facts
    : { ...facts, suggested_profile: suggested };
}

/** The profile facts as one-line entries of the report's `facts`. */
export function profileFactLines(facts: ProfileFacts): Record<string, string> {
  const lines: Record<string, string> = {};
  const c = facts.contributors;
  if (c === null)
    lines.contributors = `unchecked: ${facts.contributors_unchecked ?? "the history could not be read"}`;
  else {
    lines.contributors_last_90_days = String(c.last_90_days);
    lines.contributors_last_year = String(c.last_year);
    lines.automation_authors_last_year = String(c.automation_last_year);
    if (c.shallow) lines.shallow_clone = "yes: contributor counts may be low";
  }
  lines.deploy_signals =
    facts.deploy_signals.length === 0
      ? "none"
      : facts.deploy_signals
          .map((s) => `${s.file} (${s.matched.join("; ")})`)
          .join(", ");
  if (facts.unreadable_ci_files.length > 0)
    lines.deploy_signals_unchecked = facts.unreadable_ci_files.join(", ");
  lines.compliance_documents =
    facts.compliance_documents.length === 0
      ? "none"
      : some(
          facts.compliance_documents.map(
            (d) => `${d.path} (${d.regimes.join(", ")})`,
          ),
        );
  const s = facts.suggested_profile;
  lines.suggested_profile =
    s === undefined
      ? "none: the history could not be read and no CI file names deploy, release or publish work"
      : `${s.id}: ${s.why.join("; ")}`;
  return lines;
}
