#!/usr/bin/env bun
// Verified-pointer watchdog: why does the `verified` pointer lag the
// integration branch, and what should happen about it?
//
// The problem it catches. Post-merge verification advances the `verified`
// pointer, and deploys ship only what it names. When verification stops
// keeping up, the pointer freezes while the integration branch moves on, and
// nothing fails: "we deploy what was verified" quietly becomes "we deploy
// last week's code". A threshold on how far the pointer trails makes that
// silence loud, but it cannot say what to do: a pointer behind a
// documentation-only tip is fine, a pointer behind a failed verification is
// correctly held, and a pointer behind a push the CI provider never turned
// into a run needs verification started again. This check takes an
// observation of the pointer, the tip and the verification queue, and
// decides by cause. It heals the one cause it can, within a budget of
// attempts, and fails on the causes a person must repair.
//
// Two modes, told apart by the keys the observation carries.
//
// Cause mode, the full decision:
//   ANCESTOR                yes | no   the pointer is an ancestor of the tip
//   CODE_AHEAD              yes | no   `verified..tip` changes a path that
//                                      verification builds or tests
//   UNVERIFIED_AGE_SECONDS  n          seconds since the oldest code-bearing
//                                      change in `verified..tip` reached the
//                                      branch, never the tip's own age: pushes
//                                      landing faster than the grace window
//                                      would otherwise keep a frozen pointer
//                                      within grace forever
//   VERIFICATION            running | succeeded | failed | aborted | none
//                                      the tip's verification runs: running =
//                                      queued or in progress; succeeded = any
//                                      run passed; failed = the newest run
//                                      ended with an explicit failure; aborted
//                                      = the newest run ended without a
//                                      verdict (cancelled, timed out, never
//                                      started); none = no run
//   QUEUE_WAIT_SECONDS      n          the longest any job of a verification
//                                      run has waited for a runner; 0 when
//                                      none waits
//   HEAL_ATTEMPTS           n          optional: verification runs the
//                                      watchdog already dispatched at the tip
//                                      that ended without a conclusive result;
//                                      absent is 0
// ANCESTOR and QUEUE_WAIT_SECONDS are always required, CODE_AHEAD once the
// pointer is an ancestor, and UNVERIFIED_AGE_SECONDS and VERIFICATION once
// code is ahead. Two independent verdicts come out, written as `<key>=<value>` lines
// to the file `--output` names (GitHub's $GITHUB_OUTPUT, a GitLab dotenv
// report), so a workflow can branch on them:
//   queue=ok | stalled
//   pointer=no-code-ahead | verifying | blocked | within-grace
//          | dropped-trigger | heal-exhausted | ran-but-stale | diverged
// The decision:
//   * QUEUE_WAIT_SECONDS over MAX_QUEUE_WAIT_SECONDS: queue=stalled, exit 1.
//     A job timeout counts no time spent waiting for a runner, so a run that
//     never gets one holds the verification slot indefinitely while every
//     newer run waits behind it. Cancel the run that holds the slot and fail:
//     the cancel frees the slot, and the missing runner is a capacity fault
//     only a person can repair. Cancelling bypasses no gate, since the next
//     run verifies the whole unverified range.
//   * ANCESTOR no: pointer=diverged, exit 1. The pointer names a commit the
//     integration branch lacks, so no fast-forward can advance it again.
//     Recover with a back-merge; never force the pointer back.
//   * CODE_AHEAD no: pointer=no-code-ahead, exit 0. What is ahead needs no
//     verification, so the pointer is legitimately where it is.
//   * VERIFICATION running: pointer=verifying, exit 0.
//   * VERIFICATION succeeded: pointer=ran-but-stale, exit 1. Verification
//     passed and the pointer still did not move, so the step that advances it
//     was skipped or is broken. Running it again reproduces the skip, so this
//     is never healed: a person looks.
//   * VERIFICATION failed: pointer=blocked, exit 0. The gates held the
//     pointer back, which is what they are for.
//   * VERIFICATION none or aborted, and UNVERIFIED_AGE_SECONDS at or under
//     GRACE_SECONDS: pointer=within-grace, exit 0. The run may be on its way.
//     The age is the oldest unverified change's, so a steady stream of pushes
//     whose runs are all dropped still leaves the grace once the first of
//     them has waited past it.
//   * VERIFICATION none or aborted, older than the grace: pointer=
//     dropped-trigger, exit 1. The push never became a run, or the run ended
//     without a verdict. The one cause the watchdog heals: start verification
//     again at the tip, which covers the whole unverified range.
//   * The same, with HEAL_ATTEMPTS at or over --max-heal-attempts (default
//     3): pointer=heal-exhausted, exit 1. The heals at this tip keep ending
//     without a verdict, so another dispatch would only repeat them on every
//     scheduled observation: stop healing and page a person.
// The queue is judged before the pointer, and both verdicts are reported: a
// stalled queue makes a "verifying" pointer meaningless, and a heal
// dispatched into a stalled queue waits behind the stall.
//
// Threshold mode, two numbers for a repository that collects no run state:
//   BEHIND         commits the pointer trails the tip, counting only commits
//                  that change a path verification builds or tests
//   AGE_SECONDS    seconds the oldest such commit has waited
// Either or both. The pointer is lagging (exit 1) when a supplied value is
// strictly over MAX_BEHIND or MAX_AGE_SECONDS, fresh (exit 0) otherwise;
// pointer=fresh | lagging.
//
// Settings, from the environment and validated up front, because a bad
// threshold would corrupt every verdict; an unset or empty one is its
// default: MAX_QUEUE_WAIT_SECONDS (2700), GRACE_SECONDS (1200), MAX_BEHIND
// (20), MAX_AGE_SECONDS (86400). The heal budget is an option instead,
// --max-heal-attempts, a positive integer (3), checked the same way.
//
// Input. Observations arrive as environment variables named as above, or as
// an input file of `<KEY> <value>` lines (blank lines and `#` comments are
// ignored) passed as the one positional argument. An observation key set to
// the empty string in the environment is present with a value of the wrong
// shape, not absent: an optional HEAL_ATTEMPTS a collector failed to count
// must not read as 0. A key given twice, in the file or in both the file and
// the environment, is an error: two observations that disagree could hide a
// stall. Keys of both modes in one observation, an unknown key, a value of the
// wrong shape, a missing required key or no observation at all exit 2: input
// the check could not read never passes.
//
// Exit codes: 0 nothing to do, 1 something must act (a heal, a cancel or a
// person), 2 usage or input error.
//
// Usage:
//   check-verified-fresh.ts [--output <file>] [--max-heal-attempts <n>]
//                           [observation.txt]
//   ANCESTOR=yes CODE_AHEAD=yes UNVERIFIED_AGE_SECONDS=2400 VERIFICATION=none \
//     QUEUE_WAIT_SECONDS=0 check-verified-fresh.ts --output "$GITHUB_OUTPUT"
//   BEHIND=3 AGE_SECONDS=3600 check-verified-fresh.ts
import { appendFileSync, readFileSync } from "node:fs";
import { cli, strictOptions } from "../../../../lib/cli.ts";
import {
  couldNotCheck,
  type Finding,
  reportFindings,
} from "../../../../lib/findings.ts";

const GATE = "verified-pointer";
const usage =
  "usage: check-verified-fresh.ts [--output <file>] [--max-heal-attempts <n>] [observation.txt]";

const CAUSE_KEYS = [
  "ANCESTOR",
  "CODE_AHEAD",
  "UNVERIFIED_AGE_SECONDS",
  "VERIFICATION",
  "QUEUE_WAIT_SECONDS",
  "HEAL_ATTEMPTS",
] as const;
const THRESHOLD_KEYS = ["BEHIND", "AGE_SECONDS"] as const;
const KEYS: readonly string[] = [...CAUSE_KEYS, ...THRESHOLD_KEYS];
type Key = (typeof CAUSE_KEYS)[number] | (typeof THRESHOLD_KEYS)[number];
const isKey = (name: string): name is Key => KEYS.includes(name);

const VERIFICATION_STATES = [
  "running",
  "succeeded",
  "failed",
  "aborted",
  "none",
] as const;
type Verification = (typeof VERIFICATION_STATES)[number];
const isVerification = (value: string): value is Verification =>
  (VERIFICATION_STATES as readonly string[]).includes(value);

export type Observation = Partial<Record<Key, string>>;
export type Mode = "cause" | "threshold";

export interface Settings {
  maxQueueWaitSeconds: bigint;
  graceSeconds: bigint;
  maxBehind: bigint;
  maxAgeSeconds: bigint;
  /** Heals dispatched at one tip before the watchdog stops and pages. */
  maxHealAttempts: bigint;
}

export type Queue = "ok" | "stalled";
export type Pointer =
  | "no-code-ahead"
  | "verifying"
  | "blocked"
  | "within-grace"
  | "dropped-trigger"
  | "heal-exhausted"
  | "ran-but-stale"
  | "diverged"
  | "fresh"
  | "lagging";

/** A verdict: what to write to `--output`, what to print, and what to fix. */
export interface Verdict {
  /** The `key=value` pairs a workflow branches on, in output order. */
  outputs: [string, string][];
  /** One line per verdict, for the log. */
  lines: string[];
  /** Empty when nothing must act. */
  findings: Finding[];
}

type Env = Record<string, string | undefined>;

// Eighteen digits keeps every value inside the safe range of the arithmetic
// below and refuses a value that overflowed somewhere upstream.
const uint = (value: string) => /^[0-9]{1,18}$/.test(value);
const yesNo = (value: string) => value === "yes" || value === "no";

function readSetting(env: Env, name: string, fallback: string): bigint {
  const raw = env[name] || fallback;
  if (!uint(raw))
    throw new Error(`${name} must be a non-negative integer: ${raw}`);
  return BigInt(raw);
}

const DEFAULT_MAX_HEAL_ATTEMPTS = 3n;

/** The heal budget from `--max-heal-attempts`: a positive integer. */
export function readMaxHealAttempts(raw: string | undefined): bigint {
  if (raw === undefined) return DEFAULT_MAX_HEAL_ATTEMPTS;
  if (!uint(raw) || BigInt(raw) === 0n)
    throw new Error(`--max-heal-attempts must be a positive integer: ${raw}`);
  return BigInt(raw);
}

/** The thresholds, validated before any verdict depends on them. */
export function readSettings(env: Env): Settings {
  return {
    maxQueueWaitSeconds: readSetting(env, "MAX_QUEUE_WAIT_SECONDS", "2700"),
    graceSeconds: readSetting(env, "GRACE_SECONDS", "1200"),
    maxBehind: readSetting(env, "MAX_BEHIND", "20"),
    maxAgeSeconds: readSetting(env, "MAX_AGE_SECONDS", "86400"),
    maxHealAttempts: DEFAULT_MAX_HEAL_ATTEMPTS,
  };
}

/**
 * The observation keys the environment sets, the empty string included: an
 * empty value is a collector that failed to count, never an absent key.
 */
export function envObservation(env: Env): Observation {
  const observation: Observation = {};
  for (const key of [...CAUSE_KEYS, ...THRESHOLD_KEYS]) {
    const value = env[key];
    if (value !== undefined) observation[key] = value;
  }
  return observation;
}

/**
 * The observation an input file adds to `base` (the environment's). A key
 * given twice, in the file or in both sources, is an error rather than a
 * last-one-wins: two observations that disagree could hide a stall.
 */
export function parseObservation(
  text: string,
  source: string,
  base: Observation = {},
): Observation {
  const observation: Observation = { ...base };
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const tokens = (raw.split("#")[0] ?? "").trim().split(/\s+/);
    const [key, value] = tokens;
    if (!key) return;
    const at = `${source}:${index + 1}`;
    if (tokens.length !== 2 || value === undefined)
      throw new Error(`${at}: want '<KEY> <value>', got: ${raw.trim()}`);
    if (!isKey(key))
      throw new Error(
        `${at}: unknown key ${key} (allowed: ${KEYS.join(", ")})`,
      );
    if (seen.has(key)) throw new Error(`${at}: ${key} is given twice`);
    if (key in base)
      throw new Error(
        `${at}: ${key} is given both here and in the environment`,
      );
    seen.add(key);
    observation[key] = value;
  });
  return observation;
}

/** Which decision the observation asks for; keys of both modes are an error. */
export function modeOf(observation: Observation): Mode {
  const cause = CAUSE_KEYS.some((key) => observation[key] !== undefined);
  const threshold = THRESHOLD_KEYS.some(
    (key) => observation[key] !== undefined,
  );
  if (cause && threshold)
    throw new Error(
      `an observation carries the keys of one mode, the cause keys (${CAUSE_KEYS.join(", ")}) or the threshold keys (${THRESHOLD_KEYS.join(", ")}), not both`,
    );
  if (!cause && !threshold)
    throw new Error(
      "no observation given: set the cause keys, or BEHIND and/or AGE_SECONDS, in the environment or in an input file",
    );
  return cause ? "cause" : "threshold";
}

/** Throw unless every supplied value has the shape its key demands. */
export function checkShape(observation: Observation): void {
  for (const key of [
    "UNVERIFIED_AGE_SECONDS",
    "QUEUE_WAIT_SECONDS",
    "HEAL_ATTEMPTS",
    "BEHIND",
    "AGE_SECONDS",
  ] as const) {
    const value = observation[key];
    if (value !== undefined && !uint(value))
      throw new Error(`${key} must be a non-negative integer: ${value}`);
  }
  for (const key of ["ANCESTOR", "CODE_AHEAD"] as const) {
    const value = observation[key];
    if (value !== undefined && !yesNo(value))
      throw new Error(`${key} must be yes or no: ${value}`);
  }
  const state = observation.VERIFICATION;
  if (state !== undefined && !isVerification(state))
    throw new Error(
      `VERIFICATION must be one of ${VERIFICATION_STATES.join(", ")}: ${state}`,
    );
}

function required(observation: Observation, key: Key, when: string): string {
  const value = observation[key];
  if (value === undefined) throw new Error(`${key} is required ${when}`);
  return value;
}

/** The queue verdict: a job waiting for a runner past the bound is a stall. */
function judgeQueue(
  observation: Observation,
  settings: Settings,
  verdict: Verdict,
): void {
  const wait = BigInt(
    required(observation, "QUEUE_WAIT_SECONDS", "in cause mode"),
  );
  const bound = settings.maxQueueWaitSeconds;
  if (wait > bound) {
    verdict.outputs.push(["queue", "stalled"]);
    verdict.lines.push(
      `queue: stalled, a verification job has waited ${wait}s for a runner (max ${bound}s)`,
    );
    verdict.findings.push({
      rule: "queue-stalled",
      problem: `a verification job has waited ${wait}s for a runner (max ${bound}s); its timeout has not started, and the run holds the slot every newer run waits for.`,
      remedy:
        "cancel the run that holds the slot (no gate is bypassed: the next run verifies the whole range) and restore runner capacity; a stalled heal dispatch means the recovery path itself cannot get a runner.",
    });
    return;
  }
  verdict.outputs.push(["queue", "ok"]);
  verdict.lines.push(`queue: ok, longest runner wait ${wait}s (max ${bound}s)`);
}

/** The pointer verdict for a tip that has code the pointer has not verified. */
function judgeVerification(
  observation: Observation,
  settings: Settings,
): { pointer: Pointer; line: string; finding?: Finding } {
  const state = required(
    observation,
    "VERIFICATION",
    "when CODE_AHEAD is yes",
  ) as Verification;
  const age = BigInt(
    required(observation, "UNVERIFIED_AGE_SECONDS", "when CODE_AHEAD is yes"),
  );
  if (state === "running")
    return {
      pointer: "verifying",
      line: "verification is running for the tip",
    };
  if (state === "failed")
    return {
      pointer: "blocked",
      line: "verification failed for the tip, so the gates held the pointer back",
    };
  if (state === "succeeded")
    return {
      pointer: "ran-but-stale",
      line: "verification succeeded for the tip and the pointer did not move",
      finding: {
        rule: "ran-but-stale",
        problem:
          "verification succeeded for the tip, yet the pointer did not move: the step that advances it was skipped or is broken.",
        remedy:
          "a person looks at the advance step of the verification run; do not run verification again, which reproduces the skip.",
      },
    };
  const grace = settings.graceSeconds;
  if (age <= grace)
    return {
      pointer: "within-grace",
      line: `the tip has no conclusive verification run yet, and the oldest unverified change is ${age}s old (grace ${grace}s)`,
    };
  const attempts = BigInt(observation.HEAL_ATTEMPTS ?? "0");
  const budget = settings.maxHealAttempts;
  if (attempts >= budget)
    return {
      pointer: "heal-exhausted",
      line: `the tip has no conclusive verification run, the oldest unverified change is ${age}s old, and ${attempts} heals at the tip ended without one (budget ${budget})`,
      finding: {
        rule: "heal-exhausted",
        problem: `the oldest unverified change is ${age}s old and the tip has no conclusive verification run, and the ${attempts} verification runs dispatched to heal it all ended without a verdict (budget ${budget}): dispatching again would only repeat them.`,
        remedy:
          "a person looks at why the dispatched runs end without a verdict (cancelled, timed out, never started); do not dispatch again until that is repaired.",
      },
    };
  return {
    pointer: "dropped-trigger",
    line: `the tip has no conclusive verification run, and the oldest unverified change is ${age}s old (grace ${grace}s)`,
    finding: {
      rule: "dropped-trigger",
      problem: `the oldest unverified change is ${age}s old and the tip has no conclusive verification run (grace ${grace}s): its push never became a run, or the run ended without a verdict.`,
      remedy: `heal it: dispatch verification at the tip, which covers the whole unverified range (heal ${attempts + 1n} of ${budget}).`,
    },
  };
}

/** The pointer verdict: divergence, nothing to verify, or the run's state. */
function judgePointer(
  observation: Observation,
  settings: Settings,
  verdict: Verdict,
): void {
  const ancestor = required(observation, "ANCESTOR", "in cause mode");
  if (ancestor === "no") {
    verdict.outputs.push(["pointer", "diverged"]);
    verdict.lines.push("pointer: diverged, it is not an ancestor of the tip");
    verdict.findings.push({
      rule: "diverged",
      problem:
        "the verified pointer is not an ancestor of the tip: it names a commit the integration branch lacks, so no fast-forward can advance it again.",
      remedy:
        "contain first (until shown otherwise, a divergence is a leaked writer credential or a broken workflow), then back-merge: a commit on the integration branch with its own tree and the pointer's tip as second parent restores ancestry without merging the diverged content. Never force the pointer back.",
    });
    return;
  }
  const codeAhead = required(observation, "CODE_AHEAD", "when ANCESTOR is yes");
  if (codeAhead === "no") {
    verdict.outputs.push(["pointer", "no-code-ahead"]);
    verdict.lines.push(
      "pointer: no-code-ahead, nothing ahead of it changes a path verification builds or tests",
    );
    return;
  }
  const { pointer, line, finding } = judgeVerification(observation, settings);
  verdict.outputs.push(["pointer", pointer]);
  verdict.lines.push(`pointer: ${pointer}, ${line}`);
  if (finding) verdict.findings.push(finding);
}

/** Cause mode: the queue first, then the pointer; both verdicts are reported. */
export function decideByCause(
  observation: Observation,
  settings: Settings,
): Verdict {
  const verdict: Verdict = { outputs: [], lines: [], findings: [] };
  judgeQueue(observation, settings, verdict);
  judgePointer(observation, settings, verdict);
  return verdict;
}

/** Threshold mode: either supplied lag strictly over its bound is a lag. */
export function decideByThreshold(
  observation: Observation,
  settings: Settings,
): Verdict {
  const verdict: Verdict = { outputs: [], lines: [], findings: [] };
  const { BEHIND: behind, AGE_SECONDS: age } = observation;
  if (behind !== undefined && BigInt(behind) > settings.maxBehind)
    verdict.findings.push({
      rule: "pointer-lagging",
      problem: `the verified pointer trails the tip by ${behind} code-bearing commits (max ${settings.maxBehind}).`,
      remedy:
        "find out why verification stopped keeping up, or collect the cause keys so this check can decide for you.",
    });
  if (age !== undefined && BigInt(age) > settings.maxAgeSeconds)
    verdict.findings.push({
      rule: "pointer-lagging",
      problem: `the oldest unverified code-bearing commit has waited ${age}s (max ${settings.maxAgeSeconds}s).`,
      remedy:
        "find out why verification stopped keeping up, or collect the cause keys so this check can decide for you.",
    });
  const pointer: Pointer = verdict.findings.length ? "lagging" : "fresh";
  verdict.outputs.push(["pointer", pointer]);
  verdict.lines.push(
    `pointer: ${pointer}, behind ${behind ?? "n/a"} (max ${settings.maxBehind}), age ${age ?? "n/a"}s (max ${settings.maxAgeSeconds}s)`,
  );
  return verdict;
}

interface Options {
  output: string | undefined;
  maxHealAttempts: string | undefined;
  path: string | undefined;
}

/** The output file and the one input from the arguments; throw with the usage on any other shape. */
function parseArgs(args: string[]): Options {
  const { values, positionals } = strictOptions(
    {
      args,
      options: {
        output: { type: "string" },
        "max-heal-attempts": { type: "string" },
      },
      allowPositionals: true,
    },
    usage,
  );
  if (positionals.length > 1) throw new Error(`more than one input\n${usage}`);
  return {
    output: values.output,
    maxHealAttempts: values["max-heal-attempts"],
    path: positionals[0],
  };
}

/** The verdict for the arguments and environment; throws on unusable input. */
export function decide(
  args: string[],
  env: Env,
): Verdict & { output?: string } {
  const { output, maxHealAttempts, path } = parseArgs(args);
  const settings = {
    ...readSettings(env),
    maxHealAttempts: readMaxHealAttempts(maxHealAttempts),
  };
  let observation = envObservation(env);
  if (path !== undefined)
    observation = parseObservation(
      readFileSync(path, "utf8"),
      path,
      observation,
    );
  const mode = modeOf(observation);
  checkShape(observation);
  const verdict =
    mode === "cause"
      ? decideByCause(observation, settings)
      : decideByThreshold(observation, settings);
  return output === undefined ? verdict : { ...verdict, output };
}

export function main(
  args = process.argv.slice(2),
  env: Env = process.env,
): number {
  let verdict: ReturnType<typeof decide>;
  try {
    verdict = decide(args, env);
  } catch (error) {
    return couldNotCheck(
      GATE,
      error instanceof Error ? error.message : String(error),
      env,
    );
  }
  if (verdict.output !== undefined)
    appendFileSync(
      verdict.output,
      verdict.outputs.map(([key, value]) => `${key}=${value}\n`).join(""),
    );
  for (const line of verdict.lines) console.log(line);
  if (verdict.findings.length) {
    reportFindings(verdict.findings, env);
    console.log(
      `FAIL — ${verdict.findings.map((finding) => finding.rule).join(", ")}: see the findings above`,
    );
    return 1;
  }
  console.log("OK — nothing to do");
  return 0;
}

if (import.meta.main) cli(() => main());
