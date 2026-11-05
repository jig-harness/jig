/** Both retirement stages require visible, ignored and index-hidden local content to be absent. */
import { gitIdentityEnv, run } from "../../shared/proc.ts";
import { probeFailure } from "./text.ts";

export async function retirementCheckoutVeto(
  path: string,
  remaining: () => number,
): Promise<string | null> {
  for (const [args, accepts, why] of [
    [
      [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
        "-z",
      ],
      (text: string) => text === "",
      "git reports changes in it",
    ],
    [
      ["ls-files", "-v", "-z"],
      (text: string) =>
        !text.split("\0").some((entry) => /^[a-zS] /.test(entry)),
      "index flags hide possible changes from git status",
    ],
    [
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
      ],
      (text: string) => text === "",
      "ignored local content has no independent preservation proof",
    ],
    [
      ["branch", "-r", "--contains", "HEAD"],
      (text: string) => text.trim() !== "",
      "its commit is on no remote branch",
    ],
  ] as const) {
    if (remaining() <= 0) return "the retirement deadline passed";
    const done = await run(
      ["git", "-C", path, "-c", "core.fsmonitor=false", ...args],
      {
        env: gitIdentityEnv(),
        timeoutSec: Math.max(0.001, Math.min(30, remaining() / 1000)),
      },
    );
    if (done.code !== 0) return probeFailure(`git ${args.join(" ")}`, done);
    if (!accepts(done.stdout)) return why;
  }
  return null;
}
