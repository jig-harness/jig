import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  environmentLayer,
  fieldInMessage,
  formatField,
  layerOf,
  loadLayeredConfig,
  MAX_CONFIG_VALUES,
  mergeLayers,
  parseField,
  sourceOf,
} from "../config-layers.ts";
import { trackerConfig } from "../../skills/do-item/scripts/lib/tracker/config.ts";
import {
  configSource,
  readConfig,
  readOverlay,
  withSource,
} from "../consumer.ts";

const SAVED = {
  home: process.env.JIG_HOME,
  overlay: process.env.JIG_OVERLAY,
  root: process.env.JIG_CONSUMER_ROOT,
};
let dir = "";
let home = "";
let repo = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "config-layers-"));
  home = join(dir, "home");
  repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(join(repo, ".config"), { recursive: true });
  mkdirSync(join(repo, ".git"));
  process.env.JIG_HOME = home;
  process.env.JIG_CONSUMER_ROOT = repo;
  delete process.env.JIG_OVERLAY;
});

afterEach(() => {
  for (const [name, value] of [
    ["JIG_HOME", SAVED.home],
    ["JIG_OVERLAY", SAVED.overlay],
    ["JIG_CONSUMER_ROOT", SAVED.root],
  ] as const)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  for (const name of Object.keys(process.env))
    if (name.startsWith("JIG__")) delete process.env[name];
  rmSync(dir, { recursive: true, force: true });
});

const user = (text: string) => writeFileSync(join(home, "jig.yaml"), text);
const repository = (text: string) =>
  writeFileSync(join(repo, ".config", "jig.yaml"), text);

test("mappings merge key by key; lists and text replace whole", () => {
  expect(
    mergeLayers(
      { review: { bots: ["a"], sticky_marker: "x" }, gates: { command: "a" } },
      { review: { bots: ["b", "c"] }, drive: { reviews_drafts: false } },
    ),
  ).toEqual({
    review: { bots: ["b", "c"], sticky_marker: "x" },
    gates: { command: "a" },
    drive: { reviews_drafts: false },
  });
});

test("the repository overrides the user, and the environment overrides both", () => {
  user("review:\n  bots: [user-bot]\n  sticky_marker: user\n");
  repository("review:\n  bots: [repo-bot]\n");
  process.env.JIG__REVIEW__STICKY_MARKER = "run";
  const config = loadLayeredConfig(repo);
  expect(config.layers.map((l) => l.name)).toEqual([
    "user",
    "repository",
    "environment",
  ]);
  expect(config.values).toEqual({
    review: { bots: ["repo-bot"], sticky_marker: "run" },
  });
  expect(layerOf(config, "review.bots")?.name).toBe("repository");
  expect(sourceOf(config, "review.bots")).toBe(
    join(repo, ".config", "jig.yaml"),
  );
  expect(sourceOf(config, "review.sticky_marker")).toBe(
    "$JIG__REVIEW__STICKY_MARKER",
  );
});

test("supplied repository text replaces the repository file, null meaning it is absent", () => {
  user("review:\n  bots: [user-bot]\n");
  repository("review:\n  bots: [repo-bot]\n");
  const supplied = loadLayeredConfig(
    repo,
    process.env,
    "review:\n  repo_label: supplied\n",
  );
  expect(supplied.values).toEqual({
    review: { bots: ["user-bot"], repo_label: "supplied" },
  });
  expect(supplied.hasRepository).toBe(true);
  const absent = loadLayeredConfig(repo, process.env, null);
  expect(absent.values).toEqual({ review: { bots: ["user-bot"] } });
  expect(absent.hasRepository).toBe(false);
  expect(() => loadLayeredConfig(repo, process.env, "- a\n")).toThrow(
    `Jig configuration must be a mapping: ${join(repo, ".config", "jig.yaml")}`,
  );
});

test("a user layer alone configures a repository without its own file", () => {
  user("drive:\n  reviews_drafts: false\n");
  expect(readConfig()).toEqual({ drive: { reviews_drafts: false } });
  expect(configSource("drive.reviews_drafts")).toBe(join(home, "jig.yaml"));
});

test("a user layer does not make a repository look adopted", () => {
  user("review:\n  bots: [user-bot]\n");
  expect(readOverlay).toThrow("Jig configuration not found");
  repository("gates:\n  command: bun run gates\n");
  expect(readOverlay()).toEqual({
    review: { bots: ["user-bot"] },
    gates: { command: "bun run gates" },
  });
});

for (const field of [
  "gates:\n  command: make check",
  "repository:\n  base_branch: develop",
  "issue_tracker:\n  team: ENG",
  "ci:\n  required_checks: [build]",
  "changelog:\n  file: CHANGELOG.md",
  "changelog:\n  release:\n    push: direct",
])
  test(`the user layer refuses a repository's own field: ${field.split(":")[0]}`, () => {
    user(`${field}\n`);
    expect(() => loadLayeredConfig(repo)).toThrow("describes one repository");
  });

test("the environment may override a repository's own field for one run", () => {
  repository("repository:\n  base_branch: main\n");
  process.env.JIG__REPOSITORY__BASE_BRANCH = "develop";
  expect(readConfig()).toEqual({ repository: { base_branch: "develop" } });
});

test("JIG_HOME moves the user layer; a missing one is no layer", () => {
  process.env.JIG_HOME = join(dir, "absent");
  expect(loadLayeredConfig(repo).layers).toEqual([]);
});

test("an unparseable user file is an error naming it", () => {
  user("review: [unclosed\n");
  expect(() => loadLayeredConfig(repo)).toThrow(join(home, "jig.yaml"));
});

test("JIG_OVERLAY replaces the repository layer, not the user layer", () => {
  user("drive:\n  reviews_drafts: true\n");
  const other = join(dir, "other.yaml");
  writeFileSync(other, "drive:\n  load_guard_command: wait\n");
  process.env.JIG_OVERLAY = other;
  repository("drive:\n  reviews_drafts: false\n");
  expect(readOverlay()).toEqual({
    drive: { reviews_drafts: true, load_guard_command: "wait" },
  });
});

test("environment values: YAML scalars and flow collections are typed, the rest is text", () => {
  const layer = environmentLayer({
    JIG__DRIVE__REVIEWS_DRAFTS: "false",
    JIG__PULL_REQUESTS__SIZE_BUDGET: "400",
    JIG__REVIEW__BOTS: '["a[bot]", b]',
    JIG__GATES__COMMAND: "bun run gates: all",
    JIG__DRIVE__LOAD_GUARD_COMMAND: "",
  });
  expect(layer?.values).toEqual({
    drive: { reviews_drafts: false },
    pull_requests: { size_budget: 400 },
    review: { bots: ["a[bot]", "b"] },
    gates: { command: "bun run gates: all" },
  });
});

test("no nonempty variable is no environment layer", () => {
  expect(environmentLayer({ JIG__X: " ", PATH: "/bin" })).toBeNull();
});

test("an environment variable cannot both hold a value and fields", () => {
  expect(() =>
    environmentLayer({ JIG__DRIVE: "x", JIG__DRIVE__REVIEWS_DRAFTS: "true" }),
  ).toThrow("JIG__DRIVE__REVIEWS_DRAFTS");
});

test("an environment variable with an empty level is refused", () => {
  expect(() => environmentLayer({ JIG__DRIVE____X: "1" })).toThrow(
    "two underscores",
  );
});

test("an unparseable flow value names its variable", () => {
  expect(() => environmentLayer({ JIG__REVIEW__BOTS: "[a, b" })).toThrow(
    "JIG__REVIEW__BOTS",
  );
});

const JIG_CONFIG = join(
  import.meta.dirname,
  "..",
  "..",
  "skills",
  "resolve-review-comments",
  "scripts",
  "jig-config.ts",
);

function jigConfig(...args: string[]) {
  const run = Bun.spawnSync(["bun", JIG_CONFIG, ...args], {
    cwd: repo,
    env: { ...process.env },
  });
  return {
    code: run.exitCode,
    out: run.stdout.toString(),
    err: run.stderr.toString(),
  };
}

test("jig-config names the layer that set each field", () => {
  user("review:\n  sticky_marker: mine\n");
  repository("review:\n  bots: [repo-bot]\n");
  process.env.JIG__DRIVE__REVIEWS_DRAFTS = "false";
  const run = jigConfig("--json");
  expect(run.code).toBe(0);
  expect(JSON.parse(run.out)).toEqual({
    "review.sticky_marker": {
      value: "mine",
      layer: "user",
      source: join(home, "jig.yaml"),
    },
    "review.bots": {
      value: ["repo-bot"],
      layer: "repository",
      source: join(repo, ".config", "jig.yaml"),
    },
    "drive.reviews_drafts": {
      value: false,
      layer: "environment",
      source: "$JIG__DRIVE__REVIEWS_DRAFTS",
    },
  });
  const text = jigConfig("review.bots");
  expect(text.out).toContain(
    `review.bots = ["repo-bot"]  (${join(repo, ".config", "jig.yaml")})`,
  );
  expect(text.out).not.toContain("sticky_marker");
});

test("jig-config refuses a field no layer sets", () => {
  repository("{}\n");
  const run = jigConfig("review.bots");
  expect(run.code).toBe(2);
  expect(run.err).toContain("review.bots is not set in any layer");
});

test("a quoted environment value is the text inside the quotes", () => {
  const layer = environmentLayer({
    JIG__GATES__COMMAND: '"true"',
    JIG__REPOSITORY__BASE_BRANCH: "'1.10'",
  });
  expect(layer?.values).toEqual({
    gates: { command: "true" },
    repository: { base_branch: "1.10" },
  });
});

test("a value that is not valid YAML asks for quotes", () => {
  expect(() =>
    environmentLayer({ JIG__GATES__COMMAND: "[ -x ./gates ] && ./gates" }),
  ).toThrow("quote the value to keep it text");
});

test("an environment variable cannot set a field inside a mapping another sets", () => {
  expect(() =>
    environmentLayer({
      JIG__DRIVE: "{reviews_drafts: false}",
      JIG__DRIVE__REVIEWS_DRAFTS: "true",
    }),
  ).toThrow("JIG__DRIVE__REVIEWS_DRAFTS and JIG__DRIVE both set drive");
});

test("two variables for one field in different letter case are refused", () => {
  expect(() =>
    environmentLayer({ JIG__GATES__COMMAND: "a", JIG__gates__command: "b" }),
  ).toThrow("both set gates.command");
});

test("environment numbers take YAML's decimal forms", () => {
  const layer = environmentLayer({
    JIG__A__EXP: "1e3",
    JIG__A__PLUS: "+400",
    JIG__A__LEADING_DOT: ".5",
    JIG__A__NEGATIVE: "-0.5",
    JIG__A__TRAILING_DOT: "2.",
  });
  expect(layer?.values).toEqual({
    a: {
      exp: 1000,
      plus: 400,
      leading_dot: 0.5,
      negative: -0.5,
      trailing_dot: 2,
    },
  });
});

test("a __proto__ key is refused in a file and in a variable", () => {
  user('__proto__:\n  gates:\n    command: "true"\n');
  expect(() => loadLayeredConfig(repo)).toThrow(
    "__proto__ is not a configuration field",
  );
  user("do_item:\n  agents:\n    labels:\n      __proto__: x\n");
  expect(() => loadLayeredConfig(repo)).toThrow(
    "do_item.agents.labels.__proto__",
  );
  expect(() =>
    environmentLayer({ JIG__DRIVE: '{"__proto__": {x: 1}}' }),
  ).toThrow("JIG__DRIVE");
});

test("a value that contains itself is refused; a shared one is not", () => {
  repository("extra: &cycle\n  self: *cycle\n");
  expect(() => loadLayeredConfig(repo)).toThrow(
    "must not contain itself: extra.self",
  );
  repository("a: &shared {k: v}\nb: *shared\n");
  expect(loadLayeredConfig(repo).values).toEqual({
    a: { k: "v" },
    b: { k: "v" },
  });
});

test("a timestamp is a value, not a mapping, at the root and in a section", () => {
  user("drive:\n  reviews_drafts: true\n");
  repository("drive: 2026-10-12\n");
  const merged = loadLayeredConfig(repo).values;
  expect(merged.drive).toBeInstanceOf(Date);
  repository("2026-10-12\n");
  expect(() => loadLayeredConfig(repo)).toThrow(
    "Jig configuration must be a mapping",
  );
});

test("a configuration whose aliases expand past the bound is refused", () => {
  // Each anchor repeats the one before twice: 2^30 values from 30 lines.
  const lines = ["a0: &a0 [x, x]"];
  for (let i = 1; i <= 30; i++)
    lines.push(`a${i}: &a${i} [*a${i - 1}, *a${i - 1}]`);
  repository(`${lines.join("\n")}\n`);
  const started = Date.now();
  expect(() => loadLayeredConfig(repo)).toThrow(
    `more than ${MAX_CONFIG_VALUES} values`,
  );
  expect(Date.now() - started).toBeLessThan(5000);
});

test("the environment variables are bounded together, not only one by one", () => {
  const half = `[${Array.from({ length: 6000 }, () => "x").join(", ")}]`;
  const env = { JIG__A__LIST: half, JIG__B__LIST: half };
  expect(() => environmentLayer({ JIG__A__LIST: half })).not.toThrow();
  expect(() => environmentLayer(env)).toThrow(
    `more than ${MAX_CONFIG_VALUES} values with its aliases expanded: the JIG__* environment variables together`,
  );
});

test("a tracker setting's error names the variable or file that set it", () => {
  repository("issue_tracker:\n  team: ENG\n");
  process.env.JIG__ISSUE_TRACKER__LABELS__BUG = "oops";
  expect(() => trackerConfig()).toThrow("$JIG__ISSUE_TRACKER__LABELS__BUG");
  delete process.env.JIG__ISSUE_TRACKER__LABELS__BUG;
  repository("issue_tracker:\n  team: ENG\nreview:\n  taxonomy: []\n");
  expect(() => trackerConfig()).toThrow(
    `review.taxonomy must be an object: ${join(repo, ".config", "jig.yaml")}`,
  );
});

test("JIG_USER_LAYER=off leaves the user layer out", () => {
  user("decide:\n  policy_files: [MINE.md]\n");
  repository("review:\n  bots: [b]\n");
  const off = loadLayeredConfig(repo, {
    ...process.env,
    JIG_USER_LAYER: "off",
  });
  expect(off.layers.map((layer) => layer.name)).toEqual(["repository"]);
  expect(off.values).toEqual({ review: { bots: ["b"] } });
  expect(() =>
    loadLayeredConfig(repo, { ...process.env, JIG_USER_LAYER: "no" }),
  ).toThrow("JIG_USER_LAYER must be off or unset");
});

test("field paths round-trip keys that hold dots", () => {
  const path = ["do_item", "agents", "title_keywords", "node.js"];
  expect(formatField(path)).toBe('do_item.agents.title_keywords."node.js"');
  expect(parseField(formatField(path))).toEqual(path);
  expect(parseField("a.b")).toEqual(["a", "b"]);
});

test("jig-config reports a key that holds a dot as one field", () => {
  repository(
    'do_item:\n  agents:\n    title_keywords:\n      "node.js": backend-dev\n',
  );
  const run = jigConfig("--json");
  expect(run.code).toBe(0);
  expect(JSON.parse(run.out)).toEqual({
    'do_item.agents.title_keywords."node.js"': {
      value: "backend-dev",
      layer: "repository",
      source: join(repo, ".config", "jig.yaml"),
    },
  });
  const one = jigConfig('do_item.agents.title_keywords."node.js"');
  expect(one.code).toBe(0);
  expect(one.out).toContain('"node.js" = "backend-dev"');
});

test("a validation error names the layer that set the failing field", () => {
  user("pull_requests:\n  size_budget: lots\n");
  process.env.JIG__PULL_REQUESTS__OPEN_AS = "draft";
  const values = readConfig();
  const error = withSource(
    values,
    "pull_requests",
    new Error("pull_requests.size_budget must be a positive integer"),
  );
  expect(error.message).toBe(
    `pull_requests.size_budget must be a positive integer: ${join(home, "jig.yaml")}`,
  );
  expect(
    fieldInMessage("decide.policy_files[2] must be a path", "decide"),
  ).toBe("decide.policy_files");
  expect(fieldInMessage("something else", "decide")).toBe("decide");
  expect(
    fieldInMessage("review.taxonomy must be an object", [
      "issue_tracker",
      "review",
    ]),
  ).toBe("review.taxonomy");
  expect(fieldInMessage("something else", ["issue_tracker", "review"])).toBe(
    "issue_tracker",
  );
});

test("a list position inside a quoted key stays part of the key", () => {
  user('do_item:\n  agents:\n    labels:\n      "ui[0]": ""\n');
  repository("do_item:\n  agents:\n    labels:\n      ui: x\n");
  const values = readConfig();
  const message = `do_item.agents.labels.${formatField(["ui[0]"])} must be a nonempty string`;
  expect(fieldInMessage(message, "do_item")).toBe(
    'do_item.agents.labels."ui[0]"',
  );
  expect(withSource(values, "do_item", new Error(message)).message).toBe(
    `${message}: ${join(home, "jig.yaml")}`,
  );
});

test("an error at a key a plain field cannot hold names the layer that set it", () => {
  user(
    'do_item:\n  agents:\n    labels:\n      "ui-bug": ""\n      "node.js": ""\n      "good first issue": ""\n',
  );
  repository("review:\n  bots: [b]\n");
  const values = readConfig();
  for (const key of ["ui-bug", "node.js", "good first issue"]) {
    const message = `do_item.agents.labels.${formatField([key])} must be a nonempty string`;
    expect(withSource(values, "do_item", new Error(message)).message).toBe(
      `${message}: ${join(home, "jig.yaml")}`,
    );
  }
  expect(
    fieldInMessage('do_item.agents.labels."node.js" must be', "do_item"),
  ).toBe('do_item.agents.labels."node.js"');
  // Written without quotes, the path reads short; the deepest set part of it
  // still names the user's file.
  expect(
    withSource(
      values,
      "do_item",
      new Error(
        "do_item.agents.labels.good first issue must be a nonempty string",
      ),
    ).message,
  ).toEndWith(join(home, "jig.yaml"));
});
