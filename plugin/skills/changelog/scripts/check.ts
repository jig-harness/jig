// The branch side of change notes: every note can be read by the release
// step, and the branch leaves to that step what only it may write: the
// version and the changelog's Unreleased and release sections. A branch that
// changes a released path carries a note that asks for a release; one that
// changes a note path carries a note. Edits to an earlier release's text (a
// typo, a link) stay allowed, and so do corrections and removals of entries
// already under Unreleased, which the check names for the reviewer: they are
// rare and touch lines no other branch does. Adding to Unreleased is refused.
//
// The check enforces the configuration the base holds, not the branch's own:
// it reads the `changelog:` section of `.config/jig.yaml` at the base
// (`git show <base>:.config/jig.yaml`), so a branch cannot unset
// `changelog.file`, empty `release_paths` or move the notes folder to pass its
// own check. A branch that changes the section is checked against the
// section it proposes as well, which must be valid, and the check names the
// change. Where the base holds no section the check says "not configured".
//
// In `pull-request` mode (the base's `changelog.release.push`), the pull
// request from the base's `changelog.release.branch` is the release pull
// request, which the release step writes: instead of the rules above, the
// check re-runs the release step on its merge base and passes it only when
// that gives exactly its change (release-pr.ts says how).
//
// Usage: bun check.ts [--root <dir>] [--base <ref>] [--head-ref <name>]
// The base is `--base`, else the base of the pull request that started the CI
// job, else the hosting service's default branch (never `repository.base_branch`
// of the branch's own tree). The branch the change comes from is `--head-ref`,
// else the head of the pull request that started the CI job, else the branch
// checked out. On the base itself only the notes are checked,
// and the output says so. A base git cannot compare against is a finding: the
// branch rules must not pass because they did not run.
// Exit: 0 clean (or not configured), 1 findings (an invalid configuration at
// the base or the branch included), 2 a usage error or an unreadable file.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fail, runMain } from "../../../shared/cli.ts";
import { swallow } from "../../../shared/errors.ts";
import { consumerRoot } from "../../../shared/consumer.ts";
import { type ChangeNote, parseNote } from "./change-notes.ts";
import { banner } from "./banner.ts";
import { checkBase } from "./branches.ts";
import { creditRefusals, isBreaking } from "./common-changelog.ts";
import {
  type ChangelogConfig,
  changes,
  configAtBase,
  loadChangelogConfig,
  resolve as resolveConfig,
} from "./config.ts";
import { releasedVersions, unreleasedSection } from "./formats.ts";
import { fenced, heading } from "./markdown-blocks.ts";
import { authorsIn, isBot, originLinks } from "./history.ts";
import {
  checkReleasePullRequest,
  headRef,
  isReleasePullRequest,
} from "./release-pr.ts";
import {
  isNoteFile,
  type NotesConfig,
  readNotes,
  tryGit,
  workingTree,
} from "./notes-dir.ts";
import { currentVersion, type FileReader, versionIn } from "./versions.ts";

export interface CheckOptions extends NotesConfig {
  /** Path prefixes whose change ships only in a release, such as `plugin/`. */
  releasePaths: string[];
  /** Path prefixes whose change carries a note, with or without a release. */
  notePaths: string[];
  /** Whether a release credits the people who wrote each note. */
  authors: boolean;
  /** The branch the change merges into; null checks only the notes. */
  base: string | null;
}

export interface CheckResult {
  findings: string[];
  /** What the reviewer should see, though it fails nothing. */
  notices: string[];
  /** Why the branch checks did not run; null when they did. */
  skipped: string | null;
}

/** The branch as the checks read it: what it changed, and each file before and now. */
interface Branch {
  changed: string[];
  mergeBase: string;
  atBase: FileReader;
  now: FileReader;
}

/** NUL-separated git output as a list; git quotes unusual names otherwise. */
const paths = (out: string) => out.split("\0").filter(Boolean);

/**
 * The branch against its merge base with `base`; `skipped` on the base
 * itself, `failed` when git cannot make the comparison.
 */
function readBranch(
  root: string,
  base: string,
): Branch | { skipped: string } | { failed: string } {
  const head = tryGit(root, ["rev-parse", "HEAD"])?.trim();
  const mergeBase = tryGit(root, ["merge-base", "HEAD", base])?.trim();
  if (!head || !mergeBase)
    return {
      failed: `the branch cannot be compared with ${base} (no such revision, or no merge base): fetch it, or give a base git can find`,
    };
  const status = tryGit(root, ["status", "--porcelain", "-z"]);
  const diff = tryGit(root, [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    mergeBase,
  ]);
  const untracked = tryGit(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (status === null || diff === null || untracked === null)
    return {
      failed: `git could not list what the branch changes against ${base}`,
    };
  if (head === mergeBase && !paths(status).length)
    return { skipped: `HEAD is ${base}` };
  return {
    changed: [...paths(diff), ...paths(untracked)],
    mergeBase,
    atBase: (path) => tryGit(root, ["show", `${mergeBase}:${path}`]),
    now: workingTree(root),
  };
}

function versionFindings(options: CheckOptions, branch: Branch): string[] {
  if (options.version.kind !== "files") return [];
  return options.version.files.flatMap((file) => {
    const before = versionIn(file, branch.atBase(file.path));
    const after = versionIn(file, branch.now(file.path));
    return before !== null && before !== after
      ? [
          `${file.path}: the branch moves the version from ${before} to ${String(after)}; the release step sets it after the merge, so leave it and give the change note a \`release:\``,
        ]
      : [];
  });
}

function changelogFindings(options: CheckOptions, branch: Branch): string[] {
  const before = branch.atBase(options.changelog);
  const after = branch.now(options.changelog);
  if (before === null) return [];
  if (after === null)
    return [
      `${options.changelog}: the branch deletes the changelog, whose sections the release step writes`,
    ];
  const findings: string[] = [];
  if (
    options.format.hasUnreleased &&
    addsUnreleased(unreleasedSection(before), unreleasedSection(after))
  )
    findings.push(
      `${options.changelog}: the branch adds to Unreleased, which the release step writes; put the change in a note under ${options.notes}/ instead`,
    );
  const versions = (text: string) =>
    releasedVersions(text, options.format).join(" ");
  if (versions(before) !== versions(after))
    findings.push(
      `${options.changelog}: the branch adds or removes a release section, which the release step writes; put the change in a note under ${options.notes}/ with \`release:\` instead`,
    );
  return findings;
}

/** A line's leading structure: indentation, quote markers and a list marker. */
const lead = (line: string) =>
  (/^[\s>]*(?:(?:[-*+]|\d+[.)])(?=\s|$))?/.exec(line)?.[0] ?? "").replace(
    /\d+/,
    "1",
  );

/** A non-blank line of an Unreleased section, with its place. */
type Placed = { text: string; place: string };

/**
 * The place of each non-blank line of an Unreleased section, which a
 * correction may not change: a heading's level and title, or a line's leading
 * structure (indentation, quote markers, a list marker, a fence delimiter, or
 * being inside a fence) with the heading it sits under.
 */
function places(section: string): Placed[] {
  const lines: Placed[] = [];
  let under = "";
  for (const line of fenced(section)) {
    if (line.line.trim() === "") continue;
    const text = line.line;
    const h = line.inFence ? null : heading(text);
    if (h !== null) {
      under = `${"#".repeat(h.level)} ${h.title.toLowerCase()}`;
      lines.push({ text, place: under });
    } else if (line.delimiter !== null)
      lines.push({ text, place: `fence ${line.delimiter}\n${under}` });
    else
      lines.push({
        text,
        place: `${line.inFence ? "in fence" : `lead ${lead(text)}`}\n${under}`,
      });
  }
  return lines;
}

/**
 * For each non-blank line of the branch's Unreleased, the base line whose
 * place it takes: the first one after the previous match with the same
 * place. Null when a line finds none, which is a line the base did not have
 * room for. One pass over each section.
 */
function matchPlaces(was: Placed[], now: Placed[]): number[] | null {
  const matched: number[] = [];
  let i = 0;
  for (const line of now) {
    while (i < was.length && was[i]?.place !== line.place) i++;
    if (i === was.length) return null;
    matched.push(i++);
  }
  return matched;
}

/**
 * Whether the branch's Unreleased adds to what the base's holds, or the
 * section itself appears or goes. Which lines form an entry is for a Markdown
 * parser to say, and the check has none, so the rule is about places, never
 * about text: read line by line, the branch's section must be the base's with
 * lines removed, each line it keeps or rewrites in the place of one the base
 * had, in order, with the same leading structure and under the same heading.
 * So a line inserted anywhere, an entry moved to another heading, a
 * continuation turned into a list item and a rewrap onto more lines are all
 * refused, and removing a line under one heading cannot make room for one
 * under another. A heading is rewritten only into the same level and title.
 * What a line now says is the reviewer's to judge: the notice lists every line
 * changed, removed or added. One pass over each section, so its cost grows
 * with the section's length and no faster.
 */
function addsUnreleased(before: string | null, after: string | null): boolean {
  if (before === after) return false;
  if (before === null || after === null) return true;
  return matchPlaces(places(before), places(after)) === null;
}

/**
 * The lines a correction changes, read the way `addsUnreleased` reads it:
 * each branch line takes the place of the base line it matched, so a base
 * line is changed when the line in its place says something else, and
 * removed when no line took its place. Order counts, so two lines swapped
 * are both named. The caller leaves out the lines both sections end on first.
 */
function changedLines(
  was: Placed[],
  now: Placed[],
  matched: number[],
): { removed: string[]; added: string[] } {
  const taken = new Map(matched.map((at, n) => [at, now[n]?.text]));
  return {
    removed: was
      .filter((line, at) => taken.get(at) !== line.text)
      .map((line) => line.text),
    added: now
      .filter((line, n) => was[matched[n] ?? -1]?.text !== line.text)
      .map((line) => line.text),
  };
}

/**
 * Both sections without the lines they end on alike, same text in the same
 * place, so deleting the first of several alike entries names that entry
 * alone rather than every line after it shifted up a place. Lines they start
 * on alike already match themselves. What is left still matches whenever the
 * whole sections did.
 */
function withoutSharedTail(was: Placed[], now: Placed[]): [Placed[], Placed[]] {
  let end = 0;
  while (end < Math.min(was.length, now.length)) {
    const [a, b] = [was[was.length - 1 - end], now[now.length - 1 - end]];
    if (a?.text !== b?.text || a?.place !== b?.place) break;
    end++;
  }
  return [was.slice(0, was.length - end), now.slice(0, now.length - end)];
}

/** Unreleased entries the branch corrected or removed, named for the reviewer. */
function correctedUnreleased(options: CheckOptions, branch: Branch): string[] {
  if (!options.format.hasUnreleased) return [];
  const before = branch.atBase(options.changelog);
  const after = branch.now(options.changelog);
  if (before === null || after === null) return [];
  const was = unreleasedSection(before);
  const now = unreleasedSection(after);
  if (was === null || now === null || was === now) return [];
  const [wasLines, nowLines] = withoutSharedTail(places(was), places(now));
  const matched = matchPlaces(wasLines, nowLines);
  if (matched === null) return [];
  const { removed, added } = changedLines(wasLines, nowLines, matched);
  const listed = (heading: string, lines: string[]) =>
    lines.length
      ? [`${heading}\n${lines.map((line) => `  - ${line.trim()}`).join("\n")}`]
      : [];
  const lines = [
    ...listed("Lines it changes or removes:", removed),
    ...listed("Lines it adds:", added),
  ];
  return [
    `${options.changelog}: the branch corrects or removes entries under Unreleased; check that it changes only what was wrong. ${lines.join("\n")}`,
  ];
}

/** The notes the branch added or changed that still exist, read. */
function branchNotes(
  options: CheckOptions,
  branch: Branch,
): { file: string; note: ChangeNote }[] {
  return branch.changed.flatMap((file) => {
    const text = isNoteFile(options.notes, file) ? branch.now(file) : null;
    const note =
      text === null ? null : parseNote(file, text, options.format).note;
    return note ? [{ file, note }] : [];
  });
}

/**
 * Whether `file` is under `prefix`: a prefix ending in `/` is a folder, and
 * one without is a file or a folder, never another name that starts with it
 * (`plugin` holds `plugin/x`, not `plugin-docs/x`).
 */
export const under = (file: string, prefix: string): boolean =>
  prefix.endsWith("/")
    ? file.startsWith(prefix)
    : file === prefix || file.startsWith(`${prefix}/`);

const some = (files: string[], prefixes: string[]) =>
  files.filter((f) => prefixes.some((p) => under(f, p)));

const listed = (files: string[]) =>
  `${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}`;

function pathFindings(
  options: CheckOptions,
  branch: Branch,
  notes: { file: string; note: ChangeNote }[],
): string[] {
  const findings: string[] = [];
  const released = some(branch.changed, options.releasePaths);
  if (released.length && !notes.some(({ note }) => note.release !== null))
    findings.push(
      `${listed(released)} changed, which ships only in a release, but no change note under ${options.notes}/ asks for one: add a note with \`release: patch|minor|major\``,
    );
  const noted = some(branch.changed, options.notePaths);
  if (noted.length && !notes.length)
    findings.push(
      `${listed(noted)} changed, which needs a change note, but the branch adds none under ${options.notes}/: add one`,
    );
  return findings;
}

/** The version at the merge base; null when it cannot be told. */
function versionAtBase(options: CheckOptions, branch: Branch): string | null {
  try {
    return currentVersion(options.version, {
      read: branch.atBase,
      format: options.format,
      tagPrefix: options.tagPrefix,
      changelog: branch.atBase(options.changelog) ?? "",
      tags: () => (tryGit(options.root, ["tag", "--list"]) ?? "").split("\n"),
    });
  } catch (error) {
    swallow(error, "the version at the base cannot be told");
    return null;
  }
}

/**
 * The summaries of the notes waiting on the base, which a release can hold
 * only one of in a format that gives a release a single notice.
 */
function noticesAtBase(options: CheckOptions, base: string): string[] {
  const listing = tryGit(options.root, [
    "ls-tree",
    "--name-only",
    "-z",
    base,
    `${options.notes}/`,
  ]);
  return paths(listing ?? "").flatMap((file) => {
    const text = isNoteFile(options.notes, file)
      ? tryGit(options.root, ["show", `${base}:${file}`])
      : null;
    return text !== null && parseNote(file, text, options.format).note?.lead
      ? [file]
      : [];
  });
}

/** A `**Breaking:**` entry needs a release that says so. */
function breakingFinding(
  file: string,
  note: ChangeNote,
  preStable: boolean,
): string | null {
  const breaking = [...note.sections.values()].flat().some(isBreaking);
  const enough =
    note.release === "major" || (preStable && note.release === "minor");
  return breaking && !enough
    ? `${file}: a **Breaking:** entry needs \`release: major\`${preStable ? " (or minor before 1.0.0)" : ""}, but the note asks for ${note.release ?? "no release"}`
    : null;
}

/** A release has one notice: a summary is refused where a waiting note has one. */
function noticeFinding(
  file: string,
  note: ChangeNote,
  waiting: string[],
): string | null {
  const others = waiting.filter((other) => other !== file);
  return note.lead && others.length
    ? `${file}: a release has one notice, and ${others.join(", ")} waiting on the base already has a summary: put this one's point in an entry`
    : null;
}

/** A note written only by bots needs people named, since a release credits people only. */
function botFinding(
  options: CheckOptions,
  branch: Branch,
  file: string,
  note: ChangeNote,
): string | null {
  if (!options.authors || note.authors !== null) return null;
  const names = authorsIn(options.root, `${branch.mergeBase}..HEAD`, file);
  return names.length && names.every(isBot)
    ? `${file}: every commit that wrote it is by a bot, and a release credits people only: name them with \`authors:\` in the note's front matter`
    : null;
}

/** The rules a format that credits a change adds, for the notes the branch wrote. */
function creditFindings(
  options: CheckOptions,
  branch: Branch,
  notes: { file: string; note: ChangeNote }[],
): string[] {
  if (!options.format.credits) return [];
  const preStable = versionAtBase(options, branch)?.startsWith("0.") === true;
  const waiting = options.base ? noticesAtBase(options, options.base) : [];
  return notes.flatMap(({ file, note }) =>
    [
      breakingFinding(file, note, preStable),
      noticeFinding(file, note, waiting),
      botFinding(options, branch, file, note),
    ].flatMap((finding) => (finding === null ? [] : [finding])),
  );
}

/**
 * Why the release would refuse to credit a note, for every note waiting in the
 * folder, the branch's own or not: the release credits each note it consumes.
 */
function creditable(options: CheckOptions, notes: ChangeNote[]): string[] {
  if (!options.format.credits) return [];
  const links = originLinks(options.root);
  return notes.flatMap((note) => creditRefusals(note, links));
}

/** Notes of an earlier branch that this one changes or deletes, for the reviewer. */
function editedNotices(options: CheckOptions, branch: Branch): string[] {
  return branch.changed
    .filter((f) => isNoteFile(options.notes, f) && branch.atBase(f) !== null)
    .map(
      (f) =>
        `${f} was added by an earlier branch and this one ${branch.now(f) === null ? "deletes" : "changes"} it`,
    );
}

export function checkNotes(options: CheckOptions): CheckResult {
  const read = readNotes(options);
  const findings = [...read.errors, ...creditable(options, read.notes)];
  if (!options.base)
    return { findings, notices: [], skipped: "no base branch given" };
  const branch = readBranch(options.root, options.base);
  if ("failed" in branch)
    return {
      findings: [...findings, branch.failed],
      notices: [],
      skipped: null,
    };
  if ("skipped" in branch)
    return { findings, notices: [], skipped: branch.skipped };
  const notes = branchNotes(options, branch);
  findings.push(
    ...versionFindings(options, branch),
    ...changelogFindings(options, branch),
    ...pathFindings(options, branch, notes),
    ...creditFindings(options, branch, notes),
  );
  return {
    findings,
    notices: [
      ...editedNotices(options, branch),
      ...correctedUnreleased(options, branch),
    ],
    skipped: null,
  };
}

/** What the branch check found, with whether the repository has the skill on at its base. */
export interface BranchCheck extends CheckResult {
  configured: boolean;
  /** The release a release pull request was reproduced as; null for any other branch. */
  reproduced: { version: string; date: string } | null;
}

const notConfigured = (more: Partial<BranchCheck> = {}): BranchCheck => ({
  findings: [],
  notices: [],
  skipped: null,
  configured: false,
  reproduced: null,
  ...more,
});

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Whether the clone has any remote. */
const hasRemote = (root: string): boolean =>
  (tryGit(root, ["remote"]) ?? "").trim() !== "";

/**
 * Why the branch cannot be compared with `base` at all, as the finished
 * check; null when it can. A clone with no remote at all is not asked for a base
 * it did not give.
 */
function unusableBase(
  root: string,
  base: string | null,
  proposed: ChangelogConfig | null,
  explicitBase: boolean,
): BranchCheck | null {
  if (
    base !== null &&
    tryGit(root, ["rev-parse", "--verify", "-q", `${base}^{commit}`]) !== null
  )
    return null;
  // Only a clone with no remote at all is taken for one that never adopted
  // the skill; the branch's own tree never vouches for itself.
  if (proposed === null && !explicitBase && !hasRemote(root))
    return notConfigured();
  return notConfigured({
    findings: [
      base === null
        ? "the branch to compare with is unknown: pass --base <ref>, or give the clone an origin/HEAD (git remote set-head origin --auto)"
        : `the branch cannot be compared with ${base} (no such revision): fetch it, or give a base git can find`,
    ],
  });
}

/** What the reviewer should see of the section the branch proposes against the base's. */
function proposalNotices(
  atBase: ChangelogConfig,
  proposed: ChangelogConfig | null,
): string[] {
  if (proposed === null)
    return [
      "this branch removes the changelog section from .config/jig.yaml; the check still holds it to the base's",
    ];
  const changed = changes(atBase, proposed);
  return changed.length
    ? [
        `this branch changes the changelog section, which the base's still governs this check:\n  ${changed.join("\n  ")}`,
      ]
    : [];
}

/** The finding when the section a branch proposes does not work against its tree. */
function proposalFindings(
  root: string,
  proposed: ChangelogConfig | null,
): string[] {
  if (proposed === null) return [];
  try {
    resolveConfig(root, proposed, workingTree(root));
    return [];
  } catch (error) {
    return [
      `the changelog section this branch proposes does not work: ${message(error)}`,
    ];
  }
}

/**
 * The branch check of the repository at `root` against `base`: the
 * configuration is the base's, and the branch's own section is checked as a
 * proposal. A repository whose base has no `changelog.file` is not
 * configured, whatever the branch adds. The release pull request of
 * `pull-request` mode is reproduced instead; `explicitHead` names the branch
 * the change comes from where the CI event or the checkout does not.
 */
export function checkBranch(
  root: string,
  base: string | null,
  env: Record<string, string | undefined> = process.env,
  explicitBase = true,
  explicitHead: string | null = null,
): BranchCheck {
  let proposed: ChangelogConfig | null;
  try {
    proposed = loadChangelogConfig(root, env);
  } catch (error) {
    return notConfigured({ findings: [message(error)] });
  }
  const unusable = unusableBase(root, base, proposed, explicitBase);
  if (unusable || base === null) return unusable ?? notConfigured();
  let atBase: ChangelogConfig | null;
  try {
    atBase = configAtBase(root, base);
  } catch (error) {
    return notConfigured({
      findings: [
        `the changelog configuration at ${base} is invalid, so the branch cannot be held to it: ${message(error)}`,
      ],
    });
  }
  const findings = proposalFindings(root, proposed);
  if (atBase === null)
    return notConfigured({
      findings,
      notices:
        proposed === null
          ? []
          : [
              "this branch adds the changelog section; it takes effect once it is merged",
            ],
    });
  const notices = proposalNotices(atBase, proposed);
  let resolved: ReturnType<typeof resolveConfig>;
  try {
    resolved = resolveConfig(root, atBase, (path) =>
      tryGit(root, ["show", `${base}:${path}`]),
    );
  } catch (error) {
    return notConfigured({
      findings: [
        ...findings,
        `the base's changelog configuration does not work at ${base}: ${message(error)}`,
      ],
      notices,
    });
  }
  if (isReleasePullRequest(atBase, headRef(root, explicitHead, env))) {
    const reproduction = checkReleasePullRequest(root, base);
    return {
      findings: [...findings, ...reproduction.findings],
      notices,
      skipped: null,
      configured: true,
      reproduced: reproduction.reproduced,
    };
  }
  const result = checkNotes({
    ...resolved,
    releasePaths: atBase.releasePaths,
    notePaths: atBase.notePaths,
    authors: atBase.authors,
    base,
  });
  return {
    findings: [...findings, ...result.findings],
    notices: [...notices, ...result.notices],
    skipped: result.skipped,
    configured: true,
    reproduced: null,
  };
}

/** Run the check and report it; the exit status for the command line. */
export function runCheck(
  root: string,
  explicitBase: string | null,
  env: Record<string, string | undefined> = process.env,
  explicitHead: string | null = null,
): number {
  console.log(banner("check"));
  const base = checkBase(root, explicitBase, env);
  const { findings, notices, skipped, configured, reproduced } = checkBranch(
    root,
    base,
    env,
    explicitBase !== null,
    explicitHead,
  );
  for (const n of notices) console.log(`note: ${n}`);
  for (const f of findings) console.error(f);
  if (findings.length) return 1;
  console.log(
    !configured
      ? "change notes: not configured (the base holds no changelog.file in .config/jig.yaml)"
      : reproduced
        ? `change notes: OK — the release pull request is what the release step writes on its merge base: ${reproduced.version}, dated ${reproduced.date}`
        : skipped
          ? `change notes: OK — every note reads; branch checks skipped (${skipped})`
          : `change notes: OK — every note reads, and the branch leaves the version and the changelog's sections to the release step`,
  );
  return 0;
}

if (import.meta.main)
  runMain("check", async () => {
    try {
      const { values } = parseArgs({
        options: {
          root: { type: "string" },
          base: { type: "string" },
          "head-ref": { type: "string" },
        },
      });
      return runCheck(
        values.root ? resolve(values.root) : consumerRoot(),
        values.base ?? null,
        process.env,
        values["head-ref"] ?? null,
      );
    } catch (error) {
      fail(2, error instanceof Error ? error.message : String(error));
    }
  });
