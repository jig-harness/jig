/** Seeded reflection-class vocabularies, loaded only by gather. */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { finding, Machine, type Repo } from "./scratch.ts";

let machine: Machine;
beforeEach(() => {
  machine = new Machine();
});
afterEach(() => machine.cleanup());

type Gathered = {
  classes: Array<{
    class: string;
    findings: number;
    example: string;
    seeded?: true;
    source?: string;
  }> | null;
  store_error: string | null;
};

function gather(repo: Repo): Gathered {
  return repo.json("reflect.ts", ["gather"]) as Gathered;
}

function expectExit(
  result: { code: number; stdout: string; stderr: string },
  code: number,
): void {
  expectSpawnExit(
    { exitCode: result.code, stdout: result.stdout, stderr: result.stderr },
    code,
  );
}

describe("seeded reflection classes", () => {
  it("merges inline classes and YAML vocabulary files across layers", () => {
    machine.userConfig(
      `reflection:\n  path: ${JSON.stringify(machine.store)}\n  classes:\n    - slug: duplicate\n      shape: user inline\n    - slug: user-only\n      shape: user class\n`,
    );
    const repo = machine.repository("web", "git@github.com:example/web.git");
    repo.write(
      "classes.yaml",
      "- slug: duplicate\n  shape: repository file\n- slug: file-only\n  shape: file class\n",
    );
    repo.write(
      ".config/jig.yaml",
      "reflection:\n  classes_from: classes.yaml\n  classes:\n    - slug: duplicate\n      shape: repository inline\n      source: repository register\n",
    );

    const environment = repo.script(
      "reflect.ts",
      ["gather"],
      undefined,
      undefined,
      {
        ...machine.env,
        JIG__REFLECTION__CLASSES: JSON.stringify([
          {
            slug: "duplicate",
            shape: "environment inline",
            source: "environment register",
          },
        ]),
      },
    );
    expectExit(environment, 0);
    expect((JSON.parse(environment.stdout) as Gathered).classes).toEqual([
      {
        class: "duplicate",
        findings: 0,
        example: "environment inline",
        seeded: true,
        source: "environment register",
      },
      { class: "file-only", findings: 0, example: "file class", seeded: true },
      { class: "user-only", findings: 0, example: "user class", seeded: true },
    ]);
  });

  it("reads JSON from a tilde-expanded local path", () => {
    const home = join(machine.dir, "home");
    mkdirSync(home);
    writeFileSync(
      join(home, "classes.json"),
      JSON.stringify([{ slug: "json-class", shape: "A JSON class" }]),
    );
    machine.userConfig(
      `reflection:\n  path: ${JSON.stringify(machine.store)}\n  classes_from: ~/classes.json\n`,
    );
    const repo = machine.repository("web", "git@github.com:example/web.git");
    const result = repo.script("reflect.ts", ["gather"], undefined, undefined, {
      ...machine.env,
      HOME: home,
      USERPROFILE: home,
    });

    expectExit(result, 0);
    expect((JSON.parse(result.stdout) as Gathered).classes).toEqual([
      {
        class: "json-class",
        findings: 0,
        example: "A JSON class",
        seeded: true,
      },
    ]);
  });

  it("uses the seed description and preserves the stored count on collision", () => {
    machine.userConfig(
      `reflection:\n  path: ${JSON.stringify(machine.store)}\n  classes:\n    - slug: instruction-missing-precondition\n      shape: Canonical description\n`,
    );
    const repo = machine.repository("web", "git@github.com:example/web.git");
    repo.note(finding());
    repo.json("reflect.ts", ["contribute"]);

    expect(gather(repo).classes).toEqual([
      {
        class: "instruction-missing-precondition",
        findings: 1,
        example: "Canonical description",
        seeded: true,
      },
    ]);
  });

  it("warns for an unreadable vocabulary but rejects malformed values", () => {
    machine.userConfig(
      `reflection:\n  path: ${JSON.stringify(machine.store)}\n  classes_from: absent.yaml\n  classes:\n    - slug: inline-class\n      shape: An inline class remains\n`,
    );
    const repo = machine.repository("web", "git@github.com:example/web.git");
    const unavailable = repo.script("reflect.ts", ["gather"]);
    expectExit(unavailable, 0);
    expect(unavailable.stderr).toContain("warning: reflection.classes_from");
    expect((JSON.parse(unavailable.stdout) as Gathered).classes).toEqual([
      {
        class: "inline-class",
        findings: 0,
        example: "An inline class remains",
        seeded: true,
      },
    ]);

    machine.userConfig(
      `reflection:\n  path: ${JSON.stringify(machine.store)}\n  classes_from: FILE://classes.yaml\n`,
    );
    const invalid = repo.script("reflect.ts", ["gather"]);
    expectExit(invalid, 1);
    expect(invalid.stderr).toContain(
      "reflection.classes_from must be a local path",
    );
  });

  it("reports a vocabulary parse location without logging file contents", () => {
    const repo = machine.repository("web", "git@github.com:example/web.git");
    machine.userConfig("reflection:\n  classes_from: classes.yaml\n");
    repo.write("classes.yaml", "- [fixture-marker\n- other line\n");

    const result = repo.script("reflect.ts", ["gather"], undefined, undefined, {
      ...machine.env,
      JIG_LOG: "debug",
    });

    expectExit(result, 1);
    expect(result.stderr).toContain("classes.yaml could not be parsed");
    expect(result.stderr).toMatch(/line \d+, column \d+/);
    expect(result.stderr).not.toContain("fixture-marker");
  });

  it("rejects a bad lower-layer slug even when a higher layer masks it", () => {
    machine.userConfig(
      `reflection:\n  path: ${JSON.stringify(machine.store)}\n  classes:\n    - slug: bad_slug\n      shape: user typo\n`,
    );
    const repo = machine.repository("web", "git@github.com:example/web.git");
    repo.write(
      ".config/jig.yaml",
      "reflection:\n  classes:\n    - slug: valid-slug\n      shape: repository class\n",
    );

    const result = repo.script("reflect.ts", ["gather"]);
    expectExit(result, 1);
    expect(result.stderr).toContain("reflection.classes[0].slug");
    expect(result.stderr).toContain(join(machine.home, "jig.yaml"));
  });

  it("keeps zero-count seeds out of planning and review grouping", () => {
    machine.userConfig(
      `reflection:\n  path: ${JSON.stringify(machine.store)}\n  classes:\n    - slug: known-problem\n      shape: A known problem class\n`,
    );
    const repo = machine.repository("web", "git@github.com:example/web.git");
    expect(gather(repo).classes).toEqual([
      {
        class: "known-problem",
        findings: 0,
        example: "A known problem class",
        seeded: true,
      },
    ]);

    expect(
      (repo.json("reflect.ts", ["plan"]) as { classes: unknown[] }).classes,
    ).toEqual([]);
    const review = repo.review(["load"]);
    expectExit(review, 0);
    expect((JSON.parse(review.stdout) as { groups: unknown[] }).groups).toEqual(
      [],
    );
  });

  it("returns seeds when the store cannot be read", () => {
    const down = join(machine.dir, "down.ts");
    writeFileSync(
      down,
      'console.error("the store is down"); process.exit(3);\n',
    );
    machine.userConfig(
      `reflection:\n  store: command\n  command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(down)}]\n  classes:\n    - slug: missing-preflight-guard\n      shape: A preflight guard is absent\n`,
    );
    const repo = machine.repository("web", "git@github.com:example/web.git");

    const result = gather(repo);
    expect(result.store_error).toContain("the store is down");
    expect(result.classes).toEqual([
      {
        class: "missing-preflight-guard",
        findings: 0,
        example: "A preflight guard is absent",
        seeded: true,
      },
    ]);
  });
});
