/**
 * `jig dispatch probe [--apply] [--json]`: one change probe
 * (`lib/change-probe.ts`) over the repositories the machine file
 * dispatches. Without `--apply` it reads the forge and says which
 * repositories it would wake, and writes nothing. With it, it wakes each
 * changed repository's tick and keeps what it saw for the next probe: the
 * probe's own timer runs it once a minute (`install.ts`).
 *
 * Under that timer the probe is the woken tick's waiter itself
 * (`wakeTickHere`): the scheduler ends whatever a job leaves running, so it
 * waits for the ticks it wakes, one repository after another, before it
 * exits. A probe whose forge read fails wakes nothing, prints why on
 * standard error and exits 1; the sweep runs on its own timer either way.
 */
import { ExitError } from "../shared/cli.ts";
import { failed, ok, type Outcome } from "../shared/outcome.ts";
import { probe, type ProbeDeps, type ProbeReport } from "./lib/change-probe.ts";
import { githubProbeForge } from "./lib/change-probe-github.ts";
import { type MachineConfig, machineConfigPath } from "./lib/machine-config.ts";
import { wakeTickHere } from "./lib/wake-tick.ts";

/** Exit when the forge did not read and nothing was woken. */
const PROBE_UNREAD_EXIT = 1;
/** Exit when an applied probe's wake did not record or its state was not written: the report is printed, the job fails. */
const PROBE_UNKEPT_EXIT = 3;

export interface ProbeOptions {
  apply: boolean;
  json: boolean;
}

/** Wake the tick of the checkout at `path` and wait for it, saying how the waiter ended. */
async function wakeHere(
  path: string,
  reason: string,
): Promise<Outcome<string, "failed">> {
  const woke = await wakeTickHere(path, reason);
  if (!woke.ok) return woke;
  switch (woke.value) {
    case "elsewhere":
      return ok("taken by the waiter already holding the wake");
    case "failed":
      return failed(
        "failed",
        "the woken tick did not start; the wake's last-run.log says why",
      );
    case "bounded":
      return ok("woken; requests are left for the next wake");
    case "idle":
      return ok("woken");
  }
}

/** The report in lines, for a person and the scheduler's log. */
function formatProbe(report: ProbeReport): string {
  if (report.status === "busy")
    return "another probe is running, so this one did nothing";
  if (report.status === "off")
    return `the change probe is off: change_probe is false in ${machineConfigPath()}`;
  const lines = [
    `probe: ${report.probed.length} repositor${report.probed.length === 1 ? "y" : "ies"}${report.since === null ? "" : ` since ${report.since}`}, ${report.calls} call(s) costing ${report.cost} point(s)${report.remaining === null ? "" : `, ${report.remaining} left`}`,
  ];
  if (report.changes.length === 0) lines.push("  no change: nothing woken");
  for (const change of report.changes) {
    lines.push(`  ${change.slug}: ${change.what.join(", ")}`);
    for (const path of change.paths)
      lines.push(
        `    ${path}: ${change.woke?.[path] ?? "would be woken (no --apply)"}`,
      );
  }
  for (const slug of report.unseen)
    lines.push(
      `  ${slug}: not visible to the signed-in account, so its changes wait for the sweep`,
    );
  for (const { path, reason } of report.unresolved)
    lines.push(
      `  ${path}: its forge repository did not read (${reason}), so its changes wait for the sweep`,
    );
  if (report.restarted !== undefined)
    lines.push(`  the kept state was started over: ${report.restarted}`);
  if (report.unkept !== undefined)
    lines.push(`  what this probe saw was not kept: ${report.unkept}`);
  return lines.join("\n");
}

/** One probe over `machine`'s repositories, printed; `deps` replaces the forge, the wake or the state directory. */
export async function probeMain(
  options: ProbeOptions,
  machine: MachineConfig | null,
  deps: Partial<ProbeDeps> = {},
): Promise<number> {
  if (machine === null)
    throw new ExitError(
      2,
      `jig dispatch probe needs the machine file ${machineConfigPath()}: the repositories it reads are the ones that file dispatches`,
    );
  const result = await probe(machine, options.apply, {
    forge: githubProbeForge,
    wake: wakeHere,
    ...deps,
  });
  if (!result.ok) {
    console.error(
      `jig dispatch probe: the forge did not read, so nothing is woken: ${result.failure.reason}`,
    );
    return PROBE_UNREAD_EXIT;
  }
  console.log(
    options.json
      ? JSON.stringify(result.value, null, 2)
      : formatProbe(result.value),
  );
  return result.value.unkept === undefined ? 0 : PROBE_UNKEPT_EXIT;
}
