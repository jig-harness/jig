#!/usr/bin/env bun
/**
 * Check and preview a priorities change without making one: validate a
 * `priorities/v1` record, read the host's lane weights, show how a proposed
 * record or weights file would change the dispatcher's newest shortlist, and
 * ask `work-batch`'s eligibility mode which issues may be batched.
 *
 * It never launches work, never writes the tracker and never edits a
 * tracker Priority: every subcommand only reads and prints.
 *
 * Usage:
 *     bun priorities.ts validate [--file <path>]
 *     bun priorities.ts weights [--file <path>]
 *     bun priorities.ts shortlist [--repo owner/name] [--record <path>] [--weights <path>] [--json]
 *     bun priorities.ts batchable --issues <file.json>
 *
 * Exit codes: 0 done (a valid record, a shortlist or a diff printed);
 * 1 an invalid record or weights file, or an unreadable state database;
 * 2 usage.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ExitError, runMain } from "../../../shared/cli.ts";
import {
  laneShares,
  WEIGHTED_LANES,
} from "../../../shared/priorities/lanes.ts";
import {
  parsePrioritiesRecord,
  PRIORITIES_FILE,
  type PrioritiesRecord,
  referenceProblems,
} from "../../../shared/priorities/record.ts";
import { rank, type RankerOutput } from "../../../shared/priorities/ranker.ts";
import {
  readLaneWeights,
  weightsFilePath,
} from "../../../shared/priorities/weights.ts";
import { latestRanking } from "../../../dispatch/lib/allocation-store.ts";
import { readOnlyStateDb } from "../../../dispatch/lib/state.ts";
import { shortlistDiff, type ShortlistDiff } from "./lib/diff.ts";

const USAGE = [
  "usage: priorities.ts validate [--file <path>]",
  "       priorities.ts weights [--file <path>]",
  "       priorities.ts shortlist [--repo owner/name] [--record <path>] [--weights <path>] [--json]",
  "       priorities.ts batchable --issues <file.json>",
].join("\n");

function usage(message?: string): never {
  console.error(message === undefined ? USAGE : `${message}\n${USAGE}`);
  throw new ExitError(2, message ?? "usage");
}

/** The `--name value` options and bare flags after the subcommand; anything else is a usage error. */
function options(
  args: string[],
  valued: string[],
  flags: string[] = [],
): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const name = arg.replace(/^--/, "");
    if (!arg.startsWith("--")) usage(`unexpected argument ${arg}`);
    if (flags.includes(name)) out.set(name, "true");
    else if (valued.includes(name)) {
      const value = args[++i];
      if (value === undefined || value.startsWith("--"))
        usage(`--${name} needs a value`);
      out.set(name, value);
    } else usage(`unknown option ${arg}`);
  }
  return out;
}

/**
 * Read and validate a record file: the record and its notes, or every
 * problem found. A reference to another level's objective resolves only
 * where that level's record is read with it (the site's on the hub), so it
 * is a note here, never a problem: a host never requires the site level.
 */
function readRecord(
  file: string,
): { record: PrioritiesRecord; notes: string[] } | { problems: string[] } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return {
      problems: [`${file} cannot be read: ${(error as Error).message}`],
    };
  }
  const parsed = parsePrioritiesRecord(text, file);
  if (!parsed.ok) return { problems: [parsed.failure.reason] };
  const record = parsed.value;
  const own = `${record.level}:${record.scope}:`;
  const problems: string[] = [];
  const notes: string[] = [];
  for (const p of referenceProblems([record]))
    if (
      p.includes("which no record read holds") &&
      !p.includes(` references ${own}`)
    )
      notes.push(p);
    else problems.push(p);
  return problems.length > 0 ? { problems } : { record, notes };
}

function validate(args: string[]): number {
  const file = resolve(options(args, ["file"]).get("file") ?? PRIORITIES_FILE);
  const read = readRecord(file);
  if ("problems" in read) {
    console.log(`${file} is not a valid priorities/v1 record:`);
    for (const p of read.problems) console.log(`  - ${p}`);
    return 1;
  }
  const { record, notes } = read;
  for (const n of notes)
    console.log(`  note: ${n}; it resolves where that record is read`);
  console.log(
    `${file}: valid priorities/v1 record, ${record.level} level, scope ${record.scope}, revision ${record.revision}, ${record.objectives.length} objective(s)`,
  );
  return 0;
}

function weights(args: string[]): number {
  const file = options(args, ["file"]).get("file") ?? weightsFilePath();
  const read = readLaneWeights(resolve(file));
  const shares = laneShares(read.weights);
  console.log(`lane weights from ${read.source}:`);
  for (const lane of WEIGHTED_LANES) {
    const w = read.weights[lane];
    console.log(
      `  ${lane}: ${w === null ? "out of rotation (invalid entry)" : w === 0 ? "0, out of rotation" : w} share ${Math.round(shares[lane] * 1000) / 10}%`,
    );
  }
  for (const p of read.problems) console.log(`  problem: ${p}`);
  return read.problems.length > 0 ? 1 : 0;
}

/** The repository's `owner/name` from its `origin` remote, or `null`. */
function originRepo(): string | null {
  const out = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (out.exitCode !== 0) {
    const tail = out.stderr.toString().trim().split("\n").slice(-1)[0] ?? "";
    console.error(`no origin remote to name the repository by: ${tail}`);
    return null;
  }
  const url = out.stdout.toString().trim();
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url);
  return match?.[1] ?? null;
}

function shortlist(args: string[]): number {
  const opts = options(args, ["repo", "record", "weights"], ["json"]);
  const repo = opts.get("repo") ?? originRepo();
  if (repo === null)
    usage("no --repo given and no origin remote to derive it from");
  const opened = readOnlyStateDb();
  if (!opened.ok) {
    console.error(
      `the dispatcher's state database cannot be read: ${opened.failure.reason}`,
    );
    return 1;
  }
  const ro = opened.value;
  let ranking: ReturnType<typeof latestRanking> = null;
  try {
    ranking = ro === null ? null : latestRanking(ro.db, repo);
  } finally {
    ro?.db.close();
  }
  if (ranking === null) {
    console.log(
      `no dispatcher ranking for ${repo} on this host: the dispatcher has not ranked it yet, so there is no shortlist to compare against`,
    );
    return 0;
  }
  const input = structuredClone(ranking.input);
  const recordFile = opts.get("record");
  if (recordFile !== undefined) {
    const read = readRecord(resolve(recordFile));
    if ("problems" in read) {
      console.log(`${recordFile} is not a valid priorities/v1 record:`);
      for (const p of read.problems) console.log(`  - ${p}`);
      return 1;
    }
    input.records = [
      read.record,
      ...input.records.filter((r) => r.level !== read.record.level),
    ];
    input.allocationBlocked = null;
  }
  const weightsFile = opts.get("weights");
  if (weightsFile !== undefined)
    input.weights = readLaneWeights(resolve(weightsFile));
  const proposed = rank(input);
  const diff = shortlistDiff(ranking.output, proposed);
  if (opts.has("json")) {
    console.log(
      JSON.stringify(
        {
          repo,
          rankedAtMs: ranking.atMs,
          current: ranking.output.inputHash,
          proposed: proposed.inputHash,
          diff,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  printDiff(repo, ranking.output, proposed, diff);
  return 0;
}

function printDiff(
  repo: string,
  current: RankerOutput,
  proposed: RankerOutput,
  diff: ShortlistDiff,
): void {
  console.log(
    `shortlist for ${repo}: current ${current.inputHash}, proposed ${proposed.inputHash}`,
  );
  if (diff.unchanged)
    console.log("  the proposed change leaves the shortlist as it is");
  for (const a of diff.added)
    console.log(`  + ${a.position}. ${a.key} (${a.lane}): ${a.reason}`);
  for (const r of diff.removed)
    console.log(`  - ${r.key} (${r.lane}), was ${r.position}`);
  for (const m of diff.moved)
    console.log(
      `  ~ ${m.key}: ${m.from} -> ${m.to}${m.lane === undefined ? "" : ` (${m.lane})`}`,
    );
  for (const s of diff.shares)
    console.log(`  share ${s.lane}: ${s.from} -> ${s.to}`);
  for (const p of proposed.problems) console.log(`  problem: ${p}`);
}

async function batchable(args: string[]): Promise<number> {
  const file = options(args, ["issues"]).get("issues");
  if (file === undefined) usage("batchable needs --issues <file.json>");
  let issues: string;
  try {
    issues = readFileSync(resolve(file), "utf8");
  } catch (error) {
    usage(`${file} cannot be read: ${(error as Error).message}`);
  }
  // The batching rules are work-batch's own: ask its eligibility mode, never copy them.
  const script = join(
    import.meta.dir,
    "..",
    "..",
    "work-batch",
    "scripts",
    "candidates.ts",
  );
  const child = Bun.spawn([process.execPath, script, "--eligibility"], {
    stdin: new TextEncoder().encode(issues),
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "validate":
      return validate(rest);
    case "weights":
      return weights(rest);
    case "shortlist":
      return shortlist(rest);
    case "batchable":
      return batchable(rest);
    default:
      return usage(
        command === undefined ? undefined : `unknown subcommand ${command}`,
      );
  }
}

runMain("jig-priorities", main);
