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
import {
  type Contention,
  readContention,
  UNREAD_CONTENTION,
} from "../contention.ts";
import { defaultBranchFile, pullRequestFiles } from "../forge.ts";
import type { ReadRecord } from "../launches.ts";
import { settleHolds } from "../serial-holds.ts";
import type { DrivenPr, RepoReport, RepoTarget } from "../types.ts";

/** The configured catalog names no file the default branch could hold. */
class CatalogPathError extends Error {}

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

/** The configured catalog as a path on the default branch; throws when it cannot name one. */
function repositoryPath(value: string): string {
  if (
    value.trim() === "" ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").includes("..")
  )
    throw new CatalogPathError(
      "drive.change_areas_catalog must be a repository-relative path for the catalog to be read from the default branch",
    );
  return value.replace(/^(\.\/)+/, "");
}

/** Decide serialization for one repository, report it, and keep its holds. */
export async function observeContention(
  repo: RepoTarget,
  values: Record<string, unknown>,
  report: RepoReport,
  forge: ForgeView,
  launches: readonly ReadRecord[],
  nowMs: number,
  threads: (pr: number) => Promise<number>,
): Promise<Contention> {
  if (!forge.ok) return UNREAD_CONTENTION;
  const merged = new Set(forge.merged.map((m) => m.number));
  const drives = forge.drives.filter((d) => !merged.has(d.number));
  const path = configuredCatalog(values);
  const where = `${repo.slug}@${repo.defaultBranch}:${path ?? ""}`;
  const contention = await readContention(
    {
      catalogPath: path,
      where,
      drives,
      created: forge.created,
      launches: launches.filter((r) => r.record.repo === repo.slug),
    },
    {
      catalog: async (p) => defaultBranchFile(repo, repositoryPath(p)),
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
  for (const reason of settleHolds(
    repo.slug,
    contention,
    new Date(nowMs).toISOString(),
  ))
    report.unplaced.push({
      target: "the outcome log",
      record: "runtime",
      reason,
    });
  return contention;
}
