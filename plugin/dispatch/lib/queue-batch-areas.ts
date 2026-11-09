/** Catalog sensitivity flags apply before grouping, from the reviewed default branch. */
import { isRecord } from "../../shared/guards.ts";
import { loadCatalogText } from "../../skills/drive-pr/scripts/lib/change-areas-catalog.ts";
import { parseAgentRouting } from "../../skills/do-item/scripts/determine_agent.ts";
import { defaultBranchFile } from "./forge.ts";
import type { RepoTarget, WantedItem } from "./types.ts";

export async function batchSafePickups(
  repo: RepoTarget,
  values: Record<string, unknown>,
  items: WantedItem[],
  allowRead = true,
): Promise<WantedItem[]> {
  if (!items.some((item) => item.servedPerson !== undefined)) return items;
  const configured = isRecord(values.drive)
    ? values.drive.change_areas_catalog
    : undefined;
  if (configured === undefined) return items;
  const refused = () => items.map((i) => ({ ...i, batchAllowed: false }));
  if (!allowRead) return refused();
  if (
    typeof configured !== "string" ||
    configured.startsWith("/") ||
    /^[A-Za-z]:/.test(configured) ||
    configured.split("/").includes("..")
  )
    return refused();
  const read = await defaultBranchFile(repo, configured);
  if (!read.ok || read.value === null) return refused();
  try {
    const catalog = loadCatalogText(
      read.value,
      `${repo.slug}@${repo.defaultBranch}:${configured}`,
    );
    const routing = parseAgentRouting(values);
    const flags = new Set([...catalog.values()].flatMap((area) => area.flags));
    return items.map((item) => ({
      ...item,
      batchAllowed: !(item.queueIssue?.labels ?? []).some((label) => {
        if (flags.has(label)) return true;
        const area = routing.codeareaAreas[label.toLowerCase()];
        return area !== undefined && (catalog.get(area)?.flags.length ?? 0) > 0;
      }),
    }));
  } catch {
    return refused();
  }
}
