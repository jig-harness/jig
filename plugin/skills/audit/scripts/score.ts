#!/usr/bin/env bun
/**
 * Score the repository against every module's maturity criteria, as far as a
 * script can: each criterion with a probe is tested against the tracked
 * files, and one whose precondition is missing is scored `absent` with the
 * search as its evidence. Every other criterion is left for the agent, with
 * what the probes found as a hint.
 *
 * Usage (from anywhere inside the repository under audit):
 *   bun score.ts [--json]
 *       print the scoring checklist: one table per module, probe results
 *       filled in, Score and Evidence left for the agent
 *   bun score.ts --draft <file> [--prior <record>] [--date YYYY-MM-DD]
 *                [--at <rev>] [--profile <id>] [--conditions M12,M3]
 *                [--heading-to <id>] [--examine-all]
 *       write a draft audit record to <file>: decided scores filled, the rest
 *       `null` with the criterion, its bar and the prior answer as comments.
 *       The prior record defaults to .config/jig-audit.yaml when it exists;
 *       its declined recommendations are carried over. The checkout must
 *       match HEAD, or --at <rev> scores that commit instead, from a
 *       temporary worktree the whole audit reads: the draft names it and the
 *       command that removes it once the record is done. --profile
 *       (default: the prior record's, with its conditions and heading_to)
 *       leaves every criterion
 *       beyond the target `not-examined`: one above its module's target
 *       level, or in a module the profile does not target; a listed
 *       condition and the heading-to profile's targets count as targets, and
 *       a probe's `absent` stands. --examine-all leaves nothing unexamined.
 *       The draft's own profile: stays the prior record's (null without
 *       one): the team, not the audit, chooses it. So --profile naming
 *       another profile examines the prior record's targets too.
 *   bun score.ts --check
 *       check the criteria themselves: every module present, each with
 *       well-formed criteria. Needs no repository.
 *   --criteria <dir> reads the criteria from another directory.
 *
 * Exit codes: 0 done; 1 --check found a fault; 2 usage or an unreadable input.
 */
import {
  beyondTarget,
  examinedTargets,
  loadProfiles,
  type Profile,
  type Profiles,
  selectProfiles,
} from "./lib/profiles.ts";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { consumerRoot } from "../../../shared/consumer.ts";
import {
  CRITERIA_DIR,
  type Criterion,
  evaluateProbe,
  loadModules,
  type ProbeResult,
  MODULE_IDS,
  type Module,
  type Level,
  LEVELS,
  NOT_EXAMINED,
  probedFiles,
  type Rung,
  type Score,
} from "./lib/criteria.ts";
import {
  type AuditRecord,
  notExaminedEvidence,
  parseRecord,
  probeEvidence,
  RECORD_RELPATH,
  renderDraft,
} from "./lib/record.ts";
import { isDate, pluginVersion, run, today, trackedFiles } from "./lib/repo.ts";

const USAGE =
  "usage: score.ts [--json] | --draft <file> [--prior <record>] [--date YYYY-MM-DD] [--at <rev>] [--profile <id>] [--conditions M12,M3] [--heading-to <id>] [--examine-all] | --check   [--criteria <dir>]";

interface Args {
  mode: "checklist" | "draft" | "check";
  json: boolean;
  draft?: string;
  prior?: string;
  date?: string;
  /** The revision `--at` names, scored from a worktree of its own. */
  at?: string;
  profile?: string;
  conditions?: string[];
  headingTo?: string;
  examineAll: boolean;
  criteria: string;
}

/** The flags only a draft reads. */
const DRAFT_FLAGS = [
  "--prior",
  "--date",
  "--at",
  "--profile",
  "--conditions",
  "--heading-to",
  "--examine-all",
];

/** The flags that take no value, and what each sets. */
const SWITCHES: Record<string, (args: Args) => void> = {
  "--json": (a) => {
    a.json = true;
  },
  "--check": (a) => {
    a.mode = "check";
  },
  "--examine-all": (a) => {
    a.examineAll = true;
  },
};

/** The flags that take a value, and where each puts it. */
const VALUED: Record<string, (args: Args, value: string) => void> = {
  "--draft": (a, v) => {
    a.mode = "draft";
    a.draft = v;
  },
  "--prior": (a, v) => {
    a.prior = v;
  },
  "--date": (a, v) => {
    a.date = v;
  },
  "--at": (a, v) => {
    a.at = v;
  },
  "--profile": (a, v) => {
    a.profile = v;
  },
  "--conditions": (a, v) => {
    a.conditions = v
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
  },
  "--heading-to": (a, v) => {
    a.headingTo = v;
  },
  "--criteria": (a, v) => {
    a.criteria = v;
  },
};

/** Why parsed arguments do not hold together, or null. */
function argsFault(args: Args, argv: string[]): string | null {
  if (args.date !== undefined && !isDate(args.date))
    return "--date must be a calendar date, YYYY-MM-DD";
  if (args.mode === "draft") return null;
  const stray = DRAFT_FLAGS.find((f) => argv.includes(f));
  return stray === undefined ? null : `${stray} needs --draft`;
}

/**
 * Apply the flag at `argv[i]` to `args`; returns how many words it took, or
 * why it cannot be read.
 */
function applyFlag(args: Args, argv: string[], i: number): number | string {
  const arg = argv[i] ?? "";
  // Own keys only: `constructor` is no flag.
  if (Object.hasOwn(SWITCHES, arg)) {
    SWITCHES[arg]?.(args);
    return 1;
  }
  if (!Object.hasOwn(VALUED, arg)) return `unknown argument ${arg}`;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--"))
    return `${arg} needs a value`;
  VALUED[arg]?.(args, value);
  return 2;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: "checklist",
    json: false,
    examineAll: false,
    criteria: CRITERIA_DIR,
  };
  let fault: string | null = null;
  for (let i = 0; i < argv.length && fault === null; ) {
    const taken = applyFlag(args, argv, i);
    if (typeof taken === "string") fault = taken;
    else i += taken;
  }
  fault ??= argsFault(args, argv);
  if (fault !== null) throw new Error(fault);
  return args;
}

function check(modules: Module[]): number {
  let bad = false;
  for (const id of MODULE_IDS) {
    const module = modules.find((m) => m.module === id);
    if (!module) {
      console.log(`MISSING: ${id} has no criteria file`);
      bad = true;
    } else if (module.criteria.length === 0) {
      console.log(`EMPTY: ${id} (${module.file}) has no criteria`);
      bad = true;
    } else
      console.log(
        `ok: ${id} — ${module.criteria.length} criteria, ${module.criteria.filter((c) => c.probe).length} probed`,
      );
  }
  if (!bad)
    console.log(
      `All ${MODULE_IDS.length} modules (${MODULE_IDS.join(", ")}) carry well-formed criteria.`,
    );
  return bad ? 1 : 0;
}

interface Row {
  key: string;
  level: string;
  requires: string;
  /** `capped`: a probe a rung needs did not hold, and the criterion scores at most `atMost`. */
  probe: "absent" | "capped" | "found" | "unchecked" | null;
  evidence: string | null;
  atMost?: Rung;
}

/** A row's probe outcome, from what the probe found. */
function rowProbe(
  result: ProbeResult,
): Pick<Row, "probe" | "evidence" | "atMost"> {
  if (result.met === false)
    return { probe: "absent", evidence: result.evidence };
  if (result.atMost)
    return {
      probe: "capped",
      evidence: `${result.atMost.evidence}; at most ${result.atMost.rung}`,
      atMost: result.atMost.rung,
    };
  return {
    probe: result.met === null ? "unchecked" : "found",
    evidence: result.evidence,
  };
}

function evaluate(modules: Module[], root: string): Row[] {
  const files = probedFiles(trackedFiles(root));
  return modules.flatMap((m) =>
    m.criteria.map((c) => {
      const result = c.probe ? evaluateProbe(c.probe, files, root) : null;
      return {
        key: c.key,
        level: c.level,
        requires: c.requires,
        ...(result === null
          ? { probe: null, evidence: null }
          : rowProbe(result)),
      };
    }),
  );
}

/** Text safe inside a Markdown table cell. */
const cell = (text: string) => text.replace(/\|/g, "\\|");

/** One criterion's checklist row: the probe's result, and its score when it decided one. */
function checklistRow(c: Criterion, row?: Row): string {
  const absent = row?.probe === "absent";
  const probe = absent
    ? "not met"
    : row?.probe != null
      ? `${row.probe}: ${row.evidence}`
      : "";
  const score = absent ? "absent" : "";
  const evidence = absent ? probeEvidence(row.evidence ?? "") : "";
  return `| ${c.id} | ${c.level} | ${c.requires} | ${cell(probe)} | ${score} | ${cell(evidence)} |`;
}

function checklist(modules: Module[], rows: Row[]): string {
  const out = [
    "# Module scoring checklist",
    "",
    "For every criterion, record the observed rung (`absent`, `convention`,",
    "`advisory`, `mechanical`, or `expected-absent` where the repository's shape",
    "rules the practice out) with file-path evidence. A probe that found nothing",
    "has already scored its criterion `absent`; one marked `capped` found only what a",
    "higher rung needs missing, so score the criterion no higher than it says.",
    "A module attains a level when every",
    "criterion at that level and below meets its `requires` rung.",
    "",
  ];
  for (const m of modules)
    out.push(
      `## ${m.module} — ${m.name}`,
      "",
      "| Criterion | Level | Requires | Probe | Score | Evidence |",
      "|-----------|-------|----------|-------|-------|----------|",
      ...m.criteria.map((c) =>
        checklistRow(
          c,
          rows.find((r) => r.key === c.key),
        ),
      ),
      "",
    );
  return out.join("\n");
}

/** The prior record's path: the one `--prior` names, else the repository's own. */
function priorPathOf(args: Args, root: string): string {
  const path = args.prior ?? join(root, RECORD_RELPATH);
  return isAbsolute(path) ? path : resolve(path);
}

/**
 * Scores the probes decided (absent), the ceilings capped probes set, and
 * what the others saw as hints.
 */
function probeOutcomes(rows: Row[]): {
  decided: Map<string, { score: Score; evidence: string }>;
  ceilings: Map<string, Rung>;
  hints: Map<string, string>;
} {
  const decided = new Map<string, { score: Score; evidence: string }>();
  const ceilings = new Map<string, Rung>();
  const hints = new Map<string, string>();
  for (const row of rows) {
    if (row.atMost !== undefined) ceilings.set(row.key, row.atMost);
    if (row.probe === "absent")
      decided.set(row.key, {
        score: "absent",
        evidence: probeEvidence(row.evidence ?? ""),
      });
    else if (row.probe !== null && row.evidence)
      hints.set(row.key, `${row.probe}: ${row.evidence}`);
  }
  return { decided, ceilings, hints };
}

/** Whether two paths name one file: the same path, or a link to it. */
function sameFile(a: string, b: string): boolean {
  if (a === b) return true;
  if (!existsSync(a) || !existsSync(b)) return false;
  const [x, y] = [statSync(a), statSync(b)];
  return x.dev === y.dev && x.ino === y.ino;
}

/**
 * Why the checkout is not the commit a draft would name: tracked files
 * staged or changed since HEAD, which the probes would read instead. Null
 * when it matches.
 */
function uncommitted(root: string): string | null {
  const status = run("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: root,
  });
  if (status.code !== 0)
    return `cannot read the checkout's state: ${status.stderr.trim()}`;
  const changed = status.stdout.split("\n").filter(Boolean);
  if (changed.length === 0) return null;
  return `tracked files differ from HEAD (${changed
    .slice(0, 5)
    .map((l) => l.slice(3))
    .join(
      ", ",
    )}${changed.length > 5 ? ", …" : ""}): commit or stash them, or score the last commit as it stands with --at HEAD, so the draft describes the commit it names`;
}

/** What the draft leaves unexamined: every criterion beyond these targets. */
interface Scope {
  profile: Profile;
  /** The prior record's profile, when `--profile` names another: its targets are examined too. */
  declared?: Profile;
  targets: Map<string, Level>;
}

/**
 * The profile the draft is scoped to: the one `--profile` names, else the
 * prior record's, each with its conditions and heading-to profile. The draft
 * keeps the profile the prior record declares, and `record.ts check` wants
 * every criterion within that profile's targets scored, so another
 * `--profile` adds its targets to the declared profile's rather than
 * narrowing them. Null when there is none, or `--examine-all` asks for every
 * criterion.
 */
function draftScope(
  args: Args,
  prior: AuditRecord | null,
  profiles: Profiles,
): Scope | null | { error: string } {
  if (args.examineAll) return null;
  const selection = scopeSelection(args, prior);
  if (selection === null || "error" in selection) return selection;
  const chosen = selectProfiles(profiles, selection);
  if ("error" in chosen)
    return {
      error: `${chosen.error}${args.profile === undefined ? " (from the prior record; give --profile or --examine-all)" : ""}`,
    };
  const targets = examinedTargets(
    chosen.profile,
    selection.conditions,
    chosen.heading,
  );
  if (prior?.profile === undefined) return { profile: chosen.profile, targets };
  // The draft keeps every declaration the prior record makes, so its targets
  // stay examined even when `--conditions` or `--heading-to` names others.
  const declared = addDeclaredTargets(
    { ...prior, profile: prior.profile },
    profiles,
    targets,
  );
  if ("error" in declared) return declared;
  return prior.profile === selection.profile
    ? { profile: chosen.profile, targets }
    : { profile: chosen.profile, declared, targets };
}

/**
 * Add the targets of the profile the prior record declares to `targets`,
 * keeping the higher level per module; the declared profile, or why it
 * cannot be read.
 */
function addDeclaredTargets(
  prior: AuditRecord & { profile: string },
  profiles: Profiles,
  targets: Map<string, Level>,
): Profile | { error: string } {
  const declared = selectProfiles(profiles, {
    profile: prior.profile,
    conditions: prior.profile_conditions ?? [],
    ...(prior.heading_to === undefined ? {} : { heading_to: prior.heading_to }),
  });
  if ("error" in declared)
    return {
      error: `${declared.error} (the prior record's profile, which the draft keeps; give --examine-all)`,
    };
  for (const [m, l] of examinedTargets(
    declared.profile,
    prior.profile_conditions ?? [],
    declared.heading,
  )) {
    const own = targets.get(m);
    if (own === undefined || LEVELS.indexOf(l) > LEVELS.indexOf(own))
      targets.set(m, l);
  }
  return declared.profile;
}

/**
 * The profile, conditions and heading-to profile the flags name, filled from
 * the prior record's; another profile than the prior record's starts without
 * its conditions and heading-to profile.
 */
function scopeSelection(
  args: Args,
  prior: AuditRecord | null,
):
  | { profile: string; conditions: string[]; heading_to?: string }
  | null
  | { error: string } {
  const id = args.profile ?? prior?.profile;
  if (id === undefined)
    return args.conditions !== undefined || args.headingTo !== undefined
      ? { error: "--conditions and --heading-to need --profile" }
      : null;
  const inherited =
    args.profile === undefined || args.profile === prior?.profile
      ? prior
      : null;
  const headingTo = args.headingTo ?? inherited?.heading_to;
  return {
    profile: id,
    conditions: args.conditions ?? inherited?.profile_conditions ?? [],
    ...(headingTo === undefined ? {} : { heading_to: headingTo }),
  };
}

/** The profile, or profiles, whose targets a scope examines. */
const scopeName = (scope: Scope): string =>
  scope.declared === undefined
    ? scope.profile.name
    : `${scope.profile.name} and ${scope.declared.name}`;

/**
 * Leave every criterion beyond the scope's targets `not-examined`, except
 * one its probe decided: a missing precondition is a finding at any level.
 * Returns how many were left.
 */
function leaveUnexamined(
  modules: Module[],
  decided: Map<string, { score: Score; evidence: string }>,
  scope: Scope,
): number {
  let left = 0;
  for (const c of modules.flatMap((m) => m.criteria))
    if (!decided.has(c.key) && beyondTarget(c, scope.targets)) {
      decided.set(c.key, {
        score: NOT_EXAMINED,
        evidence: notExaminedEvidence(scopeName(scope)),
      });
      left++;
    }
  return left;
}

/**
 * A checkout of `commit` for the whole scoring run: a detached worktree in a
 * temporary folder, made without running the repository's hooks. The probes
 * read it, and so do the surveys after them, so it outlives this script;
 * the draft names it and how to remove it. Removed at once when the probes
 * cannot run on it.
 */
/** Remove a snapshot worktree and its registration. */
function dropSnapshot(root: string, dir: string): void {
  run("git", ["worktree", "remove", "--force", dir], { cwd: root });
  rmSync(dir, { recursive: true, force: true });
  run("git", ["worktree", "prune"], { cwd: root });
}

function snapshotAt(
  root: string,
  commit: string,
  modules: Module[],
): { dir: string; rows: Row[] } | { error: string } {
  const dir = mkdtempSync(join(tmpdir(), "jig-audit-at-"));
  const remove = () => dropSnapshot(root, dir);
  const add = run(
    "git",
    [
      "-c",
      `core.hooksPath=${dir}.no-hooks`,
      "worktree",
      "add",
      "--detach",
      "--quiet",
      dir,
      commit,
    ],
    { cwd: root, timeoutMs: 300_000 },
  );
  if (add.code !== 0) {
    remove();
    return { error: `cannot check out ${commit}: ${add.stderr.trim()}` };
  }
  try {
    return { dir, rows: evaluate(modules, dir) };
  } catch (error) {
    remove();
    throw error;
  }
}

/** The commit the draft names, the probes' rows, and the snapshot `--at` read them from. */
function audited(
  args: Args,
  modules: Module[],
  root: string,
): { commit: string; rows: Row[]; snapshot?: string } | { error: string } {
  if (args.at === undefined) {
    const dirty = uncommitted(root);
    if (dirty !== null) return { error: dirty };
    const head = run("git", ["rev-parse", "HEAD"], { cwd: root });
    if (head.code !== 0)
      return {
        error: `cannot read the audited commit: ${head.stderr.trim()}`,
      };
    return { commit: head.stdout.trim(), rows: evaluate(modules, root) };
  }
  const rev = run(
    "git",
    ["rev-parse", "--verify", "--quiet", `${args.at}^{commit}`],
    { cwd: root },
  );
  if (rev.code !== 0) return { error: `--at ${args.at}: no such commit` };
  const commit = rev.stdout.trim();
  const snapshot = snapshotAt(root, commit, modules);
  return "error" in snapshot
    ? snapshot
    : { commit, rows: snapshot.rows, snapshot: snapshot.dir };
}

/** How to remove the snapshot `--at` left for the scoring run. */
const removeSnapshot = (dir: string) => `git worktree remove --force ${dir}`;

/**
 * The prior record a draft carries over, or why the draft cannot be written:
 * it would overwrite the prior, or the prior `--prior` names is missing.
 */
function priorFor(
  args: Args,
  draftPath: string,
  root: string,
): { prior: AuditRecord | null } | { error: string } {
  const priorPath = priorPathOf(args, root);
  if (sameFile(draftPath, priorPath))
    return {
      error:
        "the draft must not overwrite the prior record: the comparison reads both",
    };
  const prior = existsSync(priorPath)
    ? parseRecord(readFileSync(priorPath, "utf8"), priorPath)
    : null;
  if (args.prior !== undefined && prior === null)
    return { error: `prior record not found: ${priorPath}` };
  return { prior };
}

/** The line that says what the draft holds. */
function draftLine(opts: {
  path: string;
  commit: string;
  probed: number;
  left: number;
  open: number;
  scope: Scope | null;
  prior: AuditRecord | null;
  snapshot?: string;
}): string {
  const unexamined =
    opts.scope === null
      ? ""
      : `, ${opts.left} left not examined beyond the ${scopeName(opts.scope)} target`;
  const prior = opts.prior
    ? `; prior record of ${opts.prior.date}`
    : "; no prior record";
  const line = `draft written: ${opts.path} (commit ${opts.commit.slice(0, 12)}; ${opts.probed} decided by probes${unexamined}, ${opts.open} to score${prior})`;
  return opts.snapshot === undefined
    ? line
    : `${line}\nsnapshot of ${opts.commit.slice(0, 12)}: ${opts.snapshot}\n  score every criterion from the files there, not the checkout's; when the record is done: ${removeSnapshot(opts.snapshot)}`;
}

/** What a draft is written from, or the first reason it cannot be. */
function draftInputs(
  args: Args,
  modules: Module[],
  root: string,
  draftPath: string,
) {
  const found = priorFor(args, draftPath, root);
  if ("error" in found) return found;
  const profiles = loadProfiles(modules);
  const scope = draftScope(args, found.prior, profiles);
  if (scope !== null && "error" in scope) return scope;
  const version = pluginVersion();
  if (version === null)
    return {
      error:
        "cannot read the plugin version: no plugin manifest beside this skill",
    };
  const read = audited(args, modules, root);
  if ("error" in read) return read;
  return { prior: found.prior, profiles, scope, version, ...read };
}

function writeDraft(args: Args, modules: Module[], root: string): number {
  const draftPath = resolve(args.draft ?? "");
  const inputs = draftInputs(args, modules, root, draftPath);
  if ("error" in inputs) {
    console.error(inputs.error);
    return 2;
  }
  const { prior, profiles, scope, version, commit, rows, snapshot } = inputs;
  const { decided, ceilings, hints } = probeOutcomes(rows);
  const probed = decided.size;
  const left = scope === null ? 0 : leaveUnexamined(modules, decided, scope);
  const header =
    snapshot === undefined
      ? ""
      : `# snapshot: ${snapshot}\n#   the commit this draft scores, checked out for the whole audit: read the\n#   files there, not the checkout's. Remove it once the record is done:\n#   ${removeSnapshot(snapshot)}\n`;
  try {
    writeFileSync(
      draftPath,
      header +
        renderDraft({
          modules,
          decided,
          hints,
          ceilings,
          prior,
          pluginVersion: version,
          date: args.date ?? today(),
          commit,
          profileIds: [...profiles.profiles.keys()],
        }),
    );
  } catch (error) {
    // The snapshot is kept only for a draft that names it.
    if (snapshot !== undefined) dropSnapshot(root, snapshot);
    console.error(
      `cannot write the draft ${draftPath}: ${error instanceof Error ? error.message : error}`,
    );
    return 2;
  }
  console.log(
    draftLine({
      path: draftPath,
      commit,
      probed,
      left,
      open: rows.length - decided.size,
      scope,
      prior,
      ...(snapshot === undefined ? {} : { snapshot }),
    }),
  );
  return 0;
}

export function main(argv = process.argv.slice(2)): number {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : e}\n${USAGE}`);
    return 2;
  }
  const modules = loadModules(args.criteria);
  if (args.mode === "check") return check(modules);

  const root = consumerRoot();
  if (args.mode === "draft") return writeDraft(args, modules, root);
  const rows = evaluate(modules, root);
  console.log(
    args.json ? JSON.stringify(rows, null, 2) : checklist(modules, rows),
  );
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
}
