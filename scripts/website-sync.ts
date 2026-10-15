// Scope: the commits the jig-harness.dev site has not been checked against,
// for the website-update skill (.claude/skills/website-update/SKILL.md).
//
// The record (website/content-sync.yaml) holds the last commit of `main` the
// site was checked against. With no flag, this lists every first-parent
// commit after it up to <to> (default origin/main), oldest first, with the
// lines it changed, the change-areas it touched (.config/change-areas.yaml)
// and what that means for the site:
//   content  it touched a docs or skill area the `website` area is implied
//            by, directly or through other areas, so the site renders
//            something it changed
//   build    it touched another area the `website` area is implied by, which
//            can break the site's build but holds nothing the site renders
//   site     it touched the site itself and nothing the site reads
//   outside  it touched nothing the site reads
//   update   it changed the record and nothing else content: an earlier
//            run of the skill, whose site edits and change note that run
//            already checked. A record change that also touched content
//            stays `content`, since nothing shows a run checked that part.
// A commit whose counted lines exceed --max-lines (default 5000) is marked
// oversized. Lockfiles, test fixtures, vendored code and binary files are
// not counted: they are large and never what a page states.
//
// `--advance <commit>` writes <commit> and today's date into the record.
//
// Listing and advancing check the same thing first: the recorded commit and
// the target are both commits of origin/main's first-parent history, and the
// recorded one is an ancestor of the target. A branch head that descends from
// the record is refused, since recording it would leave main's next run with
// a commit main does not contain.
//
// Usage: bun scripts/website-sync.ts [--to <ref>] [--max-lines N] [--json]
//        bun scripts/website-sync.ts --advance <commit>
// Exit: 0 done; 1 the recorded commit is not an ancestor of the target, or
// a commit is not on origin/main's first-parent history; 2 usage error,
// unreadable record or catalog, malformed git output, or a git failure.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { cli } from "../lib/cli.ts";
import { LEAKY_GIT_ENV, spawnSync } from "../lib/guarded-git-spawn.ts";
import { isRecord } from "../lib/record.ts";
import { load as loadYaml } from "../lib/vendor/js-yaml.mjs";
import {
  CATALOG,
  type Catalog,
  resolveAreas,
  validCatalog,
} from "./change-areas.ts";

export const RECORD = "website/content-sync.yaml";
/** The change note a run of the skill adds (changes/README.md). */
const UPDATE_NOTE = "changes/website-update.md";
const MAIN = "origin/main";
const SITE_AREA = "website";
const CONTENT_CATEGORIES = ["docs", "skill"];
const DEFAULT_MAX_LINES = 5000;
const UNCOUNTED = [
  /(^|\/)(bun\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/,
  /(^|\/)fixtures?\//,
  /(^|\/)vendor\//,
];

type Kind = "content" | "build" | "site" | "outside" | "update";

interface Commit {
  sha: string;
  date: string;
  subject: string;
  /** Lines added and deleted, without the uncounted files. */
  lines: number;
  files: number;
  /** The areas its files match directly. */
  areas: string[];
  kind: Kind;
  oversized: boolean;
}

interface Plan {
  base: string;
  baseDate: string;
  to: string;
  toCommit: string;
  maxLines: number;
  commits: Commit[];
}

function git(root: string, args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()),
    ),
  );
  return spawnSync("git", ["-C", root, ...args], { env });
}

function gitOut(root: string, args: string[]): string {
  const result = git(root, args);
  if (result.status !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`,
    );
  return result.stdout.toString();
}

/** Whether `a` is an ancestor of `b`; throws when git cannot tell (an unknown commit). */
function isAncestor(root: string, a: string, b: string): boolean {
  const result = git(root, ["merge-base", "--is-ancestor", a, b]);
  if (result.status === 0 || result.status === 1) return result.status === 0;
  throw new Error(
    `git merge-base --is-ancestor ${a} ${b} failed: ${result.stderr.toString().trim()}`,
  );
}

/** Whether `sha` is on main's first-parent history, where the record lives. */
function onMainLine(root: string, sha: string): boolean {
  return gitOut(root, ["rev-list", "--first-parent", MAIN])
    .split("\n")
    .includes(sha);
}

/** The recorded commit and date; throws when the record is missing or malformed. */
export function readRecord(root: string): { commit: string; date: string } {
  const doc: unknown = loadYaml(readFileSync(join(root, RECORD), "utf8"));
  if (!isRecord(doc) || typeof doc.commit !== "string")
    throw new Error(`${RECORD}: no \`commit\``);
  if (!/^[0-9a-f]{40}$/.test(doc.commit))
    throw new Error(`${RECORD}: \`commit\` is not a full commit hash`);
  return {
    commit: doc.commit,
    date: typeof doc.date === "string" ? doc.date : "",
  };
}

/**
 * The areas the site area is implied by, directly or through other areas:
 * the same closure resolveAreas() follows, read from the other end.
 */
function feedsOf(catalog: Catalog): Set<string> {
  const feeds = new Set<string>();
  const queue = [...(catalog[SITE_AREA]?.impliedBy ?? [])];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    if (feeds.has(id)) continue;
    feeds.add(id);
    queue.push(...(catalog[id]?.impliedBy ?? []));
  }
  return feeds;
}

/** How a commit's directly matched areas bear on the site. */
export function kindOf(areas: string[], catalog: Catalog): Kind {
  const feeds = feedsOf(catalog);
  const fed = areas.filter((id) => feeds.has(id));
  if (
    fed.some((id) => CONTENT_CATEGORIES.includes(catalog[id]?.category ?? ""))
  )
    return "content";
  if (fed.length) return "build";
  return areas.includes(SITE_AREA) ? "site" : "outside";
}

/**
 * Whether a commit is an earlier run of the skill: it changed the record,
 * and nothing else it changed is content once the change note such a run
 * may add is set aside.
 */
function isUpdate(paths: string[], catalog: Catalog): boolean {
  if (!paths.includes(RECORD)) return false;
  const rest = paths.filter((path) => path !== UPDATE_NOTE);
  return kindOf(resolveAreas(rest, catalog).seedAreas, catalog) !== "content";
}

const SHA = /^[0-9a-f]{40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Added, deleted ("-" for a binary file) and the path, which may hold any
// byte but NUL.
const STAT = /^(\d+|-)\t(\d+|-)\t(.+)$/s;

/**
 * Each commit's hash, date, subject, changed paths and counted lines, from
 * one `git log -z --numstat --format=%H%x00%cs%x00%s`. Every field ends in
 * NUL and paths are not quoted, so a subject or path holding a tab, a
 * newline or a quote comes through as written. Fields are read by position:
 * three header fields, then stats up to the next hash. A stat always holds
 * tabs, so it never reads as a hash. Throws on anything else.
 */
export function parseLog(log: string): {
  sha: string;
  date: string;
  subject: string;
  paths: string[];
  lines: number;
}[] {
  const fields = log.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const commits: ReturnType<typeof parseLog> = [];
  let i = 0;
  while (i < fields.length) {
    const [sha = "", date = "", subject] = fields.slice(i, i + 3);
    if (!SHA.test(sha) || !DATE.test(date) || subject === undefined)
      throw new Error(`git log: unexpected commit header at field ${i}`);
    i += 3;
    let end = i;
    while (end < fields.length && !SHA.test(fields[end] ?? "")) end++;
    commits.push({ sha, date, subject, ...readStats(fields.slice(i, end), i) });
    i = end;
  }
  return commits;
}

/** One commit's changed paths and counted lines; `at` places an error. */
function readStats(
  stats: string[],
  at: number,
): { paths: string[]; lines: number } {
  let lines = 0;
  const paths = stats.map((stat, k) => {
    // git puts one newline between a commit's header and its first stat.
    const match = STAT.exec(stat.replace(/^\n/, ""));
    if (!match) throw new Error(`git log: unexpected stat at field ${at + k}`);
    const [, added = "", deleted = "", path = ""] = match;
    if (added !== "-" && !UNCOUNTED.some((re) => re.test(path)))
      lines += Number(added) + Number(deleted);
    return path;
  });
  return { paths, lines };
}

/** The commits after the recorded one up to `to`, oldest first. */
export function plan(
  root: string,
  to = MAIN,
  maxLines = DEFAULT_MAX_LINES,
): Plan {
  const record = readRecord(root);
  const toCommit = checkedTarget(root, record.commit, to);
  const catalog = validCatalog(root);
  // Without the site area nothing would read as feeding the site, and every
  // commit would quietly drop out of review.
  if (!catalog[SITE_AREA])
    throw new Error(`${CATALOG}: no \`${SITE_AREA}\` area`);
  // One git call for the whole range. A merge commit is compared with its
  // first parent, the branch it landed on.
  const log = gitOut(root, [
    "log",
    "-z",
    "--first-parent",
    "--diff-merges=first-parent",
    "--reverse",
    "--no-renames",
    "--numstat",
    "--format=%H%x00%cs%x00%s",
    `${record.commit}..${toCommit}`,
  ]);
  const commits = parseLog(log).map(({ paths, lines, ...c }): Commit => {
    const areas = resolveAreas(paths, catalog).seedAreas;
    return {
      ...c,
      lines,
      files: paths.length,
      areas,
      kind: isUpdate(paths, catalog) ? "update" : kindOf(areas, catalog),
      oversized: lines > maxLines,
    };
  });
  return {
    base: record.commit,
    baseDate: record.date,
    to,
    toCommit,
    maxLines,
    commits,
  };
}

export class NotOnMain extends Error {
  constructor(commit: string) {
    super(
      `${commit.slice(0, 7)} is not on ${MAIN}'s first-parent history; the record only ever names a commit of main`,
    );
  }
}

export class NotAncestor extends Error {
  constructor(commit: string, to: string) {
    super(
      `${RECORD}: ${commit.slice(0, 7)} is not an ancestor of ${to}; the record names a commit ${to} does not contain (a rewritten history, or the wrong ref)`,
    );
  }
}

/**
 * `target` as a commit, once the recorded commit and it are both on main's
 * first-parent history and the recorded one is its ancestor.
 */
function checkedTarget(root: string, recorded: string, target: string): string {
  const sha = gitOut(root, [
    "rev-parse",
    "--verify",
    `${target}^{commit}`,
  ]).trim();
  for (const commit of [recorded, sha])
    if (!onMainLine(root, commit)) throw new NotOnMain(commit);
  if (!isAncestor(root, recorded, sha)) throw new NotAncestor(recorded, target);
  return sha;
}

/** Record `commit` as checked, after the same checks as the plan. */
export function advance(root: string, commit: string, today: string): string {
  const sha = checkedTarget(root, readRecord(root).commit, commit);
  writeFileSync(
    join(root, RECORD),
    `# The last commit of main the site was checked against. Written by the
# website-update skill (.claude/skills/website-update/SKILL.md) with
# \`bun scripts/website-sync.ts --advance <commit>\`; its next run reviews the
# commits after this one.
commit: ${sha}
date: "${today}"
`,
  );
  return sha;
}

export function formatPlan(p: Plan): string {
  const head = `${p.commits.length} commit(s) after ${p.base.slice(0, 7)}${p.baseDate ? ` (checked ${p.baseDate})` : ""} up to ${p.to} (${p.toCommit.slice(0, 7)})`;
  const rows = p.commits.map(
    (c) =>
      `${c.kind.padEnd(8)} ${c.sha.slice(0, 7)} ${c.date} ${String(c.lines).padStart(6)} lines  ${c.subject}${c.oversized ? "  [OVERSIZED]" : ""}\n${" ".repeat(17)}areas: ${c.areas.join(", ") || "(none)"}`,
  );
  const oversized = p.commits.filter((c) => c.oversized).length;
  const tail = oversized
    ? [
        `${oversized} commit(s) over ${p.maxLines} counted lines: review what you can, file a follow-up for the rest`,
      ]
    : [];
  return [head, ...rows, ...tail].join("\n");
}

function main(): number {
  const root = join(import.meta.dir, "..");
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      to: { type: "string", default: MAIN },
      "max-lines": { type: "string", default: String(DEFAULT_MAX_LINES) },
      json: { type: "boolean", default: false },
      advance: { type: "string" },
    },
    strict: true,
  });
  const maxLines = Number(values["max-lines"]);
  if (!Number.isInteger(maxLines) || maxLines < 1) {
    console.error("--max-lines takes a positive whole number");
    return 2;
  }
  try {
    if (values.advance) {
      const sha = advance(
        root,
        values.advance,
        new Date().toISOString().slice(0, 10),
      );
      console.log(`${RECORD}: checked through ${sha}`);
      return 0;
    }
    const p = plan(root, values.to, maxLines);
    console.log(values.json ? JSON.stringify(p, null, 2) : formatPlan(p));
    return 0;
  } catch (error) {
    if (!(error instanceof NotAncestor || error instanceof NotOnMain))
      throw error;
    console.error(error.message);
    return 1;
  }
}

if (import.meta.main) cli(main);
