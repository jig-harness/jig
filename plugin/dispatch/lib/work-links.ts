/**
 * Which tracker items each open pull request of a repository works on, and
 * the reverse, for the dashboard's line (`LineLinks`). A pure function of
 * what the tick's query of the repository already read (`forge-batch.ts`):
 * no request of its own.
 *
 * A pull request is linked to an item when
 *
 * - its branch carries the item's key, read under the repository's
 *   branch-name pattern (`keyFromBranch`), as `do-item` names the branches
 *   it opens;
 * - its description closes the item: a `Closes`, `Fixes` or `Resolves`
 *   (any tense, any case) followed by one key or a list of them, outside
 *   code and HTML comments; or
 * - the forge says it closes the item (its closing references), for a
 *   tracker whose items are the forge's own issues.
 *
 * A tracker whose keys are the forge's issue numbers (`#123`) shares them
 * with the pull requests, so a number is taken only from a closing keyword
 * or the forge's closing references, never from a bare mention; and a
 * description's `#123` names an issue of the pull request's own repository,
 * so it is read only when the tracker's issues live there.
 */
import {
  type IssueKeys,
  keyFromBranch,
} from "../../skills/do-item/scripts/lib/tracker/keys.ts";
import { markdownVisibleTextLines } from "./owed-steps.ts";

/** What links one open pull request to the items it works on, as the repository's query read it. */
export interface PrLinkText {
  number: number;
  url: string;
  headRefName: string;
  /** Its description; empty when it has none. */
  body: string;
  /** The issues the forge says it closes, each with its repository (`owner/name`). */
  /** `null` when the forge returned only part of its closing-reference connection. */
  closing: ReadonlyArray<{ number: number; repository: string }> | null;
}

/** How a repository's keys are read. */
export interface LinkRules {
  keys: IssueKeys;
  /** `pull_requests.branch_name`, as `keyFromBranch` reads it. */
  branchPattern: string;
  /** The pull requests' own repository (`owner/name`). */
  repository: string;
  /** For a tracker whose keys are the forge's issue numbers, the repository its issues are in; `null` for a tracker with keys of its own. */
  issueRepository: string | null;
}

/** The links of one repository's open pull requests, both ways. */
export interface WorkLinks {
  /** The keys a pull request is linked to, in canonical form; `null` when it is not one the read held, so nothing is known of it. */
  itemsOf(pr: number): string[] | null;
  /** The open pull requests linked to an item, by number. */
  prsOf(key: string): Array<{ number: number; url: string }> | null;
}

/** A word that closes what follows it: `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved`. */
const CLOSING = "(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)";

/** Between two keys of a list: a comma (optionally followed by `and`), `&`, or `and`, on one line. */
const SEP =
  "(?:[ \\t]*,[ \\t]*(?:and[ \\t]+)?|[ \\t]*&[ \\t]*|[ \\t]+and[ \\t]+)";

/** A run of backticks at `at`, or an empty string when none starts there. */
function backtickRun(line: string, at: number): string {
  return /^`+/.exec(line.slice(at))?.[0] ?? "";
}

/** Whether a code span opened on `at` can close later in its paragraph. */
function spanContinues(
  lines: readonly string[],
  at: number,
  run: string,
): boolean {
  for (let i = at + 1; i < lines.length; i++) {
    const line = (lines[i] ?? "").replace(/^(?: {0,3}>[ \t]?)+/, "");
    if (
      line.trim() === "" ||
      /^ {0,3}(?:#{1,6}(?:\s|$)|(?:[-*_]\s*){3,}$|`{3,}|~{3,}|(?:[-*+]|0*1[.)])\s)/.test(
        line,
      )
    )
      return false;
    for (let column = 0; column < line.length; ) {
      const found = backtickRun(line, column);
      if (found === "") {
        column++;
        continue;
      }
      if (found.length === run.length) return true;
      column += found.length;
    }
  }
  return false;
}

/** One position inside an HTML comment: the next one, or past its closing marker. */
function stepComment(
  line: string,
  at: number,
  state: { comment: boolean },
): number {
  if (!line.startsWith("-->", at)) return at + 1;
  state.comment = false;
  return at + 3;
}

/** One position inside a multiline inline-code span: past a closing run, or past a run that does not close it. */
function stepSpan(
  line: string,
  at: number,
  state: { span: string | null },
): number {
  const run = backtickRun(line, at);
  if (run.length === state.span?.length) state.span = null;
  return at + Math.max(run.length, 1);
}

/** One position of visible text: it may open a comment or an inline-code span. */
function stepText(
  lines: readonly string[],
  lineIndex: number,
  at: number,
  state: { comment: boolean; span: string | null },
): number {
  const line = lines[lineIndex] ?? "";
  if (line.startsWith("<!--", at)) {
    state.comment = true;
    return at + 4;
  }
  if (line[at] !== "`") return at + 1;
  const run = backtickRun(line, at);
  const close = line.indexOf(run, at + run.length);
  if (close !== -1) return close + run.length;
  if (spanContinues(lines, lineIndex, run)) state.span = run;
  return at + run.length;
}

/** Advance HTML-comment and multiline-inline-code state before normalizing quote containers. */
function commentState(
  lines: readonly string[],
  lineIndex: number,
  state: { comment: boolean; span: string | null },
): void {
  const line = lines[lineIndex] ?? "";
  for (let at = 0; at < line.length; ) {
    if (state.comment) at = stepComment(line, at, state);
    else if (state.span !== null) at = stepSpan(line, at, state);
    else at = stepText(lines, lineIndex, at, state);
  }
}

/** The blockquote markers opening a line: how many there are and how long the prefix is. */
function quotePrefix(line: string): { depth: number; length: number } {
  let depth = 0;
  let at = 0;
  for (;;) {
    let next = at;
    while (next < at + 3 && line[next] === " ") next++;
    if (line[next] !== ">") break;
    next++;
    if (line[next] === " " || line[next] === "\t") next++;
    at = next;
    depth++;
  }
  return { depth, length: at };
}

type Fence = { marker: string; quoteDepth: number };

/** Whether a line closes the open fence: the same character, at least as long, and nothing after it. */
function closesFence(text: string, fence: Fence): boolean {
  let start = 0;
  while (start < 3 && text[start] === " ") start++;
  const char = text[start];
  if (char !== fence.marker[0]) return false;
  let end = start;
  while (text[end] === char) end++;
  return end - start >= fence.marker.length && text.slice(end).trim() === "";
}

/** The fence a line opens, if it does. */
function openedFence(text: string, quoteDepth: number): Fence | null {
  const open = /^( {0,3})(`{3,}|~{3,})/.exec(text);
  return open === null ? null : { marker: open[2] ?? "", quoteDepth };
}

/** Remove blockquote containers before the shared reader sees their Markdown, without changing a quote that is literal text inside a top-level fence or comment. */
function withoutBlockquoteContainers(body: string): string {
  let fence = null as Fence | null;
  const state = { comment: false, span: null as string | null };
  const visible: string[] = [];
  const lines = body.split(/\r?\n/);
  for (const [lineIndex, line] of lines.entries()) {
    const prefix = quotePrefix(line);
    if (fence !== null && prefix.depth < fence.quoteDepth) {
      visible.push(fence.marker);
      fence = null;
    }
    const literal: boolean = fence?.quoteDepth === 0;
    const text: string = literal ? line : line.slice(prefix.length);
    if (fence !== null) {
      if (closesFence(text, fence)) fence = null;
      visible.push(text);
      continue;
    }
    visible.push(text);
    fence = state.comment ? null : openedFence(text, prefix.depth);
    if (fence === null) commentState(lines, lineIndex, state);
  }
  return visible.join("\n");
}

/** Mask indented code after the shared reader has established Markdown's container and paragraph boundaries. */
function withoutIndentedCode(body: string): string {
  let paragraph = false;
  return body
    .split("\n")
    .map((line) => {
      if (line.trim() === "") {
        paragraph = false;
        return line;
      }
      const indentation =
        /^\s*/.exec(line.replace(/\t/g, "    "))?.[0].length ?? 0;
      if (indentation >= 4 && !paragraph) return " ";
      paragraph =
        /^ {0,3}(?:[-*+]|\d+[.)])\s+\S/.test(line) ||
        !/^ {0,3}(?:#{1,6}(?:\s|$)|(?:[-*_]\s*){3,}$)/.test(line);
      return line;
    })
    .join("\n");
}

/** A description without what only shows text: code blocks, inline code and HTML comments. */
function assertedText(body: string): string {
  return withoutIndentedCode(
    markdownVisibleTextLines(withoutBlockquoteContainers(body)).join("\n"),
  );
}

function sameRepository(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The keys a description closes, in canonical form, each once, in the order written. */
export function closingKeys(body: string, keys: IssueKeys): string[] {
  const key = keys.source;
  const line = new RegExp(
    `(?<![\\w-])${CLOSING}(?::[ \\t]*|[ \\t]+)(${key}(?:${SEP}${key})*)`,
    "gi",
  );
  const found: string[] = [];
  for (const m of assertedText(body).matchAll(line))
    for (const one of (m[1] ?? "").matchAll(new RegExp(key, "gi"))) {
      const canonical = keys.normalize(one[0]);
      if (canonical !== null && !found.includes(canonical))
        found.push(canonical);
    }
  return found;
}

/** The keys one pull request is linked to, each once: its branch's first, then its description's, then the forge's closing references. */
function itemsOfPr(pr: PrLinkText, rules: LinkRules): string[] | null {
  const { keys } = rules;
  const found: string[] = [];
  const add = (key: string | null) => {
    if (key !== null && !found.includes(key)) found.push(key);
  };
  add(keyFromBranch(pr.headRefName, keys, rules.branchPattern));
  const ownIssues =
    !keys.sharesPullRequestNumbers ||
    (rules.issueRepository !== null &&
      sameRepository(rules.issueRepository, rules.repository));
  if (ownIssues) for (const key of closingKeys(pr.body, keys)) add(key);
  if (keys.sharesPullRequestNumbers && rules.issueRepository !== null) {
    if (pr.closing === null) return null;
    for (const ref of pr.closing)
      if (sameRepository(ref.repository, rules.issueRepository))
        add(keys.normalize(String(ref.number)));
  }
  return found;
}

/** The links between one repository's open pull requests (`prs`, every one the read held) and its items. */
export function workLinks(
  prs: readonly PrLinkText[],
  rules: LinkRules,
): WorkLinks {
  const items = new Map<number, string[]>();
  const reverse = new Map<string, Array<{ number: number; url: string }>>();
  let unknownReverse = false;
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    const keys = itemsOfPr(pr, rules);
    if (keys === null) {
      unknownReverse = true;
      continue;
    }
    items.set(pr.number, keys);
    for (const key of keys) {
      const linked = reverse.get(key) ?? [];
      if (!linked.some((l) => l.number === pr.number))
        linked.push({ number: pr.number, url: pr.url });
      reverse.set(key, linked);
    }
  }
  return {
    itemsOf: (pr) => items.get(pr) ?? null,
    prsOf: (key) =>
      unknownReverse
        ? null
        : [...(reverse.get(rules.keys.normalize(key) ?? key) ?? [])],
  };
}
