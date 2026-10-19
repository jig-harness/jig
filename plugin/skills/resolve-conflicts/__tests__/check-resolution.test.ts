/**
 * record.ts and check-resolution.ts against real scratch repositories: the
 * dropped-change check, markers, staging, reasons, escalation, the commit
 * message, and the snapshot's operation identity.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import {
  CONFIG_BASE,
  CONFIG_COMBINED,
  mergeConflict,
  type Run,
  Scratch,
} from "./scratch.ts";
import type { PathEntry, Snapshot } from "../scripts/lib/snapshot.ts";

let s: Scratch;
beforeEach(() => {
  s = new Scratch();
  mergeConflict(s);
  expect(s.script("conflict-map.ts").code).toBe(0);
});
afterEach(() => s.cleanup());

function record(...args: string[]): Run {
  return s.script("record.ts", args);
}
function check(...args: string[]): Run {
  return s.script("check-resolution.ts", args);
}
/** Edit the snapshot JSON by hand, as SKILL.md allows. */
function editSnapshot(edit: (snapshot: Snapshot) => void): void {
  const file = s
    .git(
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "jig/conflicts.json",
    )
    .trim();
  const snapshot = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
  edit(snapshot);
  writeFileSync(file, JSON.stringify(snapshot));
}

describe("deleting the path", () => {
  it("passes with a reason and reports every line either side added", () => {
    s.git("rm", "-q", "src/config.ts");
    expect(
      record(
        "src/config.ts",
        "deleted",
        "--reason",
        "the configuration moves to the gateway",
      ).code,
    ).toBe(0);
    const r = check();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      'note src/config.ts: theirs line 2 dropped: "retries: 5,"',
    );
  });
});

describe("taking one side wholesale (git checkout --ours)", () => {
  beforeEach(() => {
    s.git("checkout", "--ours", "src/config.ts");
    s.git("add", "src/config.ts");
  });

  it("fails as combined and names the other side's dropped lines, including the cleanly merged one", () => {
    expect(record("src/config.ts", "combined").code).toBe(0);
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      'PROBLEM src/config.ts: theirs line 2 dropped: "retries: 5,"',
    );
    // The change git had merged cleanly, outside the conflict region.
    expect(r.stdout).toContain(
      'PROBLEM src/config.ts: theirs line 8 dropped: "return "detailed";"',
    );
  });

  it("passes as ours with a reason, reporting what was dropped", () => {
    expect(
      record(
        "src/config.ts",
        "ours",
        "--reason",
        "this branch replaces the retry policy wholesale",
      ).code,
    ).toBe(0);
    const r = check();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      'note src/config.ts: theirs line 2 dropped: "retries: 5," (decision: ours)',
    );
  });

  it("refuses to record ours without a reason, and fails a hand-written one", () => {
    const refused = record("src/config.ts", "ours");
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("ours needs --reason");

    editSnapshot((snapshot) => {
      (snapshot.paths["src/config.ts"] as PathEntry).resolution.decision =
        "ours";
    });
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("decision 'ours' needs a reason");
  });

  it("fails a side dropping its own lines under its own decision", () => {
    expect(
      record("src/config.ts", "theirs", "--reason", "main supersedes it").code,
    ).toBe(0);
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      'theirs line 2 dropped: "retries: 5,", although the decision keeps theirs',
    );
  });

  it("refuses regenerated for a text path, and fails a hand-written one", () => {
    const refused = record("src/config.ts", "regenerated", "--command", "true");
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain(
      "regenerated applies only to lockfiles and generated files",
    );
    editSnapshot((snapshot) => {
      (snapshot.paths["src/config.ts"] as PathEntry).resolution = {
        decision: "regenerated",
        reason: null,
        command: "true",
        dropped: null,
      };
    });
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "decision 'regenerated' applies only to lockfiles and generated files",
    );
    expect(r.stdout).toContain('theirs line 2 dropped: "retries: 5,"');
  });

  it("fails a hand-written acknowledgement without a why", () => {
    editSnapshot((snapshot) => {
      (snapshot.paths["src/config.ts"] as PathEntry).resolution = {
        decision: "combined",
        reason: null,
        command: null,
        dropped: {
          why: " ",
          lines: [
            { side: "theirs", text: "retries: 5," },
            { side: "theirs", text: 'return "detailed";' },
          ],
        },
      };
    });
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "the dropped-lines acknowledgement needs a nonempty why",
    );
    expect(r.stdout).toContain(
      'PROBLEM src/config.ts: theirs line 2 dropped: "retries: 5,"',
    );
  });

  it("passes as combined once the dropped lines are acknowledged, and only those", () => {
    const r = record(
      "src/config.ts",
      "combined",
      "--dropped",
      "the retry limit moves to the gateway",
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('acknowledged: theirs line 2 "retries: 5,"');
    expect(check().code).toBe(0);
  });
});

describe("a correct combined resolution", () => {
  beforeEach(() => {
    s.write("src/config.ts", CONFIG_COMBINED);
    s.git("add", "src/config.ts");
    expect(
      record(
        "src/config.ts",
        "combined",
        "--reason",
        "kept the retry limit from main and this branch's timeout override",
      ).code,
    ).toBe(0);
  });

  it("passes", () => {
    const r = check();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("the resolution passes");
  });

  it("--message prints the commit-message section", () => {
    const r = check("--message");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      "Conflicts resolved:\n- src/config.ts: combined — kept the retry limit from main and this branch's timeout override\n",
    );
  });

  it("--commit-message prepends git's prepared message without its comments", () => {
    const r = check("--commit-message");
    expect(r.code).toBe(0);
    expect(r.stdout).toStartWith("Merge branch 'main' into feature\n\n");
    expect(r.stdout).not.toContain("#");
    expect(r.stdout).toContain(
      "Conflicts resolved:\n- src/config.ts: combined",
    );
  });

  it("--json carries the result and the message", () => {
    const r = check("--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      exit: 0,
      problems: [],
      escalations: [],
      operation: { kind: "merge" },
      message: expect.stringContaining("Conflicts resolved:\n- src/config.ts"),
    });
  });

  it("finds a conflict marker in another staged file", () => {
    s.write(
      "notes.txt",
      "one\n<<<<<<< HEAD\ntwo\n=======\nthree\n>>>>>>> main\n",
    );
    s.git("add", "notes.txt");
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PROBLEM notes.txt:2: conflict marker in a staged file",
    );
  });

  it("fails when the working tree differs from what is staged", () => {
    s.write("src/config.ts", `${CONFIG_COMBINED}// later edit\n`);
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("the working tree differs from what is staged");
  });
});

describe("unfinished resolutions", () => {
  it("fails on markers left in a staged file, with their lines", () => {
    s.git("add", "src/config.ts");
    expect(record("src/config.ts", "combined").code).toBe(0);
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PROBLEM src/config.ts:2: conflict marker left in the staged file",
    );
    expect(r.stdout).toContain("src/config.ts:9: conflict marker left");
    expect(check("--message").stdout).toBe("");
  });

  it("fails on a path still unmerged (not staged)", () => {
    s.write("src/config.ts", CONFIG_COMBINED);
    expect(record("src/config.ts", "combined").code).toBe(0);
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PROBLEM src/config.ts: still unmerged: resolve it, then git add it",
    );
  });

  it("fails on a resolved path with no decision recorded", () => {
    s.write("src/config.ts", CONFIG_COMBINED);
    s.git("add", "src/config.ts");
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("no decision recorded");
  });
});

describe("escalation", () => {
  it("exits 4 and prints the question", () => {
    expect(
      record(
        "src/config.ts",
        "escalate",
        "--reason",
        "Should the timeout override apply when retries are raised?",
      ).code,
    ).toBe(0);
    const r = check();
    expect(r.code).toBe(4);
    expect(r.stdout).toContain(
      "NEEDS A HUMAN src/config.ts: Should the timeout override apply when retries are raised?",
    );
    expect(check("--message").stdout).toBe("");
  });

  it("refuses escalate without the question", () => {
    const r = record("src/config.ts", "escalate");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("the question to put to a human");
  });
});

describe("derived files", () => {
  beforeEach(() => {
    s.git("merge", "--abort");
    s.commit("Lock the feature dependencies", { "bun.lock": "feature\n" });
    s.git("checkout", "-q", "main");
    s.commit("Lock the main dependencies", { "bun.lock": "main\n" });
    s.git("checkout", "-q", "feature");
    expect(s.gitTry("merge", "main").code).not.toBe(0);
    expect(s.script("conflict-map.ts").code).toBe(0);
    s.write("src/config.ts", CONFIG_COMBINED);
    s.git("checkout", "--theirs", "bun.lock");
    s.write("bun.lock", "regenerated\n");
    s.git("add", "src/config.ts", "bun.lock");
    expect(record("src/config.ts", "combined").code).toBe(0);
  });

  it("a lockfile recorded as anything but regenerated fails", () => {
    expect(record("bun.lock", "combined").code).toBe(0);
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PROBLEM bun.lock: is a lockfile: take the integration side, regenerate it (bun install) and record regenerated",
    );
  });

  it("regenerated records the mapped command and passes", () => {
    expect(record("bun.lock", "regenerated").stdout).toContain(
      "recorded bun.lock: regenerated (bun install)",
    );
    const r = check("--message");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("- bun.lock: regenerated (bun install)\n");
  });

  it("a regenerated lockfile that was not staged again fails", () => {
    expect(record("bun.lock", "regenerated").code).toBe(0);
    s.write("bun.lock", "regenerated again\n");
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PROBLEM bun.lock: the working tree differs from what is staged",
    );
  });
});

/** A catalog whose one generated entry writes `output` with `command`. */
function writeCatalog(
  output: string,
  command: string,
  file = "catalog.yaml",
): void {
  s.write(
    file,
    [
      "areas:",
      "  api:",
      '    paths: ["src/api/**"]',
      "    generated:",
      `      - outputs: [${output}]`,
      '        source: ["src/api/**"]',
      `        command: ${command}`,
      `        check: ${command} --check`,
      "",
    ].join("\n"),
  );
}

describe("a file the change-area catalog declares generated", () => {
  beforeEach(() => {
    s.git("merge", "--abort");
    writeCatalog("openapi.json", "bun run gen:openapi");
    s.overlay("drive:\n  change_areas_catalog: catalog.yaml\n");
    s.commit("Describe the feature API", { "openapi.json": "feature\n" });
    s.git("checkout", "-q", "main");
    s.commit("Describe the main API", { "openapi.json": "main\n" });
    s.git("checkout", "-q", "feature");
    expect(s.gitTry("merge", "main").code).not.toBe(0);
    expect(s.script("conflict-map.ts").code).toBe(0);
    s.write("src/config.ts", CONFIG_COMBINED);
    s.git("checkout", "--theirs", "openapi.json");
    s.write("openapi.json", "regenerated\n");
    s.git("add", "src/config.ts", "openapi.json");
    expect(record("src/config.ts", "combined").code).toBe(0);
  });

  it("fails unless it is recorded regenerated", () => {
    expect(record("openapi.json", "combined").code).toBe(0);
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PROBLEM openapi.json: is a generated file: take the integration side, regenerate it (bun run gen:openapi) and record regenerated",
    );
  });

  it("records the catalog's command and passes", () => {
    expect(record("openapi.json", "regenerated").stdout).toContain(
      "recorded openapi.json: regenerated (bun run gen:openapi)",
    );
    const r = check("--message");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      "- openapi.json: regenerated (bun run gen:openapi)\n",
    );
  });

  it("fails once the catalog replaces the generator the decision was recorded with, until the map runs again", () => {
    expect(record("openapi.json", "regenerated").code).toBe(0);
    writeCatalog("openapi.json", "bun run gen:api");
    s.git("add", "catalog.yaml");
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PROBLEM openapi.json: mapped as generated (bun run gen:openapi), but the configuration and change-area catalog now make it generated (bun run gen:api): run conflict-map.ts again and record the path again",
    );
    s.git("add", "catalog.yaml");
    expect(s.script("conflict-map.ts").code).toBe(0);
    expect(record("openapi.json", "regenerated").code).toBe(0);
    expect(
      record(
        "catalog.yaml",
        "rewritten",
        "--reason",
        "the API generator is renamed",
      ).code,
    ).toBe(0);
    expect(check().code).toBe(0);
  });

  it("fails when the catalog cannot be read at the check, though it could when mapped", () => {
    expect(record("openapi.json", "regenerated").code).toBe(0);
    s.write("catalog.yaml", "areas: [\n");
    s.git("add", "catalog.yaml");
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PROBLEM (conflict map): the generated files the configuration and change-area catalog declare cannot all be read now",
    );
  });
});

describe("a generated declaration the catalog gains after the map", () => {
  beforeEach(() => {
    s.git("merge", "--abort");
    writeCatalog("schema.json", "bun run gen:schema");
    s.overlay("drive:\n  change_areas_catalog: catalog.yaml\n");
    s.commit("Describe the feature API", { "openapi.json": "feature\n" });
    s.git("checkout", "-q", "main");
    s.commit("Describe the main API", { "openapi.json": "main\n" });
    s.git("checkout", "-q", "feature");
    expect(s.gitTry("merge", "main").code).not.toBe(0);
    expect(s.script("conflict-map.ts").code).toBe(0);
    s.write("src/config.ts", CONFIG_COMBINED);
    s.write("openapi.json", "feature\nmain\n");
    s.git("add", "src/config.ts", "openapi.json");
    expect(record("src/config.ts", "combined").code).toBe(0);
    expect(record("openapi.json", "combined").code).toBe(0);
  });

  it("passes the hand-merged file while the catalog does not declare it", () => {
    expect(check().code).toBe(0);
  });

  it("fails the hand-merged file once the catalog declares it generated", () => {
    writeCatalog("openapi.json", "bun run gen:openapi");
    s.git("add", "catalog.yaml");
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PROBLEM openapi.json: mapped as text, but the configuration and change-area catalog now make it generated (bun run gen:openapi): run conflict-map.ts again and record the path again",
    );
  });

  it("classifies by the staged catalog, whatever the working tree's says", () => {
    const mapped = s.read("catalog.yaml");
    writeCatalog("openapi.json", "bun run gen:openapi");
    s.git("add", "catalog.yaml");
    s.write("catalog.yaml", mapped);
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PROBLEM openapi.json: mapped as text, but the configuration and change-area catalog now make it generated (bun run gen:openapi)",
    );
  });

  it("ignores a working-tree catalog that is not staged", () => {
    writeCatalog("openapi.json", "bun run gen:openapi");
    expect(check().code).toBe(0);
  });

  it("ignores a working-tree catalog under an assume-unchanged or skip-worktree flag", () => {
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      const mapped = s.read("catalog.yaml");
      s.git("update-index", flag, "catalog.yaml");
      writeCatalog("openapi.json", "bun run gen:openapi");
      expect(check().code).toBe(0);
      s.git("update-index", flag.replace("--", "--no-"), "catalog.yaml");
      s.write("catalog.yaml", mapped);
    }
  });

  it("reads the configuration from the index too", () => {
    s.overlay(
      "drive:\n  change_areas_catalog: catalog.yaml\nresolve_conflicts:\n  generated:\n    - paths: [openapi.json]\n      command: make openapi\n",
    );
    expect(check().code).toBe(0);
    s.git("add", ".config/jig.yaml");
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PROBLEM openapi.json: mapped as text, but the configuration and change-area catalog now make it generated (make openapi)",
    );
  });

  it("does not read a staged link named .gitattributes as attributes", () => {
    symlinkSync("* conflict-marker-size=50", `${s.root}/.gitattributes`);
    s.write(
      "docs/guide.md",
      "<<<<<<< ours\nguide\n=======\nother\n>>>>>>> theirs\n",
    );
    s.git("add", ".gitattributes", "docs/guide.md");
    expect(check().stdout).toContain(
      "PROBLEM docs/guide.md:1: conflict marker in a staged file",
    );
  });

  it("ignores a .gitattributes file that is untracked or ignored, and refuses one staged outside the operation", () => {
    s.write("src/.gitattributes", "*.ts conflict-marker-size=9\n");
    expect(check().code).toBe(0);
    s.write(".git/info/exclude", "/.gitattributes\n");
    s.write(".gitattributes", "openapi.json -diff\n");
    expect(check().code).toBe(0);
    s.git("add", "src/.gitattributes");
    expect(check().stdout).toContain(
      "PROBLEM src/.gitattributes: staged path is outside this operation",
    );
  });
});

describe("a catalog reached through a symbolic link", () => {
  beforeEach(() => {
    s.git("merge", "--abort");
    writeCatalog("schema.json", "bun run gen:schema", "config/catalog.yaml");
    symlinkSync("config/catalog.yaml", `${s.root}/catalog.yaml`);
    s.overlay("drive:\n  change_areas_catalog: catalog.yaml\n");
    s.commit("Describe the feature API", { "openapi.json": "feature\n" });
    s.git("checkout", "-q", "main");
    s.commit("Describe the main API", { "openapi.json": "main\n" });
    s.git("checkout", "-q", "feature");
    expect(s.gitTry("merge", "main").code).not.toBe(0);
    expect(s.script("conflict-map.ts").code).toBe(0);
    s.write("src/config.ts", CONFIG_COMBINED);
    s.write("openapi.json", "feature\nmain\n");
    s.git("add", "src/config.ts", "openapi.json");
    expect(record("src/config.ts", "combined").code).toBe(0);
    expect(record("openapi.json", "combined").code).toBe(0);
  });

  it("classifies by the link's staged target, whatever the working tree's says", () => {
    const mapped = s.read("config/catalog.yaml");
    writeCatalog("openapi.json", "bun run gen:openapi", "config/catalog.yaml");
    expect(check().code).toBe(0);
    s.git("add", "config/catalog.yaml");
    s.write("config/catalog.yaml", mapped);
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PROBLEM openapi.json: mapped as text, but the configuration and change-area catalog now make it generated (bun run gen:openapi)",
    );
  });
});

describe("an untracked .gitattributes file beside an automatically merged file", () => {
  beforeEach(() => {
    s.git("merge", "--abort");
    s.git("checkout", "-q", "main");
    s.commit("Add the guide", { "docs/guide.md": "guide\n" });
    s.git("checkout", "-q", "feature");
    expect(s.gitTry("merge", "main").code).not.toBe(0);
    expect(s.script("conflict-map.ts").code).toBe(0);
    s.write("src/config.ts", CONFIG_COMBINED);
    s.git("add", "src/config.ts");
    expect(record("src/config.ts", "combined").code).toBe(0);
    expect(check().code).toBe(0);
  });

  it("does not hide a conflict marker staged in a path it governs", () => {
    s.write(
      "docs/guide.md",
      "<<<<<<< ours\nguide\n=======\nother\n>>>>>>> theirs\n",
    );
    s.git("add", "docs/guide.md");
    s.write("docs/.gitattributes", "*.md conflict-marker-size=9\n");
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PROBLEM docs/guide.md:1: conflict marker in a staged file",
    );
  });
});

describe("a catalog reached through a chain of symbolic links", () => {
  beforeEach(() => {
    s.git("merge", "--abort");
    writeCatalog("schema.json", "bun run gen:schema", "config/catalog.yaml");
    writeCatalog("openapi.json", "bun run gen:openapi", "config/other.yaml");
    writeCatalog("openapi.json", "bun run gen:openapi", "alt/catalog.yaml");
    symlinkSync("config", `${s.root}/cfg`);
    symlinkSync("cfg/catalog.yaml", `${s.root}/link.yaml`);
    symlinkSync("link.yaml", `${s.root}/catalog.yaml`);
    s.overlay("drive:\n  change_areas_catalog: catalog.yaml\n");
    s.commit("Describe the feature API", { "openapi.json": "feature\n" });
    s.git("checkout", "-q", "main");
    s.commit("Describe the main API", { "openapi.json": "main\n" });
    s.git("checkout", "-q", "feature");
    expect(s.gitTry("merge", "main").code).not.toBe(0);
    expect(s.script("conflict-map.ts").code).toBe(0);
    s.write("src/config.ts", CONFIG_COMBINED);
    s.write("openapi.json", "feature\nmain\n");
    s.git("add", "src/config.ts", "openapi.json");
    expect(record("src/config.ts", "combined").code).toBe(0);
    expect(record("openapi.json", "combined").code).toBe(0);
    expect(check().code).toBe(0);
  });

  it("ignores a link on the way retargeted in the working tree only", () => {
    rmSync(`${s.root}/link.yaml`);
    symlinkSync("config/other.yaml", `${s.root}/link.yaml`);
    expect(check().code).toBe(0);
  });

  it("fails while a link between the configured path and the file read is retargeted in the index", () => {
    rmSync(`${s.root}/link.yaml`);
    symlinkSync("config/other.yaml", `${s.root}/link.yaml`);
    s.git("add", "link.yaml");
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PROBLEM openapi.json: mapped as text, but the configuration and change-area catalog now make it generated (bun run gen:openapi)",
    );
  });

  it("fails while a linked directory on the way is retargeted in the index", () => {
    rmSync(`${s.root}/cfg`);
    symlinkSync("alt", `${s.root}/cfg`);
    s.git("add", "cfg");
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PROBLEM openapi.json: mapped as text, but the configuration and change-area catalog now make it generated (bun run gen:openapi)",
    );
  });
});

describe("a catalog whose link target climbs out of a linked directory", () => {
  beforeEach(() => {
    s.git("merge", "--abort");
    writeCatalog("schema.json", "bun run gen:schema", "config/defs.yaml");
    writeCatalog("openapi.json", "bun run gen:openapi", "defs.yaml");
    symlinkSync("config/nested", `${s.root}/cfg`);
    symlinkSync("cfg/../defs.yaml", `${s.root}/catalog.yaml`);
    s.overlay("drive:\n  change_areas_catalog: catalog.yaml\n");
    s.commit("Describe the feature API", {
      "openapi.json": "feature\n",
      "config/nested/keep": "",
    });
    s.git("checkout", "-q", "main");
    s.commit("Describe the main API", { "openapi.json": "main\n" });
    s.git("checkout", "-q", "feature");
    expect(s.gitTry("merge", "main").code).not.toBe(0);
    expect(s.script("conflict-map.ts").code).toBe(0);
    s.write("src/config.ts", CONFIG_COMBINED);
    s.write("openapi.json", "feature\nmain\n");
    s.git("add", "src/config.ts", "openapi.json");
    expect(record("src/config.ts", "combined").code).toBe(0);
    expect(record("openapi.json", "combined").code).toBe(0);
    expect(check().code).toBe(0);
  });

  it("classifies by the staged file the system reads, not the one beside the link", () => {
    const mapped = s.read("config/defs.yaml");
    writeCatalog("openapi.json", "bun run gen:openapi", "config/defs.yaml");
    expect(check().code).toBe(0);
    s.git("add", "config/defs.yaml");
    s.write("config/defs.yaml", mapped);
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PROBLEM openapi.json: mapped as text, but the configuration and change-area catalog now make it generated (bun run gen:openapi)",
    );
  });
});

describe.skipIf(process.platform === "win32")(
  "a catalog reached through a link in a directory whose name holds a backslash",
  () => {
    beforeEach(() => {
      s.git("merge", "--abort");
      writeCatalog("openapi.json", "bun run gen:openapi", "generated.yaml");
      writeCatalog("schema.json", "bun run gen:schema", "ordinary.yaml");
      s.write("dir\\name/keep", "");
      symlinkSync("../generated.yaml", `${s.root}/dir\\name/link.yaml`);
      symlinkSync("dir\\name/link.yaml", `${s.root}/catalog.yaml`);
      s.overlay("drive:\n  change_areas_catalog: catalog.yaml\n");
      s.commit("Describe the feature API", { "openapi.json": "feature\n" });
      s.git("checkout", "-q", "main");
      s.commit("Describe the main API", { "openapi.json": "main\n" });
      s.git("checkout", "-q", "feature");
      expect(s.gitTry("merge", "main").code).not.toBe(0);
      expect(s.script("conflict-map.ts").code).toBe(0);
      expect(s.snapshot().paths).toMatchObject({
        "openapi.json": { class: "generated" },
      });
      s.write("src/config.ts", CONFIG_COMBINED);
      s.git("checkout", "--theirs", "openapi.json");
      s.write("openapi.json", "regenerated\n");
      s.git("add", "src/config.ts", "openapi.json");
      expect(record("src/config.ts", "combined").code).toBe(0);
      expect(record("openapi.json", "regenerated").code).toBe(0);
      expect(check().code).toBe(0);
    });

    it("ignores the link retargeted in the working tree only", () => {
      rmSync(`${s.root}/dir\\name/link.yaml`);
      symlinkSync("../ordinary.yaml", `${s.root}/dir\\name/link.yaml`);
      expect(check().code).toBe(0);
    });

    it("fails once the link is retargeted in the index", () => {
      rmSync(`${s.root}/dir\\name/link.yaml`);
      symlinkSync("../ordinary.yaml", `${s.root}/dir\\name/link.yaml`);
      s.git("add", "dir\\name/link.yaml");
      const r = check();
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(
        "PROBLEM openapi.json: mapped as generated (bun run gen:openapi), but the configuration and change-area catalog now make it text",
      );
    });
  },
);

describe("a catalog outside the repository that an obligation command changes", () => {
  beforeEach(() => {
    s.git("merge", "--abort");
    writeCatalog("schema.json", "bun run gen:schema", "../catalog.yaml");
    s.overlay(`drive:\n  change_areas_catalog: ${s.home}/catalog.yaml\n`);
    s.commit("Describe the feature API", { "openapi.json": "feature\n" });
    s.git("checkout", "-q", "main");
    s.commit("Describe the main API", { "openapi.json": "main\n" });
    s.git("checkout", "-q", "feature");
    expect(s.gitTry("merge", "main").code).not.toBe(0);
    expect(s.script("conflict-map.ts").code).toBe(0);
    s.write("src/config.ts", CONFIG_COMBINED);
    s.write("openapi.json", "feature\nmain\n");
    s.git("add", "src/config.ts", "openapi.json");
    expect(record("src/config.ts", "combined").code).toBe(0);
    expect(record("openapi.json", "combined").code).toBe(0);
  });

  it("is read again for the final check", () => {
    const declared = s
      .read("../catalog.yaml")
      .replace("outputs: [schema.json]", "outputs: [openapi.json]");
    writeFileSync(`${s.home}/declared.yaml`, declared);
    writeFileSync(
      `${s.home}/declare.ts`,
      `import { copyFileSync } from "node:fs"; copyFileSync(${JSON.stringify(`${s.home}/declared.yaml`)}, ${JSON.stringify(`${s.home}/catalog.yaml`)});`,
    );
    s.env.JIG__RESOLVE_CONFLICTS__OBLIGATIONS = JSON.stringify([
      {
        check: "Declare the API generated",
        command: `${process.execPath} ${s.home}/declare.ts`,
      },
    ]);
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PROBLEM openapi.json: mapped as text, but the configuration and change-area catalog now make it generated (bun run gen:schema)",
    );
  });
});

describe("a catalog whose file name starts with two dots", () => {
  beforeEach(() => {
    s.git("merge", "--abort");
    writeCatalog("schema.json", "bun run gen:schema", "..catalog.yaml");
    s.overlay("drive:\n  change_areas_catalog: ..catalog.yaml\n");
    s.commit("Describe the feature API", { "openapi.json": "feature\n" });
    s.git("checkout", "-q", "main");
    s.commit("Describe the main API", { "openapi.json": "main\n" });
    s.git("checkout", "-q", "feature");
    expect(s.gitTry("merge", "main").code).not.toBe(0);
    expect(s.script("conflict-map.ts").code).toBe(0);
    s.write("src/config.ts", CONFIG_COMBINED);
    s.write("openapi.json", "feature\nmain\n");
    s.git("add", "src/config.ts", "openapi.json");
    expect(record("src/config.ts", "combined").code).toBe(0);
    expect(record("openapi.json", "combined").code).toBe(0);
  });

  it("is read from the index as a declaration inside the repository", () => {
    const mapped = s.read("..catalog.yaml");
    writeCatalog("openapi.json", "bun run gen:openapi", "..catalog.yaml");
    expect(check().code).toBe(0);
    s.git("add", "..catalog.yaml");
    s.write("..catalog.yaml", mapped);
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PROBLEM openapi.json: mapped as text, but the configuration and change-area catalog now make it generated (bun run gen:openapi)",
    );
  });
});

describe("a conflicted catalog recorded deleted", () => {
  beforeEach(() => {
    s.git("merge", "--abort");
    writeCatalog("schema.json", "bun run gen:schema");
    s.overlay("drive:\n  change_areas_catalog: catalog.yaml\n");
    s.commit("Declare the feature schema");
    s.git("checkout", "-q", "main");
    writeCatalog("schema.json", "bun run gen:main-schema");
    s.commit("Declare the main schema");
    s.git("checkout", "-q", "feature");
    expect(s.gitTry("merge", "main").code).not.toBe(0);
    expect(s.script("conflict-map.ts").code).toBe(0);
    s.write("src/config.ts", CONFIG_COMBINED);
    s.git("add", "src/config.ts");
    expect(record("src/config.ts", "combined").code).toBe(0);
    s.git("rm", "-q", "catalog.yaml");
    expect(
      record(
        "catalog.yaml",
        "deleted",
        "--reason",
        "the schema is no longer generated",
      ).code,
    ).toBe(0);
  });

  it("fails while a catalog recreated on disk is not staged", () => {
    writeCatalog("schema.json", "bun run gen:schema");
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PROBLEM (conflict map): the generated files the configuration and change-area catalog declare could not all be read when the conflicts were mapped",
    );
  });
});

describe("a conflict-marker-size changed after the markers were written", () => {
  beforeEach(() => {
    s.git("merge", "--abort");
    s.commit("Mark conflicts with nine characters", {
      ".gitattributes": "src/config.ts conflict-marker-size=9\n",
    });
    expect(s.gitTry("merge", "main").code).not.toBe(0);
    expect(s.script("conflict-map.ts").code).toBe(0);
    expect(s.read("src/config.ts")).toContain("<<<<<<<<< ");
    s.git("add", "src/config.ts");
    expect(record("src/config.ts", "combined").code).toBe(0);
  });

  it("still finds the markers git wrote once the attribute and the map move to another size", () => {
    s.write(".gitattributes", "src/config.ts conflict-marker-size=7\n");
    s.git("add", ".gitattributes");
    expect(s.script("conflict-map.ts").code).toBe(0);
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PROBLEM src/config.ts:2: conflict marker left in the staged file",
    );
  });
});

describe("the snapshot's identity", () => {
  it("exits 3 when the snapshot belongs to a different operation", () => {
    s.git("merge", "--abort");
    s.git("checkout", "-q", "main");
    s.git("checkout", "-q", "-b", "other");
    s.commit("Other", {
      "src/config.ts": CONFIG_BASE.replace("retries: 3", "retries: 9"),
    });
    const merge = s.gitTry("merge", "feature");
    expect(merge.code).not.toBe(0);
    const r = check();
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("belongs to a different operation");
    expect(r.stderr).toContain("conflict-map.ts");
  });

  it("exits 3 when there is no snapshot at all", () => {
    const file = s
      .git(
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "jig/conflicts.json",
      )
      .trim();
    rmSync(file);
    const r = check();
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("Run conflict-map.ts first");
  });

  it("record.ts exits 2 for a path that is not mapped", () => {
    const r = record("src/other.ts", "combined");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("src/config.ts");
  });
});

describe("attributes the commit does not carry", () => {
  /** Stage src/config.ts with git's markers still in it, recorded combined. */
  function stageWithMarkers(): void {
    s.git("add", "src/config.ts");
    expect(record("src/config.ts", "combined").code).toBe(0);
  }

  it("a staged link named .gitattributes does not make a mapped path binary", () => {
    symlinkSync("* -diff", `${s.root}/.gitattributes`);
    s.git("add", ".gitattributes");
    expect(s.script("conflict-map.ts").code).toBe(0);
    stageWithMarkers();
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(
      /PROBLEM src\/config\.ts:\d+: conflict marker left in the staged file/,
    );
  });

  it("markers written at a size only an untracked file declares are found", () => {
    s.git("merge", "--abort");
    s.write("src/.gitattributes", "*.ts conflict-marker-size=9\n");
    s.write(".git/info/exclude", "/src/.gitattributes\n");
    expect(
      s.gitTry("-c", "merge.conflictStyle=diff3", "merge", "main").code,
    ).not.toBe(0);
    expect(s.read("src/config.ts")).toContain("<<<<<<<<< ");
    expect(s.script("conflict-map.ts").code).toBe(0);
    stageWithMarkers();
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(
      /PROBLEM src\/config\.ts:\d+: conflict marker left in the staged file/,
    );
  });

  it("info/attributes, core.attributesFile and the system's file do not make a mapped path binary", () => {
    s.write(".git/info/attributes", "src/config.ts -diff\n");
    s.write("user-attributes", "src/config.ts binary\n");
    s.git("config", "core.attributesFile", `${s.root}/user-attributes`);
    expect(s.script("conflict-map.ts").code).toBe(0);
    stageWithMarkers();
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(
      /PROBLEM src\/config\.ts:\d+: conflict marker left in the staged file/,
    );
  });

  it("an attribute outside the commit does not hide markers in another staged file", () => {
    s.write(".git/info/attributes", "notes.txt -diff\n");
    s.write(
      "notes.txt",
      "one\n<<<<<<< HEAD\ntwo\n=======\nthree\n>>>>>>> main\n",
    );
    s.git("add", "notes.txt");
    expect(s.script("conflict-map.ts").code).toBe(0);
    const r = check();
    expect(r.stdout).toContain(
      "PROBLEM notes.txt:2: conflict marker in a staged file",
    );
  });

  it("markers written at a size from a file removed before the first map are found", () => {
    s.git("merge", "--abort");
    s.write("src/.gitattributes", "*.ts conflict-marker-size=9\n");
    s.write(".git/info/exclude", "/src/.gitattributes\n");
    expect(
      s.gitTry("-c", "merge.conflictStyle=diff3", "merge", "main").code,
    ).not.toBe(0);
    expect(s.read("src/config.ts")).toContain("<<<<<<<<< ");
    rmSync(`${s.root}/src/.gitattributes`);
    expect(s.script("conflict-map.ts").code).toBe(0);
    stageWithMarkers();
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(
      /PROBLEM src\/config\.ts:\d+: conflict marker left in the staged file/,
    );
  });

  it("a merge driver only an untracked file selects does not make its result automatic", () => {
    const guide = "one\ntwo\nthree\nfour\nfive\n";
    const root = s.git("rev-list", "--max-parents=0", "main").trim();
    s.git("merge", "--abort");
    s.git("config", "merge.keepours.driver", "true");
    s.git("checkout", "-q", "-b", "base2", root);
    s.commit("Add the guide", { "docs/guide.md": guide });
    s.git("checkout", "-q", "-b", "feature2");
    s.commit("Feature", {
      "docs/guide.md": guide.replace("one", "ONE"),
      "src/config.ts": CONFIG_BASE.replace(
        "  retries: 3,\n",
        "  retries: 3,\n  timeoutOverride: true,\n",
      ),
    });
    s.git("checkout", "-q", "base2");
    s.commit("Main", {
      "docs/guide.md": guide.replace("five", "FIVE"),
      "src/config.ts": CONFIG_BASE.replace("retries: 3", "retries: 5"),
    });
    s.git("checkout", "-q", "feature2");
    s.write("docs/.gitattributes", "*.md merge=keepours\n");
    s.write(".git/info/exclude", "/docs/.gitattributes\n");
    expect(s.gitTry("merge", "base2").code).not.toBe(0);
    expect(s.read("docs/guide.md")).toBe(guide.replace("one", "ONE"));
    expect(s.script("conflict-map.ts").code).toBe(0);
    s.write(
      "src/config.ts",
      CONFIG_BASE.replace(
        "  retries: 3,\n",
        "  retries: 5,\n  timeoutOverride: true,\n",
      ),
    );
    s.git("add", "src/config.ts");
    expect(record("src/config.ts", "combined").code).toBe(0);
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PROBLEM docs/guide.md: staged content differs from Git's automatic result",
    );
  });

  it("a merge driver only info/attributes selects does not make its result automatic", () => {
    const guide = "one\ntwo\nthree\nfour\nfive\n";
    const root = s.git("rev-list", "--max-parents=0", "main").trim();
    s.git("merge", "--abort");
    s.git("config", "merge.keepours.driver", "true");
    s.git("checkout", "-q", "-b", "base2", root);
    s.commit("Add the guide", { "docs/guide.md": guide });
    s.git("checkout", "-q", "-b", "feature2");
    s.commit("Feature", {
      "docs/guide.md": guide.replace("one", "ONE"),
      "src/config.ts": CONFIG_BASE.replace(
        "  retries: 3,\n",
        "  retries: 3,\n  timeoutOverride: true,\n",
      ),
    });
    s.git("checkout", "-q", "base2");
    s.commit("Main", {
      "docs/guide.md": guide.replace("five", "FIVE"),
      "src/config.ts": CONFIG_BASE.replace("retries: 3", "retries: 5"),
    });
    s.git("checkout", "-q", "feature2");
    s.write(".git/info/attributes", "*.md merge=keepours\n");
    expect(s.gitTry("merge", "base2").code).not.toBe(0);
    expect(s.read("docs/guide.md")).toBe(guide.replace("one", "ONE"));
    expect(s.script("conflict-map.ts").code).toBe(0);
    s.write(
      "src/config.ts",
      CONFIG_BASE.replace(
        "  retries: 3,\n",
        "  retries: 5,\n  timeoutOverride: true,\n",
      ),
    );
    s.git("add", "src/config.ts");
    expect(record("src/config.ts", "combined").code).toBe(0);
    const r = check();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "PROBLEM docs/guide.md: staged content differs from Git's automatic result",
    );
  });
});
