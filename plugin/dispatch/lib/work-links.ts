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
    const line = lines[i] ?? "";
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

/** Advance HTML-comment and multiline-inline-code state before normalizing quote containers. */
function commentState(
  lines: readonly string[],
  lineIndex: number,
  state: { comment: boolean; span: string | null },
): void {
  const line = lines[lineIndex] ?? "";
  for (let at = 0; at < line.length; ) {
    if (state.comment) {
      if (line.startsWith("-->", at)) {
        state.comment = false;
        at += 3;
      } else at++;
      continue;
    }
    if (state.span !== null) {
      const run = backtickRun(line, at);
      if (run.length === state.span.length) state.span = null;
      at += run === "" ? 1 : run.length;
      continue;
    }
    if (line.startsWith("<!--", at)) {
      state.comment = true;
      at += 4;
      continue;
    }
    if (line[at] !== "`") {
      at++;
      continue;
    }
    const run = backtickRun(line, at);
    const close = line.indexOf(run, at + run.length);
    if (close !== -1) at = close + run.length;
    else {
      if (spanContinues(lines, lineIndex, run)) state.span = run;
      at += run.length;
    }
  }
}

/** Remove blockquote containers before the shared reader sees their Markdown, without changing a quote that is literal text inside a top-level fence or comment. */
function withoutBlockquoteContainers(body: string): string {
  let fence: { marker: string; quoteDepth: number } | null = null;
  const state = { comment: false, span: null as string | null };
  const visible: string[] = [];
  const lines = body.split(/\r?\n/);
  for (const [lineIndex, line] of lines.entries()) {
    const quotePrefix = /^(?: {0,3}>[ \t]?)+/.exec(line)?.[0] ?? "";
    const quoteDepth = (quotePrefix.match(/>/g) ?? []).length;
    if (fence !== null && quoteDepth < fence.quoteDepth) {
      visible.push(fence.marker);
      fence = null;
    }
    const text =
      (fence === null && !state.comment) || fence?.quoteDepth !== 0
        ? line.replace(/^(?: {0,3}>[ \t]?)+/, "")
        : line;
    const raw = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence !== null) {
      if (
        raw !== null &&
        raw[2]?.[0] === fence.marker[0] &&
        (raw[2]?.length ?? 0) >= fence.marker.length &&
        (raw[3] ?? "").trim() === ""
      )
        fence = null;
      visible.push(text);
      continue;
    }
    if (!state.comment && raw !== null) {
      fence = { marker: raw[2] ?? "", quoteDepth };
      visible.push(text);
      continue;
    }
    visible.push(text);
    commentState(lines, lineIndex, state);
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
