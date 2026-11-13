/**
 * The preflight: before the tick launches a stage that touches the tracker,
 * it asks, headless, whether each account the launch could bill reaches the
 * repository's tracker with the credential a pass on that account would
 * read. A pass that cannot (an operating system keychain waiting for an
 * approval, a lapsed connection) would fail on it, and every such pass of
 * the repository would raise its own need for one fault of the host's.
 *
 * The stages that touch the tracker are the follow-up (it settles the
 * merged work's items) and the pickup (it claims and records its item); a
 * steward's resume of a stalled one counts as that stage. A drive's re-arm
 * or takeover and the steward's own pass read the tracker through nothing
 * but the tick, and are never held.
 *
 * Each account is asked once per tick for each tracker, whichever
 * repositories read it (`run.ts tracker`, in the account's environment and
 * the first such repository's checkout). An account whose answer failed is
 * held: no tracker stage of the repository launches on it this tick, the
 * launch tries the next account, and with none left it waits, naming the
 * answers. The repository's report keeps one hold per account, with the
 * check's answer and the stages it held, which the line shows as one need
 * of the host's, act Authorize (`preflightNeeds`). Nothing is kept between
 * ticks: the next tick asks again, and an account whose answer passes is
 * no longer held and raises no need.
 *
 * `preflight` in the machine file names the checks (`preflight-config.ts`);
 * `[]` turns them off.
 */
import { resolve } from "node:path";
import { actOfNeed } from "../../shared/acts.ts";
import { run } from "../../shared/proc.ts";
import { admittedVendor, passEnvironment } from "./accounts.ts";
import type { LineNeed } from "./dashboard-contract.ts";
import type { LaunchAction } from "./launches.ts";
import type { OpenedRepo, Tracked } from "./tick-observe.ts";
import type { MachineAccount } from "./machine-config.ts";
import { type PreflightProbe, preflightOf } from "./preflight-config.ts";
import { failureText, probeFailure } from "./text.ts";
import { isMapping } from "../../shared/config-layers.ts";
import type { PreflightHold, RepoReport, Stage } from "./types.ts";

/** What the tracker probe prints (`tracker-probe.ts`). */
export type TrackerAnswer = { ok: true } | { ok: false; reason: string };

/** Whether a parsed value is what the probe prints. */
function isTrackerAnswer(value: unknown): value is TrackerAnswer {
  return (
    isMapping(value) &&
    (value.ok === true ||
      (value.ok === false && typeof value.reason === "string"))
  );
}

/** The stages whose passes touch the tracker. */
const TRACKER_STAGES: ReadonlySet<string> = new Set<Stage>([
  "followup",
  "pickup",
]);

/** One repository's tracker, as the probe opens it. */
export interface TrackerTarget {
  slug: string;
  /** The repository's checkout, where the probe runs. */
  path: string;
  /** The tracker's identity: repositories that read the same tracker share one answer per account. */
  tracker: string;
  /** The repository's configuration as the tick read it, from which the probe opens the tracker. */
  values: Record<string, unknown>;
  /** The report the holds go on. */
  report: RepoReport;
}

/** Ask whether `account` reaches `target`'s tracker, within `timeoutSec`. */
export type TrackerProbe = (
  account: MachineAccount,
  target: TrackerTarget,
  timeoutSec: number,
) => Promise<TrackerAnswer>;

/** The preflight's part of one tick's apply state. */
export interface Preflight {
  probes: readonly PreflightProbe[];
  /** Each repository's tracker, by slug, registered as its turn starts acting. */
  targets: Map<string, TrackerTarget>;
  /** Each answer this tick, by account and tracker. */
  answers: Map<string, Promise<TrackerAnswer>>;
  probe: TrackerProbe;
}

/** A tick's preflight under the machine file's checks. */
export function newPreflight(
  machine: { preflight?: readonly PreflightProbe[] },
  probe: TrackerProbe = spawnTrackerProbe,
): Preflight {
  return {
    probes: preflightOf(machine),
    targets: new Map(),
    answers: new Map(),
    probe,
  };
}

/** Whether the preflight checks `stage`'s launches. */
export function checksStage(preflight: Preflight, stage: string): boolean {
  return preflight.probes.includes("tracker") && TRACKER_STAGES.has(stage);
}

/**
 * The accounts among `accounts` whose tracker answer failed for the
 * repository `slug`, each with the answer, for a launch of `stage`; each
 * account asked at most once per tick and tracker, the accounts not yet
 * asked side by side. A repository with no tracker registered holds none.
 */
export async function heldAccounts(
  preflight: Preflight,
  slug: string,
  stage: Stage,
  accounts: readonly MachineAccount[],
  timeoutSec: number,
): Promise<Map<string, string>> {
  const held = new Map<string, string>();
  const target = preflight.targets.get(slug);
  if (target === undefined || !checksStage(preflight, stage)) return held;
  const answers = await Promise.all(
    accounts.map(async (account) => {
      const key = `${account.name}\u0000${target.tracker}`;
      let answer = preflight.answers.get(key);
      if (answer === undefined) {
        answer = preflight.probe(account, target, timeoutSec);
        preflight.answers.set(key, answer);
      }
      return [account.name, await answer] as const;
    }),
  );
  for (const [name, answer] of answers) {
    if (answer.ok) continue;
    held.set(name, answer.reason);
    hold(target.report, name, answer.reason, stage);
  }
  return held;
}

/** Keep one hold per account on the report, with each stage it held. */
function hold(
  report: RepoReport,
  account: string,
  reason: string,
  stage: Stage,
): void {
  report.preflight ??= [];
  const known = report.preflight.find((h) => h.account === account);
  if (known === undefined) {
    report.preflight.push({
      probe: "tracker",
      account,
      reason,
      stages: [stage],
    });
    return;
  }
  if (!known.stages.includes(stage)) known.stages.push(stage);
}

/**
 * A repository's tracker for the probe, from what its observe phase read;
 * `null` when its tracker configuration did not read, so no pass of it
 * could reach a tracker either.
 */
export function trackerTargetOf(
  opened: Pick<OpenedRepo, "repo" | "values" | "report">,
  tracked: Pick<Tracked, "adapter" | "issueRepository" | "servedPolicy">,
): TrackerTarget | null {
  const { adapter } = tracked;
  if (adapter === null) return null;
  const tracker =
    adapter === "github" && tracked.issueRepository !== null
      ? `github:${tracked.issueRepository.toLowerCase()}`
      : (tracked.servedPolicy?.trackerNamespace ??
        `${adapter}:${opened.repo.slug}`);
  return {
    slug: opened.repo.slug,
    path: opened.repo.path,
    tracker,
    values: opened.values,
    report: opened.report,
  };
}

/** What a launch held on every account it could bill waits on. */
export function heldDetail(held: ReadonlyMap<string, string>): string {
  return `the tracker preflight holds it on ${[...held]
    .map(([account, reason]) => `${account} (${reason})`)
    .join(", ")}`;
}

const RUN_TS = resolve(import.meta.dir, "../run.ts");
const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");

/** The probe's script: `run.ts`, unless a test names another one. */
function probeScript(): string {
  return process.env.JIG_DISPATCH_TRACKER_PROBE || RUN_TS;
}

/**
 * `run.ts tracker` in the account's pass environment and the repository's
 * checkout, the configuration on its input; a probe that exits otherwise,
 * or prints no answer, is a failed answer that says so.
 */
async function spawnTrackerProbe(
  account: MachineAccount,
  target: TrackerTarget,
  timeoutSec: number,
): Promise<TrackerAnswer> {
  // The child's own deadline ends the tracker's request first, so its answer names the cause.
  const deadlineMs = Math.max(1_000, timeoutSec * 1_000 - 2_000);
  const command = [
    process.execPath,
    "--no-env-file",
    `--config=${BUNFIG}`,
    probeScript(),
    "tracker",
    target.slug,
    String(deadlineMs),
  ];
  const env = passEnvironment(process.env, {
    vendor: admittedVendor(account),
    configDir: account.configDir,
  });
  try {
    const done = await run(command, {
      timeoutSec,
      cwd: target.path,
      stdin: JSON.stringify(target.values),
      env,
    });
    if (done.code !== 0)
      return { ok: false, reason: probeFailure("the tracker probe", done) };
    const value: unknown = JSON.parse(done.stdout);
    return isTrackerAnswer(value)
      ? value
      : { ok: false, reason: "the tracker probe printed no answer" };
  } catch (error) {
    return {
      ok: false,
      reason: `the tracker probe printed no answer: ${failureText(error)}`,
    };
  }
}

/**
 * The line's needs for one repository's holds: one per account, act
 * Authorize, its time the first tick that held it, while holds continue.
 */
export function preflightNeeds(
  report: RepoReport,
  slug: string,
  previous: readonly LineNeed[],
  nowIso: string,
): LineNeed[] {
  return (report.preflight ?? []).map((h: PreflightHold): LineNeed => {
    const target = `account ${h.account}`;
    const since = previous.find(
      (n) =>
        n.repo === slug &&
        n.target === target &&
        n.cause === "tracker-unreachable",
    )?.since;
    return {
      cause: "tracker-unreachable",
      act: actOfNeed({ cause: "tracker-unreachable" }),
      stage: (h.stages[0] ?? "followup") as LaunchAction,
      repo: slug,
      target,
      pr: null,
      item: null,
      url: null,
      title: null,
      workspace: null,
      since: since ?? nowIso,
      reason: `account ${h.account} cannot reach the tracker, so its ${h.stages.join(" and ")} launches are held: ${h.reason}`,
      question: null,
      decisions: [],
      notified: null,
      workspaces: [],
    };
  });
}
