import { expect, test } from "bun:test";
import { ghRepoEnvFor } from "../gh-repo-env.ts";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";

test("ghRepoEnv drops an inherited GH_REPO", async () => {
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { ghRepoEnv } from ${JSON.stringify(new URL("../gh-repo-env.ts", import.meta.url).href)};
       process.exit(ghRepoEnv().GH_REPO === undefined ? 0 : 1);`,
    ],
    {
      env: { ...process.env, GH_REPO: "someone/else" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  expectSpawnExit({ exitCode, stdout, stderr }, 0);
  expect(exitCode).toBe(0);
});

test("ghRepoEnvFor names the repository, or none", () => {
  expect(ghRepoEnvFor("owner/name").GH_REPO).toBe("owner/name");
  expect(ghRepoEnvFor(null).GH_REPO).toBeUndefined();
});
