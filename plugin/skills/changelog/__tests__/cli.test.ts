/**
 * The commands as an agent or CI runs them: a process with the repository as
 * its working directory and the environment it was given.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import {
  cleanEnv,
  commit,
  git,
  jigYaml,
  KEEP_CHANGELOG,
  repository,
  temporary,
  write,
} from "./scratch.ts";

const scripts = join(import.meta.dir, "..", "scripts");
function run(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
) {
  const result = spawnSync(
    process.execPath,
    [join(scripts, command), ...args],
    {
      cwd,
      env: cleanEnv({ JIG_HOME: temporary("jig-home-"), ...env }),
    },
  );
  return {
    code: result.status,
    out: result.stdout,
    err: result.stderr,
  };
}

const configured = (extra = "") =>
  repository({
    "CHANGELOG.md": KEEP_CHANGELOG,
    "package.json": `{"version": "1.2.0"}\n`,
    "changes/a.md": "---\nrelease: minor\n---\n### Added\n\n- a\n",
    "src/x.ts": "x\n",
    ".config/jig.yaml": jigYaml(
      `  file: CHANGELOG.md\n  release_paths: [src/]${extra}`,
    ),
  });

describe("a repository that did not turn the skill on", () => {
  const root = () =>
    repository({
      "CHANGELOG.md": KEEP_CHANGELOG,
      "package.json": `{"version": "1.2.0"}\n`,
      "changes/a.md": "---\nrelease: minor\n---\n### Added\n\n- a\n",
    });

  test("every command says so, passes, and writes nothing", () => {
    const dir = root();
    for (const [command, args, text] of [
      ["check.ts", ["--base", "main"], "not configured"],
      ["release.ts", [], "not configured"],
      ["status.ts", [], "not configured"],
    ] as const) {
      const result = run(command, [...args], dir);
      expect([command, result.code]).toEqual([command, 0]);
      expect(result.out).toContain(text);
      expect(result.out).toContain("(plugin ");
    }
    expect(existsSync(join(dir, "changes/a.md"))).toBe(true);
  });
});

describe("the commands", () => {
  test("release --json keeps standard output to the report when after_version prints", () => {
    const dir = configured("\n  after_version: echo updating");
    const result = run("release.ts", ["--json"], dir);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).version).toBe("1.3.0");
    expect(result.err).toContain("updating");
  });

  test.skipIf(process.platform === "win32")(
    "an after_version still running past its deadline is stopped, with the notes still in place",
    () => {
      const dir = configured("\n  after_version: sleep 30");
      const started = Date.now();
      const result = run("release.ts", [], dir, {
        JIG_AFTER_VERSION_TIMEOUT_SEC: "1",
      });
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(result.code).toBe(1);
      expect(result.err).toContain("still running after 1s");
      expect(existsSync(join(dir, "changes/a.md"))).toBe(true);
      const bad = run(
        "release.ts",
        [],
        configured("\n  after_version: echo ok"),
        {
          JIG_AFTER_VERSION_TIMEOUT_SEC: "0",
        },
      );
      expect(bad.err).toContain("JIG_AFTER_VERSION_TIMEOUT_SEC must be");
    },
  );

  test("release --dry-run --json reports and writes nothing; every command prints its plugin version", () => {
    const dir = configured();
    const dry = run("release.ts", ["--dry-run", "--json"], dir);
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.out)).toMatchObject({
      configured: true,
      version: "1.3.0",
      previous: "1.2.0",
      notes: ["changes/a.md"],
      waiting: [],
    });
    expect(JSON.parse(dry.out).plugin).toMatch(/^\d+\.\d+\.\d+$/);
    expect(existsSync(join(dir, "changes/a.md"))).toBe(true);
    const real = run("release.ts", [], dir);
    expect(real.out).toContain("jig changelog release (plugin ");
    expect(real.out).toContain(
      "wrote 1 change note(s) into CHANGELOG.md as 1.3.0",
    );
    expect(existsSync(join(dir, "changes/a.md"))).toBe(false);
  });

  test("check holds a branch to the base's section and exits 1 on a finding", () => {
    const dir = configured();
    git(dir, "checkout", "-qb", "work");
    commit(
      dir,
      { "src/x.ts": "changed\n", "changes/a.md": "### Added\n\n- a\n" },
      "work",
    );
    const found = run("check.ts", ["--base", "main"], dir);
    expect(found.code).toBe(1);
    expect(found.err).toContain(
      "src/x.ts changed, which ships only in a release",
    );
    expect(found.out).toContain("jig changelog check (plugin ");
    commit(
      dir,
      { "changes/a.md": "---\nrelease: patch\n---\n### Added\n\n- a\n" },
      "ask",
    );
    const clean = run("check.ts", ["--base", "main"], dir);
    expect([clean.code, clean.out]).toEqual([
      0,
      expect.stringContaining("change notes: OK"),
    ]);
  });

  test("check in CI takes the pull request's base from the event", () => {
    const dir = configured();
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(dir, "checkout", "-qb", "work");
    commit(dir, { "src/x.ts": "changed\n" }, "work");
    const result = run("check.ts", [], dir, { GITHUB_BASE_REF: "main" });
    expect(result.code).toBe(1);
    expect(result.err).toContain("src/x.ts changed");
  });

  test("status prints the version the waiting notes would make", () => {
    const dir = configured();
    const result = run("status.ts", ["--json"], dir);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      next: "1.3.0",
      current: "1.2.0",
    });
  });
});

describe("what stops a command", () => {
  test("an invalid section is exit 2 naming the field and the file", () => {
    const dir = configured("\n  authors: maybe");
    for (const command of ["release.ts", "status.ts"]) {
      const result = run(command, [], dir);
      expect([command, result.code]).toEqual([command, 2]);
      expect(result.err).toContain("changelog.authors must be true or false");
    }
  });

  test("an environment variable cannot turn it on, even in a repository without the field", () => {
    const dir = repository({ "a.txt": "x" });
    const result = run("release.ts", [], dir, {
      JIG__CHANGELOG__FILE: "CHANGELOG.md",
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain("$JIG__CHANGELOG__FILE");
  });

  test("an unknown flag is a usage error", () => {
    const dir = configured();
    for (const command of ["check.ts", "release.ts", "status.ts"])
      expect([command, run(command, ["--unknown"], dir).code]).toEqual([
        command,
        2,
      ]);
  });
});

describe("the exit codes", () => {
  const note = "---\nrelease: minor\n---\n### Added\n\n- a\n";

  test("a failed step is exit 1: disagreeing version files, a failing after_version, a missing origin", () => {
    const disagree = repository({
      "CHANGELOG.md": KEEP_CHANGELOG,
      "a.json": `{"version": "1.2.0"}\n`,
      "b.json": `{"version": "1.1.0"}\n`,
      "changes/a.md": note,
      ".config/jig.yaml": jigYaml(
        "  file: CHANGELOG.md\n  version:\n    files:\n      - { path: a.json, key: version }\n      - { path: b.json, key: version }",
      ),
    });
    for (const command of ["release.ts", "status.ts"]) {
      const result = run(command, [], disagree);
      expect([command, result.code]).toEqual([command, 1]);
      expect(result.err).toContain("the version files disagree");
    }
    const failing = configured("\n  after_version: exit 3");
    const after = run("release.ts", [], failing);
    expect(after.code).toBe(1);
    expect(after.err).toContain("changelog.after_version `exit 3` failed");
    const common = repository({
      "CHANGELOG.md": "# Changelog\n\nhttps://common-changelog.org\n",
      "package.json": `{"version": "1.2.0"}\n`,
      "changes/a.md": note,
      ".config/jig.yaml": jigYaml("  file: CHANGELOG.md"),
    });
    const origin = run("release.ts", [], common);
    expect(origin.code).toBe(1);
    expect(origin.err).toContain("origin remote");
  });

  test("an unreadable file or an invalid configuration is exit 2", () => {
    const dir = repository({
      "changes/a.md": note,
      ".config/jig.yaml": jigYaml("  file: MISSING.md"),
    });
    expect(run("release.ts", [], dir).code).toBe(2);
  });
});

describe("where the configuration and the base come from", () => {
  test("JIG_OVERLAY neither turns the skill on nor swaps its section", () => {
    const other = temporary("overlay-");
    write(other, "o.yaml", jigYaml("  file: CHANGELOG.md"));
    const off = repository({ "a.txt": "x\n" });
    const result = run("status.ts", [], off, {
      JIG_OVERLAY: `${other}/o.yaml`,
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain("not configured");
    const dir = configured();
    write(other, "o.yaml", jigYaml("  file: OTHER.md"));
    const own = run("status.ts", ["--json"], dir, {
      JIG_OVERLAY: `${other}/o.yaml`,
    });
    expect(own.code).toBe(0);
    expect(JSON.parse(own.out)).toMatchObject({ next: "1.3.0" });
  });

  test("a push to the integration branch in CI is checked against the event's default branch", () => {
    const dir = configured();
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    const event = temporary();
    write(
      event,
      "push.json",
      JSON.stringify({ repository: { default_branch: "main" } }),
    );
    const result = run("check.ts", [], dir, {
      GITHUB_EVENT_PATH: `${event}/push.json`,
      GITHUB_ACTIONS: "true",
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain("branch checks skipped (HEAD is origin/main)");
  });
});
