/** Markdown rendering of the cross-PR process scoreboard. */
import { METRICS, type MetricSpec } from "./fractal-baseline.ts";
import { renderConflictCoverage } from "./fractal-conflicts.ts";
import {
  cutShareIsPublishable,
  judgedLateRoundShare,
  judgedSelfInflictedShare,
  MIN_SELF_INFLICTED_COVERAGE,
} from "./fractal-judgments.ts";
import type { Cell, Scoreboard, PrSide, LinearSide } from "./fractal.ts";

// ── Rendering ───────────────────────────────────────────────────────────────

function pct(v: number | null): string {
  return v === null ? "n/a" : `${(v * 100).toFixed(1)}%`;
}

export function formatValue(
  unit: MetricSpec["unit"],
  v: number | null,
): string {
  if (v === null) return "n/a";
  if (unit === "share") return pct(v);
  if (unit === "rate") return v.toFixed(1);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function formatDelta(unit: MetricSpec["unit"], d: number | null): string {
  if (d === null) return "—";
  const sign = d > 0 ? "+" : "";
  return unit === "share"
    ? `${sign}${(d * 100).toFixed(1)} pp`
    : `${sign}${Number.isInteger(d) ? d : d.toFixed(1)}`;
}

function cellText(c: Cell | undefined): string {
  if (c === undefined || c.answered === 0) return "—";
  return `${pct(c.share)} (${c.accepted}/${c.answered})`;
}

function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

function renderSelfInflicted(
  pr: PrSide,
  specs: ReadonlyArray<MetricSpec>,
): string[] {
  const out: string[] = [];
  out.push(
    "",
    "### Self-inflicted",
    "",
    `${judgedSelfInflictedShare(pr, specs) === null ? `${pr.selfInflicted.selfInflicted} of ${pr.selfInflicted.measured} measured threads (share withheld: coverage is ${pr.selfInflicted.eligible === 0 ? "absent" : `below the ${MIN_SELF_INFLICTED_COVERAGE * 100}% floor or the unmeasured threads could move the verdict`})` : `${pct(pr.selfInflicted.share)} of ${pr.selfInflicted.measured} measured threads`} were raised on code written after review began ` +
      `(coverage ${pct(pr.selfInflicted.coverage)} of the ${pr.selfInflicted.eligible} threads raised after the first reviewed head; the rest could not be blamed).`,
  );
  if (pr.selfInflicted.measured > 0) {
    out.push(
      "",
      table(
        ["Cut", "Measured", "Self-inflicted", "Share"],
        [
          ...Object.entries(pr.selfInflicted.byBand).map(([k, c]) => [
            `band \`${k}\` (${c.measured}/${c.eligible} eligible measured, ${pct(c.coverage)})`,
            String(c.measured),
            String(c.selfInflicted),
            c.measured === 0
              ? "not measured"
              : cutShareIsPublishable(pr, c, specs)
                ? pct(c.share)
                : "withheld",
          ]),
          ...pr.selfInflicted.byWeek.map((c) => [
            `week of ${c.week} (${c.days} day${c.days === 1 ? "" : "s"} in window; ${c.measured}/${c.eligible} eligible measured, ${pct(c.coverage)})`,
            String(c.measured),
            String(c.selfInflicted),
            c.measured === 0
              ? "not measured"
              : cutShareIsPublishable(pr, c, specs)
                ? pct(c.share)
                : "withheld",
          ]),
        ],
      ),
    );
  }
  return out;
}

function renderPrSide(pr: PrSide, specs: ReadonlyArray<MetricSpec>): string[] {
  const out: string[] = [];
  out.push(
    "",
    "## PR side",
    "",
    `${pr.prs} merged PRs (${pr.prsWithRounds} with at least one bot-reviewed head) · ` +
      `${pr.threads.total} threads, ${pr.threads.answered} answered, ${pr.threads.unknownRound} with no recoverable round.`,
    "",
    `Bot-reviewed heads per PR: median ${pr.rounds.median ?? "n/a"} · p90 ${pr.rounds.p90 ?? "n/a"} · max ${pr.rounds.max ?? "n/a"}.`,
    "",
    "### Accepted share by round band and severity",
    "",
  );
  const sevs = Object.keys(pr.bySeverity);
  out.push(
    table(
      ["Band", ...sevs, "All"],
      [
        ...Object.entries(pr.byBandSeverity).map(([band, row]) => [
          band,
          ...sevs.map((s) => cellText(row[s])),
          cellText(pr.byBand[band]),
        ]),
        [
          "**all bands**",
          ...sevs.map((s) => cellText(pr.bySeverity[s])),
          cellText(pr.accepted),
        ],
      ],
    ),
    "",
    `Threads raised after the first band: ${judgedLateRoundShare(pr, specs) === null ? `${pr.lateRoundThreadShare.late}/${pr.lateRoundThreadShare.total} with a known round (share withheld: the ${pr.threads.unknownRound} threads with no recoverable round could move the verdict either way)` : `${pct(pr.lateRoundThreadShare.share)} of threads with a known round (${pr.lateRoundThreadShare.late}/${pr.lateRoundThreadShare.total}${pr.threads.unknownRound > 0 ? `; against all ${pr.lateRoundThreadShare.total + pr.threads.unknownRound} threads it lies between ${pct(pr.lateRoundThreadShare.late / (pr.lateRoundThreadShare.total + pr.threads.unknownRound))} and ${pct((pr.lateRoundThreadShare.late + pr.threads.unknownRound) / (pr.lateRoundThreadShare.total + pr.threads.unknownRound))}` : ""})`}.`,
  );
  out.push(...renderSelfInflicted(pr, specs));

  return out;
}

function renderLinearSide(lin: LinearSide): string[] {
  const out: string[] = [];
  const c = lin.cohort;
  out.push(
    "",
    `## Linear side — \`${c.label}\` cohort minted in the window`,
    "",
    table(
      ["Quantity", "Value"],
      [
        [
          "Minted",
          `${c.minted} (${c.mintsPerDay.toFixed(1)}/day over ${c.days} days)`,
        ],
        [
          "Open / closed",
          `${c.open} / ${c.closed} (closure share ${pct(c.closureShare)})`,
        ],
        [
          "Open with no priority",
          `${c.priorityless} (${pct(c.prioritylessShare)})`,
        ],
        ["Open with no parent", String(c.parentless)],
        [
          "Median open age",
          c.medianOpenAgeDays === null ? "n/a" : `${c.medianOpenAgeDays} days`,
        ],
      ],
    ),
    "",
    `Epics: ${lin.epics.open} open (${lin.epics.started} started), ${lin.epics.completed} completed, ${lin.epics.completedInWindow} completed inside the window, ${lin.epics.total} in total.`,
    "",
    "### Debt ledger (the follow-up label ∪ the configured debt project)",
    "",
    "Context, not verdict-bearing: its population is the union, the baseline’s is the label cohort above.",
    "",
    table(
      ["Quantity", "Value"],
      [
        [
          "Ledger",
          `${lin.ledger.total} issues — ${lin.ledger.open} open, ${lin.ledger.closed} closed`,
        ],
        [
          `Flow, trailing ${lin.ledger.windowDays} days`,
          `${lin.ledger.minted} minted (${lin.ledger.mintedPerDay}/day) vs ${lin.ledger.closedInWindow} closed (${lin.ledger.closedPerDay}/day); ratio ${lin.ledger.mintToCloseRatio ?? "n/a"}`,
        ],
        [
          "Open age",
          `median ${lin.ledger.medianOpenAgeDays ?? "n/a"} days, oldest ${lin.ledger.oldestOpenAgeDays ?? "n/a"}`,
        ],
        [
          "Open with no priority",
          `${lin.ledger.priorityless} (${pct(lin.ledger.prioritylessShare)})`,
        ],
      ],
    ),
  );
  if (lin.ledger.truncated.length > 0) {
    out.push(
      "",
      `**Truncated:** ${lin.ledger.truncated.join(", ")} — every ledger count above is a floor.`,
    );
  }
  return out;
}

export function renderScoreboard(sb: Scoreboard): string {
  // The baselines the verdicts were judged against travel in the rows.
  const specs = METRICS.map((m) => {
    const row = sb.metrics.find((r) => r.id === m.id);
    return row === undefined ? m : { ...m, baseline: row.baseline };
  });
  const out: string[] = [
    "# Fractal SDLC scoreboard",
    "",
    `Generated ${sb.generatedAt} · windows end ${sb.window.until} (exclusive)`,
    "",
    `- PR side: \`[${sb.window.pr.since}, …)\` — ${sb.window.pr.days} days`,
    `- Linear cohort: \`[${sb.window.linear.since}, …)\` — ${sb.window.linear.days} days`,
    "",
    "## Verdicts vs the recorded baseline",
    "",
    table(
      ["Metric", "Baseline", "Now", "Δ", "Verdict"],
      sb.metrics.map((m) => [
        m.label,
        formatValue(m.unit, m.baseline),
        `${m.bounded ? "≈" : ""}${formatValue(m.unit, m.current)}`,
        formatDelta(m.unit, m.delta),
        `**${m.verdict}**`,
      ]),
    ),
  ];

  if (sb.pr !== null) out.push(...renderPrSide(sb.pr, specs));
  if (sb.linear !== null) out.push(...renderLinearSide(sb.linear));

  if (sb.mergeConflicts)
    out.push("", renderConflictCoverage(sb.mergeConflicts));
  out.push("", sb.escapeAnchor);
  if (sb.caveats.length > 0) {
    out.push("", "## Caveats", "", ...sb.caveats.map((c) => `- ${c}`));
  }
  return `${out.join("\n")}\n`;
}
