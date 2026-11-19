/**
 * The GitHub store's client names the store's repository in `GH_REPO` on a
 * write that sends only node ids, so a `gh` that picks its account by the
 * repository's owner writes to a private store of a second owner. The write
 * runs in a subprocess whose `gh` answers `NOT_FOUND` unless `GH_REPO`
 * names the store.
 */
import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";

const API = join(import.meta.dir, "..", "scripts", "lib", "github", "api.ts");

it("writes to the store's repository through an owner-routing gh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-store-routing-"));
  try {
    writeFakeProgram(
      join(dir, "gh"),
      `#!/usr/bin/env bun
await Bun.stdin.text();
if (process.env.GH_REPO !== "other-owner/store") {
  console.log(JSON.stringify({ data: null, errors: [{ type: "NOT_FOUND", path: ["addComment"] }] }));
  process.exit(1);
}
console.log(JSON.stringify({ data: { addComment: { routed: process.env.GH_REPO } } }));
`,
    );
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
    };
    for (const name of ["GH_REPO", "JIG_GITHUB_GRAPHQL_URL"]) delete env[name];
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { GitHubClient } from ${JSON.stringify(API)};
const client = GitHubClient.fromEnv(process.env, "other-owner/store");
console.log(JSON.stringify(await client.write(
  "mutation StoreComment($input: AddCommentInput!) { addComment(input: $input) { routed } }",
  { input: { subjectId: "I_1", body: "event" } },
)));`,
      ],
      { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expectSpawnExit({ exitCode: await child.exited, stdout, stderr }, 0);
    expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "")).toEqual({
      addComment: { routed: "other-owner/store" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
