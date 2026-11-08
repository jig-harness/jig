/**
 * A base-branch policy for a test that runs a driver pass.
 *
 * A driver pass reads `autonomy.max_level` and `autonomy.park_classes` from
 * the `.config/jig.yaml` at the base-branch commit `$DRIVE_PR_POLICY_BASE`
 * names, never from the working tree or `JIG_OVERLAY`
 * (`plugin/shared/autonomy.ts`). `commitPolicyBase` writes that commit into
 * the clone at `repo` without touching its working tree, index or branches,
 * and returns the variable to add to the pass's environment.
 */
import { expectSpawnExit } from "./expect-spawn-exit.ts";

/** This process's environment, without what routes git at another repository. */
function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.toUpperCase().startsWith("GIT_")) env[k] = v;
  return {
    ...env,
    GIT_AUTHOR_NAME: "policy base",
    GIT_AUTHOR_EMAIL: "policy-base@example.invalid",
    GIT_COMMITTER_NAME: "policy base",
    GIT_COMMITTER_EMAIL: "policy-base@example.invalid",
  };
}

function git(repo: string, args: string[], stdin?: string): string {
  const r = Bun.spawnSync(["git", "-C", repo, ...args], {
    env: gitEnv(),
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(r, 0, `git ${args.join(" ")}`);
  return r.stdout.toString().trim();
}

/**
 * A commit in the clone at `repo` (initialised first) whose
 * tree holds `.config/jig.yaml` with `text`, or nothing when `text` is
 * `null`; returned as the environment a driver pass reads it through.
 */
export function commitPolicyBase(
  repo: string,
  text: string | null,
): { DRIVE_PR_POLICY_BASE: string } {
  // Safe on a clone already initialised: git leaves its refs and objects be.
  git(repo, ["init", "-q"]);
  let tree = git(repo, ["mktree"], "");
  if (text !== null) {
    const blob = git(repo, ["hash-object", "-w", "--stdin"], text);
    const config = git(repo, ["mktree"], `100644 blob ${blob}\tjig.yaml\n`);
    tree = git(repo, ["mktree"], `040000 tree ${config}\t.config\n`);
  }
  return {
    DRIVE_PR_POLICY_BASE: git(repo, ["commit-tree", tree, "-m", "base"]),
  };
}
