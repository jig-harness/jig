/**
 * The added lines of a diff that look like scaffolding meant to be
 * temporary: a focused or skipped test, a suppression, a timeout set or
 * raised, a gate turned off. Each is a candidate the scaffolding arm reads,
 * not a verdict: a skip with a tracked reason, or a timeout a slow step
 * needs, is the change's own. The patterns read text in any language; a
 * repository's own forms are for the agent reading the diff.
 */
import type { GitRunner } from "./facts.ts";

/** One added line that matched a pattern. */
export interface ScaffoldingHit {
  kind: string;
  file: string;
  line: number;
  text: string;
}

const PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  {
    kind: "focused test",
    pattern: /\.only\(|\bf(?:it|describe)\(|@pytest\.mark\.only\b/,
  },
  {
    kind: "skipped test",
    pattern:
      /\.skip\(|\.todo\(|\bx(?:it|describe|test)\(|@pytest\.mark\.(?:skip|xfail)\b|\bt\.Skip(?:Now|f)?\(|@Disabled\b|@Ignore\b|#\[ignore\]/,
  },
  {
    kind: "suppression",
    pattern:
      /eslint-disable|@ts-(?:ignore|expect-error|nocheck)|biome-ignore|#\s*noqa\b|#\s*type:\s*ignore|\/\/\s*nolint\b|NOSONAR|#\s*pylint:\s*disable|@SuppressWarnings|#\[allow\(|#\s*nosec\b|rubocop:disable/,
  },
  {
    kind: "timeout",
    pattern:
      /time-?out\w*["']?\s*[:=]\s*["']?\d|--timeout[ =]\d|timeout-minutes:\s*\d/i,
  },
  {
    kind: "gate turned off",
    pattern:
      /continue-on-error:\s*true|^\s*if:\s*(?:false|\$\{\{\s*false\s*\}\})\s*$|--no-verify\b|\bSKIP_[A-Z_]+=\S|\|\|\s*true\s*$/,
  },
];

/** The most hits a scan keeps: a diff with more is read by the agent. */
const MAX_HITS = 200;

/** The kind of scaffolding an added line looks like; `null` for none. */
function kindOf(text: string): string | null {
  return PATTERNS.find((p) => p.pattern.test(text))?.kind ?? null;
}

/** Each added line of `diff` (the output of `git diff -U0`), with its file and its line in the new version. */
function addedLines(
  diff: string,
): Array<{ file: string; line: number; text: string }> {
  const added: Array<{ file: string; line: number; text: string }> = [];
  let file = "";
  let line = 0;
  for (const raw of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (raw.startsWith("+++ "))
      file = raw.startsWith("+++ b/") ? raw.slice(6) : "";
    else if (hunk !== null) line = Number(hunk[1]);
    else if (raw.startsWith("+") && file !== "")
      added.push({ file, line: line++, text: raw.slice(1) });
  }
  return added;
}

/** The hits of `diff`, the output of `git diff -U0`. */
export function scanDiff(diff: string): {
  hits: ScaffoldingHit[];
  cut: boolean;
} {
  const all = addedLines(diff).flatMap(({ file, line, text }) => {
    const kind = kindOf(text);
    return kind === null
      ? []
      : [{ kind, file, line, text: text.trim().slice(0, 200) }];
  });
  return { hits: all.slice(0, MAX_HITS), cut: all.length > MAX_HITS };
}

/** The scaffolding candidates the range `base..head` adds. */
export async function scanAddedLines(
  git: GitRunner,
  base: string,
  head: string,
  notes: string[],
): Promise<ScaffoldingHit[]> {
  const r = await git([
    "diff",
    "-U0",
    "--no-color",
    "--no-ext-diff",
    base,
    head,
  ]);
  if (r.code !== 0) {
    notes.push(
      `the diff could not be scanned for scaffolding (git diff exited ${r.code})`,
    );
    return [];
  }
  const { hits, cut } = scanDiff(r.stdout);
  if (cut)
    notes.push(
      `the scaffolding scan kept the first ${MAX_HITS} candidates: read the rest of the diff yourself`,
    );
  return hits;
}
