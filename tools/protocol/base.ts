/**
 * What a stable chapter promised before this change (design/protocol.md
 * § What stable promises, and how the gate holds it): the check reads each
 * chapter's data file as the integration branch holds it at the merge base,
 * and fails a change that breaks a stable chapter without raising its
 * version: a value the base has and the new data lacks, a value whose
 * meaning changed to another value's, a field removed or retyped, a field
 * new and required or made required. A chapter the base lists as stable
 * stays stable: marking it provisional, or removing it, also needs its
 * version raised and a change note marked breaking that names its file.
 *
 * Which chapters the base lists, and their status, are read from the base's
 * data files, which the base's own gate held equal to its chapter list.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "../../lib/findings.ts";
import { isRecord } from "../../lib/record.ts";
import { checkBase } from "../../plugin/skills/changelog/scripts/branches.ts";
import { entries } from "../../plugin/skills/changelog/scripts/change-notes.ts";
import { isBreakingEntry } from "../../plugin/skills/changelog/scripts/consumer-actions.ts";
import {
  gitEnv,
  isNoteFile,
  tryGit,
} from "../../plugin/skills/changelog/scripts/notes-dir.ts";
import { spawnSync } from "../../plugin/shared/guarded-git-spawn.ts";
import {
  type Chapter,
  chapterFile,
  DATA_DIR,
  type DataFile,
  type DataValue,
  dataFile,
  type FieldSpec,
  type Withdrawn,
} from "./chapter.ts";
import { RULE } from "./outputs.ts";

/** Where the change notes live, each a file a pull request adds. */
const NOTES_DIR = "changes";

export type MergeBase =
  | { ok: true; commit: string; ref: string }
  | { ok: false; reason: string };

/** git's answer: its output, or why it failed, in its own words. */
type GitAnswer = { ok: true; stdout: string } | { ok: false; why: string };

function git(root: string, args: string[]): GitAnswer {
  const result = spawnSync("git", ["-C", root, ...args], { env: gitEnv() });
  if (result.status === 0) return { ok: true, stdout: result.stdout };
  const said = (result.stderr || result.error?.message || "").trim();
  return {
    ok: false,
    why: `git ${args.join(" ")} exited ${result.status ?? "on a signal"}${said ? `: ${said}` : ""}`,
  };
}

/** The fetch that gives the clone the history it needs to read `ref`'s merge base. */
function fetchFor(root: string, ref: string, shallow: boolean): string {
  const remotes = (tryGit(root, ["remote"]) ?? "")
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);
  const remote = remotes.find((r) => ref.startsWith(`${r}/`));
  const unshallow = shallow ? " --unshallow" : "";
  if (remote === undefined)
    return `git fetch${unshallow} <remote> ${ref} (the remote that holds ${ref})`;
  return `git fetch${unshallow} ${remote} ${ref.slice(remote.length + 1)}`;
}

/**
 * The merge base with the integration branch: the base the check is given
 * (`--base`), else the base of the pull request that started the CI job,
 * else the default branch, as the changelog check reads it, never from the
 * branch's own configuration. During a merge, the base the merge commit will
 * have. When it cannot be read, why, with the fetch that fixes it.
 */
export function mergeBase(
  root: string,
  explicit: string | null,
  env: Record<string, string | undefined> = process.env,
): MergeBase {
  const ref = checkBase(root, explicit, env);
  if (ref === null)
    return {
      ok: false,
      reason:
        "the integration branch is unknown: give the clone an origin/HEAD (git remote set-head origin --auto), or pass --base <ref>",
    };
  const shallow =
    tryGit(root, ["rev-parse", "--is-shallow-repository"])?.trim() === "true";
  if (tryGit(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]) === null)
    return {
      ok: false,
      reason: `${ref} cannot be read; fetch it: ${fetchFor(root, ref, shallow)}`,
    };
  const incoming = tryGit(root, [
    "rev-parse",
    "--verify",
    "-q",
    "MERGE_HEAD^{commit}",
  ])?.trim();
  const heads = ["HEAD", ...(incoming ? [incoming] : [])];
  const found = git(root, ["merge-base", ref, ...heads]);
  const commit = found.ok ? found.stdout.trim() : "";
  if (commit) return { ok: true, commit, ref };
  if (shallow)
    return {
      ok: false,
      reason: `the merge base with ${ref} cannot be read in this shallow clone; fetch the history that holds it: ${fetchFor(root, ref, shallow)}`,
    };
  // In a full clone, `git merge-base` exits 1 with nothing to say when the
  // two histories share no commit at all.
  if (found.ok || /exited 1$/.test(found.why))
    return {
      ok: false,
      reason: `HEAD and ${ref} share no history, so there is no merge base to compare with: compare with the branch this one was cut from (--base <ref>)`,
    };
  return {
    ok: false,
    reason: `the merge base with ${ref} cannot be read: ${found.why}`,
  };
}

/** A base data file read as one, or null when it does not have a data file's shape. */
function asData(value: unknown): DataFile | null {
  if (
    !isRecord(value) ||
    typeof value.chapter !== "string" ||
    typeof value.version !== "number" ||
    (value.status !== "stable" && value.status !== "provisional") ||
    !isRecord(value.fields) ||
    !Array.isArray(value.values)
  )
    return null;
  return value as unknown as DataFile;
}

/** The base's data files by chapter, with each one that is not a data file; or why git could not read them. */
export type BaseData =
  | { ok: true; data: Map<string, DataFile>; findings: Finding[] }
  | { ok: false; reason: string };

/** What a base data file's text holds: a data file, or why it is not one. */
function parseData(text: string): DataFile | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return `is not valid JSON (${error instanceof Error ? error.message : String(error)})`;
  }
  return (
    asData(parsed) ??
    "is JSON without a data file's shape (chapter, version, status, fields and values)"
  );
}

/**
 * The data files the base commit holds, by chapter. A listing git cannot
 * make, or a file it cannot show, means the check cannot decide; only a
 * listing git made and found empty means the base has no Protocol.
 */
export function baseData(root: string, commit: string): BaseData {
  const data = new Map<string, DataFile>();
  const findings: Finding[] = [];
  const listing = git(root, [
    "ls-tree",
    "-z",
    "--name-only",
    commit,
    "--",
    `${DATA_DIR}/`,
  ]);
  if (!listing.ok)
    return {
      ok: false,
      reason: `the base's data files cannot be listed: ${listing.why}`,
    };
  for (const path of listing.stdout.split("\0").filter(Boolean)) {
    if (!path.endsWith(".json")) continue;
    const shown = git(root, ["show", `${commit}:${path}`]);
    if (!shown.ok)
      return {
        ok: false,
        reason: `the base's copy of ${path} cannot be read: ${shown.why}`,
      };
    const doc = parseData(shown.stdout);
    if (typeof doc === "string")
      findings.push({
        rule: RULE,
        file: path,
        problem: `the base's copy (${commit.slice(0, 12)}) ${doc}, so the chapter cannot be compared with it`,
        remedy:
          "repair the data file on the integration branch (run the generator there), then bring that fix into this branch; nothing on this branch alone clears it",
      });
    else data.set(path.slice(DATA_DIR.length + 1, -".json".length), doc);
  }
  return { ok: true, data, findings };
}

/** The `**Breaking:**` entries of the change notes this branch adds or changes. */
export function breakingEntries(root: string, commit: string): string[] {
  const listed = [
    tryGit(root, ["diff", "--name-only", "-z", commit, "--", `${NOTES_DIR}/`]),
    tryGit(root, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      `${NOTES_DIR}/`,
    ]),
  ];
  const files = new Set(
    listed
      .flatMap((out) => (out ?? "").split("\0"))
      .filter((f) => f !== "" && isNoteFile(NOTES_DIR, f)),
  );
  return [...files].flatMap((file) => {
    const full = join(root, file);
    if (!existsSync(full)) return [];
    return entries(readFileSync(full, "utf8")).items.filter(isBreakingEntry);
  });
}

export interface BaseComparison {
  base: Map<string, DataFile>;
  chapters: readonly Chapter[];
  /** Each listed chapter's data as the code generates it now. */
  data: Map<string, DataFile>;
  withdrawn: readonly Withdrawn[];
  /** The breaking entries of the change notes this branch adds or changes. */
  breaking: readonly string[];
}

const describeType = (s: FieldSpec) =>
  `${s.type}${s.nullable ? " or null" : ""}`;

/** How a field the base has differs from it now, or null when it keeps its promise. */
function fieldChange(name: string, was: FieldSpec, is?: FieldSpec) {
  if (is === undefined) return `the field ${name}, which the base has, is gone`;
  if (Boolean(is.identifies) !== Boolean(was.identifies))
    return `the field ${name} changed whether it identifies a value`;
  if (is.type !== was.type || is.nullable !== was.nullable)
    return `the field ${name} changed type from ${describeType(was)} to ${describeType(is)}`;
  if (!was.required && is.required)
    return `the field ${name} changed from optional to required`;
  return null;
}

/** What a field the base lacks may not be: required, or part of a value's identity. */
function newFieldChange(name: string, is: FieldSpec) {
  if (is.required) return `the field ${name} is new and required`;
  if (is.identifies) return `the field ${name} is new and identifies a value`;
  return null;
}

function fieldFindings(file: string, base: DataFile, now: DataFile): Finding[] {
  const problems = [
    ...Object.entries(base.fields).map(([name, was]) =>
      fieldChange(name, was, now.fields[name]),
    ),
    ...Object.entries(now.fields)
      .filter(([name]) => !(name in base.fields))
      .map(([name, is]) => newFieldChange(name, is)),
  ];
  return problems
    .filter((problem): problem is string => problem !== null)
    .map((problem) => ({
      rule: RULE,
      file,
      problem,
      remedy: `keep the field as the base has it, or raise the chapter's version in tools/protocol/chapters.ts (above ${base.version}) and mark its change note breaking`,
    }));
}

/** The `kind` a value is withdrawn to: its other fields may then change. */
const TOMBSTONE = "tombstone";

/** The values of the base and of now, keyed by the identity the base gives them. */
interface ValueView {
  readonly base: DataFile;
  readonly now: DataFile;
  readonly key: (v: DataValue) => string;
  readonly show: (v: DataValue) => string;
  readonly before: ReadonlyMap<string, DataValue>;
  readonly after: ReadonlyMap<string, DataValue>;
}

function valueView(base: DataFile, now: DataFile): ValueView {
  const identity = Object.entries(base.fields)
    .filter(([, spec]) => spec.identifies)
    .map(([name]) => name);
  const key = (v: DataValue) =>
    JSON.stringify(identity.map((f) => v[f] ?? null));
  const show = (v: DataValue) =>
    identity.map((f) => `${f} ${JSON.stringify(v[f] ?? null)}`).join(", ");
  return {
    base,
    now,
    key,
    show,
    before: new Map(base.values.map((v) => [key(v), v])),
    after: new Map(now.values.map((v) => [key(v), v])),
  };
}

/** The problems with the values' identities: a value gone, or two now sharing one. */
function identityProblems(view: ValueView): string[] {
  const out = [...view.before]
    .filter(([k]) => !view.after.has(k))
    .map(([, v]) => `the value the base lists as ${view.show(v)} is gone`);
  // A reader holding the base's identity selects the first match, so two
  // values that share it now are one value to that reader.
  const seen = new Set<string>();
  for (const v of view.now.values) {
    const k = view.key(v);
    if (seen.has(k))
      out.push(`two values share the identity the base gives ${view.show(v)}`);
    seen.add(k);
  }
  return out;
}

/**
 * Every other published field of a value still listed is what a reader
 * branches on: changing one the base gave it is a break, except a withdrawal
 * to a tombstone.
 */
function behaviourProblems(view: ValueView): string[] {
  const out: string[] = [];
  for (const [k, v] of view.after) {
    const self = view.before.get(k);
    if (self === undefined || v.kind === TOMBSTONE) continue;
    for (const [field, spec] of Object.entries(view.base.fields))
      if (
        !spec.identifies &&
        field !== "meaning" &&
        self[field] !== undefined &&
        self[field] !== (v[field] ?? null)
      )
        out.push(
          `the value ${view.show(v)} changed its ${field} from ${JSON.stringify(self[field])} to ${JSON.stringify(v[field] ?? null)}`,
        );
  }
  return out;
}

/** The meaning of a value still listed, taken by another. */
function meaningProblems(view: ValueView): string[] {
  const out: string[] = [];
  for (const [k, v] of view.after) {
    const self = view.before.get(k);
    if (self !== undefined && self.meaning === v.meaning) continue;
    // A value whose own identity is gone is reported gone, not here.
    for (const [other, w] of view.before)
      if (
        other !== k &&
        view.after.has(other) &&
        w.meaning === v.meaning &&
        w.meaning !== self?.meaning
      )
        out.push(
          `the value ${view.show(v)} now carries the meaning the base gives ${view.show(w)}`,
        );
  }
  return out;
}

function valueFindings(file: string, base: DataFile, now: DataFile) {
  const view = valueView(base, now);
  const remedy = `keep the value as the base lists it (withdraw it as a tombstone rather than reuse it), or raise the chapter's version in tools/protocol/chapters.ts (above ${base.version}) and mark its change note breaking`;
  return [
    ...identityProblems(view),
    ...behaviourProblems(view),
    ...meaningProblems(view),
  ].map((problem): Finding => ({ rule: RULE, file, problem, remedy }));
}

/** What breaks a promise a stable chapter of the base made. */
export function compareWithBase(input: BaseComparison): Finding[] {
  const out: Finding[] = [];
  for (const [id, base] of input.base) {
    if (base.status !== "stable") continue;
    const breaking = input.breaking.some((entry) => namesFile(entry, id));
    const now = input.data.get(id);
    out.push(
      ...(now === undefined
        ? removedFindings(id, base, input.withdrawn, breaking)
        : keptFindings(id, base, now, breaking)),
    );
  }
  return out;
}

/**
 * Whether a change-note entry names the chapter's file, `<id>.md`, as a
 * whole name: on its own or as a path's last part, so `exits.md` is not read
 * in `drive-exits.md`.
 */
export function namesFile(entry: string, id: string): boolean {
  const name = `${id}.md`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w.-])${name}(?![\\w-]|\\.\\w)`).test(entry);
}

const noteRemedy = (id: string) =>
  `a change note whose **Breaking:** entry names ${id}.md`;

/** A stable chapter the list no longer names: withdrawn at a raised version, with a breaking note, or a finding. */
function removedFindings(
  id: string,
  base: DataFile,
  withdrawn: readonly Withdrawn[],
  breaking: boolean,
): Finding[] {
  const entry = withdrawn.find((w) => w.id === id);
  if (
    entry === undefined ||
    !Number.isInteger(entry.version) ||
    entry.version <= base.version
  )
    return [
      {
        rule: RULE,
        file: chapterFile(id),
        problem: `the base lists ${id} as a stable chapter at version ${base.version}, and the chapter list no longer names it`,
        remedy: `restore its entry, or list it in WITHDRAWN in tools/protocol/chapters.ts at a version above ${base.version}, with ${noteRemedy(id)}`,
      },
    ];
  if (breaking) return [];
  return [
    {
      rule: RULE,
      file: chapterFile(id),
      problem: `the stable chapter ${id} is withdrawn with no change note marked breaking`,
      remedy: `add ${noteRemedy(id)}`,
    },
  ];
}

/** A stable chapter the list still names: what this change breaks of it without raising its version. */
function keptFindings(
  id: string,
  base: DataFile,
  now: DataFile,
  breaking: boolean,
): Finding[] {
  const file = dataFile(id);
  if (now.version < base.version)
    return [
      {
        rule: RULE,
        file,
        problem: `the chapter's version ${now.version} is below the base's ${base.version}`,
        remedy: `give it a version from ${base.version} in tools/protocol/chapters.ts`,
      },
    ];
  const raised = now.version > base.version;
  const out: Finding[] = [];
  if (now.status !== "stable" && !(raised && breaking))
    out.push({
      rule: RULE,
      file,
      problem: `the base lists ${id} as stable, and this change marks it ${now.status}`,
      remedy: `keep it stable, or raise its version in tools/protocol/chapters.ts (above ${base.version}) and add ${noteRemedy(id)}`,
    });
  const breaks = [
    ...fieldFindings(file, base, now),
    ...valueFindings(file, base, now),
  ];
  if (!raised) return [...out, ...breaks];
  if (breaks.length > 0 && !breaking)
    out.push({
      rule: RULE,
      file,
      problem: `this change breaks the stable chapter ${id} (${breaks.map((b) => b.problem).join("; ")}) with no change note marked breaking`,
      remedy: `add ${noteRemedy(id)}`,
    });
  return out;
}
