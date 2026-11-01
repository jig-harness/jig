/**
 * What the lenses' findings do to a review: each finding's effective
 * severity, Tier 3's state, the summary's `Lenses:` line and the verdict.
 * No lens is promoted yet, so every lens is comment-only: its findings are
 * capped at WARNING, and one with an empty evidence field is INFO.
 */
import type { LensResult } from "./lens-selection.ts";

export const SEVERITIES = ["CRITICAL", "WARNING", "INFO"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** A finding as a lens's reviewer returns it: the finding quality bar's fields, its lens and its evidence. */
export interface LensFinding {
  lens: string;
  file: string;
  line: number | null;
  severity: Severity;
  confidence: string;
  scenario: string;
  impact: string;
  fix: string;
  evidence: string;
}

export interface RatedFinding extends LensFinding {
  effective: Severity;
  /** The evidence field is empty: a person or the arbiter has nothing to check. */
  unverified: boolean;
}

/** How Tier 3's other reviews ended: approved, rejected, or none triggered. */
export type Semantic = "APPROVED" | "REJECTED" | "NONE";
export type Tier3 = "✅ APPROVED" | "⚠️ WARNINGS" | "⏭️ N/A" | "❌ REJECTED";

export interface LensOutcome {
  /** The flag that ran no lens (`--quick`, `--tier=1`, `--tier=2`, `--skip-t3`), or null. */
  skippedBy: string | null;
  lenses: LensResult[];
  /** The lenses ran in the one session, so they shared a context. */
  sharedContext: boolean;
  findings: RatedFinding[];
}

export function rate(finding: LensFinding): RatedFinding {
  const unverified = finding.evidence.trim() === "";
  const capped = finding.severity === "CRITICAL" ? "WARNING" : finding.severity;
  return { ...finding, effective: unverified ? "INFO" : capped, unverified };
}

export function tier3(semantic: Semantic, outcome: LensOutcome): Tier3 {
  if (semantic === "REJECTED") return "❌ REJECTED";
  if (outcome.findings.some((f) => f.effective !== "INFO")) return "⚠️ WARNINGS";
  const ran = outcome.lenses.some((lens) => lens.runs);
  if (semantic === "NONE" && (outcome.skippedBy !== null || !ran))
    return "⏭️ N/A";
  return "✅ APPROVED";
}

function counts(findings: readonly RatedFinding[]): string {
  const parts = SEVERITIES.map(
    (severity) =>
      [
        findings.filter((f) => f.effective === severity).length,
        severity,
      ] as const,
  )
    .filter(([n]) => n > 0)
    .map(([n, severity]) => `${n} ${severity}`);
  return parts.length ? parts.join(", ") : "none";
}

function entry(lens: LensResult, findings: readonly RatedFinding[]): string {
  if (lens.id === null) return `${lens.file}: ${lens.reason}`;
  if (!lens.runs) return `${lens.id}: ${lens.reason}`;
  const label = `${lens.id}@${lens.version}`;
  return `${label}: ${counts(findings.filter((f) => f.lens === label))}`;
}

/** The summary's `Lenses:` line. */
export function lensesLine(outcome: LensOutcome): string {
  if (outcome.skippedBy !== null)
    return `Lenses:  none run (${outcome.skippedBy})`;
  const ran = outcome.lenses.filter((lens) => lens.runs).length;
  const skipped = outcome.lenses.length - ran;
  const shared =
    outcome.sharedContext && ran > 0
      ? " in the same session (one shared context)"
      : "";
  const head = `Lenses:  ${ran} run${shared}, ${skipped} skipped`;
  if (outcome.lenses.length === 0) return head;
  const ordered = [
    ...outcome.lenses.filter((l) => l.runs),
    ...outcome.lenses.filter((l) => !l.runs),
  ];
  return `${head}  (${ordered.map((lens) => entry(lens, outcome.findings)).join("; ")})`;
}

export type Tier1 = "PASSED" | "BLOCKED";
export type Tier2 = "PASSED" | "WARNINGS" | "BLOCKED";
export type Verdict = "APPROVED" | "APPROVED WITH WARNINGS" | "BLOCKED";

/**
 * The exit criteria: a Tier 1 critical violation, a failing blocking Tier 2
 * check or a rejected Tier 3 blocks; Tier 2's warnings and Tier 3's lens
 * warnings leave an approval with warnings. An INFO finding changes nothing.
 */
export function verdict(tier1: Tier1, tier2: Tier2, state: Tier3): Verdict {
  if (tier1 === "BLOCKED" || tier2 === "BLOCKED" || state === "❌ REJECTED")
    return "BLOCKED";
  if (tier2 === "WARNINGS" || state === "⚠️ WARNINGS")
    return "APPROVED WITH WARNINGS";
  return "APPROVED";
}
