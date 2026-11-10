/**
 * The repository scope the tick reads from the default branch's values under
 * the permitted configuration layers: the user file below, the environment
 * above, and never the pull request's checkout. Each case runs `scopeOf` in a
 * subprocess so the home directory, the working directory and the environment
 * are the child's own.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";

const MODULE = join(import.meta.dir, "../lib/sources/served-repo.ts");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const TAXONOMY = "review:\n  taxonomy:\n    repos: [repo:a, repo:b]\n";
const DEFAULT_BRANCH = { review: { repo_label: "repo:a" } };

interface Run {
  user?: string;
  checkout?: string;
  env?: Record<string, string>;
  values?: Record<string, unknown>;
}

async function scope(run: Run): Promise<unknown> {
  const root = mkdtempSync(join(tmpdir(), "scope-layers-"));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "checkout");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(cwd, ".config"), { recursive: true });
  if (run.user !== undefined) writeFileSync(join(home, "jig.yaml"), run.user);
  if (run.checkout !== undefined)
    writeFileSync(join(cwd, ".config", "jig.yaml"), run.checkout);
  const script = `import { scopeOf } from ${JSON.stringify(MODULE)};
console.log(JSON.stringify(scopeOf(JSON.parse(process.argv[1])) ?? null));`;
  const child = Bun.spawn(
    ["bun", "-e", script, JSON.stringify(run.values ?? DEFAULT_BRANCH)],
    {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        JIG_HOME: home,
        ...run.env,
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
  expectSpawnExit({ exitCode, stdout, stderr }, 0, "scopeOf");
  return JSON.parse(stdout);
}

describe("scopeOf", () => {
  it("reads a taxonomy that lives in the user file", async () => {
    expect(await scope({ user: TAXONOMY })).toEqual({
      own: "repo:a",
      others: ["repo:b"],
    });
  });

  it("declares no scope where no layer names a taxonomy", async () => {
    expect(await scope({})).toBeNull();
  });

  it("lets the environment override the user file's taxonomy", async () => {
    const env = { JIG__REVIEW__TAXONOMY__REPOS: '["repo:a","repo:c"]' };
    expect(await scope({ user: TAXONOMY, env })).toEqual({
      own: "repo:a",
      others: ["repo:c"],
    });
  });

  it("refuses served pickups when the user layer cannot be read", async () => {
    const found = (await scope({ user: "review: [unclosed" })) as {
      invalid?: string;
    };
    expect(found.invalid).toContain("a configuration layer could not be read");
  });

  it("refuses a user file that sets a repository-only field", async () => {
    const found = (await scope({
      user: "review:\n  repo_label: repo:b\n",
    })) as { invalid?: string };
    expect(found.invalid).toContain("a configuration layer could not be read");
  });

  it("never reads the pull request's checkout", async () => {
    const checkout =
      "review:\n  repo_label: repo:z\n  taxonomy:\n    repos: [repo:z, repo:y]\n";
    expect(await scope({ user: TAXONOMY, checkout })).toEqual({
      own: "repo:a",
      others: ["repo:b"],
    });
  });
});
