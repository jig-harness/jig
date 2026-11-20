/**
 * dispatch: a forge read whose arguments do not name the repository it is
 * about names it in `GH_REPO`, so a `gh` that picks its account by the
 * repository's owner reads a private repository of a second owner. The read
 * runs in a subprocess, from a directory that is no checkout, whose `gh`
 * answers `NOT_FOUND` unless `GH_REPO` names the repository.
 */
import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { runWithFakeGh } from "../../../lib/test-helpers/run-with-fake-gh.ts";

const FORGE = join(import.meta.dir, "..", "lib", "forge.ts");

it("counts a pull request's unresolved threads through an owner-routing gh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-forge-routing-"));
  try {
    const result = await runWithFakeGh({
      dir,
      unset: ["GH_REPO"],
      gh: `#!/usr/bin/env bun
if (process.env.GH_REPO !== "other-owner/private") {
  console.log(JSON.stringify({ data: { repository: null }, errors: [{ type: "NOT_FOUND", path: ["repository"] }] }));
  console.error("gh: Could not resolve to a Repository with the name 'other-owner/private'.");
  process.exit(1);
}
console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
  pageInfo: { hasNextPage: false },
  nodes: [{ isResolved: false }, { isResolved: true }],
} } } } }));
`,
      code: `const m = await import(${JSON.stringify(FORGE)});
console.log(JSON.stringify(await m.unresolvedThreadCount("other-owner/private", 7)));`,
    });
    expectSpawnExit(result, 0);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "")).toEqual({
      ok: true,
      value: 1,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
