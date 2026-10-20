import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  parseObligations,
  runObligations,
} from "../scripts/lib/obligations.ts";
import { CONFIG_COMBINED, mergeConflict, Scratch } from "./scratch.ts";

let scratch: Scratch | undefined;
afterEach(() => scratch?.cleanup());

test("obligations require check text and refuse malformed optional commands and keys", () => {
  expect(parseObligations(undefined)).toEqual([]);
  expect(
    parseObligations({
      generated: [],
      obligations: [{ check: "Inspect all staged hunks" }],
    }),
  ).toEqual([{ check: "Inspect all staged hunks" }]);
  for (const obligations of [
    null,
    {},
    ["check"],
    [{}],
    [{ check: " " }],
    [{ check: "x", command: null }],
    [{ check: "x", command: " " }],
    [{ check: "x", extra: "y" }],
  ])
    expect(() => parseObligations({ obligations })).toThrow(
      "resolve_conflicts.obligations",
    );
});

test("commands run from the consumer root and surface failure while text checks stay pending", async () => {
  scratch = new Scratch();
  scratch.write("expected.txt", "expected\n");
  const results = await runObligations(scratch.root, [
    { check: "Read every resolved hunk" },
    {
      check: "Consumer file is present",
      command: `"${process.execPath}" -e 'process.exit(require("node:fs").existsSync("expected.txt") ? 0 : 1)'`,
    },
    {
      check: "Reject invalid result",
      command: `"${process.execPath}" -e 'console.error("guard missing"); process.exit(7)'`,
    },
  ]);
  expect(results.map((result) => result.status)).toEqual([
    "agent-check",
    "passed",
    "failed",
  ]);
  expect(results[2]?.output).toContain("guard missing");
  expect(results[2]?.output).toContain("exit 7");
});

test("runtime reads layered configuration and bounds a command with a deadline", () => {
  scratch = new Scratch();
  const module = join(
    import.meta.dir,
    "..",
    "scripts",
    "lib",
    "obligations.ts",
  );
  scratch.write(
    "probe.ts",
    `import { obligationEntries, runObligations } from ${JSON.stringify(module)}; console.log(JSON.stringify(await runObligations(process.cwd(), obligationEntries())));`,
  );
  scratch.overlay(`resolve_conflicts:
  obligations:
    - check: Read complete diff
    - check: Bound a stalled command
      command: '${process.execPath} -e "setInterval(() => {}, 1000)"'
`);
  scratch.git("add", ".config/jig.yaml");
  scratch.env.RESOLVE_CONFLICTS_COMMAND_TIMEOUT = "1";
  const run = scratch.script(join(scratch.root, "probe.ts"));
  expectSpawnExit({ ...run, exitCode: run.code }, 0);
  const results = JSON.parse(run.stdout);
  expect(results[0].check).toBe("Read complete diff");
  expect(results[1].status).toBe("failed");
  expect(results[1].output).toContain("deadline exceeded after 1s");
  scratch.env.JIG__RESOLVE_CONFLICTS__OBLIGATIONS = JSON.stringify([
    { check: "Environment layer inspection" },
  ]);
  const layered = scratch.script(join(scratch.root, "probe.ts"));
  expectSpawnExit({ ...layered, exitCode: layered.code }, 0);
  expect(JSON.parse(layered.stdout)).toMatchObject([
    { check: "Environment layer inspection", status: "agent-check" },
  ]);
});

test("runtime rejects malformed obligations with the configuration source", () => {
  scratch = new Scratch();
  const module = join(
    import.meta.dir,
    "..",
    "scripts",
    "lib",
    "obligations.ts",
  );
  scratch.write(
    "probe.ts",
    `import { obligationEntries } from ${JSON.stringify(module)}; obligationEntries();`,
  );
  scratch.overlay(
    'resolve_conflicts:\n  obligations: [{check: Inspect, command: ""}]\n',
  );
  scratch.git("add", ".config/jig.yaml");
  const run = scratch.script(join(scratch.root, "probe.ts"));
  expectSpawnExit({ ...run, exitCode: run.code }, 1);
  expect(run.stderr).toContain("resolve_conflicts.obligations[0].command");
  expect(run.stderr).toContain(".config/jig.yaml");
});

function resolvedMerge(setup?: (s: Scratch) => void): Scratch {
  const s = new Scratch();
  scratch = s;
  setup?.(s);
  mergeConflict(s);
  let run = s.script("conflict-map.ts");
  expectSpawnExit({ ...run, exitCode: run.code }, 0);
  s.write("src/config.ts", CONFIG_COMBINED);
  s.git("add", "src/config.ts");
  run = s.script("record.ts", ["src/config.ts", "combined"]);
  expectSpawnExit({ ...run, exitCode: run.code }, 0);
  return s;
}

// The environment layer, not .config/jig.yaml: the file is read from the index,
// and a staged one would be a change outside the operation.
function setObligations(s: Scratch, entries: unknown): void {
  s.env.JIG__RESOLVE_CONFLICTS__OBLIGATIONS = JSON.stringify(entries);
}

test("CLI reports pending text and successful commands for the whole resolved merge", () => {
  const s = resolvedMerge();
  setObligations(s, [
    { check: "Inspect all staged hunks including auto-merges" },
    {
      check: "Run the result check",
      command: "git diff --cached --exit-code -- src/nonexistent.ts",
    },
  ]);
  const run = s.script("check-resolution.ts", ["--json"]);
  expectSpawnExit({ ...run, exitCode: run.code }, 0);
  expect(JSON.parse(run.stdout).obligations).toMatchObject([
    {
      check: "Inspect all staged hunks including auto-merges",
      status: "agent-check",
    },
    { check: "Run the result check", status: "passed" },
  ]);
});

test("CLI blocks failed commands and emits no commit message", () => {
  const s = resolvedMerge();
  setObligations(s, [
    { check: "Preserve guards", command: "echo missing-guard >&2; exit 7" },
  ]);
  const report = s.script("check-resolution.ts", ["--json"]);
  expectSpawnExit({ ...report, exitCode: report.code }, 1);
  expect(JSON.parse(report.stdout).obligations).toMatchObject([
    { status: "failed", output: "exit 7\nmissing-guard" },
  ]);
  const message = s.script("check-resolution.ts", ["--message"]);
  expectSpawnExit({ ...message, exitCode: message.code }, 1);
  expect(message.stdout).toBe("");
  expect(message.stderr).toContain("missing-guard");
});

test("CLI refuses invalid obligation configuration with exit 2", () => {
  const s = resolvedMerge();
  setObligations(s, [{ check: "Inspect", command: "" }]);
  const run = s.script("check-resolution.ts", ["--json"]);
  expectSpawnExit({ ...run, exitCode: run.code }, 2);
  expect(run.stderr).toContain("resolve_conflicts.obligations[0].command");
});

test("CLI rechecks staged provenance after a configured command", () => {
  const s = resolvedMerge();
  setObligations(s, [
    {
      check: "Run repository check",
      command: "echo unrelated > unrelated.txt; git add unrelated.txt",
    },
  ]);
  const run = s.script("check-resolution.ts", ["--json"]);
  expectSpawnExit({ ...run, exitCode: run.code }, 1);
  expect(JSON.parse(run.stdout).problems).toContainEqual(
    expect.objectContaining({ path: "unrelated.txt" }),
  );
});

test("a command that restages a checked path invalidates every result", () => {
  const s = resolvedMerge();
  setObligations(s, [
    { check: "Validate the config", command: "true" },
    {
      check: "Format",
      command:
        "echo 'export const broken =' >> src/config.ts; git add src/config.ts",
    },
  ]);
  const run = s.script("check-resolution.ts", ["--json"]);
  expectSpawnExit({ ...run, exitCode: run.code }, 1);
  const report = JSON.parse(run.stdout);
  expect(report.obligations).toMatchObject([
    { status: "passed" },
    { status: "passed" },
  ]);
  expect(report.problems).toContainEqual(
    expect.objectContaining({
      path: "resolve_conflicts.obligations",
      message: expect.stringContaining("changed the staged tree"),
    }),
  );
});

test("commands do not run while the working tree differs from the staged tree", () => {
  const s = resolvedMerge((setup) =>
    setup.commit("Add the notes", { "notes.md": "notes\n" }),
  );
  s.write("notes.md", "notes with an unstaged fix\n");
  setObligations(s, [{ check: "Validate", command: "true" }]);
  const run = s.script("check-resolution.ts", ["--json"]);
  expectSpawnExit({ ...run, exitCode: run.code }, 1);
  const report = JSON.parse(run.stdout);
  expect(report.obligations).toMatchObject([{ status: "not-run" }]);
  expect(report.problems).toContainEqual(
    expect.objectContaining({
      path: "notes.md",
      message: expect.stringContaining("differs from the staged tree"),
    }),
  );
});

test("a missing shell is reported as a failed command", () => {
  scratch = new Scratch();
  const module = join(
    import.meta.dir,
    "..",
    "scripts",
    "lib",
    "obligations.ts",
  );
  scratch.write(
    "probe.ts",
    `import { runObligations } from ${JSON.stringify(module)}; console.log(JSON.stringify(await runObligations(process.cwd(), [{check: "Check result", command: "echo checked"}])));`,
  );
  scratch.env.PATH = join(scratch.home, "empty-path");
  const run = scratch.script(join(scratch.root, "probe.ts"));
  expectSpawnExit({ ...run, exitCode: run.code }, 0);
  expect(JSON.parse(run.stdout)[0].status).toBe("failed");
  expect(JSON.parse(run.stdout)[0].output).toContain("exit 127");
});

test("a command that changes a file stops the later commands, even when the file is restored", () => {
  const s = resolvedMerge((setup) =>
    setup.commit("Add the helper", { "helper.txt": "staged\n" }),
  );
  setObligations(s, [
    { check: "Prepare", command: "echo edited > helper.txt" },
    { check: "Validate and restore", command: "echo staged > helper.txt" },
  ]);
  const run = s.script("check-resolution.ts", ["--json"]);
  expectSpawnExit({ ...run, exitCode: run.code }, 1);
  const report = JSON.parse(run.stdout);
  expect(report.obligations).toMatchObject([
    { status: "passed" },
    {
      status: "not-run",
      output: expect.stringContaining("An earlier command changed"),
    },
  ]);
  expect(s.read("helper.txt")).toBe("edited\n");
  expect(report.problems).toContainEqual(
    expect.objectContaining({ path: "resolve_conflicts.obligations" }),
  );
});

test("an ignored submodule setting does not hide a moved submodule from the state check", () => {
  const s = resolvedMerge((setup) => {
    setup.run("git", ["init", "-q", "sub"]);
    setup.run("git", [
      "-C",
      "sub",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "one",
    ]);
    setup.git("add", "sub");
    setup.git("commit", "-q", "-m", "Add the submodule");
  });
  const moved = s.run("git", [
    "-C",
    "sub",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "two",
  ]);
  expectSpawnExit({ ...moved, exitCode: moved.code }, 0);
  s.git("config", "diff.ignoreSubmodules", "all");
  s.git("config", "submodule.sub.ignore", "all");
  setObligations(s, [{ check: "Validate", command: "true" }]);
  const run = s.script("check-resolution.ts", ["--json"]);
  expectSpawnExit({ ...run, exitCode: run.code }, 1);
  const report = JSON.parse(run.stdout);
  expect(report.obligations).toMatchObject([{ status: "not-run" }]);
  expect(report.problems).toContainEqual(
    expect.objectContaining({ path: "sub" }),
  );
});

for (const flag of ["--assume-unchanged", "--skip-worktree"])
  for (const ignorestat of [false, true])
    test(`a ${flag} entry is compared with disk independently of git diff${ignorestat ? " under core.ignorestat=true" : ""}`, () => {
      const s = resolvedMerge((setup) =>
        setup.commit("Add the helper", { "helper.txt": "staged\n" }),
      );
      if (ignorestat) s.git("config", "core.ignorestat", "true");
      s.git("update-index", flag, "--", "helper.txt");
      setObligations(s, [{ check: "Validate", command: "true" }]);
      let run = s.script("check-resolution.ts", ["--json"]);
      expectSpawnExit({ ...run, exitCode: run.code }, 0);

      s.write("helper.txt", "edited on disk\n");
      run = s.script("check-resolution.ts", ["--json"]);
      expectSpawnExit({ ...run, exitCode: run.code }, 1);
      const report = JSON.parse(run.stdout);
      expect(report.obligations).toMatchObject([{ status: "not-run" }]);
      expect(report.problems).toContainEqual(
        expect.objectContaining({
          path: "helper.txt",
          message: expect.stringContaining("assume-unchanged or skip-worktree"),
        }),
      );
    });

function addSubmodule(setup: Scratch): void {
  setup.run("git", ["init", "-q", "sub"]);
  setup.write("sub/helper.ts", "export const helper = 1;\n");
  setup.run("git", ["-C", "sub", "add", "helper.ts"]);
  setup.run("git", ["-C", "sub", "commit", "-q", "-m", "one"]);
  setup.git("add", "sub");
  setup.git("commit", "-q", "-m", "Add the submodule");
}

for (const ignorestat of [false, true])
  test(`a flagged file inside an initialized submodule is compared with disk${ignorestat ? " under core.ignorestat=true" : ""}`, () => {
    const s = resolvedMerge(addSubmodule);
    if (ignorestat) {
      const set = s.run("git", [
        "-C",
        "sub",
        "config",
        "core.ignorestat",
        "true",
      ]);
      expectSpawnExit({ ...set, exitCode: set.code }, 0);
    }
    const flagged = s.run("git", [
      "-C",
      "sub",
      "update-index",
      "--assume-unchanged",
      "--",
      "helper.ts",
    ]);
    expectSpawnExit({ ...flagged, exitCode: flagged.code }, 0);
    setObligations(s, [{ check: "Validate", command: "true" }]);
    let run = s.script("check-resolution.ts", ["--json"]);
    expectSpawnExit({ ...run, exitCode: run.code }, 0);

    s.write("sub/helper.ts", "export const helper = 2;\n");
    run = s.script("check-resolution.ts", ["--json"]);
    expectSpawnExit({ ...run, exitCode: run.code }, 1);
    const report = JSON.parse(run.stdout);
    expect(report.obligations).toMatchObject([{ status: "not-run" }]);
    expect(report.problems).toContainEqual(
      expect.objectContaining({
        path: "sub/helper.ts",
        message: expect.stringContaining("assume-unchanged or skip-worktree"),
      }),
    );
  });

for (const flag of ["--assume-unchanged", "--skip-worktree"])
  test(`a clean submodule marked ${flag} passes`, () => {
    const s = resolvedMerge(addSubmodule);
    s.git("update-index", flag, "--", "sub");
    setObligations(s, [{ check: "Validate", command: "true" }]);
    const run = s.script("check-resolution.ts", ["--json"]);
    expectSpawnExit({ ...run, exitCode: run.code }, 0);
    expect(JSON.parse(run.stdout).obligations).toMatchObject([
      { status: "passed" },
    ]);
  });

test("flagged files whose names hold a newline or start with a quote are compared literally", () => {
  const newline = "a\nb.txt";
  const quoted = '"quoted.txt';
  const s = resolvedMerge((setup) =>
    setup.commit("Add awkward names", {
      [newline]: "staged\n",
      [quoted]: "staged\n",
    }),
  );
  s.git("update-index", "--skip-worktree", "--", newline, quoted);
  setObligations(s, [{ check: "Validate", command: "true" }]);
  let run = s.script("check-resolution.ts", ["--json"]);
  expectSpawnExit({ ...run, exitCode: run.code }, 0);

  s.write(newline, "edited on disk\n");
  run = s.script("check-resolution.ts", ["--json"]);
  expectSpawnExit({ ...run, exitCode: run.code }, 1);
  const paths = JSON.parse(run.stdout).problems.map(
    (p: { path: string }) => p.path,
  );
  expect(paths).toContain(newline);
  expect(paths).not.toContain(quoted);
});

test("a flagged symlink checked out as a plain file under core.symlinks=false is compared as git checks it out", () => {
  const s = resolvedMerge((setup) => {
    setup.write("target.txt", "target\n");
    setup.run("ln", ["-s", "target.txt", "link"]);
    setup.git("add", "target.txt", "link");
    setup.git("commit", "-q", "-m", "Add the link");
  });
  s.git("config", "core.symlinks", "false");
  s.run("rm", ["link"]);
  s.git("checkout", "--", "link");
  expect(s.read("link")).toBe("target.txt");
  s.git("update-index", "--assume-unchanged", "--", "link");
  setObligations(s, [{ check: "Validate", command: "true" }]);
  let run = s.script("check-resolution.ts", ["--json"]);
  expectSpawnExit({ ...run, exitCode: run.code }, 0);

  s.write("link", "elsewhere.txt");
  run = s.script("check-resolution.ts", ["--json"]);
  expectSpawnExit({ ...run, exitCode: run.code }, 1);
  expect(JSON.parse(run.stdout).problems).toContainEqual(
    expect.objectContaining({ path: "link" }),
  );
});
