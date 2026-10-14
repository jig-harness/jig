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
 *       write a draft audit record to <file>: decided scores filled, the rest
 *       `null` with the criterion, its bar and the prior answer as comments.
 *       The prior record defaults to .config/jig-audit.yaml when it exists;
 *       its declined recommendations are carried over.
 *   bun score.ts --check
 *       check the criteria themselves: all 14 modules present, each with
 *       well-formed criteria. Needs no repository.
 *   --criteria <dir> reads the criteria from another directory.
 *
 * Exit codes: 0 done; 1 --check found a fault; 2 usage or an unreadable input.
 */
import { loadProfiles } from "./lib/profiles.ts";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { consumerRoot } from "../../resolve-review-comments/scripts/lib/consumer.ts";
import {
  CRITERIA_DIR,
  type Criterion,
  evaluateProbe,
  loadModules,
  MODULE_COUNT,
  type Module,
  probedFiles,
  type Score,
} from "./lib/criteria.ts";
import {
  parseRecord,
  probeEvidence,
  RECORD_RELPATH,
  renderDraft,
} from "./lib/record.ts";
import { isDate, pluginVersion, run, today, trackedFiles } from "./lib/repo.ts";

const USAGE =
  "usage: score.ts [--json] | --draft <file> [--prior <record>] [--date YYYY-MM-DD] | --check   [--criteria <dir>]";

interface Args {
  mode: "checklist" | "draft" | "check";
  json: boolean;
  draft?: string;
  prior?: string;
  date?: string;
  criteria: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: "checklist", json: false, criteria: CRITERIA_DIR };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--"))
        throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--json") args.json = true;
    else if (arg === "--check") args.mode = "check";
    else if (arg === "--draft") {
      args.mode = "draft";
      args.draft = value();
    } else if (arg === "--prior") args.prior = value();
    else if (arg === "--date") args.date = value();
    else if (arg === "--criteria") args.criteria = value();
    else throw new Error(`unknown argument ${arg}`);
  }
  if (args.date !== undefined && !isDate(args.date))
    throw new Error("--date must be a calendar date, YYYY-MM-DD");
  return args;
}

function check(modules: Module[]): number {
  let bad = false;
  for (let n = 0; n < MODULE_COUNT; n++) {
    const module = modules.find((m) => m.module === `M${n}`);
    if (!module) {
      console.log(`MISSING: M${n} has no criteria file`);
      bad = true;
    } else if (module.criteria.length === 0) {
      console.log(`EMPTY: M${n} (${module.file}) has no criteria`);
      bad = true;
    } else
      console.log(
        `ok: M${n} — ${module.criteria.length} criteria, ${module.criteria.filter((c) => c.probe).length} probed`,
      );
  }
  if (!bad)
    console.log(
      `All ${MODULE_COUNT} modules (M0–M${MODULE_COUNT - 1}) carry well-formed criteria.`,
    );
  return bad ? 1 : 0;
}

interface Row {
  key: string;
  level: string;
  requires: string;
  probe: "absent" | "found" | "unchecked" | null;
  evidence: string | null;
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
        probe:
          result === null
            ? null
            : result.met === null
              ? "unchecked"
              : result.met
                ? "found"
                : "absent",
        evidence: result?.evidence ?? null,
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
    : row?.probe === "found" || row?.probe === "unchecked"
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
    "has already scored its criterion `absent`. A module attains a level when every",
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

/** Scores the probes decided (absent), and what the others saw as hints. */
function probeOutcomes(rows: Row[]): {
  decided: Map<string, { score: Score; evidence: string }>;
  hints: Map<string, string>;
} {
  const decided = new Map<string, { score: Score; evidence: string }>();
  const hints = new Map<string, string>();
  for (const row of rows) {
    if (row.probe === "absent")
      decided.set(row.key, {
        score: "absent",
        evidence: probeEvidence(row.evidence ?? ""),
      });
    else if (row.probe !== null && row.evidence)
      hints.set(row.key, `${row.probe}: ${row.evidence}`);
  }
  return { decided, hints };
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
    )}${changed.length > 5 ? ", …" : ""}): commit or stash them, so the draft describes the commit it names`;
}

function writeDraft(
  args: Args,
  modules: Module[],
  rows: Row[],
  root: string,
): number {
  const draftPath = resolve(args.draft ?? "");
  const priorPath = priorPathOf(args, root);
  if (sameFile(draftPath, priorPath)) {
    console.error(
      "the draft must not overwrite the prior record: the comparison reads both",
    );
    return 2;
  }
  const prior = existsSync(priorPath)
    ? parseRecord(readFileSync(priorPath, "utf8"), priorPath)
    : null;
  if (args.prior !== undefined && prior === null) {
    console.error(`prior record not found: ${priorPath}`);
    return 2;
  }
  const dirty = uncommitted(root);
  if (dirty !== null) {
    console.error(dirty);
    return 2;
  }
  const head = run("git", ["rev-parse", "HEAD"], { cwd: root });
  if (head.code !== 0) {
    console.error(`cannot read the audited commit: ${head.stderr.trim()}`);
    return 2;
  }
  const version = pluginVersion();
  if (version === null) {
    console.error(
      "cannot read the plugin version: no plugin manifest beside this skill",
    );
    return 2;
  }
  const { decided, hints } = probeOutcomes(rows);
  writeFileSync(
    draftPath,
    renderDraft({
      modules,
      decided,
      hints,
      prior,
      pluginVersion: version,
      date: args.date ?? today(),
      commit: head.stdout.trim(),
      profileIds: [...loadProfiles(modules).profiles.keys()],
    }),
  );
  const open = rows.length - decided.size;
  console.log(
    `draft written: ${draftPath} (${decided.size} decided by probes, ${open} to score${prior ? `; prior record of ${prior.date}` : "; no prior record"})`,
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
  const rows = evaluate(modules, root);
  if (args.mode === "draft") return writeDraft(args, modules, rows, root);
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
