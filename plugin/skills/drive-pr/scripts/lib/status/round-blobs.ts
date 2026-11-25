/**
 * The git blob id of each anchored file at the head a round was evaluated
 * on, for the structural-churn brake: what tells a file rewritten between
 * rounds from one left alone, and a return to an earlier content.
 *
 * Best-effort by design. One `git cat-file --batch-check` reads every path
 * from stdin (no argument list to outgrow), bounded by the helper deadline;
 * a head this clone does not have, a path absent at it, or any failure
 * leaves that path out, which the brake reads as "rewritten" (it never
 * reads as "unchanged", so a missing blob cannot hide churn, and it can
 * never fabricate a return to an earlier content). A failed read is said on
 * stderr, with git's exit and its last error line, so a brake that judges
 * without blobs never does so silently.
 */
import { isObjectId } from "../state/churn-facts.ts";
import { git } from "../proc.ts";

export async function readRoundBlobs(
  head: string,
  paths: readonly string[],
  timeoutSec: number,
  cwd?: string,
): Promise<Record<string, string>> {
  // One line per path in and out: a path holding a line break would shift
  // every answer after it, and the stored round never records one anyway.
  const asked = paths.filter((p) => !/[\n\r]/.test(p));
  if (head === "" || asked.length === 0) return {};
  const r = await git(
    ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    {
      stdin: asked.map((p) => `${head}:${p}\n`).join(""),
      stdout: "pipe",
      stderr: "pipe",
      timeoutSec,
      ...(cwd === undefined ? {} : { cwd }),
    },
  );
  if (r.code !== 0) {
    const why = r.stderr.trim().split("\n").at(-1) ?? "";
    process.stderr.write(
      `drive-status: git cat-file exited ${r.code} reading this round's file contents at ${head}${why === "" ? "" : ` (${why})`}; the structural-churn brake reads every file as rewritten this round\n`,
    );
    return {};
  }
  const lines = r.stdout.split("\n");
  const blobs: Record<string, string> = {};
  asked.forEach((path, i) => {
    const [id, type] = (lines[i] ?? "").split(" ");
    if (type === "blob" && isObjectId(id)) blobs[path] = id;
  });
  return blobs;
}
