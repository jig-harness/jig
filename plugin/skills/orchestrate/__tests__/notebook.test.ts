import { describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  enclosingWorkTree,
  missingSections,
  STATE_SECTIONS,
  topicSlug,
} from "../scripts/notebook.ts";

const script = resolve(import.meta.dir, "../scripts/notebook.ts");
const fixtureHome = resolve(import.meta.dir, "fixtures/jig-home");

/** A JIG_HOME outside every working tree, optionally seeded with the fixture. */
function home(seed: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "orchestrate-notebook-"));
  expect(enclosingWorkTree(dir)).toBeUndefined();
  if (seed) cpSync(fixtureHome, dir, { recursive: true });
  return dir;
}

function run(jigHome: string, args: string[], stdin = "") {
  const result = Bun.spawnSync([process.execPath, script, ...args], {
    env: { ...process.env, JIG_HOME: jigHome },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ...result,
    out: new TextDecoder().decode(result.stdout),
    err: new TextDecoder().decode(result.stderr),
  };
}

function stateText(extra = ""): string {
  return [
    "# release-cadence",
    ...STATE_SECTIONS.flatMap((name) => ["", `## ${name}`, "", "None."]),
    extra,
  ].join("\n");
}

describe("the notebook's topic and place", () => {
  test("one topic however it is written", () => {
    expect(topicSlug("Release cadence")).toBe("release-cadence");
    expect(topicSlug("  release--cadence! ")).toBe("release-cadence");
    expect(topicSlug("../../etc")).toBe("etc");
    expect(topicSlug("!!!")).toBeUndefined();
    expect(topicSlug("x".repeat(100))).toHaveLength(64);
  });

  test("a JIG_HOME inside a working tree is refused and nothing is written", () => {
    const tree = home(false);
    mkdirSync(join(tree, ".git"));
    const jigHome = join(tree, "nested", "jig-home");
    const result = run(jigHome, ["open", "release-cadence"]);
    expectSpawnExit(result, 3);
    expect(result.err).toContain("inside the Git working tree");
    expect(existsSync(join(tree, "nested"))).toBeFalse();
    expectSpawnExit(run(jigHome, ["state", "release-cadence"], stateText()), 3);
    expectSpawnExit(run(jigHome, ["journal", "release-cadence"], "entry"), 3);
    expect(existsSync(join(tree, "nested"))).toBeFalse();
  });

  test("a linked worktree's .git file counts as a working tree", () => {
    const tree = home(false);
    writeFileSync(join(tree, ".git"), "gitdir: /elsewhere\n");
    expect(enclosingWorkTree(join(tree, "a", "b"))).toBe(tree);
  });

  test("the fixture in this repository is itself refused as a JIG_HOME", () => {
    expectSpawnExit(run(fixtureHome, ["open", "release-cadence"]), 3);
  });
});

describe("resuming from the notebook alone", () => {
  test("open prints the decisions waiting and the owed acts, never the journal", () => {
    const jigHome = home(true);
    const result = run(jigHome, ["open", "Release cadence"]);
    expectSpawnExit(result, 0);
    const out = result.out;
    expect(out).toContain(
      `notebook: ${join(jigHome, "orchestrate", "release-cadence")}`,
    );
    expect(out).toContain(
      "resume (Claude Code): /jig:orchestrate release-cadence",
    );
    expect(out).toContain(
      "resume (Codex): Use the jig:orchestrate skill: release-cadence",
    );
    expect(out).toContain("1 day(s), 2026-11-17 to 2026-11-17");
    expect(out).toContain("## Waiting on the person");
    expect(out).toContain(
      "Should a release wait for a red nightly run? Recommended: no",
    );
    expect(out).toContain("## Owed");
    expect(out).toContain(
      "File the agreed release-train issue once decision 1 is answered (due 2026-11-20)",
    );
    expect(out).toContain("Ask decision 1 again");
    expect(out).not.toContain("The person ruled that release notes");
  });

  test("nothing in the output names an agent's profile or memory", () => {
    const result = run(home(true), ["open", "release-cadence"]);
    expectSpawnExit(result, 0);
    for (const word of [
      ".claude",
      ".codex",
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "memory",
    ])
      expect(result.out).not.toContain(word);
  });

  test("a new topic gets its folder and no state yet", () => {
    const jigHome = home(false);
    const result = run(jigHome, ["open", "new", "topic"]);
    expectSpawnExit(result, 0);
    expect(result.out).toContain("(new topic: created)");
    expect(result.out).toContain("none yet");
    expect(
      existsSync(join(jigHome, "orchestrate", "new-topic", "journal")),
    ).toBeTrue();
  });
});

describe("writing the notebook", () => {
  test("state.md is rewritten whole", () => {
    const jigHome = home(true);
    const path = join(jigHome, "orchestrate", "release-cadence", "state.md");
    expectSpawnExit(
      run(jigHome, ["state", "release-cadence"], stateText("first")),
      0,
    );
    expectSpawnExit(
      run(jigHome, ["state", "release-cadence"], stateText("second")),
      0,
    );
    const text = readFileSync(path, "utf8");
    expect(text).toContain("second");
    expect(text).not.toContain("first");
    expect(text).not.toContain("red nightly run");
    expect(
      readdirSync(join(jigHome, "orchestrate", "release-cadence")).sort(),
    ).toEqual(["journal", "state.md"]);
  });

  test("a state missing a section is refused and the old one stays", () => {
    const jigHome = home(true);
    const path = join(jigHome, "orchestrate", "release-cadence", "state.md");
    const before = readFileSync(path, "utf8");
    const result = run(
      jigHome,
      ["state", "release-cadence"],
      "# x\n\n## Focus\n\nOnly this.\n",
    );
    expectSpawnExit(result, 3);
    expect(result.err).toContain('"## Waiting on the person"');
    expect(readFileSync(path, "utf8")).toBe(before);
    expectSpawnExit(run(jigHome, ["state", "release-cadence"], "  \n"), 3);
  });

  test("a long state is written with a warning", () => {
    const jigHome = home(false);
    const long = stateText(
      Array.from({ length: 200 }, (_, i) => `- line ${i}`).join("\n"),
    );
    const result = run(jigHome, ["state", "release-cadence"], long);
    expectSpawnExit(result, 0);
    expect(result.err).toContain("over 150");
  });

  test("the journal is only appended to, one file a day", () => {
    const jigHome = home(true);
    expectSpawnExit(
      run(jigHome, ["journal", "release-cadence"], "Decision one, because."),
      0,
    );
    expectSpawnExit(
      run(jigHome, ["journal", "release-cadence"], "Decision two, because."),
      0,
    );
    const journal = join(jigHome, "orchestrate", "release-cadence", "journal");
    const days = readdirSync(journal).sort();
    expect(days).toContain("2026-11-17.md");
    const today = days.find((d) => d !== "2026-11-17.md") ?? "2026-11-17.md";
    const text = readFileSync(join(journal, today), "utf8");
    expect(text.indexOf("Decision one")).toBeLessThan(
      text.indexOf("Decision two"),
    );
    expect(text).toMatch(/^## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/m);
    expect(readFileSync(join(journal, "2026-11-17.md"), "utf8")).toContain(
      "The person ruled",
    );
    expectSpawnExit(run(jigHome, ["journal", "release-cadence"], "\n"), 3);
  });

  test("list names each topic with when its state was written", () => {
    const jigHome = home(true);
    expectSpawnExit(run(jigHome, ["open", "other"]), 0);
    const result = run(jigHome, ["list"]);
    expectSpawnExit(result, 0);
    expect(result.out).toMatch(/^other\tno state yet$/m);
    expect(result.out).toMatch(/^release-cadence\t\d{4}-/m);
  });

  test("usage errors exit 2", () => {
    const jigHome = home(false);
    expectSpawnExit(run(jigHome, []), 2);
    expectSpawnExit(run(jigHome, ["open"]), 2);
    expectSpawnExit(run(jigHome, ["open", "!!!"]), 2);
    expectSpawnExit(run(jigHome, ["list", "extra"]), 2);
  });

  test("the fixture's state carries every section the writer requires", () => {
    const fixture = readFileSync(
      join(fixtureHome, "orchestrate", "release-cadence", "state.md"),
      "utf8",
    );
    expect(missingSections(fixture)).toEqual([]);
  });
});
