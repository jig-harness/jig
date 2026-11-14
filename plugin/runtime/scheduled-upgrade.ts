/**
 * `jig upgrade --scheduled`: the upgrade the launcher runs, from the
 * installed plugin copy, before each job a timer starts. It upgrades at most
 * once per `upgrade.every` whichever timer fires first: under a lock it reads
 * the stamp of the latest attempt (`upgrade-stamp.ts`), withholds the
 * upgrade while that stamp is younger than the interval or its attempt is
 * still running, and otherwise claims the interval by writing a new one
 * before anything else runs, so a second timer firing meanwhile is withheld
 * and a failure is not tried again inside the interval. An attempt whose
 * process died before it finished claims nothing.
 *
 * Each harness is upgraded on the channel its marketplace follows, as `jig
 * upgrade` does (`harness.ts`, `upgrade.ts`): the plugin, then the installed
 * jobs' launcher copies and the `jig` command, from the copy now installed.
 * A harness pinned to a tag or another ref receives nothing; a plugin loaded
 * in place from a local marketplace folder is skipped, and that folder is
 * never touched. A machine whose user file says `upgrade: off` is withheld
 * before any of it. Rewriting a loaded launchd job would stop the job running
 * this upgrade, so a scheduled refresh leaves that job's file for the next
 * `jig upgrade` a person runs.
 *
 * It prints one line on standard output, the `ScheduledUpgrade` as JSON, and
 * its progress on standard error; it exits 1 only when the upgrade failed.
 */
import { mkdirSync } from "node:fs";
import { withFileLock } from "../shared/file-lock.ts";
import type { Component } from "./component.ts";
import {
  available,
  DEFAULT_SOURCE,
  describeSource,
  followsReleases,
  type Harness,
  HARNESSES,
  type HarnessResult,
  installed,
  PLUGIN_ID,
  type Programs,
  registeredMarketplace,
  type Say,
  upgradeHarnesses,
} from "./harness.ts";
import type { RefreshResult } from "./refresh.ts";
import { refreshFromInstalled } from "./upgrade.ts";
import {
  bounded,
  capped,
  type ScheduledUpgrade,
  type UpgradeSettings,
  upgradeLine,
  upgradeSettings,
} from "./upgrade-record.ts";
import {
  holderOf,
  readStamp,
  stampPath,
  stillRunning,
  upgradeStateRoot,
  ownsClaim,
  writeStamp,
  writeStampWhen,
} from "./upgrade-stamp.ts";
import { currentIso, currentMs, isoFromMs, parseMs } from "../shared/time.ts";

type Result = Omit<ScheduledUpgrade, "at">;

/** What the scheduled upgrade does with one harness, and why. */
interface Plan {
  harness: Harness;
  kind: "follows" | "pinned" | "in-place" | "absent" | "failed";
  detail: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the harness has installed and follows, and so what the upgrade does with it. */
function planFor(harness: Harness, program: string): Plan {
  const plan = (kind: Plan["kind"], detail: string): Plan => ({
    harness,
    kind,
    detail: `${harness}: ${detail}`,
  });
  try {
    if (!available(harness, program)) return plan("absent", "not on PATH");
    const state = installed(harness, program);
    if (state === null || !state.enabled)
      return plan("absent", `${PLUGIN_ID} is not installed and enabled`);
    if (state.inPlace !== undefined)
      return plan(
        "in-place",
        `loaded in place from ${state.inPlace}, which is left to whoever maintains that folder`,
      );
    const registered = registeredMarketplace(harness, program);
    if (registered === null)
      return plan("absent", "no jig marketplace is registered");
    if (!registered.git)
      return plan(
        "in-place",
        `installed from ${describeSource(registered)}, which is left to whoever maintains that folder`,
      );
    if (!followsReleases(registered))
      return plan(
        "pinned",
        `follows ${describeSource(registered)}, and a pin receives nothing`,
      );
    return plan("follows", `follows ${describeSource(registered)}`);
  } catch (error) {
    return plan("failed", message(error));
  }
}

/** The harnesses the job recorded, or with none recorded, both. */
function harnessesOf(programs: Programs): Harness[] {
  const recorded = HARNESSES.filter(
    (harness) => programs[harness] !== undefined,
  );
  return recorded.length > 0 ? recorded : [...HARNESSES];
}

/** One sentence per part, joined. */
const sentence = (parts: readonly string[]) => parts.join("; ");

/** What the plans, the harnesses' upgrades and the refresh came to, as one outcome. */
function summarize(
  plans: readonly Plan[],
  results: readonly HarnessResult[],
  refresh: readonly RefreshResult[],
): Result {
  const failures = [
    ...plans.filter((plan) => plan.kind === "failed").map((p) => p.detail),
    ...results
      .filter((r) => r.outcome === "failed" || r.outcome === "missing")
      .map((r) =>
        r.detail.startsWith(r.harness) ? r.detail : `${r.harness}: ${r.detail}`,
      ),
    ...refresh
      .filter((r) => r.outcome === "failed")
      .map((r) => `${r.target}: ${r.detail}`),
  ];
  const updated = results.filter((r) => r.outcome === "updated");
  const moves = updated.map((r) => `${r.harness} ${r.before} -> ${r.version}`);
  const first = updated[0];
  const versions =
    first?.before !== undefined && first.version !== undefined
      ? { from: first.before, to: first.version }
      : {};
  const left = plans
    .filter((plan) => plan.kind === "in-place" || plan.kind === "pinned")
    .map((plan) => plan.detail);
  if (failures.length > 0)
    return {
      outcome: "failed",
      detail: sentence([...moves, ...failures]),
      ...versions,
    };
  if (updated.length > 0)
    return {
      outcome: "updated",
      detail: sentence([...moves, ...left]),
      ...versions,
    };
  const unchanged = results.filter((r) => r.outcome === "unchanged");
  if (unchanged.length > 0)
    return {
      outcome: "unchanged",
      detail: sentence([
        ...unchanged.map((r) => `${r.harness} at ${r.version}`),
        ...left,
      ]),
    };
  if (plans.some((plan) => plan.kind === "in-place"))
    return { outcome: "skipped", detail: sentence(left) };
  if (plans.some((plan) => plan.kind === "pinned"))
    return { outcome: "withheld", detail: sentence(left) };
  return {
    outcome: "skipped",
    detail: sentence(plans.map((plan) => plan.detail)),
  };
}

interface ScheduledOptions {
  programs: Programs;
  components: readonly Component[];
  script: string;
  say: Say;
}

/** The upgrade of every harness that follows releases, then the refresh from the copy now installed. */
async function attempt(options: ScheduledOptions): Promise<Result> {
  const plans = harnessesOf(options.programs).map((harness) =>
    planFor(harness, options.programs[harness] ?? harness),
  );
  const results: HarnessResult[] = [];
  for (const plan of plans)
    if (plan.kind === "follows")
      results.push(
        ...upgradeHarnesses(
          {
            source: DEFAULT_SOURCE,
            explicit: false,
            defaulted: false,
            only: plan.harness,
            programs: options.programs,
          },
          options.say,
        ),
      );
  const current = results.some(
    (r) => r.outcome === "updated" || r.outcome === "unchanged",
  );
  const refresh = current
    ? await refreshFromInstalled(
        {
          request: {
            source: DEFAULT_SOURCE,
            explicit: false,
            defaulted: false,
            only: null,
            programs: options.programs,
          },
          components: options.components,
          script: options.script,
          say: options.say,
          scheduled: true,
        },
        results,
      )
    : [];
  return summarize(plans, results, refresh);
}

/**
 * Why the interval's attempt is withheld, from the latest stamp; null when it
 * is due: no stamp, one that does not read, or one older (or further ahead of
 * this clock) than the interval. A `running` stamp withholds while its holder
 * runs, whatever its age; one whose holder died is a failed attempt, which
 * withholds for the rest of its interval like any other.
 */
function withheldBy(
  settings: UpgradeSettings,
  nowMs: number,
): ((at: string) => ScheduledUpgrade) | null {
  const read = readStamp();
  if (!("stamp" in read)) return null;
  const last = read.stamp;
  const withheld = (detail: string) => (at: string) =>
    ({ outcome: "withheld", detail: capped(detail), at }) as const;
  const holder = last.outcome === "running" ? holderOf(last) : null;
  if (holder !== null && !holder.gone)
    return withheld(stillRunning(last, holder));
  // A stamp a little ahead of this clock is fresh too: another job may have
  // written it after this one read the time.
  const elapsed = nowMs - parseMs(last.at);
  if (Math.abs(elapsed) >= settings.everyMs) return null;
  const due = isoFromMs(parseMs(last.at) + settings.everyMs);
  const latest = holder?.gone
    ? `the upgrade started at ${last.at} did not finish (${holder.reason})`
    : `the latest, at ${last.at}, ${upgradeLine({ ...last, outcome: last.outcome as ScheduledUpgrade["outcome"] })}`;
  return withheld(
    `upgrade.every is ${settings.every}: ${latest}; the next is due at ${due}`,
  );
}

/**
 * Claims this interval's attempt: under the stamp's lock, a fresh stamp
 * withholds it; otherwise a `running` stamp is written before the lock is
 * released. Null when this process holds the claim.
 */
async function claim(
  settings: UpgradeSettings,
  at: string,
): Promise<ScheduledUpgrade | null> {
  const root = upgradeStateRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const taken = await withFileLock(
    stampPath(root),
    async () => {
      const withheld = withheldBy(settings, currentMs());
      if (withheld !== null) return withheld(at);
      writeStamp({
        outcome: "running",
        detail: "a scheduled job started it",
        at,
      });
      return null;
    },
    { root, name: "claim" },
  );
  return taken === null
    ? {
        outcome: "withheld",
        detail: "another job is claiming this interval's upgrade",
        at,
      }
    : taken.value;
}

/** The scheduled upgrade, whatever it comes to; only the attempt it claimed writes the stamp. */
async function scheduledUpgrade(
  options: ScheduledOptions,
): Promise<ScheduledUpgrade> {
  const at = currentIso();
  const read = upgradeSettings();
  if (!read.ok) return { outcome: "failed", detail: read.failure.reason, at };
  const settings = read.value;
  if (!settings.enabled)
    return {
      outcome: "withheld",
      detail: `upgrade is off in ${settings.path}`,
      at,
    };
  const withheld = await claim(settings, at);
  if (withheld !== null) return withheld;
  let result: Result;
  try {
    result = await attempt(options);
  } catch (error) {
    result = { outcome: "failed", detail: message(error) };
  }
  const upgrade = bounded({ ...result, at });
  try {
    // Fenced to this attempt's claim: a stamp another process has written since stands.
    const written = await writeStampWhen(
      upgrade,
      (standing) => ownsClaim(standing) || !("stamp" in standing),
    );
    return written
      ? upgrade
      : bounded({
          ...upgrade,
          detail: `${upgrade.detail}; the stamp was left as another upgrade wrote it`,
        });
  } catch (error) {
    // The attempt's own outcome stands; the next one is due once this process is gone.
    return bounded({
      ...upgrade,
      detail: `${upgrade.detail}; the stamp could not be written: ${message(error)}`,
    });
  }
}

/** Runs `jig upgrade --scheduled`: one line of JSON on standard output, progress on standard error. */
export async function scheduledUpgradeVerb(
  programs: Programs,
  context: { components: readonly Component[]; script: string },
): Promise<number> {
  let upgrade: ScheduledUpgrade;
  try {
    upgrade = await scheduledUpgrade({
      programs,
      ...context,
      say: console.error,
    });
  } catch (error) {
    upgrade = {
      outcome: "failed",
      detail: message(error),
      at: currentIso(),
    };
  }
  upgrade = bounded(upgrade);
  console.error(`upgrade: ${upgradeLine(upgrade)}`);
  console.log(JSON.stringify(upgrade));
  return upgrade.outcome === "failed" ? 1 : 0;
}
