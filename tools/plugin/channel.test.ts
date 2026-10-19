/**
 * The release channels: the promotion and rollback rules as functions, and
 * the whole path a channel commit takes, against a scratch origin: written by
 * channel.ts, then checked and pushed by the `push` job's own script, read
 * from .github/workflows/channels.yml.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { load } from "js-yaml";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { spawnSync } from "../../plugin/shared/guarded-git-spawn.ts";
import {
  artifactTree,
  ChannelError,
  channelReadme,
  gitEnv,
  isShipped,
  runChecked,
} from "./artifact.ts";
import {
  type ChannelCommit,
  compareVersions,
  crossesBreaking,
  evaluatePromotion,
  evaluateRollback,
  gitSources,
  type PromotionFacts,
  parseArgs,
  parseTrailers,
  readChannel,
  regressionVersions,
  requiredCheckResult,
  run,
  SOAK_HOURS,
  soakStart,
  type Sources,
  type Tag,
  versionsBetween,
} from "./channel.ts";

const root = resolve(import.meta.dirname, "../..");
const HOUR = 3_600_000;
const t0 = new Date("2026-06-01T00:00:00Z");
const at = (hours: number) => new Date(t0.getTime() + hours * HOUR);

function tag(version: string, madeAt = t0, onMain = true): Tag {
  return { version, commit: "a".repeat(40), madeAt, onMain };
}

function entry(
  version: string,
  date: Date,
  action: ChannelCommit["action"] = "latest",
  withdrawn: string[] = [],
): ChannelCommit {
  return {
    commit: "b".repeat(40),
    action,
    version,
    source: "a".repeat(40),
    date,
    withdrawn,
  };
}

function facts(overrides: Partial<PromotionFacts> = {}): PromotionFacts {
  return {
    candidate: "0.62.0",
    tag: tag("0.62.0"),
    gates: "success",
    soakStart: t0,
    stable: "0.61.0",
    withdrawn: [],
    regressions: [],
    now: at(SOAK_HOURS),
    ...overrides,
  };
}

test("the artifact leaves out tests and the instructions for Jig's own agents", () => {
  expect(isShipped(".claude-plugin/marketplace.json")).toBe(true);
  expect(isShipped(".agents/plugins/marketplace.json")).toBe(true);
  expect(isShipped("plugin/skills/audit/SKILL.md")).toBe(true);
  expect(isShipped("plugin/README.md")).toBe(true);
  expect(isShipped("plugin/skills/audit/__tests__/score.test.ts")).toBe(false);
  expect(isShipped("plugin/__tests__/x.ts")).toBe(false);
  expect(isShipped("plugin/AGENTS.md")).toBe(false);
  expect(isShipped("plugin/skills/x/CLAUDE.md")).toBe(false);
  expect(isShipped("README.md")).toBe(false);
  expect(isShipped(".claude-plugin/other.json")).toBe(false);
  expect(isShipped("plugins/x")).toBe(false);
});

test("versions compare numerically and ranges are half-open", () => {
  expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
  expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  const released = ["0.9.0", "0.10.0", "0.10.1", "0.11.0"];
  expect(versionsBetween(released, "0.9.0", "0.10.1")).toEqual([
    "0.10.0",
    "0.10.1",
  ]);
  expect(versionsBetween(released, null, "0.10.0")).toEqual([
    "0.9.0",
    "0.10.0",
  ]);
});

test("a version that met every condition may be promoted", () => {
  expect(evaluatePromotion(facts())).toEqual([]);
  // The first promotion: no stable yet.
  expect(evaluatePromotion(facts({ stable: null }))).toEqual([]);
});

test("each promotion condition refuses on its own", () => {
  expect(evaluatePromotion(facts({ tag: null }))).toEqual([
    "v0.62.0 is not tagged",
  ]);
  expect(evaluatePromotion(facts({ tag: tag("0.62.0", t0, false) }))).toEqual([
    "v0.62.0's commit is not on main",
  ]);
  expect(evaluatePromotion(facts({ gates: "failure" }))[0]).toContain(
    "gates on v0.62.0's commit aaaaaaaaaaaa is failure, not success",
  );
  expect(evaluatePromotion(facts({ gates: null }))[0]).toContain(
    "is missing, not success",
  );
  expect(evaluatePromotion(facts({ now: at(SOAK_HOURS - 1) }))).toEqual([
    `v0.62.0 has been on latest for ${SOAK_HOURS - 1} hours, under the ${SOAK_HOURS} it must soak`,
  ]);
  expect(evaluatePromotion(facts({ soakStart: null }))).toEqual([
    "v0.62.0 is not on latest yet",
  ]);
  expect(evaluatePromotion(facts({ stable: "0.62.0" }))[0]).toContain(
    "not newer than stable's v0.62.0",
  );
  expect(evaluatePromotion(facts({ withdrawn: ["0.62.0"] }))[0]).toContain(
    "was withdrawn from stable by a rollback",
  );
});

test("a regression blocks only the versions a promotion would newly ship", () => {
  const regression = (versions: string[]) => [
    { number: 7, title: "drive stops", versions },
  ];
  // Already on stable: promoting cannot make it worse.
  expect(
    evaluatePromotion(facts({ regressions: regression(["0.61.0"]) })),
  ).toEqual([]);
  // Newer than the candidate: not shipped by this promotion.
  expect(
    evaluatePromotion(facts({ regressions: regression(["0.63.0"]) })),
  ).toEqual([]);
  expect(
    evaluatePromotion(facts({ regressions: regression(["0.61.1"]) })),
  ).toEqual([
    "#7 (regression) names v0.61.1, which this promotion would ship: drive stops",
  ]);
  // A regression whose version nobody can read may be in this one.
  expect(evaluatePromotion(facts({ regressions: regression([]) }))).toEqual([
    "#7 (regression) names no version, so it may be in this one: drive stops",
  ]);
});

test("a regression is filed against the bug form's version, else its title's", () => {
  const body =
    "### Plugin version\n\nv0.61.1\n\n### What happened\n\nIt worked in 0.58.0.\n";
  expect(regressionVersions("drive stops", body)).toEqual(["0.61.1"]);
  expect(
    regressionVersions("0.62.0: drive stops", "It worked in 0.58.0."),
  ).toEqual(["0.62.0"]);
  expect(
    regressionVersions("drive stops", "### Plugin version\n\nlatest\n"),
  ).toEqual([]);
  // A dotted number that is not a version is not read as one.
  expect(regressionVersions("1.2.3.4 broke", "")).toEqual([]);
});

test("soak starts when latest first carried the version or a later one", () => {
  const history = [entry("0.62.0", at(30)), entry("0.61.0", at(10))];
  // Tagged before latest existed: it was on main, the only address, from its tag.
  expect(soakStart("0.60.0", tag("0.60.0", at(5)), history)).toEqual(at(5));
  expect(soakStart("0.61.0", tag("0.61.0", at(9)), history)).toEqual(at(9));
  // Reached latest with its own commit.
  expect(soakStart("0.61.0", tag("0.61.0", at(11)), history)).toEqual(at(10));
  // Skipped over: latest carried it from the commit that went past it.
  expect(soakStart("0.61.5", tag("0.61.5", at(20)), history)).toEqual(at(30));
  expect(soakStart("0.63.0", tag("0.63.0", at(40)), history)).toBeNull();
  expect(soakStart("0.1.0", tag("0.1.0", at(1)), [])).toEqual(at(1));
});

test("a rollback returns only to a version stable carried, and not across a breaking one", () => {
  const history = [
    entry("0.61.3", at(30), "promote"),
    entry("0.61.0", at(10), "promote"),
  ];
  expect(
    evaluateRollback("0.61.0", tag("0.61.0"), "success", history, false),
  ).toEqual([]);
  expect(
    evaluateRollback("0.61.2", tag("0.61.2"), "success", history, false),
  ).toEqual([
    "stable never carried v0.61.2; a rollback returns only to a version promoted before",
  ]);
  expect(
    evaluateRollback("0.61.4", tag("0.61.4"), "success", history, false)[0],
  ).toContain("not older than stable's v0.61.3");
  expect(
    evaluateRollback("0.61.0", tag("0.61.0"), "failure", history, false)[0],
  ).toContain("is failure, not success");
  expect(
    evaluateRollback("0.61.0", tag("0.61.0"), "success", [], false),
  ).toContain("stable carries no version yet");
  const breaking = [
    entry("1.0.0", at(30), "promote"),
    entry("0.61.0", at(10), "promote"),
  ];
  expect(
    evaluateRollback("0.61.0", tag("0.61.0"), "success", breaking, false)[0],
  ).toContain("crosses a breaking release");
  expect(
    evaluateRollback("0.61.0", tag("0.61.0"), "success", breaking, true),
  ).toEqual([]);
  // A version a rollback withdrew never returns, by a rollback either.
  const withdrawnHistory = [
    entry("0.61.4", at(50), "promote"),
    entry("0.61.0", at(40), "rollback", ["0.61.2", "0.61.3"]),
    entry("0.61.3", at(30), "promote"),
    entry("0.61.2", at(20), "promote"),
    entry("0.61.0", at(10), "promote"),
  ];
  expect(
    evaluateRollback(
      "0.61.2",
      tag("0.61.2"),
      "success",
      withdrawnHistory,
      false,
    ),
  ).toEqual([
    "v0.61.2 was withdrawn from stable by a rollback; it never returns",
  ]);
  expect(crossesBreaking("0.62.0", "0.61.0")).toBe(true);
  expect(crossesBreaking("1.2.0", "1.1.0")).toBe(false);
  expect(crossesBreaking("0.62.3", "0.62.1")).toBe(false);
});

test("channel commits carry their record as trailers", () => {
  expect(
    parseTrailers(
      "stable: rollback v0.61.0\n\nbody\n\nJig-Channel: stable\nJig-Action: rollback\nJig-Version: 0.61.0\nJig-Source: abc\nJig-Withdrawn: 0.62.0,0.62.1\n",
    ),
  ).toEqual({
    channel: "stable",
    action: "rollback",
    version: "0.61.0",
    source: "abc",
    withdrawn: ["0.62.0", "0.62.1"],
  });
  expect(parseTrailers("a commit a person wrote")).toBeNull();
});

test("the command line names one command, its version and its bundle", () => {
  expect(parseArgs(["promote", "v0.62.0", "--bundle", "b"])).toMatchObject({
    command: "promote",
    version: "0.62.0",
    bundle: "b",
  });
  expect(parseArgs(["status"]).version).toBeNull();
  expect(() => parseArgs(["promote", "0.62.0"])).toThrow("needs --bundle");
  expect(() => parseArgs(["check"])).toThrow("needs version");
  expect(() => parseArgs(["latest", "0.1.0", "--bundle", "b"])).toThrow(
    "takes no version",
  );
  expect(() => parseArgs(["check", "0.62"])).toThrow("not a major.minor.patch");
  expect(() =>
    parseArgs(["promote", "0.6.0", "--across-breaking", "--bundle", "b"]),
  ).toThrow("rollback only");
  expect(() => parseArgs(["publish"])).toThrow("usage");
});

test("release.yml hands its secrets to the latest channel's push job", () => {
  const read = (name: string) =>
    load(readFileSync(join(root, ".github/workflows", name), "utf8")) as {
      jobs: Record<string, Record<string, unknown>>;
    };
  // The push job reads the App's key from its environment, which a called
  // workflow sees only when its caller passes `secrets: inherit`.
  expect(read("channels.yml").jobs.push?.environment).toBe("release");
  const latest = read("release.yml").jobs.latest;
  expect(latest?.uses).toBe("./.github/workflows/channels.yml");
  expect(latest?.secrets).toBe("inherit");
});

// --- The whole path, against a scratch origin -------------------------------

let scratch: string;
let work: string;
let origin: string;

function sh(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): string {
  const result = spawnSync("git", args, { cwd, env: gitEnv(env) });
  expectSpawnExit({ ...result, exitCode: result.status }, 0);
  return result.stdout.trim();
}

function writeVersion(version: string): void {
  const manifest = JSON.stringify({
    name: "jig",
    version,
    skills: "./skills/",
  });
  for (const dir of [".claude-plugin", ".codex-plugin"]) {
    mkdirSync(join(work, "plugin", dir), { recursive: true });
    writeFileSync(join(work, "plugin", dir, "plugin.json"), `${manifest}\n`);
  }
  writeFileSync(join(work, "plugin/skills/x/SKILL.md"), `x ${version}\n`);
}

/** Commit, tag `v<version>` at `date` and push both to the origin. */
function release(version: string, date: string): void {
  writeVersion(version);
  const dates = { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  sh(work, ["add", "-A"]);
  sh(work, ["commit", "-q", "-m", `release ${version}`], dates);
  sh(work, ["tag", "-a", `v${version}`, "-m", `v${version}`], dates);
  sh(work, ["push", "-q", "origin", "main", `v${version}`]);
}

const github: Pick<Sources, "gates" | "regressions"> = {
  gates: () => "success",
  regressions: () => [],
};

/** Run a channel command; return its exit code and the outputs it wrote. */
function channel(
  argv: string[],
  now = new Date(Date.now() + 100 * HOUR),
): { status: number; outputs: Record<string, string> } {
  const outputs: Record<string, string> = {};
  const status = run(
    parseArgs(argv),
    work,
    gitSources(work, "origin", github),
    now,
    (key, value) => {
      outputs[key] = value;
    },
  );
  return { status, outputs };
}

/** The `push` job's check-and-push script, run against the scratch origin. */
function pushScript(): string {
  const workflow = load(
    readFileSync(join(root, ".github/workflows/channels.yml"), "utf8"),
  ) as { jobs: { push: { steps: { name?: string; run?: string }[] } } };
  const step = workflow.jobs.push.steps.find(
    (s) => s.name === "Check the commit against its tag, and push",
  );
  const script = step?.run ?? "";
  const remoteLine = /^remote="https:\/\/x-access-token.*$/m;
  expect(script).toMatch(remoteLine);
  return script.replace(remoteLine, 'remote="$ORIGIN"');
}

/** The run's request, as the workflow's inputs carry it. */
interface Request {
  command: string;
  version?: string | undefined;
}

function push(
  outputs: Record<string, string>,
  bundle: string,
  request: Request,
): { status: number | null; stdout: string; stderr: string } {
  const temp = mkdtempSync(join(scratch, "runner-"));
  const result = spawnSync("bash", ["-c", pushScript()], {
    cwd: scratch,
    env: gitEnv({
      ORIGIN: origin,
      RUNNER_TEMP: temp,
      COMMAND: request.command,
      VERSION: request.version ?? "",
      CHANNEL: outputs.channel ?? "",
      START: outputs.start ?? "",
      COMMIT: outputs.commit ?? "",
      BUNDLE: bundle,
    }),
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function promoteAndPush(argv: string[], name: string): string {
  const bundle = join(scratch, `${name}.bundle`);
  const { status, outputs } = channel([...argv, "--bundle", bundle]);
  expect(status).toBe(0);
  const pushed = push(outputs, bundle, {
    command: argv[0] as string,
    version: argv[1],
  });
  expectSpawnExit({ ...pushed, exitCode: pushed.status }, 0);
  return outputs.commit as string;
}

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "jig-channel-")));
  origin = join(scratch, "origin.git");
  work = join(scratch, "work");
  sh(scratch, ["init", "-q", "--bare", "-b", "main", origin]);
  sh(scratch, ["init", "-q", "-b", "main", work]);
  sh(work, ["config", "user.name", "Channel Test"]);
  sh(work, ["config", "user.email", "channel@example.com"]);
  sh(work, ["remote", "add", "origin", origin]);
  const files: Record<string, string> = {
    ".claude-plugin/marketplace.json": '{"name":"jig","plugins":[]}\n',
    ".agents/plugins/marketplace.json": '{"name":"jig","plugins":[]}\n',
    "plugin/skills/x/__tests__/x.test.ts": "test\n",
    "plugin/AGENTS.md": "for Jig's agents\n",
    "plugin/CLAUDE.md": "@AGENTS.md\n",
    "README.md": "the repository\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), text);
  }
  release("0.1.0", "2026-01-01T00:00:00Z");
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test.skipIf(process.platform === "win32")(
  "channels move by checked commits, and the push job refuses any other tree",
  () => {
    // latest: its first commit, built from the tag's objects.
    const first = promoteAndPush(["latest"], "latest-1");
    const files = sh(origin, ["ls-tree", "-r", "--name-only", "latest"]).split(
      "\n",
    );
    expect(files.sort()).toEqual([
      ".agents/plugins/marketplace.json",
      ".claude-plugin/marketplace.json",
      "README.md",
      "plugin/.claude-plugin/plugin.json",
      "plugin/.codex-plugin/plugin.json",
      "plugin/skills/x/SKILL.md",
    ]);
    expect(sh(origin, ["show", "latest:README.md"])).toContain(
      "`latest` channel",
    );
    expect(
      channel(["latest", "--bundle", join(scratch, "noop")]).outputs,
    ).toEqual({
      changed: "false",
    });

    release("0.1.1", new Date().toISOString());
    const second = promoteAndPush(["latest"], "latest-2");
    expect(sh(origin, ["rev-parse", "latest^"])).toBe(first);
    expect(
      readChannel(work, "refs/jig-channel/remote/latest").history,
    ).toHaveLength(1);

    // 0.1.1 reached latest just now: it has not soaked yet.
    expect(channel(["check", "0.1.1"], new Date()).status).toBe(3);
    // 0.1.0 was tagged before latest existed; stable's first commit.
    promoteAndPush(["promote", "0.1.0"], "stable-1");
    expect(sh(origin, ["rev-list", "--count", "stable"])).toBe("1");
    expect(sh(origin, ["show", "stable:plugin/skills/x/SKILL.md"])).toBe(
      "x 0.1.0",
    );

    promoteAndPush(["promote", "0.1.1"], "stable-2");
    expect(sh(origin, ["show", "stable:plugin/skills/x/SKILL.md"])).toBe(
      "x 0.1.1",
    );
    expect(sh(origin, ["log", "-1", "--format=%B", "stable"])).toContain(
      "Versions this promotion adds, oldest first: 0.1.1.",
    );

    // Rollback writes a new commit with the older tree, and withdraws 0.1.1.
    promoteAndPush(["rollback", "0.1.0"], "stable-3");
    expect(sh(origin, ["rev-list", "--count", "stable"])).toBe("3");
    expect(sh(origin, ["show", "stable:plugin/skills/x/SKILL.md"])).toBe(
      "x 0.1.0",
    );
    expect(sh(origin, ["log", "-1", "--format=%B", "stable"])).toContain(
      "Jig-Withdrawn: 0.1.1",
    );
    expect(channel(["check", "0.1.1"]).status).toBe(3);

    // A commit that names v0.1.1 but carries another tree is not pushed.
    expect(second).toMatch(/^[0-9a-f]{40}$/);
    const tip = sh(origin, ["rev-parse", "stable"]);
    sh(work, ["fetch", "-q", "origin", "stable"]);
    const reworded = spawnSync(
      "git",
      // The source tree itself, with its tests and AGENTS.md.
      ["-C", work, "commit-tree", "v0.1.1^{tree}", "-p", tip, "-F", "-"],
      {
        env: gitEnv(),
        input: `stable: promote v0.1.1\n\nJig-Channel: stable\nJig-Action: promote\nJig-Version: 0.1.1\nJig-Source: ${sh(work, ["rev-parse", "v0.1.1^{commit}"])}\n`,
      },
    );
    expectSpawnExit({ ...reworded, exitCode: reworded.status }, 0);
    const commit = reworded.stdout.trim();
    sh(work, ["update-ref", "refs/jig-channel/out/stable", commit]);
    const bundle = join(scratch, "forged.bundle");
    sh(work, [
      "bundle",
      "create",
      "-q",
      bundle,
      "refs/jig-channel/out/stable",
      `^${tip}`,
    ]);
    const refused = push({ channel: "stable", start: tip, commit }, bundle, {
      command: "promote",
      version: "0.1.1",
    });
    expectSpawnExit({ ...refused, exitCode: refused.status }, 1);
    expect(refused.stdout).toContain("files differ from what v0.1.1 ships");
    expect(sh(origin, ["rev-parse", "stable"])).toBe(tip);
  },
  60_000,
);

test.skipIf(process.platform === "win32")(
  "the push job checks the record later runs read against the request and the tags",
  () => {
    // Stable carries the rollback to 0.1.0 the test above pushed.
    release("0.1.2", new Date().toISOString());
    promoteAndPush(["latest"], "latest-3");
    promoteAndPush(["promote", "0.1.2"], "stable-4");
    const refusals: [string, Forgery, Request][] = [
      [
        "Jig-Withdrawn '0.1.2' is not the versions rolled back over, '0.1.1,0.1.2'",
        { withdrawn: "0.1.2" },
        { command: "rollback", version: "0.1.0" },
      ],
      [
        "a promote withdraws no version",
        { action: "promote", version: "0.1.2", withdrawn: "0.1.0" },
        { command: "promote", version: "0.1.2" },
      ],
      [
        "Jig-Action 'rollback' is not the requested promote",
        {},
        { command: "promote", version: "0.1.0" },
      ],
      [
        "Jig-Version 0.1.0 is not the requested 0.1.1",
        {},
        { command: "rollback", version: "0.1.1" },
      ],
      [
        "not within the last hour",
        { date: "2026-01-02T00:00:00Z" },
        { command: "rollback", version: "0.1.0" },
      ],
      [
        "files differ from what v0.1.0 ships",
        { readme: "anything\n" },
        { command: "rollback", version: "0.1.0" },
      ],
    ];
    for (const [problem, forgery, request] of refusals) {
      const forged = forge(forgery);
      const result = push(forged.outputs, forged.bundle, request);
      expectSpawnExit({ ...result, exitCode: result.status }, 1);
      expect(result.stdout).toContain(problem);
      expect(sh(origin, ["rev-parse", "stable"])).toBe(
        forged.outputs.start as string,
      );
    }
    // The same forger, asked for nothing false, writes a commit that passes.
    const honest = forge({});
    const accepted = push(honest.outputs, honest.bundle, {
      command: "rollback",
      version: "0.1.0",
    });
    expectSpawnExit({ ...accepted, exitCode: accepted.status }, 0);
  },
  60_000,
);

/** What a forged stable commit says; by default, an honest rollback to 0.1.0. */
interface Forgery {
  action?: string;
  version?: string;
  withdrawn?: string;
  readme?: string;
  date?: string;
}

/** A stable commit on top of the origin's tip, written by hand, and its bundle. */
function forge(forgery: Forgery): {
  outputs: Record<string, string>;
  bundle: string;
} {
  const action = forgery.action ?? "rollback";
  const version = forgery.version ?? "0.1.0";
  const withdrawn = forgery.withdrawn ?? "0.1.1,0.1.2";
  sh(work, ["fetch", "-q", "origin", "+stable:refs/jig-channel/forge-base"]);
  const tip = sh(work, ["rev-parse", "refs/jig-channel/forge-base"]);
  const source = sh(work, ["rev-parse", `v${version}^{commit}`]);
  const tree = artifactTree(work, source, {
    "README.md": forgery.readme ?? channelReadme("stable", version),
  });
  const message = [
    `stable: ${action} v${version}`,
    "",
    `Jig-Channel: stable`,
    `Jig-Action: ${action}`,
    `Jig-Version: ${version}`,
    `Jig-Source: ${source}`,
    `Jig-Withdrawn: ${withdrawn}`,
    "",
  ].join("\n");
  const dates: Record<string, string> = forgery.date
    ? { GIT_AUTHOR_DATE: forgery.date, GIT_COMMITTER_DATE: forgery.date }
    : {};
  const written = spawnSync(
    "git",
    ["-C", work, "commit-tree", tree, "-p", tip, "-F", "-"],
    { env: gitEnv(dates), input: message },
  );
  expectSpawnExit({ ...written, exitCode: written.status }, 0);
  const commit = written.stdout.trim();
  sh(work, ["update-ref", "refs/jig-channel/out/stable", commit]);
  const bundle = join(mkdtempSync(join(scratch, "forged-")), "stable.bundle");
  sh(work, [
    "bundle",
    "create",
    "-q",
    bundle,
    "refs/jig-channel/out/stable",
    `^${tip}`,
  ]);
  return { outputs: { channel: "stable", start: tip, commit }, bundle };
}

test.skipIf(process.platform === "win32")(
  "a tag only this clone has is not a release",
  () => {
    sh(work, ["tag", "v9.9.9"]);
    try {
      const versions = gitSources(work, "origin", github)
        .tags()
        .map((t) => t.version);
      expect(versions).toContain("0.1.0");
      expect(versions).not.toContain("9.9.9");
    } finally {
      sh(work, ["tag", "-d", "v9.9.9"]);
    }
  },
  30_000,
);

test("the required check is the one GitHub Actions reports", () => {
  const run = (slug: string, conclusion: string) => ({
    app: { slug },
    status: "completed",
    conclusion,
  });
  expect(requiredCheckResult([run("github-actions", "success")])).toBe(
    "success",
  );
  // Another App's `gates` is not the required check, success or not.
  expect(requiredCheckResult([run("impostor", "success")])).toBeNull();
  expect(
    requiredCheckResult([
      run("impostor", "success"),
      run("github-actions", "failure"),
    ]),
  ).toBe("failure");
  expect(
    requiredCheckResult([
      { app: { slug: "github-actions" }, status: "queued" },
    ]),
  ).toBe("queued");
});

test.skipIf(process.platform === "win32")(
  "a command past its deadline fails with a reason, not a hang",
  () => {
    expect(() => runChecked("sleep", ["5"], { timeout: 200 })).toThrow(
      ChannelError,
    );
    expect(() => runChecked("sleep", ["5"], { timeout: 200 })).toThrow(
      "did not finish within 0.2 seconds",
    );
  },
);
