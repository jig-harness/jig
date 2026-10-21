#!/usr/bin/env bun
import { definedFields } from "../../../shared/defined-fields.ts";
/**
 * verification-fit.ts — record a verdict on whether the round's demanded
 * validation was worth what it cost.
 *
 * A validation plan built from a change-area catalog fails toward strictness
 * in every uncertain case (unmatched files select the full profile, mixed
 * diffs take the strictest requirement, round-plan.ts's decay fails closed),
 * and nothing measures that bias in aggregate: a full-profile area can demand
 * a Testbox on round after round without anyone recording whether a single
 * one of those boxes ever caught a defect the scoped checks plus required
 * CI would have missed. This script is the measurement channel: the driving
 * agent obeys the emitted plan exactly as emitted, then puts its judgment of
 * the plan ON THE RECORD, with the plan itself as provenance. A calibration
 * pass over the log turns clusters of verdicts into catalog edits.
 *
 * A verdict NEVER changes what a round runs. That one-way valve is what keeps
 * this a calibration instrument rather than a licence to under-validate — the
 * same discipline round-plan.ts's decay applies to itself.
 *
 * Usage (the plan that provoked the verdict arrives on stdin, so provenance
 * cannot be omitted or hand-summarised):
 *
 *   <skill-dir>/scripts/round-plan.ts <PR> --json \
 *     | bun <skill-dir>/scripts/verification-fit.ts <PR> \
 *         --verdict over-strict|proportionate|under-strict \
 *         --area <catalog-area-key> \
 *         --evidence "what the demand did or could not have bought" \
 *         [--suggest "catalog-vocabulary edit, e.g. 'demote <area> to profile: scoped'"] \
 *         [--testbox-outcome pass|fail|hung|infra-error|skipped|not-required] \
 *         [--testbox-minutes N]
 *
 * `--area` is REQUIRED and validated against the consumer's change-area
 * catalog (`drive.change_areas_catalog`) when one is configured — not derived
 * from the plan's
 * `testbox.requiredBy`, which is empty by construction on exactly the verdict
 * that matters most: an `under-strict` record fires because the plan demanded
 * TOO LITTLE, so nothing forced a box and there is no `requiredBy` entry to
 * attribute it to. `--suggest` stays free-form prose for the catalog edit
 * itself; `--area` is the closed-vocabulary key the Calibrate pass clusters
 * and outranks on.
 *
 * Records append as JSON lines to
 *   ${JIG_VERIFICATION_FIT_LOG:-$HOME/.local/state/jig/verification-fit.jsonl}
 * — deliberately OUTSIDE the worktree: a per-PR workspace is archived when
 * its PR merges, and per-PR drive state dies with the clone, but calibration
 * evidence must accumulate ACROSS PRs to mean anything.
 *
 * Retention/classification stance: this log holds
 * operator/agent-authored tooling metadata (PR numbers, branch names, catalog
 * area names, free-form evidence prose) about THIS repository's own CI
 * posture — never customer data, and engineering tooling rather than the
 * product. It has no authority of its own — nothing reads it
 * except the human-reviewed Calibrate pass — so an operator may freely
 * truncate, rotate, or delete the file at any time with no durability
 * requirement on this tool's part. The one operator obligation this stance
 * doesn't relieve: `--evidence`/`--suggest` are free text an agent composes,
 * so don't paste secrets or customer-identifying content into them.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { consumerRoot } from "../../../shared/consumer.ts";
import { loadCatalogFile } from "./lib/change-areas-catalog.ts";
import { readStdinAll } from "./lib/cli.ts";
import { changeAreasCatalogPath } from "./lib/overlay.ts";
import { gitIdentityEnv, run, tsArgv } from "./lib/proc.ts";
import { isRecord as isPlainObject } from "../../../shared/guards.ts";

const VERDICTS = ["over-strict", "proportionate", "under-strict"] as const;
type Verdict = (typeof VERDICTS)[number];

const TESTBOX_OUTCOMES = [
  "pass",
  "fail",
  "hung",
  "infra-error",
  "skipped",
  "not-required",
] as const;
type TestboxOutcome = (typeof TESTBOX_OUTCOMES)[number];

function die(message: string): never {
  console.error(`verification-fit: ${message}`);
  process.exit(2);
}

function logPath(): string {
  const override = process.env.JIG_VERIFICATION_FIT_LOG;
  if (override && override.trim() !== "") return override;
  return join(homedir(), ".local", "state", "jig", "verification-fit.jsonl");
}

/**
 * Every subprocess here runs with `lib/proc.ts`'s `gitIdentityEnv` — the one
 * canonical scrub, no longer a private copy of the list.
 *
 * A caller that itself runs inside a git hook (the driving agent's own
 * pre-commit gate, say) has GIT_DIR/GIT_WORK_TREE exported pointing at ITS
 * repository — and those override any `cwd` this process sets, silently
 * redirecting every `git` call below at the wrong repo instead of the one
 * this script is actually reasoning about. That isn't hypothetical: it's
 * exactly how this suite's own throwaway-repo tests failed under the
 * drive-pr-selftest hook — the git
 * commit calls checked the real worktree's history for a sha that only
 * existed in the test's tmpdir repo. The provenance checks below exist
 * specifically to bind `base` to "this repo's actual history"; inheriting an
 * ambient GIT_DIR undermines that guarantee in both directions (a false
 * refusal, as measured, or in principle a false accept against an unrelated
 * repo that happens to share a sha).
 */
async function capture(cmd: string[], cwd?: string): Promise<string | null> {
  const r = await run(cmd, {
    ...definedFields({ cwd }),
    env: gitIdentityEnv(),
    stderr: "ignore",
  });
  if (r.code !== 0) return null;
  const trimmed = r.stdout.trim();
  return trimmed === "" ? null : trimmed;
}

async function commandSucceeds(cmd: string[]): Promise<boolean> {
  const r = await run(cmd, {
    env: gitIdentityEnv(),
    stdout: "ignore",
    stderr: "ignore",
  });
  return r.code === 0;
}

// Git permits an HTTPS remote with embedded userinfo
// (`https://x-access-token:ghp_xxx@github.com/...`), and `git config --get
// remote.origin.url` returns it verbatim — copying a live credential into a
// long-lived file outside the worktree. SSH/scp-like
// remotes (`git@host:owner/repo.git`) don't carry credentials in the address
// itself, so they pass through unchanged; `new URL()` throws on that syntax,
// which is exactly the signal used to leave it alone.
function sanitizeGitRemoteUrl(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed = new URL(raw);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return raw;
  }
}

// ── arguments ────────────────────────────────────────────────────────────────

let prRaw = "";
let verdict: Verdict | "" = "";
let area = "";
let evidence = "";
let suggest: string | null = null;
let testboxOutcome: TestboxOutcome | null = null;
let testboxMinutes: number | null = null;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i] as string;
  const value = (): string => {
    const v = args[++i];
    if (v === undefined) die(`${arg} requires a value`);
    return v;
  };
  switch (arg) {
    case "--verdict": {
      const v = value();
      if (!(VERDICTS as readonly string[]).includes(v))
        die(`--verdict must be one of: ${VERDICTS.join(", ")}`);
      verdict = v as Verdict;
      break;
    }
    case "--area":
      area = value().trim();
      break;
    case "--evidence":
      evidence = value().trim();
      break;
    case "--suggest":
      suggest = value().trim() || null;
      break;
    case "--testbox-outcome": {
      const v = value();
      if (!(TESTBOX_OUTCOMES as readonly string[]).includes(v))
        die(`--testbox-outcome must be one of: ${TESTBOX_OUTCOMES.join(", ")}`);
      testboxOutcome = v as TestboxOutcome;
      break;
    }
    case "--testbox-minutes": {
      const v = Number(value());
      if (!Number.isFinite(v) || v < 0)
        die("--testbox-minutes takes a non-negative number");
      testboxMinutes = v;
      break;
    }
    default:
      if (arg.startsWith("--")) die(`unknown flag: ${arg}`);
      if (prRaw !== "") die(`unexpected argument: ${arg}`);
      prRaw = arg;
  }
}

// A bare digit-string regex would accept "0", leading-zero aliases
// ("00123"), and integers past Number.MAX_SAFE_INTEGER, any of which can
// attach evidence to the wrong PR or serialize a corrupted identifier
//. Parse once, require a genuine positive safe
// integer, and re-derive the canonical (non-padded) string from the parsed
// number rather than trusting the original text.
if (!/^[0-9]+$/.test(prRaw))
  die(
    'usage: round-plan.ts <PR> --json | verification-fit.ts <PR> --verdict V --area A --evidence "..."',
  );
const prNumber = Number(prRaw);
if (!Number.isSafeInteger(prNumber) || prNumber <= 0)
  die("PR number must be a positive integer");
const pr = String(prNumber);

if (verdict === "") die("--verdict is required");
if (area === "")
  die(
    "--area is required — a change-area catalog key (drive.change_areas_catalog)",
  );
// A verdict without evidence is noise the calibration pass cannot act on —
// refuse it here rather than letting it dilute the log.
if (evidence === "") die("--evidence is required and must be non-empty");

// `--area` is validated against the SAME catalog the plan command reads (the
// consumer's `drive.change_areas_catalog`), never a hand-maintained duplicate
// list. A repository without a catalog records the key unchecked, and says so.
const catalogPath = changeAreasCatalogPath(consumerRoot());
if (catalogPath === undefined) {
  console.error(
    "verification-fit: --area not checked: drive.change_areas_catalog is not configured",
  );
} else {
  let knownAreas: Set<string>;
  try {
    knownAreas = new Set(loadCatalogFile(catalogPath).keys());
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
  if (!knownAreas.has(area))
    die(`--area '${area}' is not a known catalog area — see ${catalogPath}`);
}

// ── provenance: the plan on stdin ────────────────────────────────────────────
// Required, not optional: a verdict detached from the plan that provoked it is
// an opinion, and the calibration pass clusters on the plan's `requiredBy`
// areas. Piping `round-plan.ts <PR> --json` is the one supported way in.

const stdinText = (await readStdinAll()).trim();
if (stdinText === "")
  die(
    "no plan on stdin — pipe `round-plan.ts <PR> --json` in; the verdict is recorded with its provenance or not at all",
  );

let parsedStdin: unknown;
try {
  parsedStdin = JSON.parse(stdinText);
} catch {
  die("stdin is not valid JSON — pipe `round-plan.ts <PR> --json` unmodified");
}

// `JSON.parse` succeeding is not provenance: `{}`, `null`, `true`, `42`, and an
// unrelated JSON blob all parse cleanly. Validate the
// actual round-plan.ts shape before trusting any field, so a malformed or
// fabricated payload is a clean refusal here rather than an uncaught crash
// three lines later or silently-accepted garbage in the log.
if (!isPlainObject(parsedStdin))
  die("stdin is not a JSON object — not a round-plan.ts payload");
const plan = parsedStdin;

function requireString(obj: Record<string, unknown>, field: string): string {
  const v = obj[field];
  if (typeof v !== "string" || v === "")
    die(
      `stdin's '${field}' is missing or not a non-empty string — not a round-plan.ts payload`,
    );
  return v as string;
}

const planMode = requireString(plan, "mode");
const planBase = requireString(plan, "base");
if (!Array.isArray(plan.files))
  die(
    "stdin's 'files' is missing or not an array — not a round-plan.ts payload",
  );
if (!isPlainObject(plan.validation))
  die(
    "stdin's 'validation' is missing or not an object — not a round-plan.ts payload",
  );
const validation = plan.validation;
if (!isPlainObject(validation.testbox))
  die(
    "stdin's validation.testbox is missing or not an object — not a round-plan.ts payload",
  );
const testbox = validation.testbox;
if (typeof testbox.required !== "boolean")
  die(
    "stdin's validation.testbox.required is not a boolean — not a round-plan.ts payload (or the plan contract changed)",
  );

// Repo-anchored provenance: `base` must resolve to a real commit THIS clone
// actually has, and that commit must be an ancestor of (or equal to) the
// worktree's current HEAD. This doesn't bind the plan to a specific PR —
// round-plan.ts's JSON carries no PR field to bind to — but it does rule out
// a synthetic or unrelated-repo blob: the plan must describe a diff that
// could genuinely apply to the tree this script is being run against.
if (!(await commandSucceeds(["git", "cat-file", "-e", `${planBase}^{commit}`])))
  die(
    `stdin's base '${planBase}' is not a commit in this clone — not a genuine round-plan.ts payload for this repo`,
  );
if (
  !(await commandSucceeds([
    "git",
    "merge-base",
    "--is-ancestor",
    planBase,
    "HEAD",
  ]))
)
  die(
    `stdin's base '${planBase}' is not an ancestor of HEAD — this plan does not describe the current worktree's diff`,
  );

// Keep the fields the calibration pass reads; drop the command strings, which
// are bulky and derivable from the catalog at the recorded head anyway.
const planExtract = {
  mode: planMode,
  base: planBase,
  empty: plan.empty ?? null,
  fileCount: (plan.files as unknown[]).length,
  seedAreas: plan.seedAreas ?? [],
  profiles: validation.profiles ?? null,
  testbox: {
    required: testbox.required,
    reason: testbox.reason ?? null,
    requiredBy: testbox.requiredBy ?? [],
  },
  testboxDecision: plan.testboxDecision ?? null,
};

// ── context this script gathers itself ───────────────────────────────────────

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const headSha = await capture(["git", "rev-parse", "HEAD"]);
const branch = await capture(["git", "branch", "--show-current"]);
const originUrl = sanitizeGitRemoteUrl(
  await capture(["git", "config", "--get", "remote.origin.url"]),
);
// Best-effort: outside a drive (or with no state yet) this is simply null.
const round = await capture(
  tsArgv(join(scriptsDir, "drive-state.ts"), ["rounds", pr]),
);

const record = {
  v: 1,
  recordedAt: new Date().toISOString(),
  pr: prNumber,
  round: round === null ? null : Number(round),
  headSha,
  branch,
  origin: originUrl,
  verdict,
  area,
  evidence,
  suggest,
  testboxOutcome,
  testboxMinutes,
  plan: planExtract,
};

const target = logPath();
mkdirSync(dirname(target), { recursive: true });
appendFileSync(target, `${JSON.stringify(record)}\n`);

console.log(JSON.stringify(record, null, 2));
console.error(
  `verification-fit: recorded '${verdict}' for PR #${pr} → ${target}`,
);
