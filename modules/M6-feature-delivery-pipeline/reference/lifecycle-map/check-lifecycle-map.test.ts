import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  checkMap,
  codeSpans,
  type MapOptions,
  parseStages,
  skillNames,
  skillRef,
} from "./check-lifecycle-map.ts";

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

  test("a placeholder in the owner or the handoff fails; an argument placeholder in a command does not", () => {
    const found = checkMap(options("maps/placeholder.md")).findings;
    expect(found.map((f) => [f.line, f.rule])).toEqual([
      [3, "placeholder"],
      [4, "placeholder"],
    ]);
  });
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

  test("a project with no package.json cannot resolve a script", () => {
    const found = checkMap(
      options("maps/unresolved.md", { packageJson: at("no-package.json") }),
    ).findings;
    expect(found.find((f) => f.line === 6)?.problem).toContain(
      "needs a package.json",
    );
    expect(found.find((f) => f.line === 10)?.problem).toContain(
      "bun run lint needs a package.json",
    );
  });
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

  test("codeSpans reads single and double backtick spans", () =>
    expect(codeSpans("`a` and ``b`c``")).toEqual(["a", "b`c"]));
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

  test("a package.json that is not JSON exits 2", () =>
    expectSpawnExit(
      run([map, ...flags, "--package-json", at("AGENTS.md")]),
      2,
    ));
});
