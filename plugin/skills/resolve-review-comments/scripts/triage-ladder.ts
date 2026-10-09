#!/usr/bin/env bun
/**
 * Resolve one otherwise-`accepted` review finding against the escalating
 * decline ladder (TASK) — the mechanical read behind the triage rubric's
 * § The decline ladder.
 *
 * Usage:
 *   triage-ladder.ts --severity <sev> --tier <1-4> --category <cat|unknown>
 *                    --self-inflicted true|false|unknown
 *                    [--round N | --pr N] [--obligatory] [--config PATH]
 *
 *   --severity        `blocker` | `high` | `medium` | `low` | `unknown`, as
 *                     `severityOf` in drive-pr's summary-findings.ts reports
 *                     it. REQUIRED — passing it wrong is a usage error, not a
 *                     silent `unknown`.
 *   --tier            the rubric's priority tier the finding sits in: 1
 *                     CI/quality gates, 2 production code, 3 docs, 4 tests
 *                     (a VACUOUS test is tier 1, not 4). REQUIRED and always
 *                     knowable — it is the rubric's own first question — so it
 *                     is not defaulted: an omitted tier would silently remove
 *                     the standing safety net that keeps tier-1/2 findings
 *                     accepted while category emission is still pending.
 *   --category        a `categories` token from the config, or `unknown` when
 *                     the reviewer emitted no category tag (the answer for
 *                     every finding until TASK/TASK ship emission and
 *                     parsing). REQUIRED — an omitted flag must not be
 *                     indistinguishable from the explicit `unknown` a caller
 *                     passes when the finding genuinely carries none; a
 *                     category can only ever ADMIT, so silently defaulting it
 *                     here can wrongly decline a finding whose real category
 *                     should have admitted it (chatgpt-codex-connector,
 *                     a reference-implementation pull request). Validated against the LOADED config's own
 *                     vocabulary once it is known — an unrecognised token is a
 *                     usage error, not a silent abstention that can decline a
 *                     finding on a typo.
 *   --self-inflicted  self-inflicted.ts's answer for this finding's anchor.
 *                     REQUIRED — an omitted flag must not be indistinguishable
 *                     from the explicit `unknown` a caller passes when the
 *                     anchor genuinely was not measured; the rubric requires
 *                     this measurement for every finding. `unknown` is `null`,
 *                     NOT `false` — see the abstention it produces in the
 *                     output.
 *   --round           the round ordinal. Omit to read it mechanically from
 *                     `current-round.ts` (never from session memory).
 *   --pr              the PR to read the round for, when `--round` is omitted.
 *                     Defaults to the current branch's PR.
 *   --obligatory      the work must eventually happen, so a decline is
 *                     `deferred` (with a follow-up per deferral-protocol.md)
 *                     rather than `wont-fix`. The obligation boundary is the
 *                     rubric's and is unchanged by the ladder.
 *   --config          override the config path (tests; a checked-out variant).
 *
 * Prints ONE JSON object on stdout. The fields a caller acts on:
 *
 *   stance       `accepted` (post the ordinary accepted reply and fix it) or
 *                `declined` (post `reply` verbatim).
 *   reply        the ready-to-post body for a decline, `null` otherwise. For a
 *                `deferred` decline the caller appends the follow-up issue
 *                link per deferral-protocol.md — this script does not file it.
 *   minimalDiff  `true` once an escalated band is in force: fix the finding
 *                with the smallest change that resolves it, no opportunistic
 *                refactor. The mandatory sibling sweep is unaffected.
 *   anomalies    every fail-open reason, never silent. A non-empty list on an
 *                `accepted` stance means the ladder did not arm, which is the
 *                pre-ladder rubric's own answer and not an error.
 *
 * Exit codes:
 *   0  a verdict was printed — INCLUDING an inert one. Fail-open is an answer.
 *   2  usage error.
 *
 * The ladder never exits nonzero for a config or round problem: it only ever
 * declines findings, so every uncertainty resolves toward `accepted` and says
 * why. A caller that treated an unreadable config as a hard failure would stop
 * a drive over a rule whose entire job is damping.
 *
 * On Windows, invoke through the runtime (`bun triage-ladder.ts …`) — a
 * shebang only carries the POSIX direct-execution path.
 */

import { join } from "node:path";
import {
  fail,
  isDigits,
  isEntryPoint,
  isSafeDigits,
  runMain,
} from "./lib/cli.ts";
import {
  CANONICAL_SEVERITIES,
  CATEGORY_UNKNOWN,
  defaultConfigPath,
  type LadderInput,
  loadLadder,
  MAX_TIER,
  MIN_TIER,
  resolveStance,
  SEVERITY_UNKNOWN,
} from "./lib/ladder.ts";
import { type RunResult, resolvePr, run } from "./lib/proc.ts";

const CURRENT_ROUND = join(import.meta.dirname, "current-round.ts");

/** The exact tokens `severityOf` (drive-pr/scripts/summary-findings.ts) can
 * produce — a malformed value (`urgent`, a typo) must not silently reach the
 * ladder as if it were a real severity: an unrecognised token abstains rather
 * than going through fail_open.inert_when_unknown's louder inert path, which
 * can turn an otherwise-accepted finding into a decline for no reason but a
 * bad CLI argument. */
const VALID_SEVERITIES = [...CANONICAL_SEVERITIES, SEVERITY_UNKNOWN];

/**
 * Pure interpretation of `current-round.ts`'s process result, split out from
 * `readRound` so the case that used to be silently dropped — a SUCCESSFUL
 * exit that still carries an anomaly on stderr — is unit-testable without a
 * subprocess or a fake git dir.
 *
 * current-round.ts can exit 0 with a genuine ordinal on stdout (it takes the
 * max of two counters) while still reporting on stderr that ONE of those
 * counters was unreadable or corrupt. A wrapper that only looks at stderr
 * after a nonzero exit never sees that: a valid ordinal from the other
 * counter arms the ladder and can decline a finding with no trace that part
 * of the round state was unreadable.
 */
function interpretRoundResult(
  r: Pick<RunResult, "code" | "stdout" | "stderr" | "timedOut">,
): [number, string] {
  if (r.code !== 0) {
    const why = r.timedOut ? "timed out" : `exited ${r.code}`;
    return [
      0,
      `current-round.ts ${why} — reading round 0, so the ladder does not arm this pass`,
    ];
  }
  const out = r.stdout.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(out) || !Number.isSafeInteger(Number(out))) {
    return [
      0,
      `current-round.ts printed ${JSON.stringify(out)}, not an ordinal — reading round 0, so the ladder does not arm this pass`,
    ];
  }
  const round = Number.parseInt(out, 10);
  const relayed = r.stderr.trim();
  if (relayed !== "") {
    return [
      round,
      `current-round.ts (round ${round} still used): ${relayed.replaceAll("\n", " / ")}`,
    ];
  }
  return [round, ""];
}

/**
 * The round, read the way the rubric requires — mechanically, never recalled.
 * Any failure reads 0, which leaves the ladder inert, and says so: the same
 * fail-open polarity and the same announced-anomaly discipline
 * `current-round.ts` already applies inside itself.
 */
async function readRound(pr: string): Promise<[number, string]> {
  const r = await run(
    [process.execPath, CURRENT_ROUND, ...(pr === "" ? [] : [pr])],
    {
      timeoutSec: 60,
    },
  );
  return interpretRoundResult(r);
}

function takeValue(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    fail(2, `triage-ladder.ts: ${flag} needs a value`);
  }
  return v;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let severity = "";
  let category = "";
  let tierRaw = "";
  let selfInflictedRaw = "";
  let roundRaw = "";
  let pr = "";
  let obligatory = false;
  let configPath = "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--severity":
        severity = takeValue(argv, i, a);
        i += 1;
        break;
      case "--category":
        category = takeValue(argv, i, a);
        i += 1;
        break;
      case "--tier":
        tierRaw = takeValue(argv, i, a);
        i += 1;
        break;
      case "--self-inflicted":
        selfInflictedRaw = takeValue(argv, i, a);
        i += 1;
        break;
      case "--round":
        roundRaw = takeValue(argv, i, a);
        i += 1;
        break;
      case "--pr":
        pr = takeValue(argv, i, a);
        i += 1;
        break;
      case "--config":
        configPath = takeValue(argv, i, a);
        i += 1;
        break;
      case "--obligatory":
        obligatory = true;
        break;
      default:
        fail(
          2,
          `triage-ladder.ts: unknown argument: ${a}`,
          "usage: triage-ladder.ts --severity <sev> --tier <1-4> --category <cat|unknown>",
          "                       --self-inflicted true|false|unknown",
          "                       [--round N | --pr N] [--obligatory] [--config PATH]",
        );
    }
  }

  if (severity === "") {
    fail(
      2,
      "triage-ladder.ts: --severity is required (blocker|high|medium|low|unknown).",
      "Pass `unknown` explicitly when the finding carries no severity token — the ladder",
      "then reads its own fail_open.inert_when_unknown to decide, which is not the same",
      "thing as the flag being forgotten.",
    );
  }
  if (!VALID_SEVERITIES.includes(severity)) {
    fail(
      2,
      `triage-ladder.ts: --severity must be one of ${VALID_SEVERITIES.join("|")} (got '${severity}')`,
      "An out-of-domain value would abstain from every band's min_severity clause",
      "silently — that reads as a real, low-ranked severity rather than the malformed",
      "input it is, and can decline a finding for no reason but a bad argument.",
    );
  }
  if (tierRaw === "") {
    fail(
      2,
      "triage-ladder.ts: --tier is required (1 CI/quality gates, 2 production code, 3 docs, 4 tests).",
      "It is the rubric's own first question and is always knowable; defaulting it would",
      "silently remove the clause that keeps tier-1/2 findings accepted in every band.",
    );
  }
  if (
    !isDigits(tierRaw) ||
    Number(tierRaw) < MIN_TIER ||
    Number(tierRaw) > MAX_TIER
  ) {
    fail(
      2,
      `triage-ladder.ts: --tier must be an integer ${MIN_TIER}-${MAX_TIER} (got '${tierRaw}')`,
    );
  }
  if (selfInflictedRaw === "") {
    fail(
      2,
      "triage-ladder.ts: --self-inflicted is required (true|false|unknown).",
      "Pass `unknown` explicitly when self-inflicted.ts did not measure this finding’s",
      "anchor — an omitted flag must not be indistinguishable from that explicit answer,",
      "which is the one case the self_inflicted clause exists to protect (round 2 already",
      "documented this as required without the CLI enforcing it: chatgpt-codex-connector,",
      "PR #4501 round 5).",
    );
  }
  if (
    selfInflictedRaw !== "true" &&
    selfInflictedRaw !== "false" &&
    selfInflictedRaw !== "unknown"
  ) {
    fail(
      2,
      `triage-ladder.ts: --self-inflicted must be true, false, or unknown (got '${selfInflictedRaw}')`,
    );
  }
  if (roundRaw !== "" && !isSafeDigits(roundRaw)) {
    fail(
      2,
      `triage-ladder.ts: --round must be a whole number, safely representable (got '${roundRaw}')`,
      "An unsafe-integer digit string would parse imprecisely or to Infinity and could",
      "select the wrong band instead of the documented fail-open round-0 behavior.",
    );
  }
  if (pr !== "" && !isDigits(pr)) {
    fail(2, `triage-ladder.ts: --pr must be a number (got '${pr}')`);
  }
  if (roundRaw !== "" && pr !== "") {
    fail(
      2,
      "triage-ladder.ts: --round and --pr are exclusive — --round is the answer, --pr is how to read it.",
    );
  }
  if (category === "") {
    fail(
      2,
      `triage-ladder.ts: --category is required (a config category, or '${CATEGORY_UNKNOWN}').`,
      `Pass '${CATEGORY_UNKNOWN}' explicitly when the finding carries no category tag — an`,
      "omitted flag must not be indistinguishable from that explicit answer. A category can",
      "only ever ADMIT a finding, so silently defaulting it here can wrongly decline one whose",
      "real category should have admitted it (chatgpt-codex-connector, a reference-implementation pull request).",
    );
  }

  const anomalies: string[] = [];
  let round: number;
  if (roundRaw !== "") {
    round = Number.parseInt(roundRaw, 10);
  } else {
    const [read, why] = await readRound(await resolvePr(pr));
    round = read;
    if (why !== "") {
      anomalies.push(why);
    }
  }

  const input: LadderInput = {
    round,
    severity,
    category,
    tier: Number.parseInt(tierRaw, 10),
    selfInflicted:
      selfInflictedRaw === "unknown" ? null : selfInflictedRaw === "true",
  };

  const loaded = await loadLadder(
    configPath === "" ? defaultConfigPath() : configPath,
  );
  // A typo'd --category (`securty`) is not the documented `unknown` token,
  // but resolveStance cannot tell them apart: an unrecognised category only
  // abstains from the categories clause, exactly like `unknown` does, which
  // lets a fat-fingered argument reach a real decline instead of being
  // caught as the malformed input it is. The vocabulary is dynamic — this
  // config's own `categories:` list — unlike severity/tier's static domain,
  // so this can only be checked once the config has loaded; skip it when the
  // config itself is unusable, since the ladder is already inert for that
  // reason and there is no vocabulary to validate against.
  if (
    loaded.config !== null &&
    category !== CATEGORY_UNKNOWN &&
    !loaded.config.categories.includes(category)
  ) {
    fail(
      2,
      `triage-ladder.ts: --category must be '${CATEGORY_UNKNOWN}' or one of the config's categories (got '${category}')`,
      `known categories: ${loaded.config.categories.join(", ")}`,
      "An out-of-domain value would abstain from the categories clause silently — indistinguishable",
      "from a real but non-matching category, and can decline a finding for no reason but a typo.",
    );
  }
  const verdict = resolveStance(loaded, input, obligatory);
  verdict.anomalies = [...anomalies, ...verdict.anomalies];
  for (const line of verdict.anomalies) console.error(`triage-ladder: ${line}`);
  console.log(JSON.stringify(verdict, null, 2));
  return 0;
}

if (isEntryPoint(import.meta.url)) runMain("triage-ladder", main);

export { interpretRoundResult, main, readRound };
