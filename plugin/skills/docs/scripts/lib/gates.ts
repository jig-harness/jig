/**
 * Run the skill's gates as their own command lines, the way a hook or CI runs
 * them, and read what each prints into findings by file. Each gate's exit code
 * decides its status: 0 passed, 1 found something, anything else could not
 * check. The readers below follow the output each gate's README documents.
 */
import { join } from "node:path";
import { type RunResult, run, tsArgv } from "../../../../shared/proc.ts";

/** A gate that runs longer than this is stopped and reported as unchecked. */
const GATE_TIMEOUT_SEC = 300;

const SCRIPTS = join(import.meta.dir, "..");

export type Severity = "error" | "warning";

export interface Finding {
  /** Relative to the repository root, with `/` separators. */
  file: string;
  check: string;
  severity: Severity;
  message: string;
  line?: number;
}

/**
 * `ok` passed, `findings` found an error, `warnings` found only warnings,
 * `skipped` did not apply, `failed` could not check.
 */
export type CheckStatus = "ok" | "findings" | "warnings" | "skipped" | "failed";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  findings: Finding[];
}

export interface Gate {
  name: string;
  /** The script, relative to the skill's `scripts/`. */
  script: string;
  args: string[];
  env: Record<string, string>;
  read: (stdout: string, check: string) => Finding[];
  /** Keep only the findings about files under this folder. */
  under?: string;
}

const posix = (path: string) => path.replaceAll("\\", "/");

const finding = (
  check: string,
  file: string,
  message: string,
  severity: Severity = "error",
  line?: number,
): Finding => ({
  file: posix(file),
  check,
  severity,
  message,
  ...(line === undefined ? {} : { line }),
});

const SCHEMA_UNUSABLE = " (the schema cannot be used as written)";

/** `FAIL <file>` followed by one `  - <problem>` line per problem. */
export function readFrontmatterOutput(stdout: string, check: string) {
  const found: Finding[] = [];
  let file: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const head = /^FAIL (.+)$/.exec(line);
    const item = /^ {2}- (.*)$/.exec(line);
    if (head?.[1]) file = head[1];
    else if (item?.[1] !== undefined && file !== null) {
      const unusable = file.endsWith(SCHEMA_UNUSABLE);
      found.push(
        finding(
          check,
          unusable ? file.slice(0, -SCHEMA_UNUSABLE.length) : file,
          unusable ? `the schema cannot be used: ${item[1]}` : item[1],
        ),
      );
    } else file = null;
  }
  return found;
}

/** `ERROR: <file> is stale …` per stale file, and the orphan warning. */
export function readIndexOutput(stdout: string, check: string) {
  const found: Finding[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const stale = /^ERROR: (.+) is stale\b/.exec(line);
    const orphans = /^WARN — (\d+) orphaned doc\(s\), listed in (.+) \(/.exec(
      line,
    );
    if (stale?.[1])
      found.push(
        finding(check, stale[1], "stale: regenerate it with the generator"),
      );
    if (orphans?.[1] && orphans[2])
      found.push(
        finding(
          check,
          orphans[2],
          `${orphans[1]} document(s) no other document lists under related:`,
          "warning",
        ),
      );
  }
  return found;
}

/** `FAIL <file>: <why>` per document. */
export function readStaleOutput(stdout: string, check: string) {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const m = /^FAIL (.+?): (.*)$/.exec(line);
    return m?.[1] && m[2] ? [finding(check, m[1], m[2])] : [];
  });
}

/** `SCAR <file>` followed by one `  <line>: <text>` line per scar. */
export function readScarOutput(stdout: string, check: string) {
  const found: Finding[] = [];
  let file: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const head = /^SCAR (.+)$/.exec(line);
    const hit = /^ {2}(\d+): (.*)$/.exec(line);
    if (head?.[1]) file = head[1];
    else if (hit?.[1] && file !== null)
      found.push(
        finding(
          check,
          file,
          `review scar: ${(hit[2] ?? "").trim()}`,
          "error",
          Number(hit[1]),
        ),
      );
    else file = null;
  }
  return found;
}

/** `<file>:<line>: [rule] problem`, then `  | excerpt` and `  fix: remedy`. */
export function readDeferralOutput(stdout: string, check: string) {
  const found: Finding[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const head = /^(.+?):(\d+): \[([^\]]+)\] (.*)$/.exec(line);
    const fix = /^ {2}fix: (.*)$/.exec(line);
    const last = found.at(-1);
    if (head?.[1] && head[2])
      found.push(
        finding(
          check,
          head[1],
          `[${head[3]}] ${head[4]}`,
          "error",
          Number(head[2]),
        ),
      );
    else if (fix?.[1] && last) last.message += `; fix: ${fix[1]}`;
  }
  return found;
}

/** The lines a gate that could not check printed about why. */
function whyFailed(result: RunResult): string {
  if (result.spawnFailed) return "the gate could not start";
  if (result.timedOut)
    return `the gate was stopped after ${GATE_TIMEOUT_SEC} seconds`;
  if (result.bufferExceeded)
    return "the gate was stopped for printing more than its output buffer holds, so the documents after that point were not checked";
  const lines = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const errors = lines.filter((line) => line.startsWith("ERROR"));
  return (errors.length ? errors : lines.slice(-3)).join(" ") || "no output";
}

/** Run one gate from `repo` and read its result; `maxBufferBytes` is for tests. */
export async function runGate(
  gate: Gate,
  repo: string,
  maxBufferBytes?: number,
): Promise<CheckResult> {
  const result = await run(tsArgv(join(SCRIPTS, gate.script), gate.args), {
    cwd: repo,
    env: { ...process.env, ...gate.env },
    timeoutSec: GATE_TIMEOUT_SEC,
    ...(maxBufferBytes === undefined ? {} : { maxBufferBytes }),
  });
  // A stopped gate's code says nothing about the documents it never reached.
  const stopped =
    result.spawnFailed || result.timedOut || result.bufferExceeded;
  if (stopped || (result.code !== 0 && result.code !== 1))
    return {
      name: gate.name,
      status: "failed",
      detail: whyFailed(result),
      findings: [],
    };
  const findings = gate.read(result.stdout, gate.name);
  const errors = findings.filter((f) => f.severity === "error").length;
  if (result.code === 1 && errors === 0)
    return {
      name: gate.name,
      status: "failed",
      detail: `the gate failed and printed no finding this skill can read: ${whyFailed(result)}`,
      findings,
    };
  const { under } = gate;
  const kept =
    under && under !== "."
      ? findings.filter((f) => f.file.startsWith(`${under}/`))
      : findings;
  const lastLine = result.stdout.trim().split(/\r?\n/).at(-1) ?? "";
  return summarize(
    gate.name,
    kept,
    kept.length < findings.length ? `nothing under ${under}/` : lastLine,
  );
}

/** A check's result from its findings: errors first, then warnings, else `passed`. */
export function summarize(
  name: string,
  findings: Finding[],
  passed: string,
): CheckResult {
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.length - errors;
  if (errors)
    return {
      name,
      status: "findings",
      detail: `${errors} finding(s)${warnings ? `, ${warnings} warning(s)` : ""}`,
      findings,
    };
  if (warnings)
    return {
      name,
      status: "warnings",
      detail: `${warnings} warning(s)`,
      findings,
    };
  return { name, status: "ok", detail: passed, findings };
}
