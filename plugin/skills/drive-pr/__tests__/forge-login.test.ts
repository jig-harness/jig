import { expect, test } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { fakeForge, SCRIPTS } from "./ledger-forge-fixtures.ts";

for (const budget of ["on", "off"]) {
  test(`a drive process reuses its login with the forge budget ${budget}`, async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
          import { setDefaultLedgerPath } from ${JSON.stringify(join(SCRIPTS, "../../../shared/outbound/ledger.ts"))};
          import { reuseForgeIdentity } from ${JSON.stringify(join(SCRIPTS, "../../../shared/outbound/github-budget.ts"))};
          import { ghCall } from ${JSON.stringify(join(SCRIPTS, "lib/proc.ts"))};
          import { resolveLogin } from ${JSON.stringify(join(SCRIPTS, "lib/state/ledger-forge.ts"))};
          setDefaultLedgerPath(${JSON.stringify(join(forge.dir, "budget.sqlite"))});
          reuseForgeIdentity();
          const repo = await ghCall(["repo", "view", "--json", "nameWithOwner"]);
          if (repo.code !== 0) throw new Error(repo.stderr);
          if (process.env.JIG_FORGE_BUDGET === "off") {
            const path = process.env.PATH;
            process.env.PATH = ${JSON.stringify(forge.dir)};
            const missing = await resolveLogin();
            process.env.PATH = path;
            if (missing !== null) throw new Error("a missing gh resolved a login");
          }
          const logins = await Promise.all([resolveLogin(), resolveLogin()]);
          const afterOwnerRefresh = Temporal.Now.instant().add({ hours: 24 * 8 });
          Temporal.Now.instant = () => afterOwnerRefresh;
          logins.push(await resolveLogin());
          console.log(JSON.stringify(logins));
        `,
      ],
      {
        cwd: forge.repo,
        env: {
          ...forge.env,
          GH_TOKEN: "drive-fixture-token",
          JIG_FORGE_BUDGET: budget,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, 0);
    expect(JSON.parse(stdout)).toEqual(["drive-bot", "drive-bot", "drive-bot"]);
    expect(
      forge.calls().filter((call) => call.startsWith("api user")),
    ).toHaveLength(1);
  });
}
