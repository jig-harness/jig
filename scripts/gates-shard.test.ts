import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  heavyStages,
  POSIX_ONLY_SUITES,
  runStages,
  separateSuitesOf,
  shardArgs,
  shellWord,
  SKIP_SEPARATE_ENV,
  skippedSuites,
  TEST_PATHS_ENV,
  TEST_SHARD_ENV,
  testArgs,
  testPaths,
  testStage,
} from "./gates.ts";

const root = join(import.meta.dir, "..");

test("the directories the environment names confine the test stage, after its shard", () => {
  expect(testPaths({})).toEqual([]);
  expect(testPaths({ [TEST_PATHS_ENV]: " " })).toEqual([]);
  expect(
    testPaths({ [TEST_PATHS_ENV]: "./plugin/skills/explain/ ./scripts/" }),
  ).toEqual(["./plugin/skills/explain/", "./scripts/"]);
  for (const bad of [
    "scripts/",
    "./scripts",
    "./../x/",
    "./a/ --bail",
    "./a/;b/",
  ])
    expect(() => testPaths({ [TEST_PATHS_ENV]: bad })).toThrow(TEST_PATHS_ENV);
  expect(
    testStage(
      ["suite/**"],
      () => [],
      () => [
        ...shardArgs({ [TEST_SHARD_ENV]: "1/2" }),
        ...testPaths({ [TEST_PATHS_ENV]: "./scripts/" }),
      ],
    ),
  ).toMatchObject({
    command: [
      "run",
      "test",
      "--path-ignore-patterns=suite/**",
      "--shard=1/2",
      "./scripts/",
    ],
  });
});

test("a shard the environment names is the test stage's last argument", () => {
  expect(shardArgs({})).toEqual([]);
  expect(shardArgs({ [TEST_SHARD_ENV]: "" })).toEqual([]);
  expect(shardArgs({ [TEST_SHARD_ENV]: "2/4" })).toEqual(["--shard=2/4"]);
  expect(testArgs([], [], ["--shard=1/2"])).toEqual([
    "run",
    "test",
    "--shard=1/2",
  ]);
  expect(testArgs(["suite/**"], ["**/fixtures/**"], ["--shard=1/2"])).toEqual([
    "run",
    "test",
    "--path-ignore-patterns=**/fixtures/**",
    "--path-ignore-patterns=suite/**",
    "--shard=1/2",
  ]);
  expect(
    testStage(
      ["suite/**"],
      () => ["**/fixtures/**"],
      () => shardArgs({ [TEST_SHARD_ENV]: "3/4" }),
    ),
  ).toMatchObject({
    command: [
      "run",
      "test",
      "--path-ignore-patterns=**/fixtures/**",
      "--path-ignore-patterns=suite/**",
      "--shard=3/4",
    ],
  });
});

test("a malformed shard makes the test stage could not check", async () => {
  for (const bad of ["0/4", "5/4", "2", "2/4/1", "a/b", " 2/4"])
    expect(() => shardArgs({ [TEST_SHARD_ENV]: bad })).toThrow(TEST_SHARD_ENV);
  const malformed = testStage(
    [],
    () => [],
    () => shardArgs({ [TEST_SHARD_ENV]: "9/4" }),
  );
  expect(malformed).toMatchObject({ name: "bun run test" });
  const [outcome] = await runStages([malformed], root);
  expect(outcome?.status).toBe(2);
});

test("the test step leaves out POSIX-only suites on Windows and separate suites on request", () => {
  const SEPARATE_SUITES = separateSuitesOf(root);
  const separate = () => SEPARATE_SUITES;
  // The catalog is read only when the environment asks to skip its suites.
  expect(
    skippedSuites("linux", {}, () => {
      throw new Error("read");
    }),
  ).toEqual([]);
  expect(
    skippedSuites("darwin", { [SKIP_SEPARATE_ENV]: "1" }, separate),
  ).toEqual(SEPARATE_SUITES);
  const windows = skippedSuites(
    "win32",
    { [SKIP_SEPARATE_ENV]: "1" },
    separate,
  );
  for (const suite of [...POSIX_ONLY_SUITES, ...SEPARATE_SUITES])
    expect(windows).toContain(suite);
  expect(testArgs([], ["**/fixtures/**"])).toEqual(["run", "test"]);
  // Bun replaces the configured ignore list, so it must be passed along.
  expect(testArgs(["suite/**"], ["**/fixtures/**"])).toEqual([
    "run",
    "test",
    "--path-ignore-patterns=**/fixtures/**",
    "--path-ignore-patterns=suite/**",
  ]);
});

test.skipIf(process.platform === "win32")(
  "a stage's name is a command a shell runs as it is",
  () => {
    expect(shellWord("run")).toBe("run");
    expect(shellWord("--path-ignore-patterns=**/fixtures/**")).toBe(
      "'--path-ignore-patterns=**/fixtures/**'",
    );
    expect(shellWord("it's")).toBe(`'it'\\''s'`);
    // The test stage's name, pasted into a shell, hands bun the same arguments.
    const args = [
      "run",
      "test",
      "--path-ignore-patterns=**/fixtures/**",
      "--path-ignore-patterns=a b",
    ];
    const stage = heavyStages(
      testStage(["a b"], () => ["**/fixtures/**"]),
    ).find((s) => s.name.startsWith("bun run test "));
    if (stage === undefined) throw new Error("no test stage");
    const echoed = Bun.spawnSync(
      [
        "sh",
        "-c",
        `set -- ${stage.name.replace(/^bun /, "")}; printf '%s\\n' "$@"`,
      ],
      { cwd: root, stdout: "pipe" },
    );
    expect(echoed.stdout.toString().trimEnd().split("\n")).toEqual(args);
  },
);
