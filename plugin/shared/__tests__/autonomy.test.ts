/**
 * The autonomy resolver: the effective level for each combination of the
 * repository's level and ceiling, a person's own layer, the environment and
 * whether a driver pass or a person's session asks; and the policy a driver
 * pass reads from the pull request's base branch rather than its own
 * checkout. Each case builds its layers in a scratch directory and passes
 * the environment explicitly, so no test changes this process's environment.
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
  type PolicySnapshot,
  readPolicySnapshot,
  resolveAutonomy,
} from "../autonomy.ts";
import { loadLayeredConfig, parseConfigText } from "../config-layers.ts";
import { spawnSync, withoutLeakyGitEnv } from "../guarded-git-spawn.ts";
import {
  expectSpawnExit,
  expectSpawnExited,
} from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../lib/test-helpers/script-argv.ts";

const scratch = mkdtempSync(join(tmpdir(), "autonomy-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;

/** A commit id no clone in these tests holds. */
const ABSENT_COMMIT = "0123456789abcdef0123456789abcdef01234567";

interface Case {
  /** The working tree's `.config/jig.yaml`: the pull request's own checkout. */
  repository?: string;
  /**
   * The base branch's `.config/jig.yaml` a driver pass reads its policy
   * from; `null` for a base without the file. Unset, the base holds what the
   * working tree holds.
   */
  base?: string | null;
  /** The policy snapshot cannot be read, for this reason. */
  unreadable?: string;
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

/** The base branch's text for a case: its own, else the working tree's. */
function baseText(c: Case): string | null {
  return c.base === undefined ? (c.repository ?? null) : c.base;
}

/** The snapshot a driver pass of `c` reads, built without git. */
function snapshotOf(c: Case): PolicySnapshot {
  if (c.unreadable !== undefined)
    return { from: "unreadable", reason: c.unreadable };
  const text = baseText(c);
  return {
    from: "base",
    commit: ABSENT_COMMIT,
    values: text === null ? {} : parseConfigText(text, "base"),
  };
}

function resolve(c: Case) {
  const { root, env } = setup(c);
  return resolveAutonomy(
    loadLayeredConfig(root, env),
    env,
    new Date(),
    snapshotOf(c),
  );
}

/** Git in `cwd` with a fixed identity, and no hook or signing of the host's. */
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, env: withoutLeakyGitEnv(process.env) },
  );
  expectSpawnExit({ ...r, exitCode: r.status }, 0, `git ${args.join(" ")}`);
  return r.stdout.trim();
}

/**
 * `setup` in a real clone: the base branch's file committed, the working
 * tree's written over it, and the commit named as a driver names it.
 */
function setupInClone(c: Case): { root: string; env: Record<string, string> } {
  const { repository: _, ...withoutTree } = c;
  const { root, env } = setup(withoutTree);
  rmSync(join(root, ".git"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  const base = baseText(c);
  if (base !== null) writeFileSync(join(root, ".config", "jig.yaml"), base);
  writeFileSync(join(root, "README"), "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  const commit = git(root, "rev-parse", "HEAD");
  if (c.repository !== undefined)
    writeFileSync(join(root, ".config", "jig.yaml"), c.repository);
  return {
    root,
    env: {
      ...env,
      ...(c.unreadable === undefined ? { DRIVE_PR_POLICY_BASE: commit } : {}),
    },
  };
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
    return resolveAutonomy(
      loadLayeredConfig(root, env),
      env,
      now,
      snapshotOf(c),
    );
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

  test("an off-hours level from the user layer is capped by the repository's ceiling", () => {
    const a = at(
      {
        driver: true,
        repository: "autonomy:\n  max_level: unattended\n",
        user: "autonomy:\n  off_hours:\n    level: wide\n",
      },
      mondayNight,
    );
    expect(a.chosen).toBe("wide");
    expect(a.level).toBe("unattended");
    expect(a.capped).toBe(true);
    expect(a.source).toContain("home");
  });

  test("an off-hours level from the environment applies up to the ceiling", () => {
    const a = at(
      {
        driver: true,
        repository: "autonomy:\n  level: attended\n  max_level: wide\n",
        env: { JIG__AUTONOMY__OFF_HOURS__LEVEL: "wide" },
      },
      saturdayNoon,
    );
    expect(a.level).toBe("wide");
    expect(a.source).toBe("$JIG__AUTONOMY__OFF_HOURS__LEVEL");
    expect(
      at(
        {
          driver: true,
          repository: "autonomy:\n  level: attended\n  max_level: wide\n",
          env: { JIG__AUTONOMY__OFF_HOURS__LEVEL: "wide" },
        },
        mondayNoon,
      ).level,
    ).toBe("attended");
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
    return parkClasses(loadLayeredConfig(root, env), env, snapshotOf(c));
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
    ).toEqual([
      "merge",
      "data-retention",
      "escalated",
      "human-decision",
      "human-thread",
    ]);
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

describe("a driver pass reads its policy from the base branch", () => {
  test("a pull request that raises max_level does not raise its own drive", () => {
    const a = resolve({
      driver: true,
      base: "autonomy:\n  level: unattended\n  max_level: unattended\n",
      repository: "autonomy:\n  level: wide\n  max_level: wide\n",
    });
    expect(a.chosen).toBe("wide");
    expect(a.level).toBe("unattended");
    expect(a.capped).toBe(true);
    expect(a.ceilingSource).toContain("on the base branch");
    expect(describeAutonomy(a)).toContain("policy from the base branch at");
  });

  test("a pull request that raises level is capped by the base's level when the base sets no max_level", () => {
    const a = resolve({
      driver: true,
      base: "autonomy:\n  level: attended\n",
      repository: "autonomy:\n  level: unattended\n",
    });
    expect(a.level).toBe("attended");
    expect(a.capped).toBe(true);
    expect(a.ceilingSource).toContain("which sets no max_level");
  });

  test("a base without the file allows attended, whatever the working tree says", () => {
    const a = resolve({
      driver: true,
      base: null,
      repository: "autonomy:\n  level: unattended\n  max_level: wide\n",
    });
    expect(a.level).toBe("attended");
    expect(a.ceilingSource).toBe("the default, which allows attended only");
  });

  test("the working tree's level above its own max_level is capped, not refused", () => {
    const a = resolve({
      driver: true,
      base: "autonomy:\n  max_level: unattended\n",
      repository: "autonomy:\n  level: wide\n  max_level: attended\n",
    });
    expect(a.level).toBe("unattended");
    expect(a.capped).toBe(true);
  });

  test("the working tree's level up to the base's ceiling stands", () => {
    const a = resolve({
      driver: true,
      base: "autonomy:\n  level: attended\n  max_level: unattended\n",
      repository: "autonomy:\n  level: unattended\n",
    });
    expect(a.level).toBe("unattended");
    expect(a.capped).toBe(false);
  });

  test("a JIG_OVERLAY redirect does not move the ceiling", () => {
    const overlay = join(scratch, `overlay-${n++}.yaml`);
    writeFileSync(overlay, "autonomy:\n  level: wide\n  max_level: wide\n");
    const a = resolve({
      driver: true,
      base: "autonomy:\n  max_level: attended\n",
      env: { JIG_OVERLAY: overlay },
    });
    expect(a.chosen).toBe("wide");
    expect(a.level).toBe("attended");
  });

  test("a pull request that drops a park class does not drop it for its own drive", () => {
    const { root, env } = setup({
      driver: true,
      repository: "autonomy:\n  park_classes: [merge]\n",
    });
    const c = parkClasses(
      loadLayeredConfig(root, env),
      env,
      snapshotOf({
        base: "autonomy:\n  park_classes: [merge, data-retention]\n",
      }),
    );
    expect(c).toContain("data-retention");
  });

  test("an unreadable policy fails closed: attended, and every decision parked as a person's", () => {
    const c: Case = {
      driver: true,
      unreadable: "no base",
      repository: "autonomy:\n  level: unattended\n  max_level: wide\n",
    };
    const a = resolve(c);
    expect(a.level).toBe("attended");
    expect(a.ceiling).toBe("attended");
    expect(a.policy).toEqual({ from: "unreadable", reason: "no base" });
    expect(describeAutonomy(a)).toContain(
      "every decision is parked under human-decision until it reads",
    );
    const { root, env } = setup(c);
    expect(
      parkClasses(loadLayeredConfig(root, env), env, snapshotOf(c)),
    ).toEqual(["escalated", "human-decision", "human-thread"]);
  });

  test("a person's session reads the working tree's policy, as before", () => {
    const c: Case = {
      unreadable: "no base",
      repository:
        "autonomy:\n  max_level: unattended\n  park_classes: [merge]\n",
      user: "autonomy:\n  level: unattended\n",
    };
    const a = resolve(c);
    expect(a.level).toBe("unattended");
    expect(a.policy).toEqual({ from: "working-tree" });
    const { root, env } = setup(c);
    expect(
      parkClasses(loadLayeredConfig(root, env), env, snapshotOf(c)),
    ).toContain("merge");
  });
});

describe("reading the base branch's snapshot", () => {
  const read = (c: Case) => {
    const { root, env } = setupInClone({ driver: true, ...c });
    return readPolicySnapshot(env, root);
  };

  test("reads the file at the commit the driver named, not the working tree's", () => {
    const s = read({
      base: "autonomy:\n  max_level: unattended\n",
      repository: "autonomy:\n  max_level: wide\n",
    });
    expect(s.from).toBe("base");
    if (s.from === "base")
      expect(s.values).toEqual({ autonomy: { max_level: "unattended" } });
  });

  test("a base without the file is readable and sets nothing", () => {
    const s = read({
      base: null,
      repository: "autonomy:\n  max_level: wide\n",
    });
    expect(s.from).toBe("base");
    if (s.from === "base") expect(s.values).toEqual({});
  });

  test("is unreadable when no commit is named, the commit is absent, or the file does not parse or is invalid", () => {
    expect(read({ unreadable: "unset" })).toMatchObject({
      from: "unreadable",
      reason: expect.stringContaining("named no base-branch commit"),
    });
    const { root, env } = setupInClone({ driver: true, base: null });
    expect(
      readPolicySnapshot({ ...env, DRIVE_PR_POLICY_BASE: ABSENT_COMMIT }, root)
        .from,
    ).toBe("unreadable");
    expect(read({ base: "autonomy: [unclosed\n" }).from).toBe("unreadable");
    for (const base of ["autonomy: []\n", "autonomy: broken\n"])
      expect(read({ base })).toMatchObject({
        from: "unreadable",
        reason: expect.stringContaining("autonomy must be a mapping"),
      });
    expect(
      read({ base: "autonomy:\n  level: wide\n  max_level: attended\n" }),
    ).toMatchObject({
      from: "unreadable",
      reason: expect.stringContaining("above autonomy.max_level"),
    });
    expect(read({ base: "autonomy:\n  park_classes: []\n" }).from).toBe(
      "unreadable",
    );
  });

  test("a replace ref in the clone does not substitute another file for the base's", () => {
    const { root, env } = setupInClone({
      driver: true,
      base: "autonomy:\n  max_level: attended\n",
      repository: "autonomy:\n  max_level: wide\n",
    });
    const commit = env.DRIVE_PR_POLICY_BASE ?? "";
    const baseBlob = git(root, "rev-parse", `${commit}:.config/jig.yaml`);
    const wider = git(root, "hash-object", "-w", ".config/jig.yaml");
    git(root, "replace", baseBlob, wider);
    expect(git(root, "cat-file", "blob", baseBlob)).toContain("wide");
    const s = readPolicySnapshot(env, root);
    expect(s.from).toBe("base");
    if (s.from === "base")
      expect(s.values).toEqual({ autonomy: { max_level: "attended" } });
  });

  test("a stacked base's policy only narrows the integration branch's", () => {
    const { root, env } = setupInClone({
      driver: true,
      base: "autonomy:\n  max_level: wide\n  park_classes: [ready]\n",
    });
    writeFileSync(
      join(root, ".config", "jig.yaml"),
      "autonomy:\n  max_level: unattended\n  park_classes: [merge]\n",
    );
    git(root, "commit", "-q", "-am", "integration");
    const bound = git(root, "rev-parse", "HEAD");
    const withBound = { ...env, DRIVE_PR_POLICY_BOUND: bound };
    const snapshot = readPolicySnapshot(withBound, root);
    const a = resolveAutonomy(
      loadLayeredConfig(root, withBound),
      withBound,
      new Date(),
      snapshot,
    );
    expect(a.ceiling).toBe("unattended");
    expect(
      parkClasses(loadLayeredConfig(root, withBound), withBound, snapshot),
    ).toEqual(expect.arrayContaining(["ready", "merge"]));
    expect(
      readPolicySnapshot({ ...env, DRIVE_PR_POLICY_BOUND: ABSENT_COMMIT }, root)
        .from,
    ).toBe("unreadable");
  });

  test("a person's session reads the working tree without git", () => {
    expect(readPolicySnapshot({}, join(scratch, "nowhere"))).toEqual({
      from: "working-tree",
    });
  });
});

describe("the command line", () => {
  const script = join(import.meta.dir, "..", "autonomy.ts");

  async function cli(c: Case, args: string[]) {
    const { root, env } = c.driver ? setupInClone(c) : setup(c);
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

  test("a window keeps to the local clock across a daylight-saving change", async () => {
    const level = async (schedule: string, instant: string) => {
      const proc = await cli(
        {
          driver: true,
          repository: `autonomy:\n  max_level: wide\n  off_hours:\n    level: wide\n    schedule: ["${schedule}"]\n`,
          env: { TZ: "Europe/Berlin" },
        },
        ["--at", instant],
      );
      const stdout = await new Response(proc.stdout).text();
      await expectSpawnExited(proc, 0);
      return stdout.startsWith("autonomy: wide (off_hours)");
    };
    // 2026-10-25: 03:00 summer time becomes 02:00 winter time, so 02:30 comes twice.
    expect(await level("Sun 02:00-03:00", "2026-10-25T00:30:00Z")).toBe(true);
    expect(await level("Sun 02:00-03:00", "2026-10-25T01:30:00Z")).toBe(true);
    expect(await level("Sun 02:00-03:00", "2026-10-25T02:30:00Z")).toBe(false);
    // 2026-03-29: 02:00 winter time becomes 03:00 summer time.
    expect(await level("Sun 01:00-04:00", "2026-03-29T00:30:00Z")).toBe(true);
    expect(await level("Sun 01:00-04:00", "2026-03-29T01:30:00Z")).toBe(true);
    expect(await level("Sun 01:00-04:00", "2026-03-29T02:30:00Z")).toBe(false);
    expect(await level("Sun 01:00-04:00", "2026-03-28T23:30:00Z")).toBe(false);
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
  test("a driver pass prints the base branch's ceiling, not the pull request's", async () => {
    const proc = await cli(
      {
        driver: true,
        base: "autonomy:\n  max_level: attended\n",
        repository: "autonomy:\n  level: wide\n  max_level: wide\n",
      },
      [],
    );
    const stdout = await new Response(proc.stdout).text();
    await expectSpawnExited(proc, 0);
    expect(stdout).toStartWith("autonomy: attended (wide from ");
    expect(stdout).toContain("policy from the base branch at");
  });

  test("a driver pass lists the base branch's park classes", async () => {
    const proc = await cli(
      {
        driver: true,
        base: "autonomy:\n  park_classes: [merge, data-retention]\n",
        repository: "autonomy:\n  park_classes: [merge]\n",
      },
      ["classes"],
    );
    const stdout = await new Response(proc.stdout).text();
    await expectSpawnExited(proc, 0);
    expect(stdout.split("\n")).toContain("data-retention");
  });

  test("a driver pass whose base cannot be read runs attended and parks everything as a person's", async () => {
    const c: Case = {
      driver: true,
      unreadable: "unset",
      repository: "autonomy:\n  level: unattended\n  max_level: wide\n",
    };
    const level = await cli(c, []);
    const line = await new Response(level.stdout).text();
    await expectSpawnExited(level, 0);
    expect(line).toStartWith("autonomy: attended (");
    expect(line).toContain("parked under human-decision");
    const classes = await cli(c, ["classes"]);
    const listed = await new Response(classes.stdout).text();
    await expectSpawnExited(classes, 0);
    expect(listed.trim().split("\n")).toEqual([
      "escalated",
      "human-decision",
      "human-thread",
    ]);
  });
});
