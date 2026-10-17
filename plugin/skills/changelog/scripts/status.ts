// Where a repository's releases stand: the notes waiting, the version they
// would make, the notes that wait for a release to carry them and, on GitHub,
// whether the last release run on the integration branch succeeded. It writes
// nothing.
//
// Usage: bun status.ts [--root <dir>] [--json]
// Exit: 0 reported (also when the repository has not turned the skill on, and
// when the hosting service cannot be asked); 1 a note is malformed, the
// version cannot be told (the version files disagree) or the last release run
// failed; 2 a usage error, an invalid configuration or an unreadable file.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fail, runMain } from "../../../shared/cli.ts";
import { errnoCode } from "../../../shared/errors.ts";
import { consumerRoot } from "../../../shared/consumer.ts";
import { pluginVersion } from "../../../shared/plugin-version.ts";
import { banner } from "./banner.ts";
import { integrationBranch } from "./branches.ts";
import { type Bump, nextVersion } from "./change-notes.ts";
import { loadResolved, type Resolved } from "./config.ts";
import { type Hosting, hostingFor, type ReleaseRun } from "./hosting.ts";
import { currentVersionOf, readNotes } from "./notes-dir.ts";

type Env = Record<string, string | undefined>;

export interface Status {
  plugin: string | null;
  configured: boolean;
  format: string | null;
  /** The released version now. */
  current: string | null;
  /** The version the notes asking for a release would make; null when none asks. */
  next: string | null;
  /** The notes that ask for a release, with the bump each asks for. */
  releasing: { file: string; release: Bump }[];
  /** The notes that wait for a release to carry them. */
  waiting: string[];
  /** The notes the next release run writes under Unreleased at once. */
  unreleased: string[];
  /** Notes the release step cannot read. */
  errors: string[];
  integrationBranch: string | null;
  releaseRun: ReleaseRun;
}

const UNKNOWN_RUN: ReleaseRun = {
  state: "unknown",
  detail:
    "not read: the repository's host has no adapter, or it has no origin remote",
};

/** The status of the repository `resolved` describes, asking `hosting` about the last release run. */
export function status(
  resolved: Resolved,
  hosting: Hosting | null,
  env: Env = process.env,
): Status {
  const { notes, errors } = readNotes(resolved);
  const releasing = notes.flatMap((n) =>
    n.release ? [{ file: n.file, release: n.release }] : [],
  );
  const pending = notes.filter((n) => n.release === null).map((n) => n.file);
  const branch = integrationBranch(resolved.root, env, hosting);
  const run = hosting && branch ? hosting.lastReleaseRun(branch) : UNKNOWN_RUN;
  const write = resolved.unreleased === "write";
  const current = currentVersionOf(resolved);
  return {
    plugin: pluginVersion(),
    configured: true,
    format: resolved.format.id,
    current,
    next: nextVersion(
      current,
      releasing.map((r) => r.release),
    ),
    releasing,
    waiting: write ? [] : pending,
    unreleased: write ? pending : [],
    errors,
    integrationBranch: branch,
    releaseRun: run,
  };
}

function describe(s: Status): string[] {
  const lines = [
    banner("status"),
    `format: ${s.format}; released version: ${s.current}`,
  ];
  for (const e of s.errors) lines.push(`unreadable note: ${e}`);
  if (s.releasing.length)
    lines.push(
      `next release: ${s.next ?? "unknown"}, from ${s.releasing.length} note(s) asking for it:`,
      ...s.releasing.map((r) => `  ${r.file} (${r.release})`),
    );
  else lines.push("next release: none, no note asks for one");
  if (s.waiting.length)
    lines.push(
      "waiting for a release (they go into the next one):",
      ...s.waiting.map((f) => `  ${f}`),
    );
  if (s.unreleased.length)
    lines.push(
      "to be written under Unreleased by the next release run:",
      ...s.unreleased.map((f) => `  ${f}`),
    );
  lines.push(
    `release run${s.integrationBranch ? ` on ${s.integrationBranch}` : ""}: ${s.releaseRun.state} (${s.releaseRun.detail})${s.releaseRun.url ? ` ${s.releaseRun.url}` : ""}`,
  );
  return lines;
}

/** What a repository that did not turn the skill on is told. */
function reportOff(json: boolean): void {
  if (json)
    console.log(JSON.stringify({ plugin: pluginVersion(), configured: false }));
  else
    console.log(
      `${banner("status")}\nnot configured (no changelog.file in .config/jig.yaml)`,
    );
}

/** The status, or null (reported) when the version cannot be told. */
function tryStatus(
  resolved: Resolved,
  hosting: Hosting | null,
  env: Env,
): Status | null {
  try {
    return status(resolved, hosting, env);
  } catch (error) {
    // An unreadable file is the caller's to report (exit 2); a version that
    // cannot be told (the files disagree) is this run's (exit 1).
    if (errnoCode(error) !== undefined) throw error;
    console.error(error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** Report the status of the repository at `root`; the exit status for the command line. */
export function runStatus(
  root: string,
  json: boolean,
  env: Env = process.env,
  hosting: Hosting | null | undefined = undefined,
): number {
  const resolved = loadResolved(root, env);
  if (resolved === null) {
    reportOff(json);
    return 0;
  }
  const result = tryStatus(
    resolved,
    hosting === undefined ? hostingFor(root) : hosting,
    env,
  );
  if (result === null) return 1;
  if (json) console.log(JSON.stringify(result));
  else for (const line of describe(result)) console.log(line);
  return result.errors.length || result.releaseRun.state === "failure" ? 1 : 0;
}

if (import.meta.main)
  runMain("status", async () => {
    try {
      const { values } = parseArgs({
        options: {
          root: { type: "string" },
          json: { type: "boolean", default: false },
        },
      });
      return runStatus(
        values.root ? resolve(values.root) : consumerRoot(),
        values.json,
      );
    } catch (error) {
      fail(2, error instanceof Error ? error.message : String(error));
    }
  });
