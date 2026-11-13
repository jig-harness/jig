#!/usr/bin/env bun
/**
 * The Jig Protocol's generator and its gate (design/protocol.md § The
 * generator and its gate; ADR-0020).
 *
 * `bun tools/protocol/generate.ts` writes, from the chapter list
 * (`tools/protocol/chapters.ts`) and the code's own tables it imports, each
 * chapter's title, status line and generated sections in place between their
 * markers, leaving the prose alone; the index page's list of chapters; and
 * each chapter's data file under `plugin/protocol/data/`. `--stage` also
 * stages each file it changed, for the pre-commit hook.
 *
 * `--check` writes nothing. It fails, naming each file and section that
 * differs and the command that fixes it (data files are compared as parsed
 * JSON); it refuses a chapter file with no entry or an entry with no file, a
 * marker whose source is not the one the list names, a value with no
 * meaning, a value two chapters take, and a provisional chapter whose plan
 * item is not in design/plan.md or a stable one that names an item; and it
 * compares each chapter the integration branch holds as stable with that
 * branch's data file at the merge base (`base.ts`). `--base <ref>` names the
 * branch to compare with.
 *
 * Exit: 0 every chapter matches the code and keeps its promises; 1 a
 * finding; 2 a usage error, or the merge base cannot be read (the message
 * names the fetch that fixes it).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cli, strictOptions } from "../../lib/cli.ts";
import {
  couldNotCheck,
  type Finding,
  reportFindings,
} from "../../lib/findings.ts";
import {
  baseData,
  breakingEntries,
  compareWithBase,
  mergeBase,
} from "./base.ts";
import { type Chapter, COMMAND, type Withdrawn } from "./chapter.ts";
import { CHAPTERS, WITHDRAWN } from "./chapters.ts";
import { planOutputs, RULE, staleness } from "./outputs.ts";

export interface GenerateOptions {
  root: string;
  chapters?: readonly Chapter[];
  withdrawn?: readonly Withdrawn[];
  check: boolean;
  /** The branch a check compares with; null reads it as the changelog check does. */
  base?: string | null;
  env?: Record<string, string | undefined>;
}

export interface GenerateResult {
  findings: Finding[];
  /** Why the merge base could not be read, with the fetch that fixes it; null when it was read. */
  unreadable: string | null;
  /** The files a write changed, relative to the root. */
  written: string[];
  /** The merge base a check compared with. */
  comparedWith: string | null;
}

/** Write or check every chapter; reports nothing itself. */
export function generate(options: GenerateOptions): GenerateResult {
  const chapters = options.chapters ?? CHAPTERS;
  const { root } = options;
  const plan = planOutputs(root, chapters);
  const findings = [...plan.findings];
  const written: string[] = [];
  if (!options.check) {
    for (const output of plan.outputs) {
      if (!staleness(root, output).length) continue;
      const full = join(root, output.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, output.text);
      written.push(output.path);
    }
    return { findings, unreadable: null, written, comparedWith: null };
  }
  for (const output of plan.outputs)
    for (const part of staleness(root, output))
      findings.push({
        rule: RULE,
        file: output.path,
        problem: part,
        remedy: `run ${COMMAND}`,
      });
  const base = mergeBase(root, options.base ?? null, options.env);
  if (!base.ok)
    return { findings, unreadable: base.reason, written, comparedWith: null };
  const atBase = baseData(root, base.commit);
  if (!atBase.ok)
    return { findings, unreadable: atBase.reason, written, comparedWith: null };
  findings.push(
    ...atBase.findings,
    ...compareWithBase({
      base: atBase.data,
      chapters,
      data: plan.data,
      withdrawn: options.withdrawn ?? WITHDRAWN,
      breaking: atBase.data.size ? breakingEntries(root, base.commit) : [],
    }),
  );
  return {
    findings,
    unreadable: null,
    written,
    comparedWith: `${base.commit.slice(0, 12)} (the merge base with ${base.ref})`,
  };
}

/**
 * Stage the files a write changed, in the index the running commit uses: the
 * environment is passed on whole, since a pre-commit hook's git names that
 * index in it.
 */
export function stage(
  root: string,
  files: readonly string[],
  env: Record<string, string | undefined> = process.env,
): number {
  if (!files.length) return 0;
  const result = Bun.spawnSync(["git", "-C", root, "add", "--", ...files], {
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  return result.exitCode === 0 ? 0 : 2;
}

const USAGE = "usage: generate.ts [--check [--base <ref>] | --stage]";

interface Command {
  check: boolean;
  stage: boolean;
  base: string | null;
}

/** The command line read, or why it is refused. */
function parse(args: string[]): Command | string {
  const { values } = strictOptions(
    {
      args,
      options: {
        check: { type: "boolean" },
        stage: { type: "boolean" },
        base: { type: "string" },
      },
    },
    USAGE,
  );
  const check = values.check === true;
  const stage = values.stage === true;
  if (stage && check) return "--stage writes; --check does not";
  if (values.base !== undefined && !check)
    return "--base is read only by --check";
  return { check, stage, base: values.base ?? null };
}

/** A write's report: each file written, staged when asked. */
function reportWrite(
  root: string,
  result: GenerateResult,
  staging: boolean,
): number {
  for (const file of result.written) console.log(`protocol: wrote ${file}`);
  if (staging && stage(root, result.written) !== 0) return 2;
  return result.findings.length ? 1 : 0;
}

/** A check's verdict: a finding fails it, an unread merge base could not check. */
function reportCheck(result: GenerateResult): number {
  if (result.unreadable !== null) {
    const status = couldNotCheck("protocol", result.unreadable);
    return result.findings.length ? 1 : status;
  }
  if (result.findings.length) return 1;
  console.log(
    `protocol: every chapter matches the code, and every stable chapter keeps its promises against ${result.comparedWith}`,
  );
  return 0;
}

function main(args: string[]): number {
  const command = parse(args);
  if (typeof command === "string") {
    console.error(`${command}\n${USAGE}`);
    return 2;
  }
  const root = join(import.meta.dir, "..", "..");
  const result = generate({
    root,
    check: command.check,
    base: command.base,
  });
  reportFindings(result.findings);
  return command.check
    ? reportCheck(result)
    : reportWrite(root, result, command.stage);
}

if (import.meta.main) cli(() => main(process.argv.slice(2)));
