/** Repository labels for a listing of one clone's state, without network calls. */
import { git, gitCallTimeoutSeconds, gitIdentityEnv } from "./proc.ts";
import { repoOfUrl } from "./repo-url.ts";
import { resolveLegacyStateDir } from "./state/store.ts";

export async function driveRepository(): Promise<string> {
  const result = await git(["remote", "get-url", "origin"], {
    cwd: process.env.DRIVE_PR_WORKTREE || process.cwd(),
    timeoutSec: gitCallTimeoutSeconds(),
    env: gitIdentityEnv(),
  });
  // Local-only clones still have an unambiguous repository label. Never print
  // a raw remote URL: it may carry credentials.
  return (
    (result.code === 0 ? repoOfUrl(result.stdout.trim()) : "") ||
    (await resolveLegacyStateDir())
  );
}
