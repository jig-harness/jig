/**
 * The git blob id of each anchored file at the head a round was evaluated
 * on, for the structural-churn brake: what tells a file rewritten between
 * rounds from one left alone, and a return to an earlier content.
 *
 * Best-effort by design. One `git cat-file --batch-check` reads every path
 * from stdin (no argument list to outgrow), bounded by the helper deadline;
 * a head this clone does not have, a path absent at it, or any failure
 * leaves that path out, which the brake reads as no evidence either way: a
 * missing blob never shows a rewrite and never a return to an earlier
 * content, so unmeasured rounds cannot park a drive. A failed read is said on
 * stderr, with git's exit and its last error line, so a brake that judges
 * without blobs never does so silently.
 */
import { isObjectId } from "../state/churn-facts.ts";
import { gitIdentityEnv } from "../../../../../shared/git-env.ts";
import { git } from "../proc.ts";

/**
 * The blobs read, and whether the read failed as a whole: a failed batch is
 * not the same answer as paths that are absent at the head.
 */
export interface RoundBlobs {
  blobs: Record<string, string>;
  failed: boolean;
}

export async function readRoundBlobs(
  head: string,
  paths: readonly string[],
  timeoutSec: number,
  cwd?: string,
): Promise<RoundBlobs> {
  // One line per path in and out: a path holding a line break would shift
  // every answer after it, and the stored round never records one anyway.
  const asked = paths.filter((p) => !/[\n\r]/.test(p));
  if (head === "" || asked.length === 0) return { blobs: {}, failed: false };
  const r = await git(
    [
      "--no-replace-objects",
      "cat-file",
      "--batch-check=%(objectname) %(objecttype)",
    ],
    {
      // The commit itself first: a commit this clone lacks makes every path
      // read `missing`, which is not a measurement of any path.
      stdin: [`${head}^{commit}\n`, ...asked.map((p) => `${head}:${p}\n`)].join(
        "",
      ),
      stdout: "pipe",
      stderr: "pipe",
      timeoutSec,
      // The repository at `cwd`, whatever GIT_DIR a hook exported.
      env: gitIdentityEnv(),
      ...(cwd === undefined ? {} : { cwd }),
    },
  );
  if (r.code !== 0) {
    const why = r.stderr.trim().split("\n").at(-1) ?? "";
    process.stderr.write(
      `drive-status: git cat-file exited ${r.code} reading this round's file contents at ${head}${why === "" ? "" : ` (${why})`}; the structural-churn brake has no file contents to judge this round\n`,
    );
    return { blobs: {}, failed: true };
  }
  // One answer per question, the commit's first, each either `<id> <type>` or
  // `<spec> missing`; anything else is a truncated or malformed response.
  const lines = r.stdout.endsWith("\n")
    ? r.stdout.slice(0, -1).split("\n")
    : r.stdout.split("\n");
  const answer = /^([0-9a-f]+) (\w+)$/;
  const unusable = (why: string): RoundBlobs => {
    process.stderr.write(
      `drive-status: git cat-file's answer for ${head} is ${why}; the structural-churn brake has no file contents to judge this round\n`,
    );
    return { blobs: {}, failed: true };
  };
  if (lines.length !== asked.length + 1)
    return unusable(
      `malformed (${lines.length} lines for ${asked.length + 1} questions)`,
    );
  const commit = answer.exec(lines[0] ?? "");
  if (commit?.[2] !== "commit" || !isObjectId(commit[1]))
    return unusable("missing the reviewed commit");
  // Entries, not assignments: a path named `__proto__` is an own key here.
  const entries: [string, string][] = [];
  for (const [i, path] of asked.entries()) {
    const line = lines[i + 1] ?? "";
    const m = answer.exec(line);
    if (m === null) {
      // Only the answer to this very question counts as its absence.
      if (line !== `${head}:${path} missing`) return unusable("malformed");
      continue;
    }
    if (!isObjectId(m[1]))
      return unusable("malformed (an object id of no supported width)");
    if (m[2] === "blob") entries.push([path, m[1]]);
  }
  return { blobs: Object.fromEntries(entries), failed: false };
}
