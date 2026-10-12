/**
 * record.ts and check-resolution.ts against real scratch repositories: the
 * dropped-change check, markers, staging, reasons, escalation, the commit
 * message, and the snapshot's operation identity.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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
      "groundwork/conflicts.json",
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
        "groundwork/conflicts.json",
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
