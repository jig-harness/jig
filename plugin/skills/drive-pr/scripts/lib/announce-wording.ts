/** Keep a standing announcement's approval warning aligned with its live lane. */
import { attempt } from "../../../../shared/outcome.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { list } from "../../../../shared/records/forge-claims.ts";
import { MERGE_READY, OPENER, headMarker } from "./announce.ts";
import type { Lane } from "./merge-ready.ts";
import { ghCall, ghRepoEnv } from "./proc.ts";

export const APPROVAL_WARNING =
  "An approval is still required before it can merge; the repository's other\nprotection rules were not read.\n\n";

/** Read one comment body, reporting transport and format failures where they occur. */
async function commentBody(id: number): Promise<string | null> {
  const got = await ghCall(
    ["api", `repos/{owner}/{repo}/issues/comments/${id}`],
    { env: ghRepoEnv(), stderr: "pipe" },
  );
  if (got.code !== 0) {
    console.error(
      `announce-merge-ready: cannot read announcement ${id}: ${got.stderr.trim()}`,
    );
    return null;
  }
  const parsed = attempt(
    "unreadable",
    "the announcement body did not read",
    () => JSON.parse(got.stdout) as unknown,
  );
  if (
    !parsed.ok ||
    !isRecord(parsed.value) ||
    typeof parsed.value.body !== "string"
  ) {
    console.error(
      `announce-merge-ready: announcement ${id} has an unreadable body${parsed.ok ? "" : `: ${parsed.failure.reason}`}`,
    );
    return null;
  }
  return parsed.value.body;
}

/** The warning for this lane, idempotent over an already reconciled body. */
function wordingFor(original: string, lane: Lane | null): string {
  if (lane === "approve-first" && original.includes(APPROVAL_WARNING))
    return original;
  const bare = original.replace(APPROVAL_WARNING, "");
  return lane === "approve-first"
    ? bare.replace(OPENER, `${OPENER}\n\n${APPROVAL_WARNING}`)
    : bare;
}

/** Re-read trusted survivors, preserving their claim markers while reconciling their wording. */
export async function reconcileWording(
  pr: string,
  ids: readonly number[],
  head: string,
  lane: Lane | null,
  dryRun: boolean,
): Promise<number> {
  if (dryRun) return 0;
  const read = await list(
    { repo: "{owner}/{repo}", number: Number(pr) },
    MERGE_READY,
  );
  if (!read.ok) {
    console.error(
      `announce-merge-ready: wording reconciliation: ${read.failure.reason}`,
    );
    return 1;
  }
  for (const id of ids) {
    const found = read.value.find(
      (c) =>
        c.id === id &&
        c.trusted &&
        c.record.ok &&
        c.record.value.key === `merge-ready:${head}`,
    );
    if (found === undefined) {
      console.error(
        `announce-merge-ready: trusted announcement ${id} no longer stands`,
      );
      return 1;
    }
    const original = await commentBody(id);
    if (original === null) return 1;
    if (
      !original.startsWith(OPENER) ||
      !original.trimEnd().endsWith(headMarker(head))
    ) {
      console.error(
        `announce-merge-ready: announcement ${id} changed its claim while reconciling`,
      );
      return 1;
    }
    const body = wordingFor(original, lane);
    if (body === original) continue;
    const patch = await ghCall(
      [
        "api",
        "--method",
        "PATCH",
        `repos/{owner}/{repo}/issues/comments/${id}`,
        "--input",
        "-",
      ],
      {
        env: ghRepoEnv(),
        stdin: JSON.stringify({ body }),
        stderr: "pipe",
      },
    );
    if (patch.code !== 0) {
      console.error(
        `announce-merge-ready: cannot update announcement ${id}: ${patch.stderr.trim()}`,
      );
      return 1;
    }
  }
  return 0;
}
