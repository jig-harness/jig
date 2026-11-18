/** Run the drive-exits chapter's compiler-backed check in its own bounded process. */
import { join } from "node:path";
import type { Finding } from "../../lib/findings.ts";

export function checkDriveExitChapter(
  root: string,
  env: Record<string, string | undefined> = process.env,
): readonly Finding[] {
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(root, "plugin/skills/drive-pr/__tests__/protocol-check.ts"),
    ],
    {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    },
  );
  if (result.exitCode === 0) return [];
  return [
    {
      rule: "protocol-held",
      file: "plugin/protocol/drive-exits.md",
      problem: `drive exit restatement or code binding disagrees with the chapter (exit ${result.exitCode}): ${result.stderr.toString().trim()}`,
      remedy:
        "correct the named restatement or code binding, then run bun tools/protocol/generate.ts --check",
    },
  ];
}
