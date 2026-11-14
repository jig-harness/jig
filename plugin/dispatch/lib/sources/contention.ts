/**
 * Serialization's reads for one repository's tick: the change-area catalog
 * the repository's configuration names (`drive.change_areas_catalog`),
 * read from the default branch as the forge holds it, as the dispatch
 * section is, so a pull request cannot unserialize its own area; each open
 * pull request's changed files and, in a group of two or more, its
 * unresolved review threads. What it decides goes into the report, and
 * each hold that begins or ends this tick into the state database and the
 * outcome log (`serial-holds.ts`).
 */
import { isRecord } from "../../../shared/guards.ts";
import { failed, ok, type Outcome } from "../../../shared/outcome.ts";
import {
  catalogFailed,
  type Contention,
  readContention,
  UNREAD_CONTENTION,
} from "../contention.ts";
import { defaultBranchFile, pullRequestFiles } from "../forge.ts";
import type { ReadRecord } from "../launches.ts";
import { settleHolds } from "../serial-holds.ts";
import type { DrivenPr, RepoReport, RepoTarget } from "../types.ts";
import { isoFromMs } from "../../../shared/time.ts";

/** What the forge gave the tick, as serialization reads it. */
export interface ForgeView {
  ok: boolean;
  drives: readonly DrivenPr[];
  merged: ReadonlyArray<{ number: number }>;
  created: ReadonlyMap<number, string>;
}

/** `drive.change_areas_catalog` as configured; `null` when none is, `""` when it is not text. */
function configuredCatalog(values: Record<string, unknown>): string | null {
  const drive = values.drive;
  const value = isRecord(drive) ? drive.change_areas_catalog : undefined;
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : "";
}

/** The configured catalog as a path on the default branch; `invalid` when it cannot name one. */
function repositoryPath(value: string): Outcome<string, "invalid"> {
  if (
    value.trim() === "" ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").includes("..")
  )
    return failed(
      "invalid",
      "drive.change_areas_catalog must be a repository-relative path for the catalog to be read from the default branch",
    );
  return ok(value.replace(/^(\.\/)+/, ""));
}

/**
 * Decide serialization for one repository, report it, and keep its holds.
 * Only the host that owns the repository writes the holds and their rows in
 * the outcome log; another host reads the same order and writes neither.
 * With `skipped`, the reasons its reads were skipped this tick, nothing is
 * read where a catalog is configured: every drive is unplaced with that
 * reason, so no re-arm starts on one whose area cannot be told, and no hold
 * begins or ends.
 */
export async function observeContention(
  repo: RepoTarget,
  values: Record<string, unknown>,
  report: RepoReport,
  forge: ForgeView & { heldElsewhere?: ReadonlySet<number>; owner?: boolean },
  launches: readonly ReadRecord[],
  nowMs: number,
  threads: (pr: number) => Promise<Outcome<number>>,
  skipped: string | null = null,
): Promise<Contention> {
  if (!forge.ok) return UNREAD_CONTENTION;
  const merged = new Set(forge.merged.map((m) => m.number));
  const drives = forge.drives.filter((d) => !merged.has(d.number));
  const path = configuredCatalog(values);
  if (skipped !== null && path !== null)
    return catalogFailed({ drives }, skipped);
  const where = `${repo.slug}@${repo.defaultBranch}:${path ?? ""}`;
  const contention = await readContention(
    {
      catalogPath: path,
      where,
      drives,
      created: forge.created,
      launches: launches.filter((r) => r.record.repo === repo.slug),
      ...(forge.heldElsewhere === undefined
        ? {}
        : { heldElsewhere: forge.heldElsewhere }),
    },
    {
      catalog: async (p) => {
        const relative = repositoryPath(p);
        return relative.ok ? defaultBranchFile(repo, relative.value) : relative;
      },
      files: (pr) => pullRequestFiles(repo.slug, pr),
      threads,
    },
  );
  if (path !== null)
    report.records.push({
      record: "forge",
      source: `gh ${where}`,
      ok: contention.failure === undefined,
      detail:
        contention.failure === undefined
          ? `the change-area catalog serializes ${contention.report?.areas.join(", ") || "no area"}`
          : `the change-area catalog cannot be read, so no re-arm starts on a pull request whose serialized areas cannot be told: ${contention.failure}`,
    });
  if (contention.report !== null) report.serialized = contention.report;
  if (forge.owner === false) return contention;
  for (const reason of settleHolds(repo.slug, contention, isoFromMs(nowMs)))
    report.unplaced.push({
      target: "the outcome log",
      record: "runtime",
      reason,
    });
  return contention;
}
