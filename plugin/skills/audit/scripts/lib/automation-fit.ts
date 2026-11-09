/**
 * Whether the workflows that open pull requests label them as automation:
 * a regeneration, a sync or a schema update a workflow opens should carry a
 * label of the `automation:` family (`automation:docs-sync`), which says
 * which job opened it. Without one, a person reading the pull request list
 * cannot tell it from a person's, and Jig's dispatcher, which drives an
 * automation pull request only while it needs work, falls back to its
 * author: a pull request a workflow opens with a person's token reads as
 * that person's.
 *
 * A workflow opens a pull request in a step that uses
 * `peter-evans/create-pull-request` (labelled through its `labels` input) or
 * runs `gh pr create` as a command of its own (labelled through `--label` or
 * `-l`, on each such command). Other ways of
 * opening one (an API call from a script) are not read, so the finding is a
 * suggestion the repository can decline.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMapping } from "../../../../shared/config-layers.ts";
import { swallow } from "../../../../shared/errors.ts";
import { load } from "../../../../shared/yaml.ts";
import { probedFiles } from "./criteria.ts";
import type { Finding } from "./schema.ts";
import { trackerFileFindings } from "./sweep-fit.ts";

const WORKFLOW = /^\.(?:github|forgejo|gitea)\/workflows\/[^/]+\.ya?ml$/;
const CREATE_ACTION = /^peter-evans\/create-pull-request@/;
/** Whether a list of label names, comma or newline separated, holds one of the `automation:` family. */
const listsAutomation = (labels: string): boolean =>
  labels.split(/[,\n]/).some((l) => l.trim().startsWith("automation:"));

/** A here-document whose body begins after the current line: its delimiter, and whether `<<-` lets tabs indent the delimiter line. */
interface Heredoc {
  delimiter: string;
  tabs: boolean;
}

/** Where a scan of a shell script stands: the words of the command being read, the word being read (`null` between words), the quote open, the here-documents awaiting their bodies and the groups open. */
interface Scan {
  commands: string[][];
  words: string[];
  word: string | null;
  quote: string | null;
  heredocs: Heredoc[];
  groups: number;
  /** A redirection operator was read: the next word is its target, not an argument. */
  redirect: boolean;
}

const endWord = (scan: Scan): void => {
  if (scan.word !== null && !scan.redirect) scan.words.push(scan.word);
  if (scan.word !== null) scan.redirect = false;
  scan.word = null;
};

const endCommand = (scan: Scan): void => {
  endWord(scan);
  scan.redirect = false;
  if (scan.words.length > 0) scan.commands.push(scan.words);
  scan.words = [];
};

const append = (scan: Scan, text: string): void => {
  scan.word = (scan.word ?? "") + text;
};

/** Read one character inside quotes; the index of the last one used. */
function inQuote(scan: Scan, script: string, i: number): number {
  const c = script.charAt(i);
  if (c === scan.quote) scan.quote = null;
  else if (c === "\\" && scan.quote === '"' && i + 1 < script.length) {
    // In double quotes a backslash escapes only these; before a newline both vanish.
    const next = script.charAt(i + 1);
    if (next === "\n") return i + 1;
    if (/[$`"\\]/.test(next)) {
      append(scan, next);
      return i + 1;
    }
    append(scan, c);
  } else append(scan, c);
  return i;
}

/** The delimiter word of a here-document from `j`, quotes and backslashes removed, with the index after it. */
function delimiterAt(
  script: string,
  j: number,
): { word: string; end: number; present: boolean } {
  const start = j;
  let word = "";
  let quote: string | null = null;
  for (; j < script.length; j++) {
    const c = script.charAt(j);
    if (quote !== null) {
      if (c === quote) quote = null;
      else word += c;
    } else if (c === "'" || c === '"') quote = c;
    else if (/[\s;&|<>()]/.test(c)) break;
    else if (c !== "\\") word += c;
  }
  // A quoted empty delimiter is a delimiter: `end` moved past the quotes.
  return { word, end: j, present: j > start };
}

/** The here-document an operator `<<` at `i` opens, with the index of the last character of its delimiter; `null` for `<<<` or a missing delimiter. */
function heredocAt(
  script: string,
  i: number,
): { heredoc: Heredoc; end: number } | null {
  if (script.charAt(i + 2) === "<") return null;
  let j = i + 2;
  const tabs = script.charAt(j) === "-";
  if (tabs) j++;
  while (script.charAt(j) === " " || script.charAt(j) === "\t") j++;
  const { word, end, present } = delimiterAt(script, j);
  return !present ? null : { heredoc: { delimiter: word, tabs }, end: end - 1 };
}

/** The index of the last character of the here-document bodies that begin after the newline at `i`. */
function skipHeredocs(scan: Scan, script: string, i: number): number {
  let at = i + 1;
  for (const { delimiter, tabs } of scan.heredocs.splice(0)) {
    while (at < script.length) {
      const eol = script.indexOf("\n", at);
      const line = script.slice(at, eol === -1 ? script.length : eol);
      at = eol === -1 ? script.length : eol + 1;
      if ((tabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
    }
  }
  return at - 1;
}

/** Open a here-document at the `<<` at `i`; the index of the last character used. */
function openHeredoc(scan: Scan, script: string, i: number): number {
  const found = heredocAt(script, i);
  if (found === null) return i + 1;
  endWord(scan);
  scan.heredocs.push(found.heredoc);
  return found.end;
}

/** Read a `(` at a word's start, which begins a command of its own as a control keyword does, or a `)` closing such a group; whether `c` was one. */
function group(scan: Scan, c: string): boolean {
  if (c === "(" && scan.word === null) scan.groups++;
  else if (c === ")" && scan.groups > 0) scan.groups--;
  else return false;
  endCommand(scan);
  return true;
}

/** The end of the quote beginning at `at`, respecting double-quote escapes; the end of the script when it never closes. */
function quotedEnd(script: string, at: number): number {
  const quote = script.charAt(at);
  for (let i = at + 1; i < script.length; i++) {
    if (script.charAt(i) === quote) return i;
    if (quote === '"' && script.charAt(i) === "\\") i++;
  }
  return script.length - 1;
}

const isQuote = (c: string): boolean => c === "'" || c === '"';

const closesSubstitution = (c: string, depth: number): boolean =>
  c === ")" && depth === 1;

/** Read the process substitution whose `(` is at `open` as one word of the command, its nested command unread; the index of its closing `)`, or of the script's last character when it never closes. Quoted, escaped and commented parentheses are text, not delimiters. */
function substitution(
  scan: Scan,
  script: string,
  start: number,
  open: number,
): number {
  let depth = 0;
  let atWordStart = true;
  const heredocs: Heredoc[] = [];
  for (let j = open; j < script.length; j++) {
    const c = script.charAt(j);
    if (isQuote(c)) {
      j = quotedEnd(script, j);
      atWordStart = false;
      continue;
    }
    if (c === "\\") {
      // A joined line is not a word character, so it preserves comment
      // eligibility at the beginning of the continued line.
      if (script.charAt(j + 1) !== "\n") atWordStart = false;
      j++;
      continue;
    }
    if (c === "<" && script.charAt(j + 1) === "<") {
      if (script.charAt(j + 2) === "<") {
        j += 2;
        atWordStart = false;
        continue;
      }
      const found = heredocAt(script, j);
      if (found !== null) {
        heredocs.push(found.heredoc);
        j = found.end;
        atWordStart = false;
        continue;
      }
    }
    if (c === "\n" && heredocs.length > 0) {
      j = skipHeredocs({ heredocs } as Scan, script, j);
      atWordStart = true;
      continue;
    }
    if (c === "#" && atWordStart) {
      const end = script.indexOf("\n", j);
      // Leave the newline for the heredoc branch on the next iteration.
      j = end === -1 ? script.length : end - 1;
      atWordStart = true;
      continue;
    }
    if (c === "(") {
      depth++;
      atWordStart = true;
      continue;
    }
    if (closesSubstitution(c, depth)) {
      scan.word = script.slice(start, j + 1);
      return j;
    }
    if (c === ")") depth--;
    atWordStart = /[\s;&|]/.test(c);
  }
  scan.word = script.slice(start);
  return script.length - 1;
}

/** Read a redirection operator at `i`: it and its target are no arguments of the command. An all-digit word just before it is the descriptor it redirects. Returns the index of the last character used. */
function redirection(scan: Scan, script: string, i: number): number {
  if (scan.word !== null && /^\d+$/.test(scan.word)) scan.word = null;
  else endWord(scan);
  let j = i + 1;
  while (/[<>&|]/.test(script.charAt(j))) j++;
  if (script.charAt(j) === "(") return substitution(scan, script, i, j);
  scan.redirect = true;
  return j - 1;
}

/** Read one character that ends a word or a command, or belongs to the word. */
function separator(scan: Scan, c: string): void {
  if (/[;&|]/.test(c)) endCommand(scan);
  else if (/\s/.test(c)) endWord(scan);
  else append(scan, c);
}

/** Read one character that is no quote, escape or comment; the index of the last one used. */
function operator(scan: Scan, script: string, i: number): number {
  const c = script.charAt(i);
  if (c === "<" && script.charAt(i + 1) === "<")
    return openHeredoc(scan, script, i);
  if (c === "\n") {
    endCommand(scan);
    return scan.heredocs.length > 0 ? skipHeredocs(scan, script, i) : i;
  }
  if (c === "<" || c === ">") return redirection(scan, script, i);
  if (!group(scan, c)) separator(scan, c);
  return i;
}

/** Read one character outside quotes; the index of the last one used. */
function outside(scan: Scan, script: string, i: number): number {
  const c = script.charAt(i);
  if (c === "'" || c === '"') {
    scan.quote = c;
    scan.word ??= "";
  } else if (c === "\\") {
    if (script.charAt(i + 1) === "\n") return i + 1;
    append(scan, script.charAt(i + 1));
    return i + 1;
  } else if (c === "#" && scan.word === null) {
    const end = script.indexOf("\n", i);
    return end === -1 ? script.length : end - 1;
  } else return operator(scan, script, i);
  return i;
}

/**
 * The simple commands of a shell script as lists of words: split at
 * newlines, `;`, `&` and `|` outside quotes, a backslash-newline joined, a
 * `#` comment at a word's start dropped, quotes removed, the bodies of
 * here-documents skipped and a `(` at a word's start a command boundary.
 * Command substitutions and functions are not followed.
 */
export function shellCommands(script: string): string[][] {
  const scan: Scan = {
    commands: [],
    words: [],
    word: null,
    quote: null,
    heredocs: [],
    groups: 0,
    redirect: false,
  };
  for (let i = 0; i < script.length; i++)
    i = (scan.quote === null ? outside : inQuote)(scan, script, i);
  endCommand(scan);
  return scan.commands;
}

/** The shell words that begin a command without being its executable: a control keyword, a negation or a group's opener. */
const CONTROL = new Set([
  "if",
  "then",
  "else",
  "elif",
  "while",
  "until",
  "do",
  "time",
  "!",
  "{",
  "(",
]);

/** The words of a command after its leading `VAR=value` words and control keywords. */
function commandWords(words: readonly string[]): readonly string[] {
  const at = words.findIndex(
    (w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && !CONTROL.has(w),
  );
  return at === -1 ? [] : words.slice(at);
}

/** Whether a command is `gh pr create` (after any leading `VAR=value` words and control keywords). */
function createsPr(words: readonly string[]): boolean {
  const [gh, pr, create] = commandWords(words);
  return gh === "gh" && pr === "pr" && create === "create";
}

/** The `gh pr create` options that take a value of their own, which may itself read as a flag. */
const VALUED = new Set([
  "--assignee",
  "-a",
  "--base",
  "-B",
  "--body",
  "-b",
  "--body-file",
  "-F",
  "--head",
  "-H",
  "--milestone",
  "-m",
  "--project",
  "-p",
  "--recover",
  "--reviewer",
  "-r",
  "--template",
  "-T",
  "--title",
  "-t",
  "--repo",
  "-R",
]);

/** The label list a label flag at `args[i]` gives, with the index of the last word used; `null` for another word. */
function labelFlag(
  args: readonly string[],
  i: number,
): { value: string; last: number } | null {
  const w = args[i] ?? "";
  const eq = /^(?:--label|-l)=(.*)$/.exec(w);
  if (eq !== null) return { value: eq[1] ?? "", last: i };
  if (w === "--label" || w === "-l")
    return { value: args[i + 1] ?? "", last: i + 1 };
  return null;
}

/** Whether a `gh pr create` command applies an `automation:` label through a label flag: an option's value is read as its value, not as another flag. */
function labelled(words: readonly string[]): boolean {
  const args = commandWords(words).slice(3);
  for (let i = 0; i < args.length; i++) {
    const flag = labelFlag(args, i);
    if (flag !== null) {
      if (listsAutomation(flag.value)) return true;
      i = flag.last;
    } else if (VALUED.has(args[i] ?? "")) i++;
  }
  return false;
}

/** Whether every `gh pr create` of a script labels its pull request as automation; `null` when it runs none. */
function ghLabels(run: string): boolean | null {
  const creations = shellCommands(run).filter(createsPr);
  return creations.length === 0 ? null : creations.every(labelled);
}

/** Whether one step opens a pull request, and whether it labels it as automation; `null` when it opens none. */
function stepLabels(step: unknown): boolean | null {
  if (!isMapping(step)) return null;
  if (typeof step.uses === "string" && CREATE_ACTION.test(step.uses)) {
    const labels = isMapping(step.with) ? step.with.labels : undefined;
    return typeof labels === "string" && listsAutomation(labels);
  }
  return typeof step.run === "string" ? ghLabels(step.run) : null;
}

/** The steps of one parsed workflow that open a pull request with no automation label, by job and step name. */
export function unlabelledSteps(doc: unknown): string[] {
  if (!isMapping(doc) || !isMapping(doc.jobs)) return [];
  const found: string[] = [];
  for (const [job, spec] of Object.entries(doc.jobs)) {
    if (!isMapping(spec) || !Array.isArray(spec.steps)) continue;
    spec.steps.forEach((step, i) => {
      if (stepLabels(step) !== false) return;
      const name = isMapping(step) && typeof step.name === "string";
      found.push(
        `${job} › ${name ? (step as { name: string }).name : `step ${i + 1}`}`,
      );
    });
  }
  return found;
}

/** One tracked workflow file, parsed; `null` when it does not read or parse. */
function workflowDoc(root: string, file: string): unknown {
  try {
    return load(readFileSync(join(root, file), "utf8"));
  } catch (err) {
    swallow(
      err,
      "a workflow that does not read opens no pull request we can see",
    );
    return null;
  }
}

/** A suggestion naming each workflow step that opens a pull request with no `automation:` label. */
export function automationLabelFindings(
  root: string,
  tracked: readonly string[],
): Finding[] {
  const unlabelled: string[] = [];
  for (const file of probedFiles(tracked).filter((f) => WORKFLOW.test(f))) {
    const steps = unlabelledSteps(workflowDoc(root, file));
    unlabelled.push(...steps.map((s) => `${file} (${s})`));
  }
  if (unlabelled.length === 0) return [];
  return [
    {
      id: "suggestion:automation-labels",
      severity: "suggestion",
      message: `these workflow steps open pull requests without an \`automation:\` label: ${unlabelled.join("; ")}. Label each with \`automation:<job>\` (the \`labels\` input of create-pull-request, \`--label\` of \`gh pr create\`) so people and the dispatcher tell them from a person's; the dispatcher then drives one only while it needs work (plugin README, Dispatch labels)`,
    },
  ];
}

/**
 * Every finding config-fit reads from the repository's tracked files: its
 * tracker's (`sweep-fit.ts`), where it has a configuration, and its
 * workflows' automation labels.
 */
export function fileFindings(
  config: Record<string, unknown>,
  tracked: readonly string[],
  opts: { root: string },
  report: { configured: boolean },
): Finding[] {
  return [
    ...(report.configured
      ? trackerFileFindings(config, opts.root, tracked)
      : []),
    ...automationLabelFindings(opts.root, tracked),
  ];
}
