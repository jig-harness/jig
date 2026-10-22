import { isMapping } from "../../shared/config-layers.ts";
import { GcError } from "../../shared/gc-error.ts";
/** Keep drive-pr's operated predicates and refusing lock protocol in one place. */
import { fileURLToPath } from "node:url";
import { run } from "../../shared/proc.ts";
import { gitEnvironment } from "../git.ts";
import type { CollectionKind, Proof, Resource } from "../types.ts";

interface ReaperReport {
  stateDir: string;
  exists?: boolean;
  retire: { id: string; reason: string }[];
  keep: { id: string; reason: string }[];
  anchorsCompactable: number;
  anchorsCompacted: number;
  entriesRemoved: number;
  failures: string[];
}
function validReport(value: unknown): value is ReaperReport {
  if (!isMapping(value)) return false;
  const families = (items: unknown): boolean =>
    Array.isArray(items) &&
    items.every(
      (item) =>
        isMapping(item) &&
        typeof item.id === "string" &&
        typeof item.reason === "string",
    );
  return (
    typeof value.stateDir === "string" &&
    families(value.retire) &&
    families(value.keep) &&
    [
      value.anchorsCompactable,
      value.anchorsCompacted,
      value.entriesRemoved,
    ].every(
      (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
    ) &&
    Array.isArray(value.failures) &&
    value.failures.every((item) => typeof item === "string")
  );
}
function parseReport(text: string): ReaperReport {
  const value: unknown = JSON.parse(text);
  if (!isMapping(value)) throw new GcError("Invalid state reaper report");
  if (value.exists !== false && !validReport(value))
    throw new GcError("Invalid state reaper report");
  const report = value;
  if (report.exists === false && typeof report.stateDir === "string") {
    return {
      stateDir: report.stateDir,
      retire: [],
      keep: [],
      anchorsCompactable: 0,
      anchorsCompacted: 0,
      entriesRemoved: 0,
      failures: Array.isArray(report.failures)
        ? report.failures.map(String)
        : [],
    };
  }
  if (!validReport(report)) throw new GcError("Invalid state reaper report");
  return report;
}
/**
 * Worktree identity is dropped, but the relocated state root is the supported
 * location contract every drive-pr participant shares, so it is kept.
 */
export function reaperEnvironment(
  repository: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...gitEnvironment(env),
    ...(env.DRIVE_PR_STATE_DIR
      ? { DRIVE_PR_STATE_DIR: env.DRIVE_PR_STATE_DIR }
      : {}),
    JIG_CONSUMER_ROOT: repository,
  };
}
export function toolStateKind(
  repository: string,
  declaration: string,
  idleDays: number,
): CollectionKind {
  let latest: ReaperReport;
  const inspect = async (): Promise<ReaperReport> => {
    const result = await run(
      [
        process.execPath,
        "--no-env-file",
        `--config=${fileURLToPath(new URL("../bunfig.toml", import.meta.url))}`,
        fileURLToPath(
          new URL(
            "../../skills/drive-pr/scripts/reap-state.ts",
            import.meta.url,
          ),
        ),
        "--json",
        "--min-age-days",
        String(idleDays),
      ],
      {
        cwd: repository,
        timeoutSec: 600,
        env: reaperEnvironment(repository),
      },
    );
    if (![0, 1].includes(result.code) || !result.stdout.trim())
      throw new GcError(
        `state reaper failed: ${result.stderr || result.stdout}`,
      );
    return parseReport(result.stdout);
  };
  return {
    name: "tool-state",
    repository,
    declaration,
    inventory: async (): Promise<Resource[]> => {
      latest = await inspect();
      return [{ id: latest.stateDir, details: latest }];
    },
    prove: async (resource): Promise<Proof> => {
      latest = await inspect();
      resource.details = latest;
      if (latest.failures.length)
        return { state: "unverified", reason: latest.failures.join("; ") };
      return latest.retire.length || latest.anchorsCompactable
        ? {
            state: "dead",
            reportOnly:
              "state creators do not yet share collection admission; report only",
            reason: `${latest.retire.length} state families meet the reaper's lifecycle and idle checks; ${latest.anchorsCompactable} anchors can be compacted without deleting their fences`,
          }
        : {
            state: "live",
            reason:
              "state reaper found no retirable families or uncompacted fences; details retain every family's proof",
          };
    },
    collect: async () => ({
      outcome: "refused",
      reason:
        "state creators do not yet share collection admission; report only",
    }),
    describe: (resource) => `drive-pr state ${resource.id}`,
    exclusive: (body) => body(),
  };
}
