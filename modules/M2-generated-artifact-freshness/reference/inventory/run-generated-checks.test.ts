import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  entryProblems,
  generatedListProblems,
  outcomeOf,
  parseInventory,
} from "./run-generated-checks.ts";

const runner = join(import.meta.dir, "run-generated-checks.ts"),
  fixtures = join(import.meta.dir, "fixtures");

/** The runner spawned in a fixture directory, which is the repository root the commands run from. */
function run(fixture: string, args: string[]) {
  const result = Bun.spawnSync([process.execPath, runner, ...args], {
    cwd: join(fixtures, fixture),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
const inventory = (fixture: string, file = "generated-files.yaml") =>
  run(fixture, [file]);

const cases: [string, number][] = [
  ["fresh", 0],
  ["shared-check", 0],
  ["stale", 1],
  ["missing-output", 1],
  ["source-matches-nothing", 1],
  ["duplicate-output", 1],
  ["cannot-start", 2],
  ["undecided", 2],
  ["mixed", 2],
  ["malformed", 2],
  ["unknown-field", 2],
  ["empty", 2],
  ["not-yaml", 2],
  ["no-form", 2],
];
for (const [fixture, code] of cases)
  test(`${fixture} exits ${code}`, () =>
    expectSpawnExit(inventory(fixture), code));

for (const [fixture, code] of [
  ["catalog", 0],
  ["catalog-output-outside-paths", 1],
  ["catalog-nothing-declared", 2],
] as const)
  test(`a catalog form: ${fixture} exits ${code}`, () =>
    expectSpawnExit(run(fixture, ["catalog.yaml"]), code));

test("a pass names the checks, outputs and entries it covered", () => {
  const result = inventory("fresh");
  expectSpawnExit(result, 0);
  expect(result.stdout).toContain(
    "generated-files: OK — 2 check(s) passed for 2 declared output(s) in 2 entries",
  );
  expect(result.stdout).toContain("checking summary");
});

test("a shared check command runs once for every entry that declares it", () => {
  const result = inventory("shared-check");
  expectSpawnExit(result, 0);
  expect(result.stdout).toContain("[1/1] exit 0");
  expect(result.stdout).toContain(
    "1 check(s) passed for 2 declared output(s) in 2 entries",
  );
});

test("a stale output is a finding whose fix is the entry's regenerate command", () => {
  const result = inventory("stale");
  expectSpawnExit(result, 1);
  expect(result.stderr).toContain(
    "out/report.txt: [generated-files] stale: `exit 1` exited 1",
  );
  expect(result.stderr).toContain(
    "fix: run `echo regenerate report` and commit the result",
  );
  expect(result.stdout).toContain("stale (exit 1)");
});

test("every check runs and is reported, whatever the earlier ones did", () => {
  const result = inventory("mixed");
  expectSpawnExit(result, 2);
  expect(result.stdout).toContain("first check");
  expect(result.stdout).toContain("second check");
  expect(result.stdout).toContain("[1/3]");
  expect(result.stdout).toContain("[3/3] no-such-command-for-this-fixture");
  // The stale output is still reported beside the check that could not start.
  expect(result.stderr).toContain("stale: `echo first check && exit 1`");
  expect(result.stderr).toContain(
    "generated-files: could not check: 1 of 3 check(s) could not decide",
  );
  expect(result.stderr).toContain("could not start");
});

test("a check the shell cannot start is told apart from a stale output", () => {
  const result = inventory("cannot-start");
  expectSpawnExit(result, 2);
  expect(result.stdout).toContain("could not start");
  expect(result.stderr).not.toContain("stale:");
  const undecided = inventory("undecided");
  expectSpawnExit(undecided, 2);
  expect(undecided.stdout).toContain("could not decide (exit 2)");
});

test("the inventory's own findings name the inventory file and the entry", () => {
  const missing = inventory("missing-output");
  expectSpawnExit(missing, 1);
  expect(missing.stderr).toContain(
    "generated-files.yaml: [generated-files] generated[0]: output `out/gone.txt` is not a file",
  );
  const nothing = inventory("source-matches-nothing");
  expectSpawnExit(nothing, 1);
  expect(nothing.stderr).toContain(
    "generated[0]: source `src/*.json` matches no repository file",
  );
  const twice = inventory("duplicate-output");
  expectSpawnExit(twice, 1);
  expect(twice.stderr).toContain(
    "generated[1]: output `out/report.txt` is already declared by generated[0]",
  );
  const outside = run("catalog-output-outside-paths", ["catalog.yaml"]);
  expectSpawnExit(outside, 1);
  expect(outside.stderr).toContain(
    "areas.docs.generated[0]: output `docs/INDEX.md` is matched by none of its area's `paths`",
  );
});

test("a malformed inventory says what is wrong and runs nothing", () => {
  const malformed = inventory("malformed");
  expectSpawnExit(malformed, 2);
  expect(malformed.stderr).toContain("generated[0].check: must be a command");
  expect(malformed.stdout).not.toContain("[1/");
  const unknown = inventory("unknown-field");
  expectSpawnExit(unknown, 2);
  expect(unknown.stderr).toContain("generated[0]: unknown field `regenerate`");
  expect(unknown.stderr).toContain("generated[0].command: must be a command");
  expect(inventory("empty").stderr).toContain("declares no derived file");
  expect(inventory("no-form").stderr).toContain(
    "neither a `generated:` list nor an `areas:` map",
  );
  expect(run("catalog-nothing-declared", ["catalog.yaml"]).stderr).toContain(
    "no area of the catalog declares a `generated:` entry",
  );
});

test("--list prints every entry and runs no check", () => {
  const result = inventory("stale", "--list");
  expectSpawnExit(run("stale", ["--list", "generated-files.yaml"]), 0);
  expect(result.exitCode).toBe(2);
  const listed = run("catalog", ["--list", "catalog.yaml"]);
  expectSpawnExit(listed, 0);
  expect(listed.stdout).toContain("areas.docs.generated[0]: docs/INDEX.md");
  expect(listed.stdout).toContain("  source: docs/*.md");
  expect(listed.stdout).toContain("  command: echo regenerate index");
  expect(listed.stdout).toContain("  check: exit 0");
  expect(listed.stdout).not.toContain("[1/");
});

for (const args of [
  [],
  ["--bogus", "generated-files.yaml"],
  ["generated-files.yaml", "generated-files.yaml"],
  ["does-not-exist.yaml"],
])
  test(`usage: ${JSON.stringify(args)} is refused`, () => {
    const result = run("fresh", args);
    expectSpawnExit(result, 2);
    expect(result.stdout).not.toContain("[1/");
  });

test("an unreadable root is refused rather than read as empty", () => {
  const empty = mkdtempSync(join(tmpdir(), "jig-inventory-"));
  try {
    const result = Bun.spawnSync(
      [process.execPath, runner, join(fixtures, "fresh/generated-files.yaml")],
      { cwd: empty, stdout: "pipe", stderr: "pipe" },
    );
    // The outputs and sources resolve from the directory the runner runs in.
    expectSpawnExit(
      {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      },
      1,
    );
    expect(result.stderr.toString()).toContain("is not a file");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("outcomeOf reads a check's exit the way the runner does", () => {
  expect(outcomeOf(0, "")).toBe("passed");
  expect(outcomeOf(1, "")).toBe("stale");
  expect(outcomeOf(1, "bun: command not found: frob\n")).toBe("cannot-start");
  expect(outcomeOf(1, "warning\nbun: command not found: frob\n")).toBe(
    "cannot-start",
  );
  expect(outcomeOf(1, "the text bun: command not found: inside a line")).toBe(
    "stale",
  );
  expect(outcomeOf(2, "")).toBe("undecided");
  expect(outcomeOf(127, "")).toBe("undecided");
  expect(outcomeOf(137, "")).toBe("undecided");
});

test("entryProblems names each missing or malformed field", () => {
  const good = {
    outputs: ["a"],
    source: ["b/**"],
    command: "make a",
    check: "make a --check",
  };
  expect(entryProblems(good, "generated[0]")).toEqual([]);
  expect(entryProblems({ ...good, notes: "why" }, "x")).toEqual([]);
  expect(entryProblems(null, "x")).toEqual(["x: not a mapping"]);
  expect(entryProblems([], "x")).toEqual(["x: not a mapping"]);
  expect(entryProblems({}, "x")).toEqual([
    "x.outputs: must list at least one path",
    "x.source: must list at least one path",
    "x.command: must be a command",
    "x.check: must be a command",
  ]);
  expect(entryProblems({ ...good, outputs: [] }, "x")).toEqual([
    "x.outputs: must list at least one path",
  ]);
  expect(entryProblems({ ...good, source: ["ok", " "] }, "x")).toEqual([
    "x.source: must list at least one path",
  ]);
  expect(entryProblems({ ...good, check: " " }, "x")).toEqual([
    "x.check: must be a command",
  ]);
  expect(entryProblems({ ...good, notes: 3 }, "x")).toEqual([
    "x.notes: not text",
  ]);
  expect(entryProblems({ ...good, by: "make" }, "x")).toEqual([
    "x: unknown field `by`",
  ]);
});

test("generatedListProblems checks the list and each entry in it", () => {
  expect(generatedListProblems(undefined, "generated")).toEqual([
    "generated: must be a list of entries",
  ]);
  expect(generatedListProblems([], "generated")).toEqual([]);
  expect(generatedListProblems([null, {}], "generated")).toEqual([
    "generated[0]: not a mapping",
    "generated[1].outputs: must list at least one path",
    "generated[1].source: must list at least one path",
    "generated[1].command: must be a command",
    "generated[1].check: must be a command",
  ]);
});

test("parseInventory reads both forms and refuses the rest", () => {
  const entry = {
    outputs: ["docs/INDEX.md"],
    source: ["docs/*.md"],
    command: "gen",
    check: "gen --check",
  };
  const standalone = parseInventory({ generated: [entry] });
  expect(standalone).toHaveLength(1);
  expect(standalone[0]?.where).toBe("generated[0]");
  expect(standalone[0]?.ownerPaths).toBeUndefined();
  const catalog = parseInventory({
    areas: {
      docs: { paths: ["docs/**"], generated: [entry] },
      tools: { paths: ["tools/**"] },
    },
  });
  expect(catalog).toHaveLength(1);
  expect(catalog[0]?.where).toBe("areas.docs.generated[0]");
  expect(catalog[0]?.ownerPaths).toEqual(["docs/**"]);
  expect(() => parseInventory(undefined)).toThrow("not a mapping");
  expect(() => parseInventory({ generated: [] })).toThrow(
    "declares no derived file",
  );
  expect(() => parseInventory({ generated: [entry], extra: 1 })).toThrow(
    "unknown top-level field `extra`",
  );
  expect(() => parseInventory({ areas: {} })).toThrow(
    "no area of the catalog declares",
  );
  expect(() => parseInventory({ areas: { docs: null } })).toThrow(
    "areas.docs: not a mapping",
  );
  expect(() =>
    parseInventory({ areas: { docs: { generated: [entry] } } }),
  ).toThrow("areas.docs.paths: must list at least one glob");
  expect(() =>
    parseInventory({ areas: { docs: { paths: ["d/**"], generated: {} } } }),
  ).toThrow("areas.docs.generated: must be a list of entries");
});

/** A scratch repository root holding `files`, with the runner spawned in it. */
function scratch(
  files: Record<string, string>,
  {
    git = false,
    env = {},
  }: { git?: boolean; env?: Record<string, string> } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "jig-inventory-"));
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(root, name), text);
  const sh = (...argv: string[]) =>
    Bun.spawnSync(argv, { cwd: root, stdout: "ignore", stderr: "ignore" });
  if (git) {
    sh("git", "init", "-q");
    sh("git", "add", "-A");
    sh(
      "git",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "t",
    );
  }
  const runIn = () => {
    const result = Bun.spawnSync(
      [process.execPath, runner, "generated-files.yaml"],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...env },
      },
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  };
  return {
    root,
    runIn,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

const entry = (output: string, check: string, source = "src.txt") =>
  `  - outputs: ["${output}"]\n    source: ["${source}"]\n    command: echo regen\n    check: ${JSON.stringify(check)}\n`;

test("a check that cannot parse or times out is a result, and the later checks still run", () => {
  const { runIn, done } = scratch(
    {
      "out.txt": "x\n",
      "src.txt": "x\n",
      "a.txt": "x\n",
      "b.txt": "x\n",
      "generated-files.yaml": `generated:\n${entry("out.txt", "echo (")}${entry("a.txt", "sleep 30")}${entry("b.txt", "exit 1")}`,
    },
    { env: { JIG_COMMAND_TIMEOUT_SEC: "1" } },
  );
  try {
    const result = runIn();
    expectSpawnExit(result, 2);
    expect(result.stdout).toContain(
      "could not start (the shell cannot parse it)",
    );
    expect(result.stdout).toContain("could not decide (timed out)");
    expect(result.stdout).toContain("[3/3] exit 1");
    expect(result.stderr).toContain("stale: `exit 1` exited 1");
  } finally {
    done();
  }
}, 20_000);

test("an output is one file however it is spelled, and must lie inside the repository", () => {
  const { runIn, done } = scratch({
    "out.txt": "x\n",
    "src.txt": "x\n",
    "generated-files.yaml": `generated:\n${entry("out.txt", "exit 0")}${entry("./out.txt", "exit 0")}${entry("../out.txt", "exit 0")}${entry("/etc/hosts", "exit 0")}`,
  });
  try {
    const result = runIn();
    expectSpawnExit(result, 1);
    expect(result.stderr).toContain(
      "generated[1]: output `./out.txt` is already declared by generated[0]",
    );
    expect(result.stderr).toContain(
      "generated[2]: output `../out.txt` is not a path inside the repository",
    );
    expect(result.stderr).toContain(
      "generated[3]: output `/etc/hosts` is not a path inside the repository",
    );
  } finally {
    done();
  }
});

// Creating a symbolic link on Windows needs a privilege a runner may lack.
test.skipIf(process.platform === "win32")(
  "an output is the file its link resolves to, and that file must lie inside the repository",
  () => {
    const outside = mkdtempSync(join(tmpdir(), "jig-inventory-outside-"));
    writeFileSync(join(outside, "elsewhere.txt"), "x\n");
    const { root, runIn, done } = scratch({
      "out.txt": "x\n",
      "src.txt": "x\n",
      "generated-files.yaml": `generated:\n${entry("out.txt", "exit 0")}${entry("alias.txt", "exit 0")}${entry("escape.txt", "exit 0")}`,
    });
    symlinkSync("out.txt", join(root, "alias.txt"));
    symlinkSync(join(outside, "elsewhere.txt"), join(root, "escape.txt"));
    try {
      const result = runIn();
      expectSpawnExit(result, 1);
      expect(result.stderr).toContain(
        "generated[1]: output `alias.txt` is already declared by generated[0]",
      );
      expect(result.stderr).toContain(
        "generated[2]: output `escape.txt` resolves to",
      );
      expect(result.stderr).toContain("outside the repository");
    } finally {
      done();
      rmSync(outside, { recursive: true, force: true });
    }
  },
);

// Creating a symbolic link on Windows needs a privilege a runner may lack.
test.skipIf(process.platform === "win32")(
  "an output that climbs with `..` past a link is refused, and a name that merely starts with `..` is not",
  () => {
    const outside = mkdtempSync(join(tmpdir(), "jig-inventory-outside-"));
    mkdirSync(join(outside, "subdir"));
    writeFileSync(join(outside, "report.txt"), "x\n");
    const { root, runIn, done } = scratch({
      "report.txt": "x\n",
      "src.txt": "x\n",
      "generated-files.yaml": `generated:\n${entry("link/../report.txt", "exit 0")}${entry("..cache/report.txt", "exit 0")}`,
    });
    symlinkSync(join(outside, "subdir"), join(root, "link"));
    mkdirSync(join(root, "..cache"));
    writeFileSync(join(root, "..cache", "report.txt"), "x\n");
    try {
      const result = runIn();
      expectSpawnExit(result, 1);
      expect(result.stderr).toContain(
        "generated[0]: output `link/../report.txt` climbs with `..`",
      );
      expect(result.stderr).not.toContain("generated[1]");
    } finally {
      done();
      rmSync(outside, { recursive: true, force: true });
    }
  },
);

test("a source deleted from the working tree matches nothing, staged or not", () => {
  const { root, runIn, done } = scratch(
    {
      "out.txt": "x\n",
      "src.txt": "x\n",
      "generated-files.yaml": `generated:\n${entry("out.txt", "exit 0")}`,
    },
    { git: true },
  );
  try {
    expectSpawnExit(runIn(), 0);
    unlinkSync(join(root, "src.txt"));
    const result = runIn();
    expectSpawnExit(result, 1);
    expect(result.stderr).toContain(
      "source `src.txt` matches no repository file",
    );
  } finally {
    done();
  }
});

test("an inventory path that is not a regular file is refused before it is read", () => {
  const result = run("fresh", [import.meta.dir]);
  expectSpawnExit(result, 2);
  expect(result.stderr).toContain("not a regular file");
});
