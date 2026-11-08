/**
 * Whether a failed CI run failed on its infrastructure rather than on the
 * code: the one rule `fix-ci` (its `CI_INFRA` exit) and `drive-pr` (which
 * re-runs such a run instead of spending a CI-repair pass on it) both apply.
 *
 * A job failed on the infrastructure when, and only when:
 *
 * - its log prints no code diagnostic: every error entry `ci-log.ts` reads in
 *   it is the runner's generic exit note, a cancellation note, or a line that
 *   itself names the infrastructure failure; and
 * - the runner itself was lost (a shutdown signal, lost communication with
 *   the server, the hosted runner's own error), in any step; or every failed
 *   step is a setup step (setting up the job, a checkout, a tool download or
 *   install, a cache restore, a tool's initialisation) and the log names a
 *   network failure: an HTTP 5xx answer, a connection timeout, a reset or
 *   refused connection, a name that did not resolve.
 *
 * Anything else is the code's, ambiguity included: a network failure in a
 * step that runs the repository's own commands, a 4xx answer, a log with no
 * job and step prefix to place its lines, or no failure signal at all. A run
 * is infrastructure only when it has a failed job and every one of them is.
 *
 * The log is `gh run view <run> --log-failed`'s: every line prefixed
 * `<job>\t<step>\t`, then the timestamp, and only the failed steps' lines.
 */

import { type CiError, head, parseCiErrors } from "./ci-log.ts";

/** One failed job's reading. */
export interface JobReading {
  /** The job's name as the log prefix gives it; `""` for unprefixed lines. */
  job: string;
  infrastructure: boolean;
  /** Why, in one clause naming the deciding line or step. */
  why: string;
}

/** A failed run's reading: infrastructure only when every failed job is. */
export interface InfraReading {
  infrastructure: boolean;
  why: string;
  jobs: JobReading[];
}

/** The runner itself was lost: infrastructure in whatever step it happened. */
const RUNNER_LOST: readonly RegExp[] = [
  /The runner has received a shutdown signal/iu,
  /lost communication with the server/iu,
  /The hosted runner encountered an error while running your job/iu,
];

/** A network or service failure: infrastructure when a setup step failed on it. */
const NETWORK: readonly RegExp[] = [
  /^npm\s+(?:ERR!|error)\s+code\s+E5\d\d\b/iu,
  /\bHTTP(?: status code| response| error| code)?:? ?5\d\d\b/iu,
  /\b5\d\d (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)\b/iu,
  /\b(?:status code|response code|returned error):? ?5\d\d\b/iu,
  /\bE(?:TIMEDOUT|SOCKETTIMEDOUT|CONNRESET|CONNREFUSED|AI_AGAIN|NETUNREACH|HOSTUNREACH)\b/u,
  /\bsocket hang up\b/iu,
  /\b(?:connection|connect|request|read|handshake) timed out\b/iu,
  /\b(?:TLS handshake|i\/o) timeout\b/iu,
  /\bCould not resolve host\b/iu,
  /\bTemporary failure in name resolution\b/iu,
  /\bnetwork is unreachable\b/iu,
  /\bthe remote end hung up unexpectedly\b/iu,
];

/**
 * Error annotations that accompany a failure without saying whose it is: the
 * runner's exit note is `process_exit` already; a cancellation note follows a
 * lost runner and a person's cancel alike.
 */
const NEUTRAL: readonly RegExp[] = [
  /^##\[error\]The operation was canceled\.?$/u,
];

/**
 * A step that prepares the job rather than running the repository's
 * commands, by the name GitHub Actions gives it: its own `Set up job` and
 * `Complete job`, a named setup, checkout, install, download, cache or
 * initialisation step, a post step, and an unnamed step of a setup action.
 */
const SETUP_STEP =
  /^(?:set ?up\b|setup\b|initiali[sz]e\b|init\b|check ?out\b|install\b|download\b|restore\b|cache\b|prepare\b|complete job$|post\b|run [\w.-]+\/(?:checkout|cache|download-artifact|setup-[\w.-]+|codeql-action\/init)@)/iu;

const matchesAny = (patterns: readonly RegExp[], line: string): boolean =>
  patterns.some((p) => p.test(line));

/** One prefixed log line: its job, its step and its text after the timestamp. */
interface LogLine {
  job: string;
  step: string;
  text: string;
}

const TIMESTAMP = /^﻿?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/u;

function splitLine(raw: string): LogLine {
  const fields = raw.split("\t");
  if (fields.length < 3)
    return { job: "", step: "", text: raw.replace(TIMESTAMP, "").trim() };
  const [job = "", step = "", ...rest] = fields;
  return {
    job,
    step,
    text: rest.join("\t").replace(TIMESTAMP, "").trim(),
  };
}

/** Why an error entry stands against an infrastructure reading, or `null` when it does not. */
function codeDiagnostic(error: CiError): string | null {
  if (error.category === "process_exit") return null;
  const line = error.raw;
  const display = head(line, 200);
  if (error.category === "gate_failure") {
    if (matchesAny(NEUTRAL, line)) return null;
    if (matchesAny(RUNNER_LOST, line) || matchesAny(NETWORK, line)) return null;
    return `an error annotation names no infrastructure failure: ${display}`;
  }
  return `a ${error.category} diagnostic: ${display}`;
}

/** Code diagnostics and permanent HTTP failures outrank transient evidence. */
function permanentDiagnostic(text: readonly string[]): string | null {
  const parsed = parseCiErrors(text.join("\n"), "", Number.MAX_SAFE_INTEGER);
  for (const error of parsed.errors) {
    const why = codeDiagnostic(error);
    if (why !== null) return why;
  }
  const permanent = text.find((line) =>
    /\b(?:HTTP(?: status code| response| error| code)?|status code|response code|returned error):? ?4\d\d\b/iu.test(
      line,
    ),
  );
  if (permanent !== undefined)
    return `a permanent HTTP failure: ${head(permanent, 200)}`;
  return null;
}

/** One failed job's lines, read against the rule. */
function readJob(job: string, lines: readonly LogLine[]): JobReading {
  if (job.trim() === "" || lines.some((line) => line.step.trim() === ""))
    return {
      job,
      infrastructure: false,
      why: "no job or no step is named for its lines",
    };
  const text = lines.map((l) => l.text);
  const diagnostic = permanentDiagnostic(text);
  if (diagnostic !== null)
    return { job, infrastructure: false, why: diagnostic };
  const lost = text.find((line) => matchesAny(RUNNER_LOST, line));
  if (lost !== undefined)
    return { job, infrastructure: true, why: `the runner was lost: ${lost}` };
  const network = text.find((line) => matchesAny(NETWORK, line));
  if (network === undefined)
    return {
      job,
      infrastructure: false,
      why: "its log names no infrastructure failure",
    };
  const steps = [...new Set(lines.map((l) => l.step))];
  const other = steps.find((step) => !SETUP_STEP.test(step));
  if (other !== undefined)
    return {
      job,
      infrastructure: false,
      why:
        other === ""
          ? `a network failure in a line no step is named for: ${network}`
          : `a network failure in step '${other}', which is not a setup step: ${network}`,
    };
  return {
    job,
    infrastructure: true,
    why: `setup step '${steps.join("', '")}' failed on the network: ${network}`,
  };
}

/** Read a failed run's log, `gh run view --log-failed`'s form, against the rule. */
export function readInfrastructure(log: string): InfraReading {
  const byJob = new Map<string, LogLine[]>();
  for (const raw of log.replace(/\r\n?/gu, "\n").split("\n")) {
    if (raw.trim() === "") continue;
    const line = splitLine(raw);
    const lines = byJob.get(line.job) ?? [];
    lines.push(line);
    byJob.set(line.job, lines);
  }
  const jobs = [...byJob].map(([job, lines]) => readJob(job, lines));
  if (jobs.length === 0)
    return { infrastructure: false, why: "the log names no failed job", jobs };
  const code = jobs.find((j) => !j.infrastructure);
  if (code !== undefined)
    return {
      infrastructure: false,
      why: `${code.job === "" ? "the log" : `job '${code.job}'`}: ${code.why}`,
      jobs,
    };
  return {
    infrastructure: true,
    why: `every failed job failed on the infrastructure (${jobs.map((j) => j.job).join(", ")})`,
    jobs,
  };
}
