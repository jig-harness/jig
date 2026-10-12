#!/usr/bin/env bun
/**
 * Read audit records (`.config/jig-audit.yaml`): check one before it is
 * committed, compare a new one with the prior, summarise the levels one
 * attains, and set several repositories' records side by side.
 *
 * Usage (from anywhere inside the repository; <record> defaults to
 * .config/jig-audit.yaml):
 *   bun record.ts check [<record>]
 *       every criterion scored with evidence, every key a current criterion
 *   bun record.ts compare <prior> <current> [--json] [--date YYYY-MM-DD]
 *       fixed, regressed, still open, new, added by Jig since the prior
 *       audit's plugin version, removed; configuration fields added since;
 *       each declined recommendation held, due, resolved or stale; refuses
 *       a current record that check finds incomplete
 *   bun record.ts summary [<record>]
 *       the level each module attains
 *   bun record.ts portfolio <name>=<record> <name>=<record> ...
 *       levels and scores of several repositories, side by side
 *
 * Exit codes: 0 done; 1 check (or compare, for the current record) found the
 * record unfit to commit; 2 usage or
 * an unreadable record.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { consumerRoot } from "../../resolve-review-comments/scripts/lib/consumer.ts";
import { attained, loadModules, type Module } from "./lib/criteria.ts";
import {
  type AuditRecord,
  checkRecord,
  compare,
  parseRecord,
  RECORD_RELPATH,
  renderComparison,
  renderPortfolio,
  scoresOf,
} from "./lib/record.ts";
import { isDate, today } from "./lib/repo.ts";
import { loadSchema } from "./lib/schema.ts";

const USAGE = `usage:
  record.ts check [<record>]
  record.ts compare <prior> <current> [--json] [--date YYYY-MM-DD]
  record.ts summary [<record>]
  record.ts portfolio <name>=<record> ...`;

function read(path: string): AuditRecord {
  return parseRecord(readFileSync(path, "utf8"), path);
}

function defaultRecord(): string {
  return join(consumerRoot(), RECORD_RELPATH);
}

/** One subcommand's input: its words, its flags and the current criteria. */
interface Invocation {
  positional: string[];
  json: boolean;
  date: string;
  modules: Module[];
  usage: (why: string) => number;
}

function checkCommand({ positional, modules, usage }: Invocation): number {
  if (positional.length > 1) return usage("check takes one record");
  const record = read(positional[0] ?? defaultRecord());
  const problems = checkRecord(record, modules);
  for (const p of problems) console.log(`- ${p}`);
  console.log(
    problems.length === 0
      ? `record complete: ${record.criteria.size} criteria scored, ${record.declined.length} declined`
      : `${problems.length} problem(s): fill or fix them before committing the record`,
  );
  return problems.length === 0 ? 0 : 1;
}

function compareCommand(inv: Invocation): number {
  if (inv.positional.length !== 2)
    return inv.usage("compare takes two records");
  const [priorPath, currentPath] = inv.positional as [string, string];
  const prior = read(priorPath);
  const current = read(currentPath);
  // A criterion missing from the new record would drop out of the changes
  // unseen, so the comparison waits until the record is complete.
  const problems = checkRecord(current, inv.modules);
  if (problems.length > 0) {
    for (const p of problems) console.error(`- ${p}`);
    console.error(
      `${currentPath} is incomplete: complete it (record.ts check) before comparing`,
    );
    return 1;
  }
  const result = compare(prior, current, inv.modules, loadSchema(), inv.date);
  console.log(
    inv.json
      ? JSON.stringify(result, null, 2)
      : renderComparison(result, prior),
  );
  return 0;
}

function summaryCommand({ positional, modules, usage }: Invocation): number {
  if (positional.length > 1) return usage("summary takes one record");
  const record = read(positional[0] ?? defaultRecord());
  const scores = scoresOf(record);
  console.log(
    `| Module | Level attained |\n|--------|----------------|\n${modules
      .map(
        (m) =>
          `| ${m.module} ${m.name} | ${attained(m, scores) ?? "incomplete"} |`,
      )
      .join("\n")}`,
  );
  return 0;
}

function portfolioCommand({ positional, modules, usage }: Invocation): number {
  if (positional.length < 2)
    return usage("portfolio compares two or more records");
  const records = positional.map((arg) => {
    const at = arg.indexOf("=");
    if (at <= 0) throw new Error(`${arg}: write <name>=<record>`);
    return { name: arg.slice(0, at), record: read(arg.slice(at + 1)) };
  });
  console.log(renderPortfolio(records, modules));
  return 0;
}

const COMMANDS = new Map<string, (inv: Invocation) => number>([
  ["check", checkCommand],
  ["compare", compareCommand],
  ["summary", summaryCommand],
  ["portfolio", portfolioCommand],
]);

export function main(argv = process.argv.slice(2)): number {
  const [op, ...rest] = argv;
  const json = rest.includes("--json");
  const dateAt = rest.indexOf("--date");
  const date = dateAt >= 0 ? rest[dateAt + 1] : today();
  const positional = rest.filter(
    (a, i) => !a.startsWith("--") && !(dateAt >= 0 && i === dateAt + 1),
  );
  const usage = (why: string) => {
    console.error(`${why}\n${USAGE}`);
    return 2;
  };
  if (date === undefined || !isDate(date))
    return usage("--date must be a calendar date, YYYY-MM-DD");
  const modules = loadModules();
  const command = op === undefined ? undefined : COMMANDS.get(op);
  if (command === undefined)
    return usage(
      op === undefined ? "missing command" : `unknown command ${op}`,
    );
  return command({ positional, json, date, modules, usage });
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
}
