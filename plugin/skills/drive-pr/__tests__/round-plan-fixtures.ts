import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { binDir, tmpRoot, gitCleanEnv } from "./drive-pr-harness.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";

/** The real `git`, for a stub that wraps it from a shell script. */
export function realGitForShell(): string {
  const real = Bun.which("git");
  if (!real) throw new Error("no git on PATH to wrap for this probe");
  return real.replaceAll("\\", "/");
}

/**
 * A `gh` that answers pull request #999's base (`develop`) and the repository
 * (`acme/widgets`) a scratch clone's `origin` must fetch, and hands every
 * other call to the harness's own `gh`. A round's base is the pull request's,
 * so a scratch clone without either refuses to plan.
 */
export function prBaseGh(): string {
  const dir = mkdtempSync(join(tmpRoot, "pr-base-gh-"));
  writeFakeProgram(
    join(dir, "gh"),
    `#!/bin/sh
case "$*" in
  "pr view 999 --json baseRefName -q .baseRefName") echo develop ;;
  "pr view 999 --json baseRefName,url") echo '{"baseRefName":"develop","url":"https://github.com/acme/widgets/pull/999"}' ;;
  "repo view --json owner,name") echo '{"owner":{"login":"acme"},"name":"widgets"}' ;;
  *) exec "${binDir}/gh" "$@" ;;
esac
`,
  );
  return dir;
}

/** Point a scratch clone's `origin` at the repository `prBaseGh` answers. */
export function addOrigin(repo: string): void {
  Bun.spawnSync(
    ["git", "remote", "add", "origin", "https://github.com/acme/widgets.git"],
    { cwd: repo, env: gitCleanEnv(), stdout: "ignore", stderr: "ignore" },
  );
}
