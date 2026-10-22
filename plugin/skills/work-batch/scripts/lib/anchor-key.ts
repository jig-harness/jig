/**
 * Which issue, if any, a batch anchor names. An anchor is a change-area name,
 * a repository path, an epic or an issue, and the three read alike in places:
 * a GitHub issue is named by a bare number, which may also be a directory.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ChangeAreaCatalog } from "../../../drive-pr/scripts/lib/change-areas-catalog.ts";
import {
  ANY_TEAM_KEY,
  type IssueKeys,
} from "../../../do-item/scripts/lib/tracker/keys.ts";

/**
 * The issue key `input` names, or `null` when it names an area or a path.
 * A catalog area of that name wins over everything. A team key comes next,
 * as given (the tracker spells it). Then a key of the tracker's shape as a
 * person types it (`keys.normalize`): `#123` or the issue's address always
 * names the issue, but a bare number names it only when no file or directory
 * of that name is in the repository, since a path anchor cannot be spelt any
 * other way and the issue still can (`#123`).
 */
export function anchorIssueKey(
  input: string,
  catalog: ChangeAreaCatalog | null,
  root: string,
  keys: IssueKeys | null,
): string | null {
  if (catalog?.has(input)) return null;
  if (ANY_TEAM_KEY.test(input)) return input;
  const key = keys?.normalize(input) ?? null;
  if (key === null) return null;
  return /^\d+$/.test(input.trim()) && existsSync(resolve(root, input.trim()))
    ? null
    : key;
}
