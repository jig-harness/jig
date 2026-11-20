/**
 * Settle a run: one report row per arm, and how the run ends. It refuses to
 * end while an arm the run settles has no verdict, naming the arm, so a
 * pass cannot record done with an arm it never looked at.
 *
 * How a run ends, from its verdicts:
 * - a preview ends as a preview: it carried out nothing and claims nothing;
 * - any arm `unread` ends it `failed`: an obligation nobody could read is
 *   not known to be settled, and a person decides whether to run it again;
 * - otherwise any arm `pending` ends it as a wait: something settles by
 *   itself (a deploy, a release run) and the follow-up looks again later;
 * - otherwise it is `done`.
 */
import { failed, ok, type Outcome } from "../../../../shared/outcome.ts";
import { armTags } from "../../../../dispatch/lib/followup-waits.ts";
import { armTitle, repoArmOf } from "./arms.ts";
import type { RunFile, Verdict } from "./run.ts";

export type Ending = "done" | "wait" | "failed" | "preview";

/** One row of the report. */
export interface ReportRow {
  arm: string;
  title: string;
  /** A core arm, or one the repository declares in `followup.arms`. */
  source: "core" | "repository";
  verdict: Verdict | "skipped";
  items: string[];
  evidence: string;
}

export interface Settled {
  pr: number;
  mode: RunFile["facts"]["mode"];
  ending: Ending;
  rows: ReportRow[];
  /** The arms whose verdict decided a `wait` or `failed` ending. */
  because: string[];
  marker: number | null;
}

/** Whether `arm` is one of the run's repository arms. */
function sourceOf(run: RunFile, arm: string): ReportRow["source"] {
  return repoArmOf(run.arms, arm) === undefined ? "core" : "repository";
}

/** The run's report and ending; refused, naming the arms, while an arm has no verdict. */
export function settle(run: RunFile): Outcome<Settled, "unsettled"> {
  const missing = run.arms.apply.filter((a) => run.verdicts[a] === undefined);
  if (missing.length > 0)
    return failed(
      "unsettled",
      `not settled: ${missing.map((a) => `${a} (${armTitle(a, run.arms)})`).join(", ")} ${missing.length === 1 ? "has" : "have"} no verdict; record one for each before the run ends`,
    );
  const rows = reportRows(run);
  const { ending, because } = endingOf(run.facts.mode, rows);
  return ok({
    pr: run.pr,
    mode: run.facts.mode,
    ending,
    rows,
    because,
    marker: run.marker,
  });
}

/** One row per arm the run settled, then one per arm it skipped. */
function reportRows(run: RunFile): ReportRow[] {
  const settled = run.arms.apply.flatMap((arm) => {
    const v = run.verdicts[arm];
    return v === undefined
      ? []
      : [
          {
            arm,
            title: armTitle(arm, run.arms),
            source: sourceOf(run, arm),
            // What the arm's check left unread or pending stands until a
            // later check answers.
            verdict:
              v.check === "unread" || v.check === "pending"
                ? v.check
                : v.verdict,
            items: v.items,
            evidence: v.evidence,
          },
        ];
  });
  const skipped = run.arms.skipped.map((s) => ({
    arm: s.id,
    title: armTitle(s.id, run.arms),
    source: sourceOf(run, s.id),
    verdict: "skipped" as const,
    items: [],
    evidence: s.reason,
  }));
  return [...settled, ...skipped];
}

/** How a run of `mode` with these rows ends, and the arms that decided a wait or a failure. */
function endingOf(
  mode: RunFile["facts"]["mode"],
  rows: readonly ReportRow[],
): { ending: Ending; because: string[] } {
  const having = (verdict: Verdict) =>
    rows.filter((r) => r.verdict === verdict).map((r) => r.arm);
  if (mode === "preview") return { ending: "preview", because: [] };
  const unread = having("unread");
  if (unread.length > 0) return { ending: "failed", because: unread };
  const pending = having("pending");
  return pending.length > 0
    ? { ending: "wait", because: pending }
    : { ending: "done", because: [] };
}

const VERDICT_WORDS: Record<ReportRow["verdict"], string> = {
  owed: "OWED",
  "not-owed": "NOT OWED",
  pending: "PENDING",
  unread: "UNREAD",
  skipped: "skipped",
};

/** A table cell's text: one line, its pipes escaped. */
function cell(text: string): string {
  // Escape a backslash first: otherwise an input ending in `\\` can escape
  // the escape we add for a following table delimiter.
  return text
    .replace(/\s+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .trim();
}

/** The report as Markdown: the table, then how to end the run. */
export function renderSettled(s: Settled): string {
  const owed = s.rows.filter((r) => r.verdict === "owed");
  const lines = [
    `Follow-up of PR #${s.pr} (${s.mode === "preview" ? "preview, before the merge" : "after the merge"})`,
    "",
    "| Arm | Verdict | Items | Evidence |",
    "|---|---|---|---|",
    ...s.rows.map(
      (r) =>
        `| ${cell(r.title)} (\`${r.arm}\`) | ${VERDICT_WORDS[r.verdict]} | ${cell(r.items.join(", ")) || "—"} | ${cell(r.evidence)} |`,
    ),
    "",
    owed.length === 0 && s.ending === "done"
      ? "Nothing is owed."
      : `Owed: ${owed.length === 0 ? "none" : owed.map((r) => r.arm).join(", ")}.`,
    "",
    ...endingLines(s),
  ];
  return lines.join("\n");
}

/** The longest arm text `jig dispatch result … --arm` takes. */
const ARM_MAX = 200;

/** A workflow run's link on the forge, as a deploy arm carries it. */
const RUN_LINK_TEXT =
  /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d{1,19}(?!\d)/g;

/** The pending arms and what each waits for, in one line short enough for `--arm`. */
export function pendingArm(s: Settled): string {
  const text = s.rows
    .filter((r) => r.verdict === "pending")
    .map((r) => `${r.arm}: ${r.evidence.replace(/\s+/g, " ").trim()}`)
    .join("; ");
  if (text.length <= ARM_MAX) return text;
  // The re-read settles an arm only when every tag and run it names is
  // done, so a shortened arm keeps the whole set or names none of it: a
  // partial set would let part of the wait release the rest.
  const deps = [...armTags(text), ...new Set(text.match(RUN_LINK_TEXT) ?? [])];
  const depText = deps.join(" ");
  const fits = depText.length <= ARM_MAX - 2;
  // Run links come out as spans, whatever wraps them, before the prose is cut.
  const prose = text
    .replace(RUN_LINK_TEXT, "")
    .split(" ")
    .filter((w) => w !== "" && armTags(w).length === 0)
    .join(" ");
  const room = fits ? ARM_MAX - 2 - depText.length : ARM_MAX - 1;
  let head = prose.slice(0, room);
  // A word the cut ran through is dropped whole.
  if (prose[room] !== undefined && prose[room] !== " ")
    head = head.replace(/\S*$/, "");
  head = head.trimEnd();
  return fits ? `${head}… ${depText}`.trim() : `${head}…`;
}

/** How the session ends the run, for each way it was started. */
function endingLines(s: Settled): string[] {
  const marker = s.marker === null ? "<marker>" : String(s.marker);
  const markerDone = `jig dispatch marker done ${s.pr} --comment ${marker}`;
  const markerFailed = `jig dispatch marker failed ${s.pr} --comment ${marker}`;
  switch (s.ending) {
    case "preview":
      return [
        "End: preview. Nothing was carried out and nothing is claimed: put the owed rows in the pull request's description (its `## Out-of-tree follow-ups` section for steps a person takes) so the post-merge run checks a list instead of rebuilding it.",
      ];
    case "done":
      return [
        "End: done.",
        `- Run by hand, with the marker this run claimed: ${markerDone}`,
        "- Started by the dispatcher: record done with the `jig dispatch result` command your prompt names.",
      ];
    case "wait":
      return [
        `End: a wait, on ${s.because.join(", ")} (each settles by itself; the follow-up looks again later).`,
        `- Run by hand: report each pending arm and leave the marker open: it keeps the claim, and a done marker would hold against the later run. Once the arm can settle, run the follow-up again with this marker (${marker}) instead of claiming a new one, and end it as the settled ending says`,
        `- Started by the dispatcher: report each pending arm, then record \`waits --until <when to look again> --reason pending --arm "<arm>"\` with the \`jig dispatch result\` command your prompt names, the time at most a day ahead and the arm in one line: ${pendingArm(s)}`,
      ];
    case "failed":
      return [
        `End: failed, on ${s.because.join(", ")} (unread: nobody could tell whether the merge owes it).`,
        `- Run by hand: ${markerFailed}, and say what could not be read`,
        "- Started by the dispatcher: record failed with the `jig dispatch result` command your prompt names",
      ];
  }
}
