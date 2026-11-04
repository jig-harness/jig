// The workflow-convention lint's rules, one function each, over the parsed
// workflows and composite actions (inputs.ts). Each returns its findings; a
// finding names its job where it has one, so an exception can name the job.
import { isRecord } from "../../../../lib/record.ts";
import type { Job, Settings, Workflow } from "./inputs.ts";
import {
  PR_EVENTS,
  README,
  at,
  bare,
  callsWorkflow,
  condition,
  conjuncts,
  escapeRegExp,
  failsOnError,
  isPullRequest,
  lineOf,
  needs,
  runs,
  steps,
  topKey,
  triggerLine,
  type Found,
  type Pipelines,
} from "./workflow-reading.ts";

/** The longest `timeout-minutes` a job may declare, in minutes. It is generous
 * on purpose (a timeout stops a hang, it does not police a slow run) and far
 * below GitHub's default of 360; a job that needs more is sharded, or carries a
 * reasoned exception. */
const MAX_JOB_MINUTES = 60;
const EXPRESSION = /\$\{\{/;

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

/** `github.event.label.name && github.event.label.name != '<label>'`: an event
 * for a label other than the hold's. A pull request's other events carry no
 * label, so the test is false on them. */
const otherLabelTest = (label: string) =>
  `github\\.event\\.label\\.name\\s*&&\\s*github\\.event\\.label\\.name\\s*!=\\s*'${escapeRegExp(label)}'`;

/** Whether an `if:` skips the job on another label's event: one of its
 * `&&`-joined terms is exactly `!(<the other-label test>)`. */
function skipsOtherLabels(cond: string, label: string): boolean {
  const term = new RegExp(`^!\\s*\\(\\s*${otherLabelTest(label)}\\s*\\)$`);
  return conjuncts(bare(cond))?.some((t) => term.test(t)) ?? false;
}

/** Whether an `if:` is nothing but the other-label test, optionally inside
 * `\${{ }}`: the condition of the step that repeats the real run's result. */
const onlyOnOtherLabels = (cond: string, label: string) =>
  new RegExp(`^${otherLabelTest(label)}$`).test(bare(cond));

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
    ...labelEventConditions(pipelines, heavy, label, unguarded),
    ...missingEvents(pipelines, heavy, label),
    ...missingSentinel(pipelines, label),
    ...mirrorForm(pipelines, heavy, label),
  ];
}

/** Whether a term of a job's `if:` decides on the event's own label or on a
 * label action, rather than on the pull request's label set. */
const readsLabelEvent = (term: string) =>
  /\bgithub\.event\.label\b/.test(term) ||
  (/\bgithub\.event\.action\b/.test(term) && /labeled/.test(term));

/** Every job of a workflow in the hold whose `if:` decides on the label event
 * in any form but the mirror form's skip term. A job skipped on a label event
 * can turn a failing head into a passing one, so a form the lint cannot prove
 * safe is a finding, never a pass. Jobs already reported as unguarded are not
 * reported again. */
function labelEventConditions(
  pipelines: Pipelines,
  heavy: { wf: Workflow; jobs: Job[] }[],
  label: string,
  reported: Found[],
): Found[] {
  const skip = new RegExp(`^!\\s*\\(\\s*${otherLabelTest(label)}\\s*\\)$`);
  return holdParticipants(pipelines, heavy).flatMap((wf) =>
    wf.jobs
      .filter(
        (job) => !reported.some((f) => f.file === wf.file && f.job === job.id),
      )
      .filter((job) =>
        (conjuncts(bare(condition(job))) ?? [bare(condition(job))]).some(
          (term) => readsLabelEvent(term) && !skip.test(term),
        ),
      )
      .map((job) =>
        at(
          wf,
          job,
          "ci-hold-guard",
        )(
          `job '${job.id}' decides on the label event in a form the lint cannot prove safe, and a job skipped on a label event can turn a failing head into a passing one`,
          `test the pull request's label set for the hold, and skip on another label's event only with the term !(github.event.label.name && github.event.label.name != '${label}') of the mirror form (${README}#ci-hold)`,
        ),
      ),
  );
}

/** A required job's step that repeats the newest real run's result: a `run:`
 * step whose whole `if:` is the other-label test, whose failure fails the job. */
const mirrorStep = (job: Job, label: string) =>
  failsOnError(job.def) &&
  steps(job).some(
    (step) =>
      runs(step) &&
      failsOnError(step) &&
      step.if !== undefined &&
      onlyOnOtherLabels(String(step.if), label),
  );

/** Whether `wf`'s run-name begins with the other-label test, marking a mirror
 * run apart from a real one. */
function marksMirrors(wf: Workflow, label: string): boolean {
  const name = wf.doc["run-name"];
  const rest =
    typeof name === "string"
      ? name.match(
          new RegExp(
            `^\\s*\\$\\{\\{\\s*${otherLabelTest(label)}\\s*&&([\\s\\S]*)\\}\\}\\s*$`,
          ),
        )?.[1]
      : undefined;
  if (rest === undefined) return false;
  // The literal start of each name the expression gives: the first is the
  // mirror's, each one after an `||` or `&&` another branch's.
  const starts = [
    ...`&&${rest}`.matchAll(/(?:&&|\|\|)\s*(?:format\(\s*)?'([^'{]*)/g),
  ].map((m) => m[1] ?? "");
  const [mirror, ...others] = starts;
  return (
    !!mirror &&
    others.some(
      (real) => real && !real.startsWith(mirror) && !mirror.startsWith(real),
    )
  );
}

/** Whether `wf`'s concurrency group gives a mirror run a key of its own: its
 * expression begins with the other-label test and a key that reads the run id,
 * outside any quoted text, before the first `||`. */
function isolatesMirrors(wf: Workflow, label: string): boolean {
  const concurrency = wf.doc.concurrency;
  const group = isRecord(concurrency) ? String(concurrency.group ?? "") : "";
  const key = group.match(
    new RegExp(`\\$\\{\\{\\s*${otherLabelTest(label)}\\s*&&([^|]*)\\|\\|`),
  )?.[1];
  return /\bgithub\.run_id\b/.test(key?.replace(/'[^']*'/g, "''") ?? "");
}

/** The mirror form's workflow-level findings: its concurrency group and its
 * run-name. */
function mirrorRunFindings(
  wf: Workflow,
  required: Job[],
  label: string,
): Found[] {
  const found = (key: string, problem: string, remedy: string): Found => ({
    rule: "ci-hold-mirror",
    file: wf.file,
    line: lineOf(wf.raw, topKey(key)) ?? triggerLine(wf),
    problem: `the workflow runs a mirror of the hold label '${label}' on another label's event, but ${problem}`,
    remedy: `${remedy} (${README}#ci-hold)`,
  });
  return [
    ...(isolatesMirrors(wf, label)
      ? []
      : [
          found(
            "concurrency",
            "its concurrency group is not that run's own, so the event cancels the real run in flight",
            `begin the group's expression with the other-label test and a key of the run's own, e.g. group: ci-\${{ github.event.label.name && github.event.label.name != '${label}' && format('mirror-{0}', github.run_id) || github.ref }}`,
          ),
        ]),
    ...(required.length && !marksMirrors(wf, label)
      ? [
          found(
            "run-name",
            "no run-name marks such a run, so its required job cannot tell a mirror run from a real one",
            `name a mirror run apart, e.g. run-name: \${{ github.event.label.name && github.event.label.name != '${label}' && format('ci mirror ({0} label)', github.event.label.name) || '' }}, and have the mirror step skip runs with that name`,
          ),
        ]
      : []),
  ];
}

/** The mirror form's job findings: each required job runs and repeats the
 * real result, and each heavy job skips. */
function mirrorJobFindings(
  wf: Workflow,
  required: Job[],
  heavyJobs: Job[],
  label: string,
): Found[] {
  const requiredFound = required.flatMap((job): Found[] => {
    const report = at(wf, job, "ci-hold-mirror");
    if (skipsOtherLabels(condition(job), label))
      return [
        report(
          `required job '${job.id}' skips on another label's event, and a skipped required check counts as passing`,
          `let it run on that event and repeat the newest real run's result (${README}#ci-hold)`,
        ),
      ];
    if (mirrorStep(job, label)) return [];
    return [
      report(
        `required job '${job.id}' has no step that runs only on another label's event, so that event's run judges the jobs it skipped instead of repeating the newest real run's result`,
        `add a run: step with if: \${{ github.event.label.name && github.event.label.name != '${label}' }} that repeats the newest real run's result and fails closed, and keep the steps that judge the jobs off that event (${README}#ci-hold)`,
      ),
    ];
  });
  const heavyFound = heavyJobs
    .filter((job) => !skipsOtherLabels(condition(job), label))
    .map((job) =>
      at(
        wf,
        job,
        "ci-hold-mirror",
      )(
        `heavy job '${job.id}' runs in full on another label's event, the work the mirror form exists to skip`,
        `add the term !(github.event.label.name && github.event.label.name != '${label}') to its if: (${README}#ci-hold)`,
      ),
    );
  return [...requiredFound, ...heavyFound];
}

/** The hold's mirror form, in every pull-request workflow that takes part in
 * it: a workflow that skips any job on another label's event, or whose
 * required job has a mirror step, or whose run-name tests for another label.
 * Such a run must cancel nothing, so its concurrency group is its own (keyed by
 * its run id); its required job must run and repeat the newest real run's
 * result, since a skipped required check passes and a run with none leaves the
 * check unreported; run-name must mark it, so a mirror never repeats another
 * mirror; and every heavy job skips, which is the saving. */
function mirrorForm(
  pipelines: Pipelines,
  heavy: { wf: Workflow; jobs: Job[] }[],
  label: string,
): Found[] {
  return holdParticipants(pipelines, heavy).flatMap((wf) => {
    const required = requiredJobs(wf, pipelines.settings);
    const inForm =
      marksMirrors(wf, label) ||
      wf.jobs.some((job) => skipsOtherLabels(condition(job), label)) ||
      required.some((job) => mirrorStep(job, label));
    if (!inForm) return [];
    const heavyJobs = heavy.filter((h) => h.wf === wf).flatMap((h) => h.jobs);
    return [
      ...mirrorRunFindings(wf, required, label),
      ...mirrorJobFindings(wf, required, heavyJobs, label),
    ];
  });
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
      remedy: `add a step with if: contains(github.event.pull_request.labels.*.name, '${label}') that exits 1 (in the required job, optionally after cancelling its own run so it is listed as cancelled once released) and does not continue on error, in a job that runs while held: the required job or one it needs (${README}#ci-hold)`,
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
