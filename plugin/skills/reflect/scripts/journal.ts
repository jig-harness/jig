#!/usr/bin/env bun
/**
 * Capture findings in the worktree's journal.
 *
 * Usage:
 *   bun journal.ts note [--skill <name>] [--fact <text>]...   # finding on stdin
 *   bun journal.ts revise <id>                                # fields on stdin
 *   bun journal.ts drop <id> --reason <text> [--merged-into <id>]
 *   bun journal.ts unsent
 *   bun journal.ts park
 *   bun journal.ts path
 *
 * `note` reads one finding as JSON (kind, severity, class, target, title,
 * description, suggested_fix; optionally time_cost_minutes, change fields,
 * and the session fields the agent states: model, skills, harness, mode) and
 * fills in the id, time, repository, branch and the measured session. A skill
 * that writes a finding itself passes `--skill`. `--fact` (repeatable) gives
 * a finding about a fact that can recur an id derived from it, so noting it
 * again changes nothing; the repository is part of the fact already, so name
 * the change in it.
 *
 * `park` moves the unsent findings to `~/.jig/pending/` (under `JIG_HOME`)
 * for a worktree about to be removed; the next `reflect` in any worktree of
 * the repository picks them up. A removal hook refuses the removal when it
 * fails.
 *
 * When reflection is off every operation but `park` does nothing, says so
 * on stderr and exits 0, so a caller never needs to check the switch first.
 * `park` still runs, on the journal the section still names beside
 * `enabled: false` and on the default otherwise: findings noted while
 * reflection was on must not vanish with the worktree.
 *
 * Exit codes: 0 done (or reflection off); 1 failed; 2 usage.
 */
import { fail, readStdinAll, runMain } from "../../../shared/cli.ts";
import { chooseOperation, last, type ParsedArgs } from "./lib/args.ts";
import { journalPath, repositoryId } from "./lib/context.ts";
import { parseObject } from "./lib/events.ts";
import {
  buildFinding,
  dropFinding,
  noteFinding,
  park,
  readJournal,
  reviseFinding,
  unsent,
} from "./lib/journal.ts";
import { reflectionSettings } from "./lib/settings.ts";

const USAGE = `usage:
  journal.ts note [--skill <name>] [--fact <text>]...   (finding JSON on stdin)
  journal.ts revise <id>                                (fields JSON on stdin)
  journal.ts drop <id> --reason <text> [--merged-into <id>]
  journal.ts unsent
  journal.ts park
  journal.ts path`;

async function readJson(): Promise<Record<string, unknown>> {
  return parseObject((await readStdinAll()).trim(), "stdin");
}

interface Operation {
  options: string[];
  /** How many positional arguments it takes. */
  positional: number;
  run(path: string, args: ParsedArgs): Promise<unknown> | unknown;
  /**
   * Runs with reflection off too: findings noted while it was on must not
   * vanish with a removed worktree.
   */
  whenOff?: boolean;
}

const OPERATIONS: Record<string, Operation> = {
  note: {
    options: ["skill", "fact"],
    positional: 0,
    async run(path, args) {
      const finding = buildFinding(await readJson(), {
        scriptDir: import.meta.dir,
        skill: last(args, "skill"),
        fact: args.values.get("fact"),
      });
      return { id: finding.id, noted: noteFinding(path, finding) };
    },
  },
  revise: {
    options: [],
    positional: 1,
    async run(path, args) {
      return reviseFinding(
        path,
        args.positional[0] as string,
        await readJson(),
      );
    },
  },
  drop: {
    options: ["reason", "merged-into"],
    positional: 1,
    run(path, args) {
      const id = args.positional[0] as string;
      const reason = last(args, "reason");
      if (reason === undefined) fail(2, "drop needs --reason", USAGE);
      dropFinding(path, id, reason, last(args, "merged-into"));
      return { id, dropped: true };
    },
  },
  unsent: {
    options: [],
    positional: 0,
    run(path) {
      for (const finding of unsent(readJournal(path)))
        process.stdout.write(`${JSON.stringify(finding)}\n`);
      return undefined;
    },
  },
  park: {
    options: [],
    positional: 0,
    whenOff: true,
    run(path) {
      const result = park(path, repositoryId());
      return { parked: result.count, file: result.file };
    },
  },
  path: { options: [], positional: 0, run: (path) => path },
};

export async function main(argv: string[]): Promise<number> {
  const { operation, args } = chooseOperation(argv, OPERATIONS, USAGE);
  const settings = reflectionSettings();
  if (!settings.on && operation.whenOff !== true) {
    console.error(
      "reflection is off: nothing recorded (see the reflection section of the Jig configuration)",
    );
    return 0;
  }
  const out = await operation.run(journalPath(settings.journal ?? null), args);
  if (typeof out === "string") console.log(out);
  else if (out !== undefined) console.log(JSON.stringify(out));
  return 0;
}

if (import.meta.main) runMain("journal.ts", () => main(process.argv.slice(2)));
