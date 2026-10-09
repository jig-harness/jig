/**
 * The repository is the `groundwork` plugin for Claude Code and Codex. These
 * tests pin its manifests and run the shipped skill scripts the way a plugin
 * cache holds them: copied outside this repository (no `node_modules`
 * anywhere above them), invoked from a scratch consumer repository whose own
 * configuration, triage bands and sibling skill they must find.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { LEAKY_GIT_ENV, spawnSync } from "../../lib/guarded-git-spawn.ts";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import {
  claudeMarketplace,
  claudeUserInstall,
  codexInstall,
  codexMarketplace,
  DEFAULT_SOURCE,
  PLUGIN_ID,
  parse,
  sameSource,
} from "./setup.ts";

const root = resolve(import.meta.dirname, "../..");
const skill = "resolve-review-comments";
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !LEAKY_GIT_ENV.some((name) => name === key.toUpperCase()),
  ),
);
delete env.GROUNDWORK_OVERLAY;
delete env.GROUNDWORK_REVIEW_TRIAGE_CONFIG;
delete env.GROUNDWORK_CONSUMER_ROOT;

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

let scratch: string;
let scripts: string;
beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "groundwork-plugin-")));
  // The plugin cache copies the plugin directory; tests are not part of it.
  cpSync(join(root, "plugin", "skills"), join(scratch, "cache", "skills"), {
    recursive: true,
    filter: (path) => !path.includes("__tests__"),
  });
  scripts = join(scratch, "cache", "skills", skill, "scripts");
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("both harness manifests describe the same plugin", () => {
  const claude = json("plugin/.claude-plugin/plugin.json");
  const codex = json("plugin/.codex-plugin/plugin.json");
  for (const manifest of [claude, codex]) {
    expect(manifest.name).toBe("groundwork");
    expect(manifest.skills).toBe("./skills/");
    expect(String(manifest.version)).toMatch(/^\d+\.\d+\.\d+$/);
  }
  // A release bumps both together; a mismatch would ship different versions.
  expect(codex.version).toBe(claude.version);
  expect(codex.description).toBe(claude.description);
});

test("both marketplaces list plugin/ as the plugin", () => {
  const claude = json(".claude-plugin/marketplace.json") as {
    name: string;
    plugins: { name: string; source: unknown }[];
  };
  const codex = json(".agents/plugins/marketplace.json") as {
    name: string;
    plugins: { name: string; source: unknown }[];
  };
  expect(`${claude.plugins[0]?.name}@${claude.name}`).toBe(PLUGIN_ID);
  expect(`${codex.plugins[0]?.name}@${codex.name}`).toBe(PLUGIN_ID);
  expect(claude.plugins).toHaveLength(1);
  expect(codex.plugins).toHaveLength(1);
  expect(claude.plugins[0]?.source).toBe("./plugin");
  expect(codex.plugins[0]?.source).toEqual({
    source: "local",
    path: "./plugin",
  });
});

test("every shipped skill is named after its directory and avoids repository paths", () => {
  const skills = readdirSync(join(root, "plugin", "skills"), {
    withFileTypes: true,
  }).filter((entry) => entry.isDirectory());
  expect(skills.length).toBeGreaterThan(0);
  for (const entry of skills) {
    const text = readFileSync(
      join(root, "plugin", "skills", entry.name, "SKILL.md"),
      "utf8",
    );
    expect(text).toMatch(new RegExp(`^---\\nname: ${entry.name}\\n`));
    // Installed once per machine: scripts are reached through the skill's own
    // directory, never through a path inside the consumer repository.
    expect(text).not.toContain(`.claude/skills/${entry.name}`);
    expect(text).not.toContain("{{");
  }
});

test("setup defaults to the Groundwork repository and rejects unknown flags", () => {
  const previous = process.env.GROUNDWORK_MARKETPLACE;
  delete process.env.GROUNDWORK_MARKETPLACE;
  try {
    expect(parse([])).toEqual({
      check: false,
      source: DEFAULT_SOURCE,
      explicit: false,
      only: null,
    });
    expect(parse(["--check", "--codex", "--source", "/x"])).toEqual({
      check: true,
      source: "/x",
      explicit: true,
      only: "codex",
    });
    expect(() => parse(["--source"])).toThrow("needs a marketplace source");
    expect(() => parse(["--bogus"])).toThrow("unknown argument");
  } finally {
    if (previous !== undefined) process.env.GROUNDWORK_MARKETPLACE = previous;
  }
});

test("setup reads only the user-scope Claude Code install", () => {
  // `claude plugin list --json` lists one entry per scope; a project install
  // made for another directory must neither satisfy nor fail the check.
  const project = {
    id: PLUGIN_ID,
    scope: "project",
    projectPath: "/elsewhere",
    version: "0.1.0",
    enabled: false,
  };
  const user = {
    id: PLUGIN_ID,
    scope: "user",
    version: "0.2.0",
    enabled: true,
  };
  expect(claudeUserInstall([project])).toBeNull();
  expect(claudeUserInstall([project, user])).toEqual({
    version: "0.2.0",
    enabled: true,
  });
  expect(claudeUserInstall({ unexpected: true })).toBeNull();
  expect(
    codexInstall({
      installed: [{ pluginId: PLUGIN_ID, version: "0.2.0", enabled: false }],
    }),
  ).toEqual({ version: "0.2.0", enabled: false });
  expect(codexInstall({ installed: [] })).toBeNull();
});

test("setup recognises where a marketplace is registered from", () => {
  expect(
    claudeMarketplace([
      {
        name: "groundwork",
        source: "git",
        url: "https://github.com/docomply/jig.git",
        ref: "v0.2.0",
      },
    ]),
  ).toEqual({
    location: "https://github.com/docomply/jig.git#v0.2.0",
    git: true,
  });
  expect(
    claudeMarketplace([
      { name: "groundwork", source: "directory", path: "/src/groundwork" },
    ]),
  ).toEqual({ location: "/src/groundwork", git: false });
  expect(
    codexMarketplace({
      marketplaces: [
        {
          name: "groundwork",
          marketplaceSource: { sourceType: "git", source: DEFAULT_SOURCE },
        },
      ],
    }),
  ).toEqual({ location: DEFAULT_SOURCE, git: true });
  expect(codexMarketplace({ marketplaces: [] })).toBeNull();
  expect(sameSource(`${DEFAULT_SOURCE}#v0.2.0`, DEFAULT_SOURCE)).toBe(true);
  // A requested release must not be satisfied by an unpinned registration.
  expect(sameSource(DEFAULT_SOURCE, `${DEFAULT_SOURCE}#v0.2.0`)).toBe(false);
  expect(
    sameSource("https://github.com/docomply/jig", DEFAULT_SOURCE),
  ).toBe(true);
  expect(
    sameSource(`${DEFAULT_SOURCE}#v0.1.0`, `${DEFAULT_SOURCE}#v0.2.0`),
  ).toBe(false);
  expect(sameSource("/src/groundwork", DEFAULT_SOURCE)).toBe(false);
});

/**
 * Run setup.ts against stub `claude`/`codex` commands that log every call and
 * answer the list queries from STUB_* environment JSON.
 */
function runSetup(
  args: string[],
  stub: Record<string, string>,
): { status: number | null; stdout: string; stderr: string; calls: string[] } {
  const bin = mkdtempSync(join(scratch, "stub-bin-"));
  const log = join(bin, "calls.log");
  for (const tool of ["claude", "codex"])
    writeFileSync(
      join(bin, tool),
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2).join(" ");
appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(tool)} + " " + args + "\\n");
const key = ("STUB_${tool}_" + args).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
if (process.env.STUB_SLEEP === args) await Bun.sleep(10_000);
if (process.env[key] !== undefined) console.log(process.env[key]);
`,
      { mode: 0o755 },
    );
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "setup.ts"), ...args],
    {
      env: {
        ...env,
        ...stub,
        GROUNDWORK_MARKETPLACE: "",
        PATH: `${bin}${delimiter}${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin`,
      },
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  const calls = existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n")
    : [];
  return { ...result, calls };
}

const registeredHere = JSON.stringify([
  { name: "groundwork", source: "directory", path: "/src/groundwork" },
]);
const userInstall = JSON.stringify([
  { id: PLUGIN_ID, scope: "user", version: "0.2.0", enabled: true },
]);

test.skipIf(process.platform === "win32")(
  "setup refuses a conflicting source before changing anything",
  () => {
    const result = runSetup(["--claude", "--source", DEFAULT_SOURCE], {
      STUB_CLAUDE_PLUGIN_MARKETPLACE_LIST_JSON: registeredHere,
      STUB_CLAUDE_PLUGIN_LIST_JSON: userInstall,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("is registered from /src/groundwork");
    expect(result.calls).toEqual([
      "claude --version",
      "claude plugin marketplace list --json",
    ]);
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "setup updates the user-scope install and refreshes a Git Codex marketplace",
  () => {
    const result = runSetup([], {
      STUB_CLAUDE_PLUGIN_MARKETPLACE_LIST_JSON: registeredHere,
      STUB_CLAUDE_PLUGIN_LIST_JSON: userInstall,
      STUB_CODEX_PLUGIN_MARKETPLACE_LIST_JSON: JSON.stringify({
        marketplaces: [
          {
            name: "groundwork",
            marketplaceSource: { sourceType: "git", source: DEFAULT_SOURCE },
          },
        ],
      }),
      STUB_CODEX_PLUGIN_LIST_JSON: JSON.stringify({
        installed: [{ pluginId: PLUGIN_ID, version: "0.2.0", enabled: true }],
      }),
    });
    expect(result.status).toBe(0);
    expect(result.calls).toContain(
      "claude plugin update groundwork@groundwork --scope user",
    );
    expect(result.calls).not.toContain(
      "claude plugin update groundwork@groundwork",
    );
    const codex = result.calls.filter((call) =>
      call.startsWith("codex plugin"),
    );
    expect(codex).toEqual([
      "codex plugin marketplace list --json",
      "codex plugin marketplace upgrade groundwork",
      "codex plugin add groundwork@groundwork",
      "codex plugin list --json",
    ]);
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "setup bounds a stalled tool command",
  () => {
    const result = runSetup(["--claude"], {
      STUB_CLAUDE_PLUGIN_MARKETPLACE_LIST_JSON: registeredHere,
      STUB_SLEEP: "plugin marketplace update groundwork",
      GROUNDWORK_SETUP_TIMEOUT_SECONDS: "1",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("did not finish within 1s");
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "setup never skips a tool it could not inspect",
  () => {
    // A stalled version probe is an error, not "not on PATH": --check must
    // not pass for the other tool alone.
    const result = runSetup(["--check"], {
      STUB_SLEEP: "--version",
      GROUNDWORK_SETUP_TIMEOUT_SECONDS: "1",
      STUB_CODEX_PLUGIN_LIST_JSON: JSON.stringify({
        installed: [{ pluginId: PLUGIN_ID, version: "0.2.0", enabled: true }],
      }),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("claude --version did not finish");
    expect(result.stdout).not.toContain("not on PATH");
  },
  30_000,
);

/** A scratch consumer repository holding only its own configuration. */
function consumerRepo(name: string, overlay?: string): string {
  const consumer = join(scratch, name);
  mkdirSync(consumer);
  const git = spawnSync("git", ["init", "-q", consumer], { env });
  expectSpawnExit({ ...git, exitCode: git.status }, 0);
  if (overlay !== undefined) {
    mkdirSync(join(consumer, ".config"));
    writeFileSync(
      join(consumer, ".config", "groundwork-overlay.yaml"),
      overlay,
    );
  }
  return consumer;
}

const overlay = `# Read at run time from the repository the agent works in.
gates:
  command: bun run gates
review:
  bots: ["review-bot[bot]"]
  job_pattern: custom-review-job
  required_checks: [custom-review-job]
  deferral_team: TASK
issue_tracker:
  team: TASK
surfaces: { ignored: true }
`;

test("the configuration step reads the consumer's YAML from any directory in it", () => {
  const consumer = consumerRepo("config", overlay);
  const nested = join(consumer, "src", "deep");
  mkdirSync(nested, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [join(scripts, "consumer-config.ts")],
    { cwd: nested, env, encoding: "utf8" },
  );
  expectSpawnExit({ ...result, exitCode: result.status }, 0);
  expect(result.stdout).toContain(`repository: ${consumer}\n`);
  expect(result.stdout).toContain("gates.command: bun run gates\n");
  expect(result.stdout).toContain("review.job_pattern: custom-review-job\n");
  expect(result.stdout).toContain("review.deferral_team: TASK\n");
});

test("an explicit consumer root and a dangling sibling link are honoured", () => {
  const consumer = consumerRepo("explicit-root", overlay);
  const elsewhere = consumerRepo("elsewhere");
  const result = spawnSync(
    process.execPath,
    [join(scripts, "consumer-config.ts")],
    {
      cwd: elsewhere,
      env: { ...env, GROUNDWORK_CONSUMER_ROOT: consumer },
      encoding: "utf8",
    },
  );
  expectSpawnExit({ ...result, exitCode: result.status }, 0);
  expect(result.stdout).toContain(`repository: ${consumer}\n`);
  // A broken drive-pr link is a broken integration, not an absent sibling:
  // it must be returned so its use fails visibly.
  mkdirSync(join(consumer, ".claude", "skills"), { recursive: true });
  symlinkSync(
    join(consumer, "missing-target"),
    join(consumer, ".claude", "skills", "drive-pr"),
  );
  const probe = join(consumer, "sibling-probe.ts");
  writeFileSync(
    probe,
    `import { siblingSkill } from ${JSON.stringify(join(scripts, "lib/consumer.ts"))}; console.log(siblingSkill("drive-pr", ${JSON.stringify(scripts)}));\n`,
  );
  const sibling = spawnSync(process.execPath, [probe], {
    cwd: consumer,
    env,
    encoding: "utf8",
  });
  expectSpawnExit({ ...sibling, exitCode: sibling.status }, 0);
  expect(sibling.stdout.trim()).toBe(
    join(consumer, ".claude", "skills", "drive-pr"),
  );
  // A dangling ancestor says nothing about the intended sibling either.
  const danglingParent = consumerRepo("dangling-parent", overlay);
  mkdirSync(join(danglingParent, ".claude"));
  symlinkSync(
    join(danglingParent, "moved-skills"),
    join(danglingParent, ".claude", "skills"),
  );
  const viaParent = spawnSync(
    process.execPath,
    [
      "-e",
      `import { siblingSkill } from ${JSON.stringify(join(scripts, "lib/consumer.ts"))}; console.log(siblingSkill("drive-pr", ${JSON.stringify(scripts)}));`,
    ],
    { cwd: danglingParent, env, encoding: "utf8" },
  );
  expectSpawnExit({ ...viaParent, exitCode: viaParent.status }, 0);
  expect(viaParent.stdout.trim()).toBe(
    join(danglingParent, ".claude", "skills", "drive-pr"),
  );
  // A repository without .claude at all is a confirmed absence.
  const plain = consumerRepo("no-claude-dir", overlay);
  const fallback = spawnSync(
    process.execPath,
    [
      "-e",
      `import { siblingSkill } from ${JSON.stringify(join(scripts, "lib/consumer.ts"))}; console.log(siblingSkill("drive-pr", ${JSON.stringify(scripts)}));`,
    ],
    { cwd: plain, env, encoding: "utf8" },
  );
  expectSpawnExit({ ...fallback, exitCode: fallback.status }, 0);
  expect(fallback.stdout.trim()).toBe(
    join(dirname(dirname(scripts)), "drive-pr"),
  );
  // An unreadable skills directory is indeterminate, not absence.
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const locked = consumerRepo("locked-skills", overlay);
    const skills = join(locked, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    chmodSync(skills, 0o000);
    try {
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          `import { siblingSkill } from ${JSON.stringify(join(scripts, "lib/consumer.ts"))}; console.log(siblingSkill("drive-pr", ${JSON.stringify(scripts)}));`,
        ],
        { cwd: locked, env, encoding: "utf8" },
      );
      expectSpawnExit({ ...result, exitCode: result.status }, 0);
      expect(result.stdout.trim()).toBe(join(skills, "drive-pr"));
    } finally {
      chmodSync(skills, 0o755);
    }
  }
});

test("an unconfigured repository is refused, not run with guessed values", () => {
  const consumer = consumerRepo("unconfigured");
  const result = spawnSync(
    process.execPath,
    [join(scripts, "consumer-config.ts")],
    { cwd: consumer, env, encoding: "utf8" },
  );
  expectSpawnExit({ ...result, exitCode: result.status }, 2);
  expect(result.stderr).toContain("Groundwork configuration not found");
  expect(result.stderr).toContain(".config/groundwork-overlay.yaml");
  const partial = consumerRepo("partial", "review:\n  job_pattern: null\n");
  const refused = spawnSync(
    process.execPath,
    [join(scripts, "consumer-config.ts")],
    { cwd: partial, env, encoding: "utf8" },
  );
  expectSpawnExit({ ...refused, exitCode: refused.status }, 2);
  expect(refused.stderr).toContain(
    "lacks required values: gates.command, review.bots, review.deferral_team",
  );
  // Reviewer selection the wait step would refuse is refused up front, with
  // the wait step's own message (one shared validator).
  for (const [name, edit, message] of [
    [
      "uncovered",
      (text: string) =>
        text.replace("  required_checks: [custom-review-job]\n", ""),
      "requires review.required_checks",
    ],
    [
      "blank-pattern",
      (text: string) =>
        text
          .replace("job_pattern: custom-review-job", 'job_pattern: " "')
          .replace("  required_checks: [custom-review-job]\n", ""),
      "requires review.required_checks",
    ],
    [
      "invalid-pattern",
      (text: string) =>
        text.replace("job_pattern: custom-review-job", 'job_pattern: "["'),
      "is not a valid regular expression",
    ],
    [
      "excluded-check",
      (text: string) =>
        text.replace(
          "required_checks: [custom-review-job]",
          "required_checks: [other-check]",
        ),
      "required check 'other-check' is excluded",
    ],
    [
      "blank-bot",
      (text: string) =>
        text.replace('bots: ["review-bot[bot]"]', 'bots: ["  "]'),
      "review.bots must be a list of nonempty reviewer names",
    ],
  ] as const) {
    const repo = consumerRepo(name, edit(overlay));
    const early = spawnSync(
      process.execPath,
      [join(scripts, "consumer-config.ts")],
      { cwd: repo, env, encoding: "utf8" },
    );
    expectSpawnExit({ ...early, exitCode: early.status }, 2);
    expect(early.stderr).toContain(message);
  }
});

test("plugin scripts use consumer policy and the consumer's sibling skill", () => {
  const consumer = consumerRepo("policy", overlay);
  const configDir = join(consumer, ".config");
  cpSync(
    join(
      root,
      "plugin",
      "skills",
      skill,
      "__tests__/fixtures/review-triage.yaml",
    ),
    join(configDir, "review-triage.yaml"),
  );
  // A consumer sibling provides its CLI; the plugin deliberately lacks it.
  const driver = join(consumer, ".claude/skills/drive-pr/scripts");
  mkdirSync(driver, { recursive: true });
  writeFileSync(join(driver, "drive-state.ts"), "console.log('7');\n");
  writeFileSync(
    join(driver, "assert-post-allowed.ts"),
    "console.error('consumer fence'); process.exitCode = 11;\n",
  );
  // The reply's liveness read runs before the consumer fence, so it needs an
  // open PR to reach the fence this test asserts on.
  const bin = join(consumer, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bun
const id = process.argv.find(arg => arg.startsWith("threadId="))?.slice(9);
console.log(JSON.stringify({ data: { node: { __typename: "PullRequestReviewThread", id, pullRequest: { number: 42, state: "OPEN" } } } }));
`,
    { mode: 0o755 },
  );
  const childEnv = { ...env, PATH: `${bin}${delimiter}${process.env.PATH}` };
  const round = spawnSync(
    process.execPath,
    [join(scripts, "current-round.ts"), "42"],
    { cwd: consumer, env: childEnv, encoding: "utf8" },
  );
  expectSpawnExit({ ...round, exitCode: round.status }, 0);
  expect(round.stdout.trim()).toBe("7");
  const ghBin = join(consumer, "stub-bin");
  mkdirSync(ghBin);
  writeFileSync(
    join(ghBin, "gh"),
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'checks') console.log('[]');
else if (args[0] === 'api') console.log('HTTP/2.0 200 OK\\r\\n\\r\\n' + JSON.stringify({state:'open',head:{sha:'a'.repeat(40)}}));
else process.exitCode = 1;
`,
  );
  chmodSync(join(ghBin, "gh"), 0o755);
  if (process.platform !== "win32") {
    // The required check comes from the consumer's YAML configuration.
    const requiredAwait = spawnSync(
      process.execPath,
      [
        join(scripts, "await-round.ts"),
        "42",
        "--once",
        "--no-ci",
        "--no-count",
      ],
      {
        cwd: consumer,
        env: { ...childEnv, PATH: `${ghBin}${delimiter}${childEnv.PATH}` },
        encoding: "utf8",
      },
    );
    expectSpawnExit({ ...requiredAwait, exitCode: requiredAwait.status }, 4);
    expect(requiredAwait.stderr).toContain(
      "required reviewer coverage is incomplete",
    );
  }
  const invalidAwait = spawnSync(
    process.execPath,
    [join(scripts, "await-round.ts"), "--invalid-flag"],
    { cwd: consumer, env: childEnv, encoding: "utf8", input: "" },
  );
  expectSpawnExit({ ...invalidAwait, exitCode: invalidAwait.status }, 2);
  expect(invalidAwait.stderr).toContain("unknown flag: --invalid-flag");
  // The stub gh above is a shebang script, which Windows cannot execute, so
  // the liveness read ahead of the fence is only reachable on POSIX.
  if (process.platform !== "win32") {
    const post = spawnSync(
      process.execPath,
      [join(scripts, "reply-to-thread.ts"), "PRRT_test"],
      {
        cwd: consumer,
        env: { ...childEnv, DRIVE_PR_TARGET: "42" },
        encoding: "utf8",
        input: "**accepted** Added the guard.\n",
      },
    );
    expectSpawnExit({ ...post, exitCode: post.status }, 11);
    expect(post.stderr).toContain("consumer fence");
  }
  const probe = join(consumer, "probe.ts");
  writeFileSync(
    probe,
    `import { defaultConfigPath, loadLadder } from ${JSON.stringify(join(scripts, "lib/ladder.ts"))}; const loaded = await loadLadder(defaultConfigPath()); console.log(JSON.stringify({path: defaultConfigPath(), valid: loaded.config !== null, anomaly: loaded.anomaly}));\n`,
  );
  const ladder = spawnSync(process.execPath, ["--no-install", probe], {
    cwd: consumer,
    env: childEnv,
    encoding: "utf8",
  });
  expectSpawnExit({ ...ladder, exitCode: ladder.status }, 0);
  expect(JSON.parse(ladder.stdout)).toEqual({
    path: join(configDir, "review-triage.yaml"),
    valid: true,
    anomaly: "",
  });
  // The vendored parser keeps js-yaml's refusal of duplicated keys.
  const configPath = join(configDir, "review-triage.yaml");
  writeFileSync(
    configPath,
    `${readFileSync(configPath, "utf8")}\nversion: 1\n`,
  );
  const duplicate = spawnSync(process.execPath, ["--no-install", probe], {
    cwd: consumer,
    env: childEnv,
    encoding: "utf8",
  });
  expectSpawnExit({ ...duplicate, exitCode: duplicate.status }, 0);
  const rejected = JSON.parse(duplicate.stdout);
  expect(rejected.valid).toBe(false);
  expect(rejected.anomaly).toContain("duplicated mapping key");
});

test("the plugin carries no dependency outside its own directory", () => {
  // Nothing above the copied plugin provides node_modules, so a script that
  // still imported a package would have failed in the tests above; keep the
  // premise itself checked.
  let dir = dirname(scripts);
  for (;;) {
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
});

test.skipIf(process.platform === "win32")(
  "plugin thread writers check pull request liveness before every write",
  () => {
    const consumer = consumerRepo("liveness", overlay);
    const bin = join(consumer, "bin");
    mkdirSync(bin);
    const log = join(consumer, "gh.log");
    writeFileSync(
      join(bin, "gh"),
      `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const query = args.find(arg => arg.startsWith("query=")) ?? "";
if (query.includes("node(id:$threadId)")) {
  appendFileSync(process.env.TEST_GH_LOG!, "read\\n");
  if (process.env.TEST_PR_STATE === "unreadable") process.exit(1);
  const id = args.find(arg => arg.startsWith("threadId="))?.slice(9);
  console.log(JSON.stringify({ data: { node: { __typename: "PullRequestReviewThread", id, pullRequest: { number: 42, state: process.env.TEST_PR_STATE } } } }));
} else {
  if (args.includes("--input")) readFileSync(0);
  appendFileSync(process.env.TEST_GH_LOG!, "write\\n");
  console.log("true");
}
`,
      { mode: 0o755 },
    );
    const childEnv: Record<string, string | undefined> = {
      ...env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      TEST_GH_LOG: log,
    };
    delete childEnv.DRIVE_PR_TARGET;
    for (const script of [
      "reply-to-thread.ts",
      "resolve-thread.ts",
      "unresolve-thread.ts",
    ]) {
      for (const state of ["OPEN", "MERGED", "CLOSED", "unreadable"]) {
        writeFileSync(log, "");
        const result = spawnSync(
          process.execPath,
          [join(scripts, script), "PRRT_plugin"],
          {
            cwd: consumer,
            env: { ...childEnv, TEST_PR_STATE: state },
            encoding: "utf8",
            input: "**accepted** Added the guard.\n",
            timeout: 5000,
          },
        );
        expectSpawnExit(
          { ...result, exitCode: result.status },
          state === "OPEN" ? 0 : state === "unreadable" ? 1 : 5,
        );
        expect(readFileSync(log, "utf8")).toBe(
          state === "OPEN" ? "read\nwrite\n" : "read\n",
        );
      }
    }
  },
  30_000,
);

test("the vendored YAML parser is the pinned js-yaml build", () => {
  // The plugin cache has no node_modules, so the skill ships js-yaml's own
  // ESM build. When the dependency is updated, refresh the copy with:
  //   cp node_modules/js-yaml/dist/js-yaml.mjs plugin/skills/resolve-review-comments/scripts/lib/vendor/
  const vendored = join(
    root,
    "plugin",
    "skills",
    skill,
    "scripts/lib/vendor/js-yaml.mjs",
  );
  const pinned = join(root, "node_modules/js-yaml/dist/js-yaml.mjs");
  expect(readFileSync(vendored, "utf8")).toBe(readFileSync(pinned, "utf8"));
});

test("plugin cancellation registrations release only their own ownership", () => {
  const probe = join(scratch, "ownership-probe.ts");
  writeFileSync(
    probe,
    `
import { registerCancellationGroup } from ${JSON.stringify(join(scripts, "lib/proc.ts"))};
const signals: number[] = [];
process.kill = ((pid: number) => { signals.push(pid); return true; }) as typeof process.kill;
process.on("SIGTERM", () => {});
const first = registerCancellationGroup(777);
const second = registerCancellationGroup(777);
first();
process.emit("SIGTERM");
if (signals.join(",") !== "-777,-777") throw Error("one release removed another owner");
second();
signals.length = 0;
process.emit("SIGTERM");
if (signals.length) throw Error("released ownership remained");
const third = registerCancellationGroup(777);
first(); second();
process.emit("SIGTERM");
if (signals.join(",") !== "-777,-777") throw Error("stale release removed new ownership");
third();
console.log("owned");
`,
  );
  const child = spawnSync(process.execPath, [probe], {
    env,
    encoding: "utf8",
    timeout: 5000,
  });
  expectSpawnExit({ ...child, exitCode: child.status }, 0);
  expect(child.stdout.trim()).toBe("owned");
});
