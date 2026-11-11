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

/** What links one open pull request to the items it works on, as the repository's query read it. */
export interface PrLinkText {
  number: number;
  url: string;
  headRefName: string;
  /** Its description; empty when it has none. */
  body: string;
  /** The issues the forge says it closes, each with its repository (`owner/name`). */
  closing: ReadonlyArray<{ number: number; repository: string }>;
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
  prsOf(key: string): Array<{ number: number; url: string }>;
}

/** A word that closes what follows it: `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved`. */
const CLOSING = "(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)";

/** Between two keys of a list: a comma (optionally followed by `and`), `&`, or `and`, on one line. */
const SEP =
  "(?:[ \\t]*,[ \\t]*(?:and[ \\t]+)?|[ \\t]*&[ \\t]*|[ \\t]+and[ \\t]+)";

/** Replace text that Markdown renders as a code block, preserving line positions. */
function withoutCodeBlocks(body: string): string {
  const lines = body.split("\n");
  let fence: { marker: "`" | "~"; length: number } | null = null;
  return lines
    .map((line) => {
      const fenceRun = line.match(
        /^(?:[ \t]{0,3}>[ \t]?)*[ \t]{0,3}(`{3,}|~{3,})/,
      )?.[1];
      if (fence !== null) {
        const closes =
          fenceRun !== undefined &&
          fenceRun[0] === fence.marker &&
          fenceRun.length >= fence.length;
        if (closes) fence = null;
        return " ";
      }
      if (fenceRun !== undefined) {
        fence = { marker: fenceRun[0] as "`" | "~", length: fenceRun.length };
        return " ";
      }
      if (/^(?:[ \t]{0,3}>[ \t]?)* {4}/.test(line)) return " ";
      return line;
    })
    .join("\n");
}

/** Replace inline code spans, including multiline spans and spans with multi-backtick delimiters. */
function withoutCodeSpans(body: string): string {
  let result = body;
  for (let start = 0; start < result.length; ) {
    if (result[start] !== "`") {
      start += 1;
      continue;
    }
    let end = start;
    while (result[end] === "`") end += 1;
    const delimiter = result.slice(start, end);
    const close = result.indexOf(delimiter, end);
    if (close < 0) {
      start = end;
      continue;
    }
    result = `${result.slice(0, start)}${" ".repeat(close + delimiter.length - start)}${result.slice(close + delimiter.length)}`;
    start = close + delimiter.length;
  }
  return result;
}

/** A description without what only shows text: code blocks, inline code and HTML comments. */
function assertedText(body: string): string {
  return withoutCodeSpans(withoutCodeBlocks(body)).replace(
    /<!--[\s\S]*?(?:-->|$)/g,
    " ",
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
function itemsOfPr(pr: PrLinkText, rules: LinkRules): string[] {
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
  if (keys.sharesPullRequestNumbers && rules.issueRepository !== null)
    for (const ref of pr.closing)
      if (sameRepository(ref.repository, rules.issueRepository))
        add(keys.normalize(String(ref.number)));
  return found;
}

/** The links between one repository's open pull requests (`prs`, every one the read held) and its items. */
export function workLinks(
  prs: readonly PrLinkText[],
  rules: LinkRules,
): WorkLinks {
  const items = new Map<number, string[]>();
  const reverse = new Map<string, Array<{ number: number; url: string }>>();
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    const keys = itemsOfPr(pr, rules);
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
    prsOf: (key) => [...(reverse.get(rules.keys.normalize(key) ?? key) ?? [])],
  };
}
