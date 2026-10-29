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
    expect(a.source).toContain("home");
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

  test("wide is a level of its own where the ceiling allows it", () => {
    const a = resolve({
      driver: true,
      repository: "autonomy:\n  level: wide\n",
    });
    expect(a.chosen).toBe("wide");
    expect(a.level).toBe("wide");
    expect(a.offHours).toBeNull();
    expect(describeAutonomy(a)).toStartWith("autonomy: wide (wide from ");
  });
});

describe("off-hours", () => {
  // Local-time constructors, so each instant is the stated wall-clock time
  // whatever time zone the suite runs in. 2026-10-26 is a Monday.
  const mondayNoon = new Date(2026, 9, 26, 12, 0);
  const mondayNight = new Date(2026, 9, 26, 22, 30);
  const saturdayNoon = new Date(2026, 9, 31, 12, 0);
  const offHours = [
    "autonomy:",
    "  level: unattended",
    "  max_level: wide",
    "  off_hours:",
    "    level: wide",
    "",
  ].join("\n");

  function at(c: Case, now: Date) {
    const { root, env } = setup(c);
    return resolveAutonomy(loadLayeredConfig(root, env), env, now);
  }

  test("inside a window of the default schedule a driver pass runs at the off-hours level", () => {
    for (const now of [mondayNight, saturdayNoon]) {
      const a = at({ driver: true, repository: offHours }, now);
      expect(a.level).toBe("wide");
      expect(a.offHours).not.toBeNull();
      expect(describeAutonomy(a)).toStartWith("autonomy: wide (off_hours) (");
      expect(a.source).toContain(join(".config", "jig.yaml"));
    }
    expect(
      at({ driver: true, repository: offHours }, mondayNight).offHours,
    ).toEqual({ window: "Mon-Fri 20:00-07:00" });
  });

  test("outside every window the base level stands", () => {
    const a = at({ driver: true, repository: offHours }, mondayNoon);
    expect(a.level).toBe("unattended");
    expect(a.offHours).toBeNull();
    expect(describeAutonomy(a)).toStartWith(
      "autonomy: unattended (unattended from ",
    );
    expect(describeAutonomy(a)).not.toContain("off_hours");
  });

  test("the off-hours level is capped by max_level, and the line says so", () => {
    const a = at(
      {
        driver: true,
        repository:
          "autonomy:\n  max_level: unattended\n  off_hours:\n    level: wide\n",
      },
      mondayNight,
    );
    expect(a.chosen).toBe("wide");
    expect(a.level).toBe("unattended");
    expect(a.capped).toBe(true);
    expect(describeAutonomy(a)).toStartWith(
      "autonomy: unattended (off_hours) (wide from ",
    );
    expect(describeAutonomy(a)).toContain("capped at unattended");
  });

  test("a schedule of the repository's own replaces the default", () => {
    const repository = `${offHours.trimEnd()}\n    schedule:\n      - "Mon 12:00-13:00"\n`;
    expect(at({ driver: true, repository }, mondayNoon).level).toBe("wide");
    expect(at({ driver: true, repository }, saturdayNoon).level).toBe(
      "unattended",
    );
  });

  test("a person's session never runs at the off-hours level", () => {
    const a = at({ repository: offHours }, mondayNight);
    expect(a.level).toBe("attended");
    expect(a.offHours).toBeNull();
  });

  test("an unset off-hours level leaves off-hours off", () => {
    const a = at(
      {
        driver: true,
        repository: "autonomy:\n  level: unattended\n  max_level: wide\n",
      },
      saturdayNoon,
    );
    expect(a.level).toBe("unattended");
    expect(a.offHours).toBeNull();
  });

  test("a schedule without a level, and an unreadable window, are refused", () => {
    expect(() =>
      at(
        {
          driver: true,
          repository: 'autonomy:\n  off_hours:\n    schedule: ["Sat-Sun"]\n',
        },
        saturdayNoon,
      ),
    ).toThrow(/off_hours.level is not/);
    expect(() =>
      at(
        {
          driver: true,
          repository: `${offHours.trimEnd()}\n    schedule: ["Someday"]\n`,
        },
        mondayNoon,
      ),
    ).toThrow(AutonomyConfigError);
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
    ).toThrow(/repository's to set/);
  });

  test("a ceiling from the user layer", () => {
    expect(() =>
      resolve({ driver: true, user: "autonomy:\n  max_level: wide\n" }),
    ).toThrow(/describes one repository/);
  });
});

describe("a person's session against the ceiling", () => {
  test("an environment level above the ceiling is capped in an interactive session", () => {
    const a = resolve({
      repository: "autonomy:\n  level: attended\n  max_level: unattended\n",
      env: { JIG__AUTONOMY__LEVEL: "wide" },
    });
    expect(a.interactive).toBe(true);
    expect(a.chosen).toBe("wide");
    expect(a.level).toBe("unattended");
    expect(a.capped).toBe(true);
    expect(a.ceilingSource).toContain("autonomy.max_level");
  });

  test("a user level above a declared max_level is capped in an interactive session", () => {
    const a = resolve({
      repository: "autonomy:\n  max_level: attended\n",
      user: "autonomy:\n  level: unattended\n",
    });
    expect(a.interactive).toBe(true);
    expect(a.level).toBe("attended");
    expect(a.capped).toBe(true);
    expect(describeAutonomy(a)).toContain(
      "capped at attended by autonomy.max_level",
    );
  });
});

describe("the park classes", () => {
  const classes = (c: Case) => {
    const { root, env } = setup(c);
    return parkClasses(loadLayeredConfig(root, env));
  };

  test("default to the registry rows plus escalated and human-decision", () => {
    expect(classes({})).toEqual([...DEFAULT_PARK_CLASSES]);
    expect(classes({})).toContain("human-decision");
  });

  test("a repository's own list keeps the arbiter's classes", () => {
    expect(
      classes({
        repository: "autonomy:\n  park_classes: [merge, data-retention]\n",
      }),
    ).toEqual(["merge", "data-retention", "escalated", "human-decision"]);
  });

  test("a malformed list is refused", () => {
    expect(() =>
      classes({ repository: 'autonomy:\n  park_classes: ["Merge it"]\n' }),
    ).toThrow(AutonomyConfigError);
  });

  test("the environment cannot widen the list", () => {
    expect(() =>
      classes({ env: { JIG__AUTONOMY__PARK_CLASSES: "[whatever]" } }),
    ).toThrow(/repository's to set.*JIG__AUTONOMY__PARK_CLASSES/);
  });

  test("the user file cannot set the list", () => {
    expect(() =>
      classes({ user: "autonomy:\n  park_classes: [whatever]\n" }),
    ).toThrow(/describes one repository/);
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

  test("--at reads the windows in the machine's local time zone", async () => {
    // 2026-10-26T21:30Z is Monday 21:30 in UTC, inside the weekday-night
    // window, and Tuesday 06:30 in Tokyo, inside it too; 13:30Z is Monday
    // afternoon in UTC and Monday 22:30 in Tokyo.
    const repository =
      "autonomy:\n  level: unattended\n  max_level: wide\n  off_hours:\n    level: wide\n";
    const level = async (tz: string, instant: string) => {
      const proc = await cli({ driver: true, repository, env: { TZ: tz } }, [
        "--at",
        instant,
      ]);
      const stdout = await new Response(proc.stdout).text();
      await expectSpawnExited(proc, 0);
      return stdout;
    };
    expect(await level("UTC", "2026-10-26T13:30:00Z")).toStartWith(
      "autonomy: unattended (",
    );
    expect(await level("Asia/Tokyo", "2026-10-26T13:30:00Z")).toStartWith(
      "autonomy: wide (off_hours) (",
    );
    expect(await level("UTC", "2026-10-26T21:30:00Z")).toStartWith(
      "autonomy: wide (off_hours) (",
    );
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
