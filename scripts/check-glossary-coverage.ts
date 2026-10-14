// Scope: tracked/non-ignored prose except templates, test fixtures
// (`fixtures/` and `fixture/` directories) and the frozen seeds. Acronyms are a proxy; fenced and inline code is excluded.
//
// The allowlist names acronym-shaped tokens that are not terms of art. Each
// entry sits in a group: `#` comment lines giving the reason, then entries,
// one per line; a blank line ends the group. An entry is a finding when its
// group has no reason, when it repeats an earlier entry, or when it suppresses
// nothing: GLOSSARY.md already contains it, or no checked document uses it.
// Exit 1 on a finding, 2 when the glossary or the allowlist cannot be read,
// the glossary has no entry, or there is no other Markdown file to check. A
// glossary whose entries hold no acronym-shaped term is still a glossary.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cli } from "../lib/cli.ts";
import { markdownFiles, prose } from "../lib/files.ts";
import {
  couldNotCheck,
  type Finding,
  reasonedEntries,
  repoPath,
  reportFindings,
} from "../lib/findings.ts";

const RULE = "glossary-coverage";
const ALLOW_RULE = "glossary-allowlist";
const ACRONYM = /\b[A-Z][A-Za-z]*[A-Z]\b/g;
const acronyms = (content: string) =>
  new Set(prose(content).match(ACRONYM) ?? []);

/**
 * Each acronym-shaped word outside code, with the line of its first use. The
 * same words `acronyms` finds: code is blanked here rather than removed, so
 * the line numbers stay those of the file.
 */
function firstUses(content: string): Map<string, number> {
  let fenced = false;
  const text = content
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return "";
      }
      return fenced ? "" : line;
    })
    .join("\n")
    .replace(/`[^`]*`/g, (code) => code.replace(/[^\n]/g, ""));
  const uses = new Map<string, number>();
  text.split("\n").forEach((line, index) => {
    for (const term of line.match(ACRONYM) ?? [])
      if (!uses.has(term)) uses.set(term, index + 1);
  });
  return uses;
}
/**
 * The glossary's entries: list items opening with a bold term that has a
 * definition after it on the same line. A bold run of blanks is no term, and
 * a term with nothing but punctuation after it is no definition.
 */
const entryCount = (content: string) =>
  [...prose(content).matchAll(/^\s*- \*\*([^*\n]+)\*\*(.*)$/gm)].filter(
    ([, term = "", definition = ""]) =>
      term.trim() && /[\p{L}\p{N}]/u.test(definition),
  ).length;

/** What is wrong with one allowlist entry, or "" when nothing is. */
function entryProblem(
  term: string,
  reason: string,
  repeated: boolean,
  known: Set<string>,
  used: Set<string>,
): string {
  if (!reason) return `entry '${term}' has no reason`;
  if (repeated) return `entry '${term}' repeats an earlier entry`;
  if (known.has(term))
    return `entry '${term}' suppresses nothing: GLOSSARY.md already contains it`;
  if (!used.has(term))
    return `entry '${term}' suppresses nothing: no checked document uses it`;
  return "";
}

/** Findings for the allowlist entries without a reason, repeated or stale. */
function allowlistFindings(
  entries: { term: string; line: number; reason: string }[],
  known: Set<string>,
  used: Set<string>,
  file: string,
): Finding[] {
  const seen = new Set<string>();
  return entries.flatMap(({ term, line, reason }): Finding[] => {
    const problem = entryProblem(term, reason, seen.has(term), known, used);
    seen.add(term);
    if (!problem) return [];
    return [
      {
        rule: ALLOW_RULE,
        file,
        line,
        problem,
        remedy: !reason
          ? "put the entry under a `#` comment that says why it is not a term of art"
          : "delete the entry",
      },
    ];
  });
}

export function checkGlossary(
  root = ".",
  glossary = join(root, "GLOSSARY.md"),
  allowlist = join(root, "scripts/glossary-allowlist.txt"),
): number {
  // An acronym the glossary's prose contains counts as known, so a term
  // defined inline inside another entry is covered; the glossary must still
  // hold entries, or a page of loose prose would pass as definitions.
  const text = readFileSync(glossary, "utf8");
  if (!entryCount(text))
    return couldNotCheck(
      RULE,
      `${glossary} has no entry (a list item opening with a bold term, "- **Term** — …")`,
    );
  const known = acronyms(text);
  const entries = reasonedEntries(readFileSync(allowlist, "utf8")).map((e) => ({
    ...e,
    term: e.text.trimEnd(),
  }));
  const allowed = new Set(entries.map((e) => e.term));
  const files = markdownFiles(root, [
    "templates",
    "fixtures",
    "fixture",
    "seeds",
  ]).filter((file) => resolve(file) !== resolve(glossary));
  if (!files.length)
    return couldNotCheck(
      RULE,
      `no Markdown file under ${root} besides the glossary`,
    );
  const findings: Finding[] = [];
  const used = new Set<string>();
  for (const file of files)
    for (const [term, line] of firstUses(readFileSync(file, "utf8"))) {
      used.add(term);
      if (!known.has(term) && !allowed.has(term))
        findings.push({
          rule: RULE,
          file: repoPath(root, file),
          line,
          problem: `undefined term of art '${term}'`,
          remedy: `define it in GLOSSARY.md, or, if it is not a term of art, add it to ${repoPath(root, allowlist)} under a reason`,
        });
    }
  findings.push(
    ...allowlistFindings(entries, known, used, repoPath(root, allowlist)),
  );
  if (findings.length) {
    reportFindings(findings);
    return 1;
  }
  console.log(
    `${RULE}: OK — ${files.length} Markdown files; every acronym-shaped word outside code is defined in the glossary or allowlisted with a reason (${entries.length} entries, each in use). Acronyms are a proxy: a term of art in lower case is not checked`,
  );
  return 0;
}
if (import.meta.main) cli(() => checkGlossary(...process.argv.slice(2)));
