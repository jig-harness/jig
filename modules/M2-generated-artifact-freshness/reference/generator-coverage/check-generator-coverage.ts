#!/usr/bin/env bun
// Generator coverage (module M2): the inputs a generator reads are the
// inputs that exist.
//
// The problem it closes. A freshness check proves only that the committed
// artifact equals what the generator writes. An input the generator never
// reads (a route it does not mount, a migration outside its list, a module
// its roster omits) is invisible to that check: the artifact is fresh and
// incomplete at once, and nothing fails. So each generator that selects its
// inputs by a list it maintains gets a second check, over the lists: the set
// of inputs that exist equals the set the generator reaches.
//
// Input. Two name lists, one name per line: the inputs that exist, as
// enumerated from where they live (a directory listing, a grep over the
// application's registrations), and the inputs the generator reads, as
// enumerated from its own list. `#` at the start of a line or after
// whitespace starts a comment, so a name may contain one; blank lines and
// surrounding whitespace are ignored, a name listed twice counts once. One
// of the two may be `-` for standard input. The enumerations are the
// caller's: the gate compares and does not guess what either should be.
//
// Findings. An input that exists but is not reached (the artifact silently
// omits it), and a name the generator reads that no longer exists (a stale
// entry, which hides the next omission among the noise). Every finding is
// reported, not only the first.
//
// Exit codes: 0 the two sets are equal; 1 a finding; 2 a list cannot be
// read, or holds no name: an enumeration that found nothing is a wrong
// path, not a generator without inputs.
//
// Usage: check-generator-coverage.ts [--generator <name>] <existing> <reached>
import { readFileSync } from "node:fs";
import { cli } from "../../../../lib/cli.ts";
import { readRegularFile } from "../../../../lib/files.ts";
import {
  couldNotCheck,
  type Finding,
  reportFindings,
} from "../../../../lib/findings.ts";

/** An argument this check was given that it cannot use. */
export class InputError extends Error {}

const usage =
  "usage: check-generator-coverage.ts [--generator <name>] <existing> <reached>";
const RULE = "generator-coverage";

/** The distinct names of a list: one per line, comments (`#` at the start
 * or after whitespace) and blank lines dropped. */
export function parseNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const raw of text.split("\n")) {
    const name = raw.replace(/(^|\s)#.*/, "").trim();
    if (name) names.add(name);
  }
  return names;
}

/** What differs between the inputs that exist and the inputs the generator reaches. */
export function coverageFindings(
  existing: Set<string>,
  reached: Set<string>,
  generator: string,
): Finding[] {
  const findings: Finding[] = [];
  for (const name of [...existing].sort())
    if (!reached.has(name))
      findings.push({
        rule: RULE,
        problem: `${generator} does not reach the input "${name}": its output omits it and the freshness check cannot tell`,
        remedy: `add "${name}" to the inputs ${generator} reads, or retire the input`,
      });
  for (const name of [...reached].sort())
    if (!existing.has(name))
      findings.push({
        rule: RULE,
        problem: `${generator} reads the input "${name}", which does not exist`,
        remedy: `remove "${name}" from the inputs ${generator} reads, or restore the input`,
      });
  return findings;
}

function readList(path: string, stdin: () => string): string {
  return path === "-" ? stdin() : readRegularFile(path);
}

/** The distinct names of one list, or why it cannot be checked. */
function readNames(
  what: string,
  path: string,
  stdin: () => string,
): Set<string> | Error {
  let text: string;
  try {
    text = readList(path, stdin);
  } catch (error) {
    return new Error(
      `cannot read the ${what} list ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const names = parseNames(text);
  if (names.size === 0)
    return new Error(
      `the ${what} list ${path} holds no name: an enumeration that found nothing is a wrong path, not a generator without inputs`,
    );
  return names;
}

interface Options {
  generator: string;
  existingPath: string;
  reachedPath: string;
}

function parseArgs(args: string[]): Options {
  let generator = "the generator";
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--generator") {
      const name = args[++i];
      if (!name) throw new InputError(usage);
      generator = name;
    } else if (arg.startsWith("-") && arg !== "-") throw new InputError(usage);
    else positional.push(arg);
  }
  if (positional.length !== 2) throw new InputError(usage);
  const [existingPath, reachedPath] = positional as [string, string];
  return { generator, existingPath, reachedPath };
}

function main(args: string[]): number {
  const { generator, existingPath, reachedPath } = parseArgs(args);
  if (existingPath === "-" && reachedPath === "-")
    return couldNotCheck(RULE, "only one list can come from standard input");
  const stdin = () => readFileSync(0, "utf8");
  const existing = readNames("existing", existingPath, stdin);
  if (existing instanceof Error) return couldNotCheck(RULE, existing.message);
  const reached = readNames("reached", reachedPath, stdin);
  if (reached instanceof Error) return couldNotCheck(RULE, reached.message);
  const findings = coverageFindings(existing, reached, generator);
  if (findings.length) {
    reportFindings(findings);
    return 1;
  }
  console.log(
    `${RULE}: OK — ${generator} reaches every one of ${existing.size} input(s)`,
  );
  return 0;
}

if (import.meta.main) cli(() => main(process.argv.slice(2)));
