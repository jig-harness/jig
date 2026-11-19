import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { cli } from "../lib/cli.ts";
import { couldNotCheck } from "../lib/findings.ts";

const git = (...args: string[]) => spawnSync("git", args, { encoding: "utf8" });

function gitError(result: ReturnType<typeof git>): string {
  return result.error?.message ?? result.stderr.trim();
}

function mergeBase(): { ref: string; commit: string } | string {
  const shallow = git("rev-parse", "--is-shallow-repository");
  if (shallow.status !== 0)
    return `cannot read checkout history: ${gitError(shallow)}`;
  if (shallow.stdout.trim() === "true")
    return "the checkout is shallow. Fetch the full history (git fetch --unshallow) and rerun.";

  const defaultRef = git("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD");
  if (defaultRef.status !== 0 && defaultRef.status !== 1)
    return `cannot read origin/HEAD: ${gitError(defaultRef)}`;
  // CI can fetch the remote branches without setting origin/HEAD.
  const ref = defaultRef.stdout.trim() || "refs/remotes/origin/main";
  const base = git("merge-base", "HEAD", ref);
  if (base.status !== 0)
    return `cannot find a merge base with ${ref}. Fetch the default branch and check that it shares history with HEAD.`;
  return { ref, commit: base.stdout.trim() };
}

async function audit(): Promise<number> {
  if (process.argv.length > 2)
    return couldNotCheck("audit", "the gate takes no arguments");
  try {
    const base = mergeBase();
    if (typeof base === "string") return couldNotCheck("audit", base);
    const { ref, commit } = base;
    const cache = resolve("node_modules/.cache/fallow");
    mkdirSync(cache, { recursive: true });
    console.log(`audit: base ${commit} (merge base with ${ref})`);
    return await Bun.spawn(
      ["fallow", "audit", "-q", "--changed-since", commit],
      {
        env: { ...process.env, TMPDIR: cache },
        stdout: "inherit",
        stderr: "inherit",
      },
    ).exited;
  } catch (error: unknown) {
    return couldNotCheck(
      "audit",
      error instanceof Error ? error.message : String(error),
    );
  }
}

if (import.meta.main) cli(audit);
