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
 * the first such repository's checkout). An account the tracker refused, or
 * that gave no answer by the probe's deadline (a credential waiting on an
 * approval), is held: no tracker stage of the repository launches on it
 * this tick, the launch tries the next account, and with none left it
 * waits, naming the answers. An answer that says nothing of the credential
 * holds nothing: a rate limit, a server error or the network (the stage's
 * own handling of them applies), or a configuration that does not open a
 * tracker (the stage's own failure reports it). Each repository's report
 * keeps one hold per account, with the answer and the stages it held; the
 * line shows one need per account for the whole host, act Authorize,
 * naming every repository it holds (`preflightNeeds`). Nothing is kept
 * between ticks: the next tick asks again, and an account whose answer
 * passes is no longer held and raises no need.
 *
 * `preflight` in the machine file names the checks (`preflight-config.ts`);
 * `[]` turns them off.
 */
import { resolve } from "node:path";
import { actOfNeed } from "../../shared/acts.ts";
import { swallow } from "../../shared/errors.ts";
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

/**
 * What the tracker probe prints (`tracker-probe.ts`). A failed answer's
 * `kind` says what it tells of the credential: `unreachable`, the tracker
 * refused it or gave no answer in time, which holds the account;
 * `transient`, a rate limit, a server error or the network; `config`, a
 * configuration that opens no tracker. Neither of the last two holds it.
 */
export type TrackerAnswer =
  | { ok: true }
  | {
      ok: false;
      kind: "unreachable" | "transient" | "config";
      reason: string;
    };

const KINDS: readonly unknown[] = ["unreachable", "transient", "config"];

/** What the probe printed as its answer, a failed answer with no kind read as unreachable; `null` when it is not one. */
function answerOf(value: unknown): TrackerAnswer | null {
  if (!isMapping(value)) return null;
  if (value.ok === true) return { ok: true };
  if (value.ok !== false || typeof value.reason !== "string") return null;
  const kind = KINDS.includes(value.kind)
    ? (value.kind as "unreachable" | "transient" | "config")
    : "unreachable";
  return { ok: false, kind, reason: value.reason };
}

/** The repository a need about the whole host names on the line. */
export const HOST_NEED_REPO = "host";

/** The stages whose passes touch the tracker. */
const TRACKER_STAGES: ReadonlySet<string> = new Set<Stage>([
  "followup",
  "pickup",
]);

/** The maximum number of credential helper processes a tracker preflight starts at once. */
const TRACKER_PROBE_CONCURRENCY = 4;

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
 * account asked at most once per tick and tracker, with at most
 * `TRACKER_PROBE_CONCURRENCY` new probes running at once. A repository with
 * no tracker registered holds none.
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
  const answers: Array<readonly [string, TrackerAnswer]> = [];
  let next = 0;
  const worker = async () => {
    while (next < accounts.length) {
      const account = accounts[next++];
      if (account === undefined) continue;
      const key = `${account.name}\u0000${target.tracker}`;
      let answer = preflight.answers.get(key);
      if (answer === undefined) {
        answer = preflight.probe(account, target, timeoutSec);
        preflight.answers.set(key, answer);
      }
      answers.push([account.name, await answer] as const);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(TRACKER_PROBE_CONCURRENCY, accounts.length) },
      worker,
    ),
  );
  for (const [name, answer] of answers) {
    if (answer.ok || answer.kind !== "unreachable") continue;
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
 * checkout, the configuration on its input, its answer the last line it
 * prints. A probe that runs out its time, exits otherwise or prints no
 * answer is an `unreachable` answer that says so: a client that hangs on
 * its credential looks like that.
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
    const failure = {
      ok: false,
      kind: "unreachable",
      reason: probeFailure("the tracker probe", done),
    } as const;
    if (done.code !== 0) return failure;
    return answerOf(lastLine(done.stdout)) ?? failure;
  } catch (error) {
    return {
      ok: false,
      kind: "unreachable",
      reason: `the tracker probe could not run: ${failureText(error)}`,
    };
  }
}

/** The last line of `text` that is not empty, parsed; `null` when it does not parse. */
function lastLine(text: string): unknown {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .at(-1);
  if (line === undefined) return null;
  try {
    return JSON.parse(line);
  } catch (error) {
    // A line that is not an answer leaves the probe's whole output for the reason.
    swallow(error, "the tracker probe's last line is not JSON");
    return null;
  }
}

/** One account's holds across the host's repositories. */
interface AccountHolds {
  repos: string[];
  stages: Stage[];
  /** Each distinct answer, with the repositories that got it. */
  answers: Map<string, string[]>;
}

/**
 * The line's needs for the holds on every repository's report: one per
 * account for the whole host (`repo` is `HOST_NEED_REPO`), act Authorize,
 * naming every repository it holds and the answers; its time the first
 * tick that held it, while holds continue.
 */
export function preflightNeeds(
  reports: readonly RepoReport[],
  previous: readonly LineNeed[],
  nowIso: string,
): LineNeed[] {
  return [...holdsByAccount(reports)].map(([account, at]) =>
    hostNeed(account, at, previous, nowIso),
  );
}

/** Every repository's holds, gathered by account. */
function holdsByAccount(
  reports: readonly RepoReport[],
): Map<string, AccountHolds> {
  const byAccount = new Map<string, AccountHolds>();
  for (const report of reports)
    for (const h of report.preflight ?? []) {
      const at: AccountHolds = byAccount.get(h.account) ?? {
        repos: [],
        stages: [],
        answers: new Map(),
      };
      byAccount.set(h.account, at);
      addHold(at, report.slug ?? report.path, h);
    }
  return byAccount;
}

/** One repository's hold added to its account's. */
function addHold(at: AccountHolds, repo: string, h: PreflightHold): void {
  if (!at.repos.includes(repo)) at.repos.push(repo);
  at.stages.push(...h.stages.filter((stage) => !at.stages.includes(stage)));
  at.answers.set(h.reason, [...(at.answers.get(h.reason) ?? []), repo]);
}

/** One account's need: the answer alone when every repository got the same one, else each with its repositories. */
function hostNeed(
  account: string,
  at: AccountHolds,
  previous: readonly LineNeed[],
  nowIso: string,
): LineNeed {
  const target = `account ${account}`;
  const since = previous.find(
    (n) =>
      n.repo === HOST_NEED_REPO &&
      n.target === target &&
      n.cause === "tracker-unreachable",
  )?.since;
  const answers =
    at.answers.size === 1
      ? [...at.answers.keys()]
      : [...at.answers].map(
          ([reason, repos]) => `${repos.join(", ")}: ${reason}`,
        );
  return {
    cause: "tracker-unreachable",
    act: actOfNeed({ cause: "tracker-unreachable" }),
    stage: (at.stages[0] ?? "followup") as LaunchAction,
    repo: HOST_NEED_REPO,
    target,
    pr: null,
    item: null,
    url: null,
    title: null,
    workspace: null,
    since: since ?? nowIso,
    reason: `account ${account} cannot reach the tracker, so its ${at.stages.join(" and ")} launches in ${at.repos.join(", ")} are held: ${answers.join("; ")}`,
    question: null,
    decisions: [],
    notified: null,
    workspaces: [],
  };
}
