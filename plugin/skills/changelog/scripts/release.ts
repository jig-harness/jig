// The release step: after a merge, write every change note into the
// changelog, move the version when a note asks for a release, and delete the
// notes. It runs on the integration branch, one run at a time, so no two
// pull requests ever pick the same version or edit the same lines. It writes
// files only; committing, tagging and pushing are the caller's.
//
// Every note waiting is one release: when several merges landed before the
// step ran, they ship together, as the largest bump any of them asks for with
// all of their notes. The step releases the tree it runs on, so it cannot
// release an earlier merge on its own: that version would carry the later
// merges' code under an earlier merge's number and notes.
//
// A file that must name the version a change ships in (a "since" field, say)
// names a placeholder instead, which the step replaces with the version it
// releases: a branch cannot know that version before it merges.
//
// Everything it needs is the repository's `changelog:` configuration
// (.config/jig.yaml); a repository without `changelog.file` gets nothing
// written.
//
// Usage: bun release.ts [--root <dir>] [--date YYYY-MM-DD] [--dry-run] [--json]
// Prints what it released (with --json, `{ plugin, configured, version,
// previous, notes, waiting, stamped }`, where `version` is null when no note
// asked for a release, `notes` are the notes written in and `waiting` those
// left for a release).
// Exit: 0 written, or nothing to write; 1 a note is malformed or a step failed
// (version files that disagree, `after_version`, no origin for the links of a
// Common Changelog release); 2 a usage error, an invalid configuration or an
// unreadable file.
import { ChangelogError } from "./errors.ts";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fail, runMain } from "../../../shared/cli.ts";
import { errnoCode } from "../../../shared/errors.ts";
import { run } from "../../../shared/proc.ts";
import { consumerRoot } from "../../../shared/consumer.ts";
import { pluginVersion } from "../../../shared/plugin-version.ts";
import { banner } from "./banner.ts";
import { type ChangeNote, nextVersion, rebaseLinks } from "./change-notes.ts";
import { applyCommonChangelog, credited } from "./common-changelog.ts";
import { loadResolved, type Placeholder, type Resolved } from "./config.ts";
import { releasedVersions } from "./formats.ts";
import { creditOf, originLinks } from "./history.ts";
import { applyKeepAChangelog } from "./keep-a-changelog.ts";
import {
  currentVersionOf,
  gitEnv,
  readNotes,
  tagsOf,
  tryGit,
} from "./notes-dir.ts";
import { withVersion } from "./versions.ts";

type Env = Record<string, string | undefined>;

export interface ReleaseOptions extends Resolved {
  /** The release date; today in UTC by default. */
  date?: string | undefined;
  /** Report what would be written without writing it. */
  dryRun?: boolean;
  /** The environment the `after_version` command and its guard read; this process's by default. */
  env?: Env;
}

export interface ReleaseResult {
  /** The version released; null when no note asked for one. */
  version: string | null;
  previous: string;
  /** The notes written in, in the order they merged. */
  notes: string[];
  /** The notes left in the folder, waiting for a release. */
  waiting: string[];
  /** The files whose placeholder now names the version. */
  stamped: string[];
  /** The changelog as written (or as it would be, on a dry run). */
  changelog: string;
}

/** The environment variable that lets `after_version` run inside a CI job. */
export const AFTER_VERSION_IN_CI = "JIG_AFTER_VERSION_IN_CI";

/** The environment variable that bounds `after_version`, in seconds. */
export const AFTER_VERSION_TIMEOUT = "JIG_AFTER_VERSION_TIMEOUT_SEC";

/** How long `after_version` may run when the environment does not say. */
const AFTER_VERSION_TIMEOUT_DEFAULT_SEC = 1800;

/** The `after_version` deadline in `env`, in seconds; throws on a value that is not one. */
function afterVersionTimeoutSec(env: Env): number {
  const raw = env[AFTER_VERSION_TIMEOUT];
  if (raw === undefined || raw === "") return AFTER_VERSION_TIMEOUT_DEFAULT_SEC;
  const seconds = /^[0-9]+$/.test(raw) ? Number.parseInt(raw, 10) : 0;
  // setTimeout-style deadlines overflow past 2^31 - 1 milliseconds.
  if (seconds < 1 || seconds * 1000 > 2_147_483_647)
    throw new ChangelogError(
      `${AFTER_VERSION_TIMEOUT} must be a whole number of seconds from 1 to 2147483, not ${JSON.stringify(raw)}`,
    );
  return seconds;
}

/** The notes waiting, read; throws, naming each, when one cannot be read. */
function waitingNotes(options: ReleaseOptions): ChangeNote[] {
  const { notes, errors } = readNotes(options);
  if (errors.length)
    throw new MalformedNotes(
      `change notes the release cannot read:\n  ${errors.join("\n  ")}`,
    );
  // Order needs the whole history, and so do the authors a format credits.
  if (notes.length > 1 || (notes.length && options.format.credits))
    requireHistory(options.root);
  return notes;
}

/**
 * The release date: `date` when it is a real calendar day written
 * YYYY-MM-DD, today in UTC when none is given. Throws otherwise.
 */
function releaseDate(date: string | undefined): string {
  if (date === undefined) return new Date().toISOString().slice(0, 10);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? new Date(`${date}T00:00:00Z`)
    : null;
  if (
    !day ||
    Number.isNaN(day.getTime()) ||
    day.toISOString().slice(0, 10) !== date
  )
    throw new ChangelogError(
      `the release date must be a calendar day written YYYY-MM-DD, not ${JSON.stringify(date)}`,
    );
  return date;
}

/** The changelog with `written` in, in the format of the repository. */
function changelogWith(
  options: ReleaseOptions,
  before: string,
  written: ChangeNote[],
  version: string | null,
  previous: string,
): string {
  const { format } = options;
  const links = format.credits ? originLinks(options.root) : null;
  const toChangelog = written.map((n) => {
    const moved = rebaseLinks(n, options.notes, dirname(options.changelog));
    return format.credits
      ? credited(moved, creditFor(options, n), links)
      : moved;
  });
  const settings = {
    version,
    date: releaseDate(options.date),
    tagPrefix: options.tagPrefix,
    unreleased: options.unreleased,
    links,
  };
  if (!format.credits)
    return applyKeepAChangelog(before, toChangelog, {
      ...settings,
      previous,
      firstRelease: isFirstRelease(options, before, previous),
    });
  requireOneNotice(written);
  return applyCommonChangelog(before, toChangelog, {
    ...settings,
    previous: releasedVersions(before, format)[0] ?? null,
  });
}

/**
 * Write the notes in and delete them; throws on a malformed note. Every file
 * is computed and checked before the first is written, so a refusal leaves
 * the repository as it was.
 */
export async function release(options: ReleaseOptions): Promise<ReleaseResult> {
  releaseDate(options.date);
  const notes = waitingNotes(options);
  const previous = currentVersionOf(options);
  const changelogPath = join(options.root, options.changelog);
  const before = readFileSync(changelogPath, "utf8");
  // A note without a release is written under Unreleased at once, or waits
  // for the release that carries it.
  const written =
    options.unreleased === "write" || notes.some((n) => n.release !== null)
      ? notes
      : [];
  const waiting = notes.filter((n) => !written.includes(n)).map((n) => n.file);
  if (!written.length)
    return {
      version: null,
      previous,
      notes: [],
      waiting,
      stamped: [],
      changelog: before,
    };
  const version = nextVersion(
    previous,
    written.flatMap((n) => (n.release ? [n.release] : [])),
  );
  const afterVersion = version ? options.config.afterVersion : null;
  if (afterVersion && !options.dryRun) requireAfterVersionAllowed(options.env);
  const changelog = changelogWith(options, before, written, version, previous);
  const computed = new Map<string, string>([
    ...(version ? versionWrites(options, previous, version) : []),
    [changelogPath, changelog],
  ]);
  // A placeholder is filled in the text already computed for a file the
  // release writes itself, never in a fresh read that would overwrite it.
  const stamped = version
    ? stamp(options.root, options.config.placeholders, version, computed)
    : new Map<string, string>();
  const writes = new Map<string, string>([
    ...computed,
    ...[...stamped].map(
      ([file, text]) => [join(options.root, file), text] as [string, string],
    ),
  ]);
  if (!options.dryRun) {
    for (const [path, text] of writes) writeFileSync(path, text);
    if (afterVersion)
      await runAfterVersion(options.root, afterVersion, options.env);
    // The notes go last: a failed command leaves them for the next run.
    for (const note of written) rmSync(join(options.root, note.file));
  }
  return {
    version,
    previous,
    notes: written.map((n) => n.file),
    waiting,
    stamped: [...stamped.keys()],
    changelog,
  };
}

/**
 * Whether the release is the first: the changelog lists no release yet and
 * the version it replaces was never tagged, so there is nothing to compare
 * the new version with.
 */
function isFirstRelease(
  options: ReleaseOptions,
  changelog: string,
  previous: string,
): boolean {
  return (
    !releasedVersions(changelog, options.format).length &&
    !tagsOf(options.root).includes(`${options.tagPrefix}${previous}`)
  );
}

/**
 * The reference and the authors a note credits: its own `authors:` first,
 * else the history's; none when `changelog.authors` is off. Refused where the
 * format needs a person and the history has only bots.
 */
function creditFor(options: ReleaseOptions, note: ChangeNote) {
  const credit = creditOf(options.root, note.file);
  if (
    options.config.authors &&
    note.authors === null &&
    credit.committed &&
    !credit.authors.length
  )
    throw new MalformedNotes(
      `${note.file}: every commit that wrote it is by a bot, and a release credits people only: name them with \`authors:\` in the note's front matter`,
    );
  return {
    ...credit,
    authors: options.config.authors ? (note.authors ?? credit.authors) : [],
  };
}

/** A release has one notice; refuses, naming the notes, when two have one. */
function requireOneNotice(notes: ChangeNote[]): void {
  const withNotice = notes.filter((n) => n.lead);
  if (withNotice.length > 1)
    throw new MalformedNotes(
      `a release has one notice, a single sentence, but ${withNotice.map((n) => n.file).join(" and ")} each have a summary: keep one and put the other's point in an entry`,
    );
}

/**
 * Refuses a root whose whole history git cannot read: notes are written in
 * the order their merges landed, which a shallow clone, or a directory
 * outside git, cannot tell.
 */
function requireHistory(root: string): void {
  if (
    tryGit(root, ["rev-parse", "--is-shallow-repository"])?.trim() !== "false"
  )
    throw new ChangelogError(
      `${root} is not a git repository with its whole history, so the order the notes merged in cannot be told: run \`git fetch --unshallow\` first`,
    );
}

/** The variables CI services set in a job; any one set to something but `false` or `0` marks a CI job. */
const CI_MARKERS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "CIRCLECI",
  "TF_BUILD",
  "JENKINS_URL",
] as const;

/** The CI markers `env` sets. */
const ciMarkers = (env: Env): string[] =>
  CI_MARKERS.filter((name) => {
    const value = env[name];
    return value !== undefined && value !== "" && !/^(false|0)$/i.test(value);
  });

/**
 * `after_version` is the repository's own command. Inside a CI job (any of
 * of the CI markers above) it would run beside whatever that job can reach, a key that
 * pushes the release included, so it runs there only when the job says it
 * holds none. Its deadline is checked here too, before any file is written.
 */
function requireAfterVersionAllowed(env: Env = process.env): void {
  if (ciMarkers(env).length && env[AFTER_VERSION_IN_CI] !== "1")
    throw new ChangelogError(
      `changelog.after_version is a command of the repository's, and this is a CI job (${ciMarkers(env).join(", ")} set), which may hold the key that pushes the release: run the release in a job that holds none and set ${AFTER_VERSION_IN_CI}=1 there, or leave after_version out`,
    );
  afterVersionTimeoutSec(env);
}

/**
 * Run `after_version` through the platform shell, from the root, in `env`: the
 * environment the CI check above read, so what it allowed is what runs. Its
 * output goes to standard error, so standard output stays the report alone
 * (`--json` included); it reads no input, so a prompt ends rather than waits;
 * past its deadline it is stopped with everything it started; and on POSIX
 * whatever it leaves running in the background when it returns is stopped and
 * fails the release, so nothing it spawned goes on writing after the release
 * reports. A process that leaves the command's process group (`setsid`) is
 * beyond both, and so is a background process on Windows.
 */
async function runAfterVersion(
  root: string,
  command: string,
  env: Env = process.env,
): Promise<void> {
  const timeoutSec = afterVersionTimeoutSec(env);
  const argv =
    process.platform === "win32"
      ? ["cmd.exe", "/d", "/s", "/c", `(${command}) 1>&2`]
      : ["sh", "-c", `exec 1>&2\n${command}`];
  const result = await run(argv, {
    cwd: root,
    env: gitEnv(env),
    stdout: "ignore",
    stderr: "inherit",
    timeoutSec,
    reapGroup: true,
  });
  if (result.code !== 0 || result.groupSurvived) {
    const why = result.timedOut
      ? `still running after ${timeoutSec}s, stopped; ${AFTER_VERSION_TIMEOUT} sets the bound`
      : result.spawnFailed
        ? result.stderr
        : result.code !== 0
          ? `exit ${result.code}`
          : "it returned with a process still running in the background, stopped; wait for it inside the command";
    throw new ChangelogError(
      `changelog.after_version \`${command}\` failed (${why}); the files it follows are written and the notes are still in place: discard the changes and fix it`,
    );
  }
}

/** Each version file's path with its text moved from `previous` to `version`. */
function versionWrites(
  options: ReleaseOptions,
  previous: string,
  version: string,
): [string, string][] {
  if (options.version.kind !== "files") return [];
  const texts = new Map<string, string>();
  for (const file of options.version.files) {
    const path = join(options.root, file.path);
    const text = texts.get(path) ?? readFileSync(path, "utf8");
    texts.set(path, withVersion(file, text, previous, version));
  }
  return [...texts];
}

/** The files a placeholder's globs match, as repository paths; never a workflow. */
function filesOf(root: string, patterns: string[]): string[] {
  const files = patterns.flatMap((pattern) =>
    [...new Bun.Glob(pattern).scanSync({ cwd: root })].map((f) =>
      f.replaceAll("\\", "/"),
    ),
  );
  const workflow = files.find((f) => f.startsWith(".github/workflows/"));
  if (workflow)
    throw new ChangelogError(
      `${workflow}: a placeholder is never filled in a workflow, which the release may not change`,
    );
  return files;
}

/**
 * Each file holding a placeholder, with the placeholder replaced by
 * `version`.
 */
function stamp(
  root: string,
  placeholders: Placeholder[],
  version: string,
  computed: Map<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const { files, from, to } of placeholders)
    for (const file of filesOf(root, files)) {
      const text =
        out.get(file) ??
        computed.get(join(root, file)) ??
        readFileSync(join(root, file), "utf8");
      const replaced = text.replaceAll(
        from,
        to.replaceAll("{version}", version),
      );
      if (replaced !== text) out.set(file, replaced);
    }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

export class MalformedNotes extends Error {}

if (import.meta.main)
  runMain("release", async () => {
    try {
      const { values } = parseArgs({
        options: {
          root: { type: "string" },
          date: { type: "string" },
          "dry-run": { type: "boolean", default: false },
          json: { type: "boolean", default: false },
        },
      });
      return await runReleaseCommand({
        root: values.root ? resolve(values.root) : consumerRoot(),
        date: values.date,
        dryRun: values["dry-run"],
        json: values.json,
      });
    } catch (error) {
      fail(2, error instanceof Error ? error.message : String(error));
    }
  });

/**
 * The release step for the repository at `root`, as the command line runs
 * it; a repository without `changelog.file` is told so and nothing is
 * written. The exit status.
 */
export async function runReleaseCommand(command: {
  root: string;
  date?: string | undefined;
  dryRun?: boolean;
  json?: boolean;
  env?: Env;
}): Promise<number> {
  const resolved = loadResolved(command.root, command.env);
  if (resolved === null) {
    if (command.json)
      console.log(
        JSON.stringify({
          plugin: pluginVersion(),
          configured: false,
          version: null,
          previous: null,
          notes: [],
          waiting: [],
          stamped: [],
        }),
      );
    else
      console.log(
        `${banner("release")}\nrelease: not configured (no changelog.file in .config/jig.yaml), nothing to write`,
      );
    return 0;
  }
  return runRelease(
    {
      ...resolved,
      date: command.date,
      dryRun: command.dryRun ?? false,
      ...(command.env ? { env: command.env } : {}),
    },
    command.json ?? false,
  );
}

/** The sentence a human report ends with. */
function summary(options: ReleaseOptions, result: ReleaseResult): string {
  const { version, previous, notes, waiting } = result;
  if (notes.length)
    return `release: ${options.dryRun ? "would write" : "wrote"} ${notes.length} change note(s) into ${options.changelog}${version ? ` as ${version} (from ${previous})` : " under Unreleased"}`;
  return waiting.length
    ? `release: no change note asks for a release; ${waiting.length} wait for one`
    : "release: no change notes to write";
}

/** Run the release step and report it; the exit status for the command line. */
export async function runRelease(
  options: ReleaseOptions,
  json: boolean,
): Promise<number> {
  let result: ReleaseResult;
  try {
    result = await release(options);
  } catch (error) {
    // An unreadable file is the caller's to report (exit 2); a note that
    // cannot be read or a step that failed is this run's (exit 1).
    if (errnoCode(error) !== undefined) throw error;
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const { version, previous, notes, waiting, stamped } = result;
  if (json)
    console.log(
      JSON.stringify({
        plugin: pluginVersion(),
        configured: true,
        version,
        previous,
        notes,
        waiting,
        stamped,
      }),
    );
  else console.log(`${banner("release")}\n${summary(options, result)}`);
  return 0;
}
