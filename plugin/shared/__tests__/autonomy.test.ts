/**
 * The autonomy resolver: the effective level for each combination of the
 * repository's level and ceiling, a person's own layer, the environment and
 * whether a driver pass or a person's session asks. Each case builds its
 * layers in a scratch directory and passes the environment explicitly, so no
 * test changes this process's environment.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AutonomyConfigError,
  DEFAULT_PARK_CLASSES,
  describeAutonomy,
  parkClasses,
  resolveAutonomy,
} from "../autonomy.ts";
import { loadLayeredConfig } from "../config-layers.ts";
import { expectSpawnExited } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../lib/test-helpers/script-argv.ts";

const scratch = mkdtempSync(join(tmpdir(), "autonomy-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;

interface Case {
  repository?: string;
  user?: string;
  env?: Record<string, string>;
  /** A driver pass when true; a person's session otherwise. */
  driver?: boolean;
}

function setup(c: Case): { root: string; env: Record<string, string> } {
  const root = join(scratch, `case-${n++}`);
  const home = join(root, "home");
  mkdirSync(join(root, "repo", ".config"), { recursive: true });
  mkdirSync(join(root, "repo", ".git"));
  mkdirSync(home);
  if (c.repository !== undefined)
    writeFileSync(join(root, "repo", ".config", "jig.yaml"), c.repository);
  if (c.user !== undefined) writeFileSync(join(home, "jig.yaml"), c.user);
  const env: Record<string, string> = {
    JIG_HOME: home,
    ...(c.driver ? { DRIVE_PR_TARGET: "12" } : {}),
    ...(c.env ?? {}),
  };
  return { root: join(root, "repo"), env };
}

function resolve(c: Case) {
  const { root, env } = setup(c);
  return resolveAutonomy(loadLayeredConfig(root, env), env);
}

describe("the effective level and its source", () => {
  test("a repository that sets nothing runs attended, by default", () => {
    const a = resolve({ driver: true });
    expect(a.level).toBe("attended");
    expect(a.source).toBe("the default");
    expect(a.capped).toBe(false);
  });

  test("a driver pass reads the repository's level", () => {
    const a = resolve({
      driver: true,
      repository: "autonomy:\n  level: unattended\n",
    });
    expect(a.level).toBe("unattended");
    expect(a.source).toEndWith(join(".config", "jig.yaml"));
    expect(a.ceiling).toBe("unattended");
    expect(a.ceilingSource).toContain("sets no max_level");
  });

  test("a person's session reads attended though the repository says unattended", () => {
    const a = resolve({ repository: "autonomy:\n  level: unattended\n" });
    expect(a.interactive).toBe(true);
    expect(a.level).toBe("attended");
    expect(a.source).toContain("interactive session");
  });

  test("a person's session takes the level its person set in the user layer", () => {
    const a = resolve({
      repository: "autonomy:\n  max_level: unattended\n",
      user: "autonomy:\n  level: unattended\n",
    });
    expect(a.level).toBe("unattended");
    expect(a.source).toEndWith("jig.yaml");
    expect(a.source).toContain("home");
  });

  test("the user layer raises a driver pass up to the ceiling", () => {
    const a = resolve({
      driver: true,
      repository: "autonomy:\n  level: attended\n  max_level: unattended\n",
      user: "autonomy:\n  level: unattended\n",
    });
    expect(a.level).toBe("unattended");
    expect(a.capped).toBe(false);
  });

  test("the environment layer wins over the user layer", () => {
    const a = resolve({
      driver: true,
      repository: "autonomy:\n  max_level: unattended\n",
      user: "autonomy:\n  level: attended\n",
      env: { JIG__AUTONOMY__LEVEL: "unattended" },
    });
    expect(a.level).toBe("unattended");
    expect(a.source).toBe("$JIG__AUTONOMY__LEVEL");
  });

  test("a level above the ceiling is capped, and the line says by what", () => {
    const a = resolve({
      driver: true,
      user: "autonomy:\n  level: unattended\n",
    });
    expect(a.chosen).toBe("unattended");
    expect(a.level).toBe("attended");
    expect(a.capped).toBe(true);
    expect(describeAutonomy(a)).toContain("capped at attended");
  });

  test("an environment level above the repository's ceiling is capped too", () => {
    const a = resolve({
      driver: true,
      repository: "autonomy:\n  max_level: attended\n",
      env: { JIG__AUTONOMY__LEVEL: "wide" },
    });
    expect(a.level).toBe("attended");
    expect(a.capped).toBe(true);
    expect(a.ceilingSource).toContain("autonomy.max_level");
  });

  test("wide is accepted and acts as unattended until it is built", () => {
    const a = resolve({
      driver: true,
      repository: "autonomy:\n  level: wide\n",
    });
    expect(a.chosen).toBe("wide");
    expect(a.level).toBe("unattended");
    expect(a.wideActsAsUnattended).toBe(true);
    expect(describeAutonomy(a)).toContain("acts as unattended");
  });
});

describe("what the resolver refuses", () => {
  test("a level outside the closed list", () => {
    expect(() =>
      resolve({ driver: true, repository: "autonomy:\n  level: eager\n" }),
    ).toThrow(AutonomyConfigError);
  });

  test("a repository level above its own ceiling", () => {
    expect(() =>
      resolve({
        driver: true,
        repository: "autonomy:\n  level: unattended\n  max_level: attended\n",
      }),
    ).toThrow(/above autonomy.max_level/);
  });

  test("a ceiling from the environment", () => {
    expect(() =>
      resolve({
        driver: true,
        env: { JIG__AUTONOMY__MAX_LEVEL: "wide" },
      }),
    ).toThrow(/repository's ceiling/);
  });

  test("a ceiling from the user layer", () => {
    expect(() =>
      resolve({ driver: true, user: "autonomy:\n  max_level: wide\n" }),
    ).toThrow(/describes one repository/);
  });
});

describe("the park classes", () => {
  test("default to the registry rows plus escalated and human-decision", () => {
    expect(parkClasses({})).toEqual([...DEFAULT_PARK_CLASSES]);
    expect(parkClasses({})).toContain("human-decision");
  });

  test("a repository's own list keeps the arbiter's classes", () => {
    expect(
      parkClasses({ autonomy: { park_classes: ["merge", "data-retention"] } }),
    ).toEqual(["merge", "data-retention", "escalated", "human-decision"]);
  });

  test("a malformed list is refused", () => {
    expect(() =>
      parkClasses({ autonomy: { park_classes: ["Merge it"] } }),
    ).toThrow(AutonomyConfigError);
  });
});

describe("the command line", () => {
  const script = join(import.meta.dir, "..", "autonomy.ts");

  async function cli(c: Case, args: string[]) {
    const { root, env } = setup(c);
    const proc = Bun.spawn(scriptArgv(script, ...args), {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        SYSTEMROOT: process.env.SYSTEMROOT ?? "",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return proc;
  }

  test("prints the level and its source", async () => {
    const proc = await cli(
      { driver: true, repository: "autonomy:\n  level: unattended\n" },
      [],
    );
    const stdout = await new Response(proc.stdout).text();
    await expectSpawnExited(proc, 0);
    expect(stdout).toStartWith("autonomy: unattended (unattended from ");
  });

  test("an invalid level exits 1 naming the field", async () => {
    const proc = await cli(
      { driver: true, repository: "autonomy:\n  level: eager\n" },
      [],
    );
    const stderr = await new Response(proc.stderr).text();
    await expectSpawnExited(proc, 1);
    expect(stderr).toContain("autonomy.level must be one of");
  });
});
