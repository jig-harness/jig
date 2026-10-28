// The workflow-convention lint's rules, one function each, over the parsed
// workflows and composite actions (inputs.ts). Each returns its findings; a
// finding names its job where it has one, so an exception can name the job.
import type { Finding } from "../../../../lib/findings.ts";
import { isRecord } from "../../../../lib/record.ts";
import type { Action, Job, Settings, Workflow } from "./inputs.ts";

export interface Found extends Finding {
  file: string;
  job?: string | undefined;
}

export interface Pipelines {
  workflows: Workflow[];
  actions: Action[];
  settings: Settings;
}

const README =
  "modules/M13-pipeline-economy/reference/workflow-conventions/README.md";
/** The longest `timeout-minutes` a job may declare, in minutes. It is generous
 * on purpose (a timeout stops a hang, it does not police a slow run) and far
 * below GitHub's default of 360; a job that needs more is sharded, or carries a
 * reasoned exception. */
const MAX_JOB_MINUTES = 60;
const PR_EVENTS = ["pull_request", "pull_request_target"];
const EXPRESSION = /\$\{\{/;

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The 1-based line of the first line matching `pattern` at or after `from`. */
function lineOf(raw: string, pattern: RegExp, from = 0): number | undefined {
  const lines = raw.split(/\r?\n/);
  for (let i = from; i < lines.length; i++)
    if (pattern.test(lines[i] ?? "")) return i + 1;
  return undefined;
}

const topKey = (name: string) => new RegExp(`^["']?${name}["']?\\s*:`);

/** The line of `name:` directly inside the top-level block `block:` (`jobs`,
 * `on`): only keys at the block's own indentation, before the next
 * top-level key, count, so a step or filter of the same name does not. */
function blockKeyLine(
  raw: string,
  block: string,
  name: string,
): number | undefined {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => topKey(block).test(l));
  if (start < 0) return undefined;
  let indent: string | undefined;
  const key = new RegExp(`^["']?${escapeRegExp(name)}["']?\\s*:`);
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const lead = line.match(/^\s*/)?.[0] ?? "";
    if (!lead) return undefined;
    indent ??= lead;
    if (lead === indent && key.test(line.slice(lead.length))) return i + 1;
  }
  return undefined;
}

const jobLine = (wf: Workflow, id: string) => blockKeyLine(wf.raw, "jobs", id);

const triggerLine = (wf: Workflow, event?: string) =>
  (event ? blockKeyLine(wf.raw, "on", event) : undefined) ??
  lineOf(wf.raw, topKey("on"));

function at(wf: Workflow, job: Job | undefined, rule: string) {
  return (problem: string, remedy: string): Found => ({
    rule,
    file: wf.file,
    line: job ? jobLine(wf, job.id) : triggerLine(wf),
    job: job?.id,
    problem,
    remedy,
  });
}

const condition = (job: Job) =>
  job.def.if === undefined ? "" : String(job.def.if);

/** An `if:` without its optional `\${{ }}` wrapper. */
const bare = (cond: string) =>
  cond
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, "$1")
    .trim();

/** The `&&`-joined terms of an expression, split outside parentheses and
 * quoted strings. Undefined when an `||` stands anywhere outside a string, or
 * the quotes or parentheses do not balance: then no single term decides
 * whether the job runs. */
function conjuncts(expr: string): string[] | undefined {
  const terms: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    // A quote inside a string is doubled (''), which toggles twice.
    if (c === "'") quoted = !quoted;
    else if (quoted) continue;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (expr.startsWith("||", i)) return undefined;
    else if (depth === 0 && expr.startsWith("&&", i)) {
      terms.push(expr.slice(start, i).trim());
      start = i + 2;
      i++;
    }
    if (depth < 0) return undefined;
  }
  if (quoted || depth) return undefined;
  terms.push(expr.slice(start).trim());
  return terms;
}

// inputs.ts has checked the shapes: `needs` is a job id or a list of them.
const needs = (job: Job): string[] =>
  typeof job.def.needs === "string"
    ? [job.def.needs]
    : ((job.def.needs as string[] | undefined) ?? []);

const isPullRequest = (wf: Workflow) =>
  PR_EVENTS.some((event) => event in wf.on);

/** A reusable-workflow call: its timeout is the called workflow's jobs'. */
const callsWorkflow = (job: Job) => typeof job.def.uses === "string";

/** Every job has `timeout-minutes`, a positive number of minutes within the
 * ceiling. */
export function jobTimeout({ workflows }: Pipelines): Found[] {
  return workflows.flatMap((wf) =>
    wf.jobs
      .filter((job) => !callsWorkflow(job))
      .flatMap((job): Found[] => {
        const finding = at(wf, job, "job-timeout");
        const value = job.def["timeout-minutes"];
        const remedy = `set timeout-minutes to about two to three times the job's slowest healthy run, at most ${MAX_JOB_MINUTES}; shard a longer job or add a reasoned exception (${README}#job-timeout)`;
        if (value === undefined)
          return [finding(`job '${job.id}' has no timeout-minutes`, remedy)];
        if (typeof value === "string" && EXPRESSION.test(value)) return [];
        const minutes =
          typeof value === "number" ||
          (typeof value === "string" && /^\s*\d+(?:\.\d+)?\s*$/.test(value))
            ? Number(value)
            : Number.NaN;
        if (
          Number.isFinite(minutes) &&
          minutes > 0 &&
          minutes <= MAX_JOB_MINUTES
        )
          return [];
        return [
          finding(
            `job '${job.id}' has timeout-minutes ${JSON.stringify(value)}, not a positive number of minutes within the ${MAX_JOB_MINUTES}-minute ceiling`,
            remedy,
          ),
        ];
      }),
  );
}

function cancels(concurrency: unknown): boolean {
  if (!isRecord(concurrency) || concurrency.group === undefined) return false;
  const cancel = concurrency["cancel-in-progress"];
  return (
    cancel === true || (typeof cancel === "string" && EXPRESSION.test(cancel))
  );
}

/** A pull-request workflow cancels the runs of a superseded head. */
export function prConcurrency({ workflows }: Pipelines): Found[] {
  return workflows
    .filter((wf) => isPullRequest(wf) && !cancels(wf.doc.concurrency))
    .flatMap((wf) => {
      const remedy = `add concurrency: { group: <workflow>-\${{ github.ref }}, cancel-in-progress: true } (${README}#pr-concurrency)`;
      const jobLevel = wf.jobs.some((job) => job.def.concurrency !== undefined);
      if (!jobLevel)
        return [
          at(
            wf,
            undefined,
            "pr-concurrency",
          )(
            "pull-request workflow has no concurrency group that cancels in progress",
            remedy,
          ),
        ];
      return wf.jobs
        .filter((job) => !cancels(job.def.concurrency))
        .map((job) =>
          at(
            wf,
            job,
            "pr-concurrency",
          )(
            `job '${job.id}' of a pull-request workflow has no concurrency group that cancels in progress`,
            remedy,
          ),
        );
    });
}

const ALWAYS = /\balways\(\s*\)/;

/** Whether an `if:` is exactly `!cancelled()`, optionally inside `\${{ }}`.
 * Anything joined to it can skip the job on a result it must judge
 * (`&& success()`), or invert it (`== false`), so only the whole condition
 * counts: a missed spelling is a finding, a misread one a false pass. */
const unlessCancelled = (cond: string) =>
  /^!\s*cancelled\(\s*\)$/.test(bare(cond));

/** The check a job reports: its literal name, else its id. */
const checkName = (job: Job) =>
  typeof job.def.name === "string" && !EXPRESSION.test(job.def.name)
    ? job.def.name
    : job.id;

/** Whether the configuration names this job as a heavy suite by itself
 * (`<file>#<job>`), not only as part of a whole heavy workflow. */
const namedHeavy = (wf: Workflow, job: Job, settings: Settings) =>
  settings.heavy.includes(`${wf.name}#${job.id}`);

/** The events that gate a merge: only their workflows hold an aggregator. */
const MERGE_EVENTS = [...PR_EVENTS, "merge_group"];

/** A job that needs every other job of a workflow gating merges: an
 * aggregator, derived from the workflow itself whatever its `if:` says, so
 * one with no condition, the commonest mistake, is found too. A job named
 * heavy is never one: it is work, and the CI hold skips it. */
function aggregates(wf: Workflow, job: Job, settings: Settings): boolean {
  if (!MERGE_EVENTS.some((event) => event in wf.on)) return false;
  if (namedHeavy(wf, job, settings)) return false;
  const others = wf.jobs.filter((other) => other !== job).map((o) => o.id);
  const needed = new Set(needs(job));
  return others.length > 0 && others.every((id) => needed.has(id));
}

/** The jobs reporting a required check: those `ci.required_checks` names,
 * or, when it is unset, the aggregators the workflows show. */
export function requiredJobs(wf: Workflow, settings: Settings): Job[] {
  const names = settings.requiredChecks;
  return names
    ? wf.jobs.filter((job) => names.includes(checkName(job)))
    : wf.jobs.filter((job) => aggregates(wf, job, settings));
}

const FILTERS = ["paths", "paths-ignore"];

/** A workflow holding a required check is not filtered by changed paths. */
export function requiredNotPathFiltered({
  workflows,
  settings,
}: Pipelines): Found[] {
  return workflows
    .filter((wf) => requiredJobs(wf, settings).length)
    .flatMap((wf) =>
      Object.entries(wf.on)
        .filter(([, filters]) => FILTERS.some((f) => f in filters))
        .map(([event]) => ({
          ...at(
            wf,
            undefined,
            "required-not-path-filtered",
          )(
            `the workflow reports required check(s) ${requiredJobs(wf, settings).map(checkName).join(", ")} but its ${event} trigger is filtered by paths: a filtered-out run never reports, and the check waits forever`,
            `remove paths/paths-ignore from the trigger and select jobs inside the run (${README}#required-not-path-filtered)`,
          ),
          line: triggerLine(wf, event),
        })),
    );
}

/** An aggregator runs on `!cancelled()`, never `always()`. */
export function aggregatorUnlessCancelled({
  workflows,
  settings,
}: Pipelines): Found[] {
  return workflows.flatMap((wf) =>
    requiredJobs(wf, settings)
      .filter((job) => needs(job).length)
      .flatMap((job): Found[] => {
        const cond = condition(job);
        if (unlessCancelled(cond)) return [];
        const problem = ALWAYS.test(cond)
          ? `required job '${job.id}' runs on always(), so it also fails a run a newer push cancelled`
          : cond
            ? `required job '${job.id}' runs on '${cond}', not on exactly !cancelled(): anything joined to it can skip the job on a result it must judge, and a skipped check counts as passing`
            : `required job '${job.id}' needs other jobs but does not run on !cancelled(): when a job it needs fails, it is skipped, and a skipped check counts as passing`;
        return [
          at(
            wf,
            job,
            "aggregator-unless-cancelled",
          )(
            problem,
            `give it if: \${{ !cancelled() }} and let its exit code judge the needed jobs' results (${README}#aggregator-unless-cancelled)`,
          ),
        ];
      }),
  );
}

interface Heavy {
  wf: Workflow;
  jobs: Job[];
  whole: boolean;
}

/** Heavy-suite entries resolved to their workflow and jobs, and the entries
 * that name nothing. */
function heavyJobs({ workflows, settings }: Pipelines): {
  heavy: Heavy[];
  lost: string[];
} {
  const heavy: Heavy[] = [];
  const lost: string[] = [];
  for (const entry of settings.heavy) {
    const [name, id] = entry.split("#");
    const wf = workflows.find((w) => w.name === name);
    const jobs = wf?.jobs.filter((job) => id === undefined || job.id === id);
    if (wf && jobs?.length) heavy.push({ wf, jobs, whole: id === undefined });
    else lost.push(entry);
  }
  return { heavy, lost };
}

/** Whether a push trigger filters only tags (`tags` or `tags-ignore`, no
 * branch filter): it runs for tags, never for a branch. */
const tagsOnly = (filters: Record<string, unknown>) =>
  ("tags" in filters || "tags-ignore" in filters) &&
  !("branches" in filters) &&
  !("branches-ignore" in filters);

/** Whether a `push` trigger runs for every change, not only for named
 * branches or tags. */
function pushPerChange(filters: Record<string, unknown>): boolean {
  const branches = filters.branches;
  if (Array.isArray(branches))
    return branches.some((b) => String(b).includes("*"));
  return !tagsOnly(filters);
}

/** Whether a job calls workflow `name` of the same repository. */
const callsLocal = (job: Job, name: string) =>
  typeof job.def.uses === "string" &&
  job.def.uses.startsWith("./") &&
  job.def.uses.split("/").pop()?.split("@")[0] === name;

/** The per-change triggers that start a workflow: its own, and those of the
 * workflows in the repository that call it, named `<event> via <caller>`. */
function perChangeTriggers(
  wf: Workflow,
  workflows: Workflow[],
  seen = new Set<Workflow>([wf]),
): string[] {
  const own = Object.entries(wf.on)
    .filter(
      ([event, filters]) =>
        [...PR_EVENTS, "merge_group"].includes(event) ||
        (event === "push" && pushPerChange(filters)),
    )
    .map(([event]) => event);
  const callers = workflows.filter(
    (caller) =>
      !seen.has(caller) && caller.jobs.some((job) => callsLocal(job, wf.name)),
  );
  for (const caller of callers) seen.add(caller);
  return [
    ...own,
    ...callers.flatMap((caller) =>
      perChangeTriggers(caller, workflows, seen).map(
        (event) => `${event.split(" via ")[0]} via ${caller.name}`,
      ),
    ),
  ];
}

/** A heavy suite has no per-change trigger. */
export function heavyPerChange(pipelines: Pipelines): Found[] {
  const { heavy, lost } = heavyJobs(pipelines);
  const stale = lost.map(
    (entry): Found => ({
      rule: "heavy-per-change",
      file: pipelines.settings.config,
      problem: `heavy suite '${entry}' names no workflow or job`,
      remedy: "correct or delete the entry",
    }),
  );
  return [
    ...stale,
    ...heavy.flatMap(({ wf, jobs, whole }) => {
      const events = perChangeTriggers(wf, pipelines.workflows);
      if (!events.length) return [];
      const problem = (what: string) =>
        `heavy suite ${what} runs on every change (${events.join(", ")})`;
      const remedy = `run it on a schedule or on demand with a cheap per-change proxy, or record why the merge waits for it in the exception list (${README}#heavy-per-change)`;
      return whole
        ? [at(wf, undefined, "heavy-per-change")(problem(wf.name), remedy)]
        : jobs.map((job) =>
            at(
              wf,
              job,
              "heavy-per-change",
            )(problem(`${wf.name}#${job.id}`), remedy),
          );
    }),
  ];
}

/** The pull request's label names, the one collection a hold test reads. */
const LABELS = "github\\.event\\.pull_request\\.labels\\.\\*\\.name";

/** `contains(<labels>, '<label>')`, the label quoted and exact. */
const labelTest = (label: string) =>
  `contains\\(\\s*${LABELS}\\s*,\\s*'${escapeRegExp(label)}'\\s*\\)`;

/** Whether an `if:` is nothing but a positive test for the label:
 * `contains(<labels>, '<label>')`, optionally inside `\${{ }}`. Any other
 * spelling (negated, compared with false, combined) is not taken as a
 * sentinel: a missed sentinel is a finding, a misread one a false pass. */
const onlyWhenHeld = (cond: string, label: string) =>
  new RegExp(`^${labelTest(label)}$`).test(bare(cond));

/** Whether an `if:` skips the job while the label is present: one of its
 * `&&`-joined terms is exactly `!contains(<labels>, '<label>')` or
 * `!(contains(<labels>, '<label>'))`. An `||` anywhere could run the job
 * while held, and a term that only holds the test (`!!contains(…)`,
 * `!contains(…) == false`) can invert it, so neither counts. */
function guarded(cond: string, label: string): boolean {
  const test = labelTest(label);
  const term = new RegExp(`^!\\s*(?:${test}|\\(\\s*${test}\\s*\\))$`);
  return conjuncts(bare(cond))?.some((t) => term.test(t)) ?? false;
}

const runs = (step: Record<string, unknown>) => step.run !== undefined;

/** Whether a failure of the job or step fails its caller: no
 * `continue-on-error`, or one that is plainly false. */
const failsOnError = (def: Record<string, unknown>) =>
  def["continue-on-error"] === undefined || def["continue-on-error"] === false;

// inputs.ts has checked the shape: `steps` is a list of maps.
const steps = (job: Job) =>
  (job.def.steps as Record<string, unknown>[] | undefined) ?? [];

/** Whether a job runs while held: it has no `if:` and needs no job, or its
 * whole `if:` is `!cancelled()`, so a needed job the hold skips does not skip
 * it too. Any other condition (`false`, a test of another value) may skip it,
 * and a skipped sentinel fails nothing. */
const runsWhileHeld = (job: Job) =>
  job.def.if === undefined
    ? !needs(job).length
    : unlessCancelled(condition(job));

/** Whether a job fails while held: the job runs only when the hold label is
 * present and has an unconditional `run:` step, or the job runs while held
 * and one of its `run:` steps runs only then. A failure the job or step
 * tolerates (`continue-on-error`) fails nothing, and a job a skipped need
 * skips never reaches its step. */
function sentinel(job: Job, label: string): boolean {
  if (!failsOnError(job.def)) return false;
  const failing = (step: Record<string, unknown>) =>
    runs(step) && failsOnError(step);
  if (onlyWhenHeld(condition(job), label))
    return (
      !needs(job).length &&
      steps(job).some((step) => failing(step) && step.if === undefined)
    );
  return (
    runsWhileHeld(job) &&
    steps(job).some(
      (step) =>
        failing(step) &&
        step.if !== undefined &&
        onlyWhenHeld(String(step.if), label),
    )
  );
}

/** The jobs of pull-request workflows that call workflow `wf`, directly or
 * through other workflows of the repository. */
function pullRequestCallers(
  wf: Workflow,
  workflows: Workflow[],
  seen = new Set<Workflow>([wf]),
): { wf: Workflow; jobs: Job[] }[] {
  return workflows
    .filter((caller) => !seen.has(caller))
    .flatMap((caller) => {
      const jobs = caller.jobs.filter((job) => callsLocal(job, wf.name));
      if (!jobs.length) return [];
      seen.add(caller);
      return [
        ...(isPullRequest(caller) ? [{ wf: caller, jobs }] : []),
        ...pullRequestCallers(caller, workflows, seen),
      ];
    });
}

/** The heavy jobs that run on pull requests: in a pull-request workflow, a
 * heavy job other than a required one not itself named heavy; and the jobs
 * of pull-request workflows that call a heavy workflow. */
function heavyOnPullRequests(pipelines: Pipelines) {
  const { settings, workflows } = pipelines;
  return heavyJobs(pipelines).heavy.flatMap(({ wf, jobs }) => {
    // A required job inside a whole heavy workflow must report, so it is
    // exempt; but only one ci.required_checks names: a derived aggregator
    // may be the heavy work itself.
    const required = settings.requiredChecks ? requiredJobs(wf, settings) : [];
    const own = isPullRequest(wf)
      ? [
          {
            wf,
            jobs: jobs.filter(
              (job) => !required.includes(job) || namedHeavy(wf, job, settings),
            ),
          },
        ]
      : [];
    return [...own, ...pullRequestCallers(wf, workflows)];
  });
}

/** With a CI hold, heavy pull-request jobs carry its guard, every workflow
 * that takes part runs on both label transitions, and a sentinel fails a
 * required check while the label is present. */
export function ciHold(pipelines: Pipelines): Found[] {
  const label = pipelines.settings.holdLabel;
  if (!label) return [];
  const heavy = heavyOnPullRequests(pipelines);
  const unguarded = heavy.flatMap(({ wf, jobs }) => {
    return jobs
      .filter((job) => !guarded(condition(job), label))
      .map((job) =>
        at(
          wf,
          job,
          "ci-hold-guard",
        )(
          `heavy job '${job.id}' runs on pull requests but its if: does not skip it while the hold label '${label}' is present`,
          `skip it while the label is present, e.g. if: \${{ !contains(github.event.pull_request.labels.*.name, '${label}') }} (${README}#ci-hold)`,
        ),
      );
  });
  return [
    ...unguarded,
    ...missingEvents(pipelines, heavy, label),
    ...missingSentinel(pipelines, label),
  ];
}

/** The pull-request event types a workflow that honours the hold runs on:
 * the three a trigger without `types:` runs on, since listing any replaces
 * them, and the two label transitions. Applying the label must start a run,
 * so the sentinel fails at once instead of the check keeping a pre-hold
 * result; removing it must start one, so every required check runs again on
 * the same head. */
const HOLD_EVENT_TYPES = [
  "opened",
  "synchronize",
  "reopened",
  "labeled",
  "unlabeled",
];

/** The pull-request workflows that take part in the hold: those with a
 * guarded heavy job or a call to a heavy workflow, and those holding a
 * required check, which the release must run again. */
function holdParticipants(
  { workflows, settings }: Pipelines,
  heavy: { wf: Workflow }[],
): Workflow[] {
  const taking = new Set(heavy.map(({ wf }) => wf));
  for (const wf of workflows)
    if (isPullRequest(wf) && requiredJobs(wf, settings).length) taking.add(wf);
  return workflows.filter((wf) => taking.has(wf));
}

/** Each pull-request trigger of a workflow that takes part in the hold lists
 * every type the hold needs. inputs.ts has checked the shape: `types` is
 * absent or a list of names. */
function missingEvents(
  pipelines: Pipelines,
  heavy: { wf: Workflow }[],
  label: string,
): Found[] {
  return holdParticipants(pipelines, heavy).flatMap((wf) =>
    PR_EVENTS.filter((event) => event in wf.on).flatMap((event): Found[] => {
      const listed = (wf.on[event]?.types as string[] | undefined) ?? [];
      const missing = HOLD_EVENT_TYPES.filter((t) => !listed.includes(t));
      if (!missing.length) return [];
      const problem = listed.length
        ? `the workflow honours the hold label '${label}' but its ${event} trigger lists types ${listed.join(", ")} and not ${missing.join(", ")}`
        : `the workflow honours the hold label '${label}' but its ${event} trigger has no types:, so it never runs when the label is applied or removed`;
      return [
        {
          ...at(
            wf,
            undefined,
            "ci-hold-events",
          )(
            `${problem}: applying the label would leave the checks' pre-hold results in place, and removing it would run nothing again`,
            `list types: [${HOLD_EVENT_TYPES.join(", ")}] under on.${event}; the guard reads the pull request's labels, so an unrelated label event still runs real CI (${README}#ci-hold)`,
          ),
          line: triggerLine(wf, event),
        },
      ];
    }),
  );
}

/** The jobs whose failure fails a required check: the required jobs, and
 * the jobs a required job running on exactly `!cancelled()` needs directly,
 * since that job runs whatever they return and judges their results. A job
 * reached only through another can have its failure absorbed there (an
 * intermediary on `!cancelled()` that succeeds anyway), and a required job on
 * any other condition is skipped by a failed need, which counts as passing;
 * so neither is taken. None when the workflow holds no required check. */
function gating(wf: Workflow, settings: Settings): Job[] {
  const byId = new Map(wf.jobs.map((job) => [job.id, job]));
  const reached = new Set<Job>();
  for (const job of requiredJobs(wf, settings)) {
    reached.add(job);
    if (!unlessCancelled(condition(job))) continue;
    for (const id of needs(job)) {
      const needed = byId.get(id);
      if (needed) reached.add(needed);
    }
  }
  return [...reached];
}

function missingSentinel(
  { workflows, settings }: Pipelines,
  label: string,
): Found[] {
  const found = workflows
    .filter(isPullRequest)
    .some((wf) => gating(wf, settings).some((job) => sentinel(job, label)));
  if (found) return [];
  return [
    {
      rule: "ci-hold-sentinel",
      file: settings.jigConfig,
      problem: `ci.hold_label is '${label}' but no pull-request job fails a required check while it is present, so a held head can look mergeable`,
      remedy: `add a step with if: contains(github.event.pull_request.labels.*.name, '${label}') that exits 1 (after cancelling its own run, if it should be listed as cancelled once released) and does not continue on error, in a job that runs while held: the required job or one it needs (${README}#ci-hold)`,
    },
  ];
}

/** A job's environment as the cache key sees it: the workflow's, then the
 * job's own. */
function jobEnv(wf: Workflow, job: Job): Record<string, string> {
  // inputs.ts has checked the shapes: each `env:` is absent or a map.
  const env = { ...(isRecord(wf.doc.env) ? wf.doc.env : {}) };
  Object.assign(env, isRecord(job.def.env) ? job.def.env : {});
  return Object.fromEntries(
    Object.entries(env).map(([k, v]) => [k, String(v)]),
  );
}

/** Configured pipelines that share a cache have the same key-affecting
 * environment. */
export function cacheEnvParity({ workflows, settings }: Pipelines): Found[] {
  return settings.cacheGroups.flatMap((group) => {
    const members = group.members.map((member) => {
      const [name, id] = member.split("#");
      const wf = workflows.find((w) => w.name === name);
      const job = wf?.jobs.find((j) => j.id === id);
      return { member, wf, job };
    });
    const lost = members.find((m) => !m.job);
    if (lost)
      return [
        {
          rule: "cache-env-parity",
          file: settings.config,
          problem: `cache group '${group.name}' names '${lost.member}', which is no job`,
          remedy: "correct or delete the member",
        },
      ];
    const envs = members.map((m) => (m.wf && m.job ? jobEnv(m.wf, m.job) : {}));
    const keys = group.env ?? [...new Set(envs.flatMap(Object.keys))];
    const [first, ...rest] = members;
    return rest.flatMap((m, i) => {
      const differing = keys.filter((k) => envs[0]?.[k] !== envs[i + 1]?.[k]);
      if (!differing.length || !m.wf || !m.job) return [];
      return [
        at(
          m.wf,
          m.job,
          "cache-env-parity",
        )(
          `cache group '${group.name}': env ${differing.join(", ")} differs from ${first?.member}, so the two pipelines write one cache under different conditions`,
          `make the key-affecting env identical across the group (${README}#cache-env-parity)`,
        ),
      ];
    });
  });
}

const SHA = /@[0-9a-f]{40}$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;

function unpinned(uses: string): boolean {
  if (uses.startsWith("./")) return false;
  return uses.startsWith("docker://") ? !DIGEST.test(uses) : !SHA.test(uses);
}

/** The `uses:` references of a list of steps, with the job they belong to. */
const stepUses = (list: unknown[], job?: string) =>
  list.flatMap((step) =>
    isRecord(step) && typeof step.uses === "string"
      ? [{ uses: step.uses, job }]
      : [],
  );

/** Every `uses:` is pinned to a full commit SHA (an image to a digest). */
export function pinnedUses({ workflows, actions }: Pipelines): Found[] {
  const files = [
    ...workflows.map((wf) => ({
      file: wf.file,
      raw: wf.raw,
      uses: wf.jobs.flatMap((job) => [
        ...(callsWorkflow(job)
          ? [{ uses: String(job.def.uses), job: job.id }]
          : []),
        ...stepUses(steps(job), job.id),
      ]),
    })),
    ...actions.map((a) => ({
      file: a.file,
      raw: a.raw,
      uses: [
        ...stepUses(a.steps),
        ...(a.image?.startsWith("docker://")
          ? [{ uses: a.image, job: undefined }]
          : []),
      ],
    })),
  ];
  return files.flatMap(({ file, raw, uses }) => {
    let cursor = 0;
    return uses.flatMap(({ uses: ref, job }): Found[] => {
      const line = lineOf(
        raw,
        new RegExp(`(?:uses|image)\\s*:.*${escapeRegExp(ref)}`),
        cursor,
      );
      cursor = line ?? cursor;
      if (!unpinned(ref)) return [];
      return [
        {
          rule: "pinned-uses",
          file,
          line,
          job,
          problem: `'${ref}' is not pinned to a full commit SHA${ref.startsWith("docker://") ? " (an image needs @sha256:<digest>)" : ""}`,
          remedy: `pin it to the 40-character commit SHA with the version as a comment, and let the dependency updater move it (modules/M1-gates-enforcement-ladder/README.md, piece 7)`,
        },
      ];
    });
  });
}

/** A trigger's path filters, comparable as text. Order is ignored unless a
 * pattern is negative: then a later pattern overrides an earlier one, so
 * order is meaning. inputs.ts has checked each is a list of strings. */
const filterSets = (filters: Record<string, unknown>) =>
  JSON.stringify(
    FILTERS.map((f) => {
      const list = filters[f] as string[] | undefined;
      if (!list) return null;
      return list.some((p) => p.startsWith("!")) ? list : [...list].sort();
    }),
  );

/** The push trigger's path filters equal each pull-request trigger's. */
export function pushPrPaths({ workflows }: Pipelines): Found[] {
  return workflows.flatMap((wf) => {
    const push = wf.on.push;
    const filtered = (t: Record<string, unknown>) =>
      FILTERS.some((f) => f in t);
    // A push filtered only by tags runs for releases, not for the branch.
    if (!push || tagsOnly(push)) return [];
    return PR_EVENTS.flatMap((event): Found[] => {
      const pr = wf.on[event];
      if (!pr || (!filtered(push) && !filtered(pr))) return [];
      if (filterSets(push) === filterSets(pr)) return [];
      const problem =
        filtered(push) && filtered(pr)
          ? `the push trigger's path filters differ from the ${event} trigger's`
          : filtered(push)
            ? `only the push trigger is filtered by paths, not the ${event} one`
            : `only the ${event} trigger is filtered by paths, not the push one`;
      return [
        {
          ...at(
            wf,
            undefined,
            "push-pr-paths",
          )(
            `${problem}, so a change can merge checked by one selection and run on the branch under another`,
            `list the same paths and paths-ignore, in the same order, under both triggers (${README}#push-pr-paths)`,
          ),
          line: triggerLine(wf, "push"),
        },
      ];
    });
  });
}

/** Trigger path lists equal the globs of whole change-area catalog areas. */
export function catalogPaths({ workflows, settings }: Pipelines): Found[] {
  const catalog = settings.catalog;
  if (!catalog) return [];
  return workflows.flatMap((wf) =>
    Object.entries(wf.on).flatMap(([event, filters]): Found[] => {
      if (!Array.isArray(filters.paths)) return [];
      const listed = new Set(filters.paths as string[]);
      const whole = [...catalog.values()].filter(
        (area) => area.globs.length && area.globs.every((g) => listed.has(g)),
      );
      const covered = new Set(whole.flatMap((area) => area.globs));
      const stray = [...listed].filter((glob) => !covered.has(glob));
      if (!stray.length) return [];
      const partial = [...catalog]
        .filter(([, area]) => stray.some((g) => area.globs.includes(g)))
        .map(
          ([name, area]) =>
            `${name} (${area.globs.filter((g) => !listed.has(g)).join(", ")} missing)`,
        );
      return [
        {
          ...at(
            wf,
            undefined,
            "catalog-paths",
          )(
            `the ${event} trigger's paths ${stray.join(", ")} are not the whole glob list of any change-area catalog area${partial.length ? `; partly listed: ${partial.join("; ")}` : ""}`,
            `list exactly the globs of the areas the workflow serves, copied from the catalog (${README}#catalog-paths)`,
          ),
          line: triggerLine(wf, event),
        },
      ];
    }),
  );
}
