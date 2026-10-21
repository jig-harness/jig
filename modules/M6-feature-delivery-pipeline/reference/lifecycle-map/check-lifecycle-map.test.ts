import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  checkMap,
  commandSegments,
  type MapOptions,
  parseStages,
  skillNames,
  skillRef,
} from "./check-lifecycle-map.ts";
import { render } from "./markdown.ts";

const script = join(import.meta.dir, "check-lifecycle-map.ts");
const repo = join(import.meta.dir, "fixtures", "repo");
const at = (...parts: string[]) => join(repo, ...parts);

const skills = [
  { namespace: "jig", dir: at("plugin/skills") },
  { namespace: "", dir: at(".claude/skills") },
  { namespace: "", dir: at(".claude/commands") },
];

function options(map: string, extra: Partial<MapOptions> = {}): MapOptions {
  return {
    map: at(map),
    root: repo,
    skills,
    external: ["gh"],
    cover: [],
    scan: [],
    ...extra,
  };
}

const rules = (map: string, extra: Partial<MapOptions> = {}): string[] =>
  checkMap(options(map, extra)).findings.map((f) => f.rule);

function run(args: string[]) {
  const r = Bun.spawnSync([process.execPath, script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

const flags = [
  "--root",
  repo,
  "--skills",
  `jig=${at("plugin/skills")}`,
  "--skills",
  at(".claude/skills"),
  "--skills",
  at(".claude/commands"),
  "--external",
  "gh",
];

describe("a map whose every owner resolves", () => {
  test("passes, counting the stages and the owners it resolved", () => {
    const { findings, stages, resolved } = checkMap(
      options("LIFECYCLE.md", {
        cover: [at("plugin/skills")],
        scan: [at("docs/process.md")],
        linkedFrom: at("AGENTS.md"),
      }),
    );
    expect(findings).toEqual([]);
    expect(stages).toBe(7);
    expect(resolved).toBe(9);
  });

  test("a table inside a fenced block is not a stage", () => {
    expect(parseStages(readMap()).map((s) => s.stage)).not.toContain("fenced");
  });

  test("the columns may come in any order, and an escaped pipe stays in its cell", () => {
    expect(rules("maps/other-column-order.md")).toEqual([]);
    const [row] = parseStages(readMap("maps/escaped-pipe.md"));
    expect(row?.handsOn).toBe("an issue | or a note");
  });
});

function readMap(path = "LIFECYCLE.md"): string {
  return readFileSync(at(path), "utf8");
}

describe("a map that is not one", () => {
  test("prose with no stage table fails", () =>
    expect(rules("maps/no-table.md")).toEqual(["stage-table"]));

  test("numbered stages fail, and so does a name another stage has", () => {
    const found = checkMap(options("maps/numbered.md")).findings;
    expect(found.map((f) => [f.line, f.rule])).toEqual([
      [3, "stage-name"],
      [4, "stage-name"],
      [5, "stage-name"],
    ]);
    expect(found[0]?.problem).toContain("numbered");
  });

  test("a number is a number however it is written, and a name that starts with digits is not", () => {
    const found = checkMap(options("maps/numbered-variants.md")).findings;
    expect(found.map((f) => f.line)).toEqual([3, 4, 5, 6, 7]);
    expect(found.every((f) => f.problem.includes("numbered"))).toBe(true);
  });

  test("a repeated stage name fails, whatever its case", () => {
    const found = checkMap(options("maps/duplicate.md")).findings;
    expect(found).toHaveLength(1);
    expect(found[0]?.problem).toContain("also on line 3");
  });

  test("a missing owner, a missing handoff, an owner in words only and a nameless stage fail", () => {
    const found = checkMap(options("maps/missing.md")).findings;
    expect(found.map((f) => [f.line, f.rule])).toEqual([
      [3, "owner-missing"],
      [4, "owner-missing"],
      [5, "handoff-missing"],
      [6, "stage-name"],
    ]);
  });

  test("a placeholder in a stage's name, its owner, its handoff (a code span included) or the skills table fails; an argument placeholder in a command does not", () => {
    const found = checkMap(options("maps/placeholder.md")).findings;
    expect(found.map((f) => [f.line, f.rule])).toEqual([
      [3, "placeholder"],
      [4, "placeholder"],
      [6, "placeholder"],
      [7, "placeholder"],
      [11, "placeholder"],
    ]);
  });

  test("a table inside an HTML comment is not a map", () =>
    expect(rules("maps/commented.md")).toEqual(["stage-table"]));
});

describe("owners that do not resolve", () => {
  const found = checkMap(options("maps/unresolved.md")).findings;
  const line = (n: number) => found.find((f) => f.line === n);

  test("every unresolved owner is a finding on its own line, and the resolved ones are not", () => {
    expect(found.map((f) => f.line)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(found.every((f) => f.rule === "owner-unresolved")).toBe(true);
  });

  test("a skill that is not shipped, one with no namespace, and a namespace nobody serves say which", () => {
    expect(line(3)?.problem).toContain("/jig:gone is not a skill");
    expect(line(4)?.problem).toContain("/nope is not a skill");
    expect(line(5)?.problem).toContain('the namespace "other"');
  });

  test("a script the package lacks, a missing file and an undeclared command say so", () => {
    expect(line(6)?.problem).toContain("bun run missing is not a script");
    expect(line(7)?.problem).toContain("scripts/gone.ts is not a file");
    expect(line(8)?.problem).toContain("--external");
  });

  test("a link to nothing fails", () =>
    expect(line(9)?.problem).toContain("../docs/gone.md"));

  test("the same command passes once it is declared external", () => {
    const declared = checkMap(
      options("maps/unresolved.md", { external: ["gh", "rm -rf"] }),
    ).findings;
    expect(declared.map((f) => f.line)).toEqual([3, 4, 5, 6, 7, 9]);
  });

  test("a root with no package.json cannot resolve a script", () => {
    const found = checkMap({
      ...options("maps/unresolved.md"),
      root: at("docs"),
    }).findings;
    expect(found.find((f) => f.line === 6)?.problem).toContain(
      "needs a package.json",
    );
    expect(found.find((f) => f.line === 10)?.problem).toContain(
      "bun run lint needs a package.json",
    );
  });
});

describe("owners that cannot be resolved or are not owners", () => {
  test("a web address, an anchor and a root link to nothing are not owners; a root link that exists is", () => {
    const found = checkMap(options("maps/unverifiable-owners.md")).findings;
    expect(found.map((f) => [f.line, f.rule])).toEqual([
      [3, "owner-missing"],
      [4, "owner-missing"],
      [5, "owner-unresolved"],
    ]);
  });

  test("every command of a chain is resolved, and an operator inside quotes is part of its argument", () => {
    const found = checkMap(options("maps/chained.md")).findings;
    expect(found.map((f) => f.line)).toEqual([4, 5]);
    expect(found[0]?.problem).toContain("bun run nope");
    expect(found[1]?.problem).toContain("/jig:gone");
  });

  test("a skill written as a placeholder is a placeholder; HTML tags and autolinks are not", () => {
    const found = checkMap(options("maps/html-and-placeholders.md")).findings;
    expect(found.map((f) => [f.line, f.rule])).toEqual([[4, "placeholder"]]);
  });

  test("a reference link resolves through its definition, and one to nothing fails", () => {
    const found = checkMap(options("maps/reference-links.md")).findings;
    expect(found.map((f) => [f.line, f.rule])).toEqual([
      [4, "owner-unresolved"],
    ]);
    expect(found[0]?.problem).toContain("../docs/gone.md");
  });

  test("only `bun run` runs a file, and a skill is a SKILL.md file, not a directory of that name", () => {
    const found = checkMap(options("maps/run-files.md")).findings;
    expect(found.map((f) => f.line)).toEqual([4, 5]);
    expect(found[0]?.problem).toContain("npm run docs/plan.md");
    expect(found[1]?.problem).toContain("/jig:hollow");
  });

  test("a script whose command is empty or not a string is not a script", () => {
    const found = checkMap(
      options("maps/chained.md", {
        packageJson: at("packages/empty-commands.json"),
      }),
    ).findings;
    expect(found[0]?.problem).toContain("bun run gates is not a script");
  });

  test("a scripts field that is not an object is an input error", () =>
    expect(() =>
      checkMap(
        options("LIFECYCLE.md", {
          packageJson: at("packages/array-scripts.json"),
        }),
      ),
    ).toThrow('"scripts" is not an object'));

  test("a package file that was asked for and is missing is an input error", () =>
    expect(() =>
      checkMap(options("LIFECYCLE.md", { packageJson: at("absent.json") })),
    ).toThrow("--package-json"));
});

describe("coverage", () => {
  test("a skill the map never names is found", () => {
    const found = checkMap(
      options("maps/partial.md", { cover: [at("plugin/skills")] }),
    ).findings;
    expect(found.map((f) => f.rule)).toEqual([
      "skill-not-in-map",
      "skill-not-in-map",
    ]);
    expect(found.map((f) => f.problem.split(" ")[0])).toEqual([
      "/jig:drive-pr",
      "/jig:orphan",
    ]);
  });

  test("only an owner or the skills table covers a skill, and every skill of a chained owner counts", () => {
    const found = checkMap(
      options("maps/cover-roles.md", { cover: [at("plugin/skills")] }),
    ).findings;
    expect(found.map((f) => f.problem.split(" ")[0])).toEqual(["/jig:orphan"]);
  });

  test.skipIf(process.platform === "win32")(
    "a linked skill directory is a skill",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "jig-lifecycle-"));
      try {
        mkdirSync(join(dir, "real", "linked"), { recursive: true });
        writeFileSync(join(dir, "real", "linked", "SKILL.md"), "# linked\n");
        mkdirSync(join(dir, "skills"));
        symlinkSync(join(dir, "real", "linked"), join(dir, "skills", "linked"));
        expect(skillNames(join(dir, "skills"))).toEqual(["linked"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("the table of skills outside the loop", () => {
  test("is resolved like an owner, and a mention in prose is not coverage", () => {
    const found = checkMap(
      options("maps/skill-table.md", { cover: [at("plugin/skills")] }),
    ).findings;
    expect(found.map((f) => [f.line, f.rule])).toEqual([
      [10, "owner-unresolved"],
      [undefined, "skill-not-in-map"],
    ]);
    expect(found[1]?.problem).toContain("/jig:drive-pr");
  });

  test("a bare name does not resolve in a namespaced directory", () =>
    expect(
      checkMap(
        options("maps/chained.md", {
          skills: [{ namespace: "jig", dir: at("plugin/skills") }],
        }),
      ).findings.length,
    ).toBeGreaterThan(0));
});

describe("process documents", () => {
  test("name only skills that exist; a mention in a fence is not read", () =>
    expect(rules("LIFECYCLE.md", { scan: [at("docs/process.md")] })).toEqual(
      [],
    ));

  test("a skill that is gone is found on its line, in its file; a namespace nobody serves is left to its owner", () => {
    const found = checkMap(
      options("LIFECYCLE.md", { scan: [at("docs/process-stale.md")] }),
    ).findings;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      rule: "skill-unresolved",
      file: "docs/process-stale.md",
      line: 3,
    });
    expect(found[0]?.problem).toContain("/jig:gone");
  });

  test("a fence opened and closed on one line is inline code, not a block that hides the rest", () => {
    const found = checkMap(
      options("LIFECYCLE.md", { scan: [at("docs/process-inline-fence.md")] }),
    ).findings;
    expect(found.map((f) => [f.line, f.rule])).toEqual([
      [5, "skill-unresolved"],
    ]);
  });

  test("a comment opener written as code or escaped hides nothing after it, and a quote or apostrophe after a backslash ends no argument", () => {
    const found = checkMap(
      options("LIFECYCLE.md", {
        scan: [at("docs/process-literal-comment.md")],
      }),
    ).findings;
    expect(found.map((f) => [f.line, f.problem.split(" ")[0]])).toEqual([
      [5, "/jig:gone"],
      [9, "/jig:missing"],
      [10, "/jig:absent"],
    ]);
  });

  test("every skill of a chained command is resolved", () => {
    const found = checkMap(
      options("LIFECYCLE.md", { scan: [at("docs/process-chained.md")] }),
    ).findings;
    expect(found).toHaveLength(1);
    expect(found[0]?.problem).toContain("/jig:gone");
  });
});

describe("reach", () => {
  test("a file that does not link the map fails", () => {
    const found = checkMap(
      options("LIFECYCLE.md", { linkedFrom: at("AGENTS-unlinked.md") }),
    ).findings;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      rule: "map-not-linked",
      file: "AGENTS-unlinked.md",
    });
  });
});

describe("reach, as a reader sees it", () => {
  test("a link in a code block, a code span or a comment, and an unused definition, are not a link", () =>
    expect(
      rules("LIFECYCLE.md", { linkedFrom: at("AGENTS-hidden.md") }),
    ).toEqual(["map-not-linked"]));

  test("a definition inside a code span, or inside a paragraph, defines no link", () =>
    expect(
      rules("LIFECYCLE.md", {
        linkedFrom: at("AGENTS-definition-in-code.md"),
      }),
    ).toEqual(["map-not-linked"]));

  test("a reference link counts", () =>
    expect(
      rules("LIFECYCLE.md", { linkedFrom: at("AGENTS-reference.md") }),
    ).toEqual([]));

  test("a link from the root counts", () =>
    expect(
      rules("LIFECYCLE.md", { linkedFrom: at("AGENTS-rooted.md") }),
    ).toEqual([]));
});

describe("helpers", () => {
  test("a skill is a directory with a SKILL.md or a command file", () => {
    expect(skillNames(at("plugin/skills"))).toEqual([
      "do-item",
      "drive-pr",
      "file-issue",
      "orphan",
    ]);
    expect(skillNames(at(".claude/commands"))).toEqual(["ship"]);
  });

  test("skillRef reads a name, a namespaced name and ignores a path or a command", () => {
    expect(skillRef("/followup 12")).toEqual({
      namespace: "",
      name: "followup",
    });
    expect(skillRef("/jig:do-item")).toEqual({
      namespace: "jig",
      name: "do-item",
    });
    expect(skillRef("/etc/hosts")).toBeUndefined();
    expect(skillRef("bun run gates")).toBeUndefined();
  });

  test("render reads single and double backtick spans", () =>
    expect(render("`a` and ``b`c``").spans).toEqual(["a", "b`c"]));

  test("commandSegments splits a chain on operators outside quotes and escapes", () => {
    expect(commandSegments(`a --m 'x;y' && b "p | q" || c; d | e`)).toEqual([
      `a --m 'x;y'`,
      `b "p | q"`,
      "c",
      "d",
      "e",
    ]);
    expect(
      commandSegments(`a --m "say \\"hi" && b it\\'s; c 'x\\' | d`),
    ).toEqual([`a --m "say \\"hi"`, `b it\\'s`, `c 'x\\'`, "d"]);
  });
});

describe("the command", () => {
  const map = at("LIFECYCLE.md");

  test("a clean map exits 0 and says what it resolved", () => {
    const r = run([map, ...flags, "--cover", at("plugin/skills")]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("7 stages");
  });

  test("a violation exits 1 and prints the file, line, rule and fix", () => {
    const r = run([at("maps/unresolved.md"), ...flags]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("maps/unresolved.md:3: [owner-unresolved]");
    expect(r.stderr).toContain("fix:");
  });

  test("a map that cannot be read exits 2", () => {
    const r = run([at("maps/absent.md"), ...flags]);
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("could not check");
  });

  test("a --cover directory that cannot be listed exits 2", () =>
    expectSpawnExit(run([map, ...flags, "--cover", at("absent")]), 2));

  test("no map, two maps and an unknown option are usage errors", () => {
    expectSpawnExit(run([...flags]), 2);
    expectSpawnExit(run([map, map, ...flags]), 2);
    expectSpawnExit(run([map, "--nonsense"]), 2);
  });

  test("--scan and --linked-from report through the command", () => {
    const r = run([
      map,
      ...flags,
      "--scan",
      at("docs/process-stale.md"),
      "--linked-from",
      at("AGENTS-unlinked.md"),
    ]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("docs/process-stale.md:3: [skill-unresolved]");
    expect(r.stderr).toContain("AGENTS-unlinked.md: [map-not-linked]");
  });

  test("a package.json that is not JSON exits 2", () =>
    expectSpawnExit(
      run([map, ...flags, "--package-json", at("AGENTS.md")]),
      2,
    ));
});
