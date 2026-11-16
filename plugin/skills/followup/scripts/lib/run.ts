/**
 * The per-run ledger: one file per pull request under
 * `.context/scratch/followup/`, holding the merge facts, the arms the run
 * settles and each arm's verdict as it is recorded. `facts` starts a run
 * (a new run for the same pull request starts over), `record` writes one
 * verdict, `settle` reads them all. A pointer to the newest run lets
 * `record` and `settle` leave the pull request out.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMapping } from "../../../../shared/config-layers.ts";
import {
  attempt,
  failed,
  ok,
  type Outcome,
} from "../../../../shared/outcome.ts";
import { FOLLOWUP_VERDICTS } from "../../../../shared/repo-command-shapes.ts";
import { currentIso } from "../../../../shared/time.ts";
import { type ArmPlan, repoArmOf } from "./arms.ts";
import type { Facts } from "./facts.ts";

/** The verdicts, the same list a repository arm's check command prints from. */
export const VERDICTS = FOLLOWUP_VERDICTS;
export type Verdict = (typeof VERDICTS)[number];

export function isVerdict(value: string): value is Verdict {
  return (VERDICTS as readonly string[]).includes(value);
}

/** One arm's verdict, with the evidence that settled it and the items it names. */
export interface ArmVerdict {
  verdict: Verdict;
  evidence: string;
  items: string[];
  at: string;
  /** Who recorded it: the arm's check command, or the agent. */
  by?: "check" | "agent";
  /** The verdict the arm's check command last printed, kept when the agent records after it. */
  check?: Verdict;
}

export interface RunFile {
  schema: 1;
  pr: number;
  startedAt: string;
  facts: Facts;
  arms: ArmPlan;
  verdicts: Partial<Record<string, ArmVerdict>>;
  /** The marker comment `guard` last checked; null until it has. */
  marker: number | null;
}

/** The folder the ledgers live in, under the repository's scratch space. */
export function ledgerDir(root: string): string {
  return join(root, ".context", "scratch", "followup");
}

export function runPath(root: string, pr: number): string {
  return join(ledgerDir(root), `pr-${pr}.json`);
}

function currentPath(root: string): string {
  return join(ledgerDir(root), "current.json");
}

/** Write `data` whole: to a temporary file first, then renamed into place. */
function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(temporary, path);
}

/** Start a run for `facts.pr`: a fresh ledger with no verdict, and the pointer at it. */
export function startRun(root: string, facts: Facts, arms: ArmPlan): RunFile {
  const run: RunFile = {
    schema: 1,
    pr: facts.pr,
    startedAt: currentIso(),
    facts,
    arms,
    verdicts: {},
    marker: null,
  };
  writeRun(root, run);
  writeJson(currentPath(root), { pr: facts.pr });
  return run;
}

export function writeRun(root: string, run: RunFile): void {
  writeJson(runPath(root, run.pr), run);
}

type ReadFailure = "no-run" | "unreadable";

/** The pull request the newest run is for. */
function currentPr(root: string): Outcome<number, ReadFailure> {
  const read = attempt("no-run", "no follow-up run has started here", () =>
    JSON.parse(readFileSync(currentPath(root), "utf8")),
  );
  if (!read.ok)
    return failed(
      "no-run",
      "no follow-up run has started here: run facts <PR> first",
    );
  const pr = isMapping(read.value) ? read.value.pr : undefined;
  return typeof pr === "number" && Number.isSafeInteger(pr)
    ? ok(pr)
    : failed("unreadable", `${currentPath(root)} names no pull request`);
}

/** The run for `pr`, or for the newest run's pull request when `pr` is null. */
export function readRun(
  root: string,
  pr: number | null,
): Outcome<RunFile, ReadFailure> {
  const which = pr === null ? currentPr(root) : ok(pr);
  if (!which.ok) return which;
  const path = runPath(root, which.value);
  const read = attempt("unreadable", `${path} cannot be read`, (): unknown =>
    JSON.parse(readFileSync(path, "utf8")),
  );
  if (!read.ok)
    return failed(
      "no-run",
      `no follow-up run for PR #${which.value}: run facts ${which.value} first`,
    );
  return isLedger(read.value, which.value)
    ? ok(read.value)
    : failed("unreadable", `${path} is not a follow-up ledger`);
}

/** Whether `value` reads as the ledger of `pr`'s run. */
function isLedger(value: unknown, pr: number): value is RunFile {
  return (
    isMapping(value) &&
    value.schema === 1 &&
    value.pr === pr &&
    [value.facts, value.arms, value.verdicts].every(isMapping)
  );
}

/** Words that say no fact was checked: never evidence on their own. */
const NO_EVIDENCE = /^(?:nothing(?: found)?|none|n\/a|ok|fine|-)[.!]?$/i;

export type RecordFailure =
  | "empty-evidence"
  | "unknown-arm"
  | "skipped-arm"
  | "bad-verdict"
  | "check-first"
  | "check-overruled";

/**
 * Why the agent may not record `verdict` on a repository arm with a check
 * command; null when it may. The check reads the verdict first; after it,
 * the agent may add what it carried out or filed, but never turn what the
 * check found owed, pending or unread into not owed: it runs the check
 * again instead.
 */
function checkRule(
  run: RunFile,
  arm: string,
  verdict: Verdict,
): Outcome<never, RecordFailure> | null {
  if (!repoArmOf(run.arms, arm)?.checkCommand) return null;
  const checked = run.verdicts[arm]?.check;
  if (checked === undefined)
    return failed(
      "check-first",
      `${arm} has a check command, which reads its verdict: run check ${arm} first`,
    );
  if (verdict === "not-owed" && checked !== "not-owed")
    return failed(
      "check-overruled",
      `${arm}: its check command found it ${checked}; run check ${arm} again rather than recording it not-owed`,
    );
  return null;
}

/** `run` with `arm`'s verdict recorded; refused when the evidence is empty or the arm is not one the run settles. */
export function recordVerdict(
  run: RunFile,
  arm: string,
  verdict: string,
  evidence: string,
  items: readonly string[],
  by: "check" | "agent" = "agent",
): Outcome<RunFile, RecordFailure> {
  if (!isVerdict(verdict))
    return failed(
      "bad-verdict",
      `${JSON.stringify(verdict)} is no verdict: one of ${VERDICTS.join(", ")}`,
    );
  const skipped = run.arms.skipped.find((s) => s.id === arm);
  if (skipped !== undefined)
    return failed(
      "skipped-arm",
      `${arm} is not an arm of this run: ${skipped.reason}`,
    );
  const id = run.arms.apply.find((a) => a === arm);
  if (id === undefined)
    return failed(
      "unknown-arm",
      `${JSON.stringify(arm)} is not an arm of this run (${run.arms.apply.join(", ")})`,
    );
  const refused = by === "agent" ? checkRule(run, id, verdict) : null;
  if (refused !== null) return refused;
  const text = evidence.trim();
  if (text === "" || NO_EVIDENCE.test(text))
    return failed(
      "empty-evidence",
      `${arm}: a verdict needs its evidence, the checkable fact that settled it; "nothing found" is none`,
    );
  const named = items.map((i) => i.trim()).filter((i) => i !== "");
  const check = by === "check" ? verdict : run.verdicts[id]?.check;
  return ok({
    ...run,
    verdicts: {
      ...run.verdicts,
      [id]: {
        verdict,
        evidence: text,
        items: named,
        at: currentIso(),
        by,
        ...(check === undefined ? {} : { check }),
      },
    },
  });
}
