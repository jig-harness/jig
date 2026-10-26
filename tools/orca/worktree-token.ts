/**
 * The token that names a worktree: a file in its git directory, written by
 * the first open that starts an agent there and read by every later one. A
 * worktree created later at the same path, which Orca gives the same
 * path-derived id, has a git directory of its own, with no token or another,
 * so a kickoff receipt (receipts.ts), which carries the token of the
 * worktree its agent was started in, is read as that worktree's own and no
 * other's, whatever stood at the path before and whenever it went. The token
 * is minted and published on the host, where the file is, for exactly one
 * open (written under a name of its own, then linked into place, which fails
 * when the file exists), and then read from the file, so two opens that both
 * found none end with the one token.
 */
import { output } from "../herdr/runner.ts";
import { inspectPath } from "./hooks.ts";
import { OrcaError, type Workspace } from "./runner.ts";

/** The file in a worktree's git directory that holds its token. */
export const WORKTREE_TOKEN = "jig-orca-worktree";

/**
 * The shell script that publishes a fresh token as the whole content of
 * `$1` for exactly one writer: 16 random bytes as hex, written under a name
 * of its own beside `$1`, then linked into `$1`, which fails when it exists.
 * The name is removed either way; the exit status is the link's.
 */
export const PUBLISH_TOKEN_SCRIPT = [
  "set -C",
  'f="$1"',
  't="$f.tmp.$$"',
  `k="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \\n')"`,
  '[ -n "$k" ]',
  `printf '%s\\n' "$k" > "$t"`,
  '{ ln -- "$t" "$f"; s=$?; rm -f -- "$t"; exit "$s"; }',
].join(" && ");

/** The command that publishes a token at `file` on the host, as `worktreeToken` runs it. */
export function publishCommand(file: string): string[] {
  return ["sh", "-c", PUBLISH_TOKEN_SCRIPT, "sh", file];
}

/**
 * The worktree's token, from its git directory on the host: read where it
 * is, and published first by this open when nothing is there. Whichever
 * open published it, the token is what the file holds, read after the
 * attempt, never what this open meant to write. A git directory with
 * something else at the token's name, or a file that does not hold one
 * token, is refused.
 */
export function worktreeToken(ws: Workspace, gitDir: string): string {
  const file = `${gitDir}/${WORKTREE_TOKEN}`;
  const kind = inspectPath(ws, file);
  if (kind === "directory" || kind === "other")
    throw new OrcaError(
      `${file} is a ${kind === "directory" ? "directory" : "special file"}, not the worktree's token file; move it away and open the workspace again`,
    );
  const published =
    kind === "absent" ? ws.host.run(publishCommand(file)) : null;
  const read = ws.host.run(["cat", file]);
  if (read.status !== 0)
    throw new OrcaError(
      `cannot read the worktree's token ${file}: ${output(read)}${
        published === null || published.status === 0
          ? ""
          : `; writing it: ${output(published)}`
      }`,
    );
  const token = read.stdout.trim();
  if (!/^\S+$/.test(token))
    throw new OrcaError(
      `${file} does not hold a token this tool wrote; move it away and open the workspace again`,
    );
  return token;
}
