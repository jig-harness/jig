import { isMapping } from "../../shared/config-layers.ts";
import { GcError } from "../../shared/gc-error.ts";
/**
 * drive-pr's state as a collection kind: what `reap-state.ts` would retire of
 * the files a clone keeps beside the drive's database (a merged PR's logs,
 * notices and answers, and an earlier release's files past their retention
 * once the database imported them), read from its `--json` report so the
 * reaper's predicates stay in one place. Report only: nothing here removes.
 */
import { fileURLToPath } from "node:url";
import { run } from "../../shared/proc.ts";
import { gitEnvironment } from "../git.ts";
import type { CollectionKind, Proof, Resource } from "../types.ts";

interface ReaperReport {
  stateDir: string | null;
  exists?: boolean;
  retire: { id: string; reason: string }[];
  keep: { id: string; reason: string }[];
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
  const removed = value.entriesRemoved;
  return (
    (typeof value.stateDir === "string" || value.stateDir === null) &&
    families(value.retire) &&
    families(value.keep) &&
    typeof removed === "number" &&
    Number.isSafeInteger(removed) &&
    removed >= 0 &&
    Array.isArray(value.failures) &&
    value.failures.every((item) => typeof item === "string")
  );
}
function parseReport(text: string): ReaperReport {
  const value: unknown = JSON.parse(text);
  if (!validReport(value)) throw new GcError("Invalid state reaper report");
  return value;
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
      return [{ id: latest.stateDir ?? repository, details: latest }];
    },
    prove: async (resource): Promise<Proof> => {
      latest = await inspect();
      resource.details = latest;
      if (latest.failures.length)
        return { state: "unverified", reason: latest.failures.join("; ") };
      return latest.retire.length
        ? {
            state: "dead",
            reportOnly:
              "state creators do not yet share collection admission; report only",
            reason: `${latest.retire.length} state families meet the reaper's lifecycle and idle checks`,
          }
        : {
            state: "live",
            reason:
              "state reaper found no retirable families; details retain every family's proof",
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
