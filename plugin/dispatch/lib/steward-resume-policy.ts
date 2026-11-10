/** A routine recommendation is evidence; a registry-class decision stays a person's. */
import { DEFAULT_PARK_CLASSES } from "../../shared/autonomy.ts";
import type { PoolIssue } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { queueHold } from "./queue-rank.ts";

/** An ended pickup may continue only while its assigned item remains live and unheld. */
export function resumablePickup(
  issue: PoolIssue | null,
  policy: { hitl?: string; manualOps?: string } = {},
): boolean {
  return (
    issue !== null &&
    issue.assignee !== null &&
    ["triage", "backlog", "unstarted", "started"].includes(issue.state.type) &&
    queueHold({ issue, blockers: [], unblocks: 0 }, policy) === null
  );
}

/**
 * Require an affirmative recommendation, rather than a mention of the word.
 * Explicit class tags, framed parks and registry language fail closed even
 * when the output also recommends an option. The steward still judges the
 * question's meaning before proposing a resume.
 */
export function routineRecommendation(
  question: string,
  output: string,
  classes: unknown = DEFAULT_PARK_CLASSES,
): string | null {
  const valid = checkedClasses(classes);
  if (valid === null || registryQuestion(question, output, valid)) return null;
  const affirmative = recommendationsIn(output).filter(
    (r) =>
      !/^(?:\*\*)?(?:none\b|no\b|not\b|unknown\b|unclear\b|n\/a\b)/i.test(r),
  );
  return affirmative.length === 1 ? (affirmative[0] ?? null) : null;
}

function checkedClasses(classes: unknown): string[] | null {
  if (
    !Array.isArray(classes) ||
    classes.length === 0 ||
    classes.some(
      (c) =>
        typeof c !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(c),
    )
  )
    return null;
  return [
    ...new Set([...classes, "escalated", "human-decision", "human-thread"]),
  ];
}

function registryQuestion(
  question: string,
  output: string,
  classes: string[],
): boolean {
  if (/^\s*\[[^\]]+\]/.test(question)) return true;
  if (
    /parked-decision\/v1|class\s+[a-z-]+|##\s*(?:Decision|Class|Steps for a person)/i.test(
      output,
    )
  )
    return true;
  for (const cls of classes) {
    const words = cls
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("-", "[-\\s]");
    if (words && new RegExp(`\\b${words}\\b`, "i").test(question)) return true;
  }
  return false;
}

function recommendationsIn(output: string): string[] {
  const lines = output.split("\n").map((l) => l.trim());
  const recommendations: string[] = [];
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] ?? "";
    const direct = directRecommendation(line);
    if (direct) recommendations.push(direct);
    else if (/^#{1,3}\s+Recommended(?: option)?\s*$/i.test(line)) {
      const text = lines.slice(n + 1).find((l) => l !== "");
      if (text && !text.startsWith("#")) recommendations.push(text);
    }
  }
  return recommendations;
}

function directRecommendation(line: string): string | undefined {
  return (
    /^(?:[-*]\s+)?(?:\*\*)?(?:Recommended(?: option)?|Recommendation)(?:\*\*)?\s*:\s*(.+)$/i.exec(
      line,
    )?.[1] ?? /^I recommend\s+(.+)$/i.exec(line)?.[1]
  );
}
