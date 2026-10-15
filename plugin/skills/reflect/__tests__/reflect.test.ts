/**
 * Capture, reflect and contribute in scratch repositories that share one
 * store: the switch, the journal, the pending folder for removed worktrees,
 * an unavailable store, and escalation.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type ClassIssues,
  escalationDecisions,
  planEscalation,
  type TrackerLookup,
  withinTrackerDeadline,
} from "../scripts/lib/escalation.ts";
import {
  adoptPending,
  appendLines,
  CLAIM_STALE_MS,
} from "../scripts/lib/journal.ts";
import {
  computeState,
  type FindingEvent,
  newId,
} from "../scripts/lib/events.ts";
import { sampleFinding } from "../scripts/store-contract.ts";
import { finding, Machine, Repo, toolFinding } from "./scratch.ts";

let m: Machine;
beforeEach(() => {
  m = new Machine();
});
afterEach(() => m.cleanup());

interface Gathered {
  unsent: FindingEvent[];
  classes: Array<{ class: string; findings: number; example: string }> | null;
  adopted_from_pending: number;
  store_error: string | null;
}

/** A pending folder's files, without the records naming each journal. */
function files(folder: string): string[] {
  return readdirSync(folder).filter((name) => !name.startsWith(".journal-"));
}

function journal(repo: Repo): string {
  return repo.script("journal.ts", ["path"]).stdout.trim();
}

describe("the switch", () => {
  it("does nothing, and says so, when no layer has a reflection section", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    const r = repo.script("journal.ts", ["note"], JSON.stringify(finding()));
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("reflection is off");
    expect(repo.json("reflect.ts", ["status"])).toEqual({ on: false });
    expect(existsSync(join(repo.root, ".git", "jig"))).toBe(false);
  });

  it("is turned off for one repository by its own file", () => {
    m.userConfig();
    const repo = m.repository("web", "git@github.com:example/web.git");
    repo.write(".config/jig.yaml", "reflection:\n  enabled: false\n");
    expect(repo.json("reflect.ts", ["status"])).toEqual({ on: false });
  });

  it("is turned off for one run by the environment", () => {
    m.userConfig();
    const repo = m.repository("web", "git@github.com:example/web.git");
    const r = repo.script("reflect.ts", ["status"], undefined, undefined, {
      ...m.env,
      JIG__REFLECTION__ENABLED: "false",
    });
    expect(JSON.parse(r.stdout)).toEqual({ on: false });
  });
});

describe("the journal", () => {
  beforeEach(() => m.userConfig());

  it("fills in the id, change and session, and lists the finding as unsent", () => {
    const repo = m.repository(
      "web",
      "git@github.com:Example/Web.git",
      "eng-12-retry",
    );
    repo.write(".config/jig.yaml", "issue_tracker:\n  team: ENG\n");
    const id = repo.note(finding({ session: { model: "a-model" } }), [
      "--skill",
      "drive-pr",
    ]);
    const gathered = repo.json("reflect.ts", ["gather"]) as Gathered;
    expect(gathered.unsent).toHaveLength(1);
    const noted = gathered.unsent[0] as FindingEvent;
    expect(noted.id).toBe(id);
    expect(noted.change).toEqual({
      repository: "github.com/example/web",
      branch: "eng-12-retry",
      pull_request: null,
      issue: "ENG-12",
    });
    expect(noted.session.skills).toEqual(["drive-pr"]);
    expect(noted.session.model).toBe("a-model");
    expect(noted.session.stated).toEqual(["model"]);
    expect(noted.session.jig_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(journal(repo)).toContain(
      join(".git", "jig", "reflection-journal.jsonl"),
    );
  });

  it("refuses a finding that is missing what makes it actionable", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    const r = repo.script(
      "journal.ts",
      ["note"],
      JSON.stringify(finding({ suggested_fix: "" })),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("suggested_fix is required");
  });

  it("notes a recurring fact once", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    const args = ["--fact", "pull-request-7", "--fact", "rounds"];
    const first = repo.json(
      "journal.ts",
      ["note", ...args],
      JSON.stringify(finding()),
    ) as { id: string; noted: boolean };
    const again = repo.json(
      "journal.ts",
      ["note", ...args],
      JSON.stringify(finding()),
    ) as { id: string; noted: boolean };
    expect(again).toEqual({ id: first.id, noted: false });
    expect(first.id).toMatch(/^drv-/);
  });

  it("revises, merges and drops findings before they are sent", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    const a = repo.note(finding());
    const b = repo.note(finding({ title: "The same incident, noted again" }));
    repo.json(
      "journal.ts",
      ["revise", a],
      JSON.stringify({ class: "setup-missing-step", severity: "high" }),
    );
    repo.json("journal.ts", [
      "drop",
      b,
      "--reason",
      "the same incident",
      "--merged-into",
      a,
    ]);
    const unsent = (repo.json("reflect.ts", ["gather"]) as Gathered).unsent;
    expect(unsent.map((f) => [f.id, f.class, f.severity])).toEqual([
      [a, "setup-missing-step", "high"],
    ]);
    const refused = repo.script(
      "journal.ts",
      ["revise", a],
      JSON.stringify({ id: "x" }),
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("id cannot be revised");
  });

  it("refuses a configured journal git would track", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    repo.write(
      ".config/jig.yaml",
      "reflection:\n  journal: notes/journal.jsonl\n",
    );
    const r = repo.script("journal.ts", ["note"], JSON.stringify(finding()));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("a path git would track");
    repo.write(".gitignore", "notes/\n");
    expect(
      repo.script("journal.ts", ["note"], JSON.stringify(finding())).code,
    ).toBe(0);
    expect(existsSync(join(repo.root, "notes", "journal.jsonl"))).toBe(true);
    // An ignore rule does not untrack a journal already committed.
    repo.git("add", "-f", "notes/journal.jsonl");
    repo.git("commit", "-q", "-m", "a committed journal");
    const tracked = repo.script(
      "journal.ts",
      ["note"],
      JSON.stringify(finding()),
    );
    expect(tracked.code).toBe(1);
    expect(tracked.stderr).toContain("a file git already tracks");
  });

  it("checks a journal in a folder whose name starts with two dots", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    repo.write(
      ".config/jig.yaml",
      "reflection:\n  journal: ..notes/journal.jsonl\n",
    );
    const r = repo.script("journal.ts", ["note"], JSON.stringify(finding()));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("a path git would track");
  });
});

describe("contributing", () => {
  beforeEach(() => m.userConfig());

  it("stores the findings, marks them contributed, and reports the classes in use", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    const id = repo.note(finding());
    const out = repo.json("reflect.ts", ["contribute"]) as {
      stored: Array<{ id: string; ref: string }>;
    };
    expect(out.stored.map((s) => s.id)).toEqual([id]);
    expect(out.stored[0]?.ref).toContain(m.store);
    const gathered = repo.json("reflect.ts", ["gather"]) as Gathered;
    expect(gathered.unsent).toEqual([]);
    expect(gathered.classes).toEqual([
      {
        class: "instruction-missing-precondition",
        findings: 1,
        example: "The setup step assumed a running database",
      },
    ]);
    expect(
      (repo.json("reflect.ts", ["contribute"]) as { stored: unknown[] }).stored,
    ).toEqual([]);
  });

  it("keeps the findings in the journal when the store is unavailable", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    const down = join(m.dir, "down.ts");
    writeFileSync(
      down,
      'console.error("the store is down"); process.exit(3);\n',
    );
    repo.write(
      ".config/jig.yaml",
      `reflection:\n  store: command\n  command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(down)}]\n`,
    );
    const id = repo.note(finding());
    const r = repo.script("reflect.ts", ["contribute"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("stay in the journal");
    const unsent = repo.script("journal.ts", ["unsent"]).stdout;
    expect(unsent).toContain(id);
  });

  it("hands a removed worktree's findings to the next reflect in the repository", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    repo.git("worktree", "add", "-q", "-b", "side", join(m.dir, "web-side"));
    const side = new Repo(m, join(m.dir, "web-side"));
    const id = side.note(finding({ title: "Found in a worktree about to go" }));
    const parked = side.json("journal.ts", ["park"]) as {
      parked: number;
      file: string;
    };
    expect(parked.parked).toBe(1);
    expect(side.script("journal.ts", ["unsent"]).stdout).toBe("");
    repo.git("worktree", "remove", "--force", side.root);

    const gathered = repo.json("reflect.ts", ["gather"]) as Gathered;
    expect(gathered.adopted_from_pending).toBe(1);
    expect(gathered.unsent.map((f) => f.id)).toEqual([id]);
    expect(files(dirname(parked.file))).toEqual([]);
    // A second gather adopts nothing again.
    expect(
      (repo.json("reflect.ts", ["gather"]) as Gathered).adopted_from_pending,
    ).toBe(0);
  });

  it("leaves a pending file another reflection has claimed, until its claim is stale", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    repo.git("worktree", "add", "-q", "-b", "side", join(m.dir, "web-side"));
    const side = new Repo(m, join(m.dir, "web-side"));
    const id = side.note(finding());
    const parked = side.json("journal.ts", ["park"]) as { file: string };
    repo.git("worktree", "remove", "--force", side.root);
    const folder = dirname(parked.file);
    const name = basename(parked.file);
    // Claimed for a journal that is gone, as a removed worktree's is.
    writeFileSync(
      join(folder, ".journal-0123456789abcdef"),
      join(m.dir, "gone", "journal.jsonl"),
    );
    const claim = (at: number): string =>
      join(folder, `.claim-${at}-0123456789abcdef-${name}`);
    const fresh = claim(Date.now());
    renameSync(parked.file, fresh);
    expect(
      (repo.json("reflect.ts", ["gather"]) as Gathered).adopted_from_pending,
    ).toBe(0);
    expect(files(folder)).toEqual([basename(fresh)]);
    renameSync(fresh, claim(Date.now() - CLAIM_STALE_MS - 1000));
    const gathered = repo.json("reflect.ts", ["gather"]) as Gathered;
    expect(gathered.adopted_from_pending).toBe(1);
    expect(gathered.unsent.map((f) => f.id)).toEqual([id]);
    expect(files(folder)).toEqual([]);
  });

  it("leaves a stale claim to the journal that took it in, when its removal was cut off", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    const { first, second, file, repository } = parkTwo(repo);
    const folder = dirname(file);
    const owner = join(m.dir, "owner", "journal.jsonl");
    // The owner's append lands; keep its claim as a removal cut off after it.
    let kept = "";
    expect(
      adoptWith(owner, repository, folder, (target, lines) => {
        appendLines(target, lines);
        const claimed = files(folder).find((n) => n.startsWith(".claim-"));
        kept = join(folder, `${claimed}.kept`);
        writeFileSync(kept, readFileSync(join(folder, claimed ?? "")));
      }),
    ).toBe(2);
    const stale = basename(kept, ".kept").replace(
      /^\.claim-[0-9]+-/,
      `.claim-${Date.now() - CLAIM_STALE_MS - 1000}-`,
    );
    renameSync(kept, join(folder, stale));

    const gathered = repo.json("reflect.ts", ["gather"]) as Gathered;
    expect(gathered.adopted_from_pending).toBe(0);
    expect(gathered.unsent).toEqual([]);
    expect(files(folder)).toEqual([]);
    const held = readFileSync(owner, "utf8");
    expect(held).toContain(first);
    expect(held).toContain(second);
  });

  it("adopts back its own parked file when its claim was cut off before the append", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    const id = repo.note(finding());
    const parked = repo.json("journal.ts", ["park"]) as { file: string };
    const folder = dirname(parked.file);
    const path = journal(repo);
    const repository = (
      JSON.parse(
        readFileSync(parked.file, "utf8").split("\n")[0] ?? "",
      ) as FindingEvent
    ).change.repository;
    // Cut off after the claim, before the append: keep the claim, drop the file.
    let kept = "";
    expect(() =>
      adoptWith(path, repository, folder, () => {
        const claimed = files(folder).find((n) => n.startsWith(".claim-"));
        kept = join(folder, `${claimed}.kept`);
        writeFileSync(kept, readFileSync(join(folder, claimed ?? "")));
        throw new Error("killed");
      }),
    ).toThrow("killed");
    rmSync(parked.file);
    const stale = basename(kept, ".kept").replace(
      /^\.claim-[0-9]+-/,
      `.claim-${Date.now() - CLAIM_STALE_MS - 1000}-`,
    );
    renameSync(kept, join(folder, stale));

    const gathered = repo.json("reflect.ts", ["gather"]) as Gathered;
    expect(gathered.adopted_from_pending).toBe(1);
    expect(gathered.unsent.map((f) => f.id)).toEqual([id]);
    expect(files(folder)).toEqual([]);
  });

  it("reports a stale claim no record names a journal for, and leaves it", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    const { file } = parkTwo(repo);
    const folder = dirname(file);
    const claim = join(
      folder,
      `.claim-${Date.now() - CLAIM_STALE_MS - 1000}-fedcba9876543210-${basename(file)}`,
    );
    renameSync(file, claim);
    const r = repo.script("reflect.ts", ["gather"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("could not tell whether the journal");
    expect(files(folder)).toEqual([basename(claim)]);
  });

  it("gives a pending file it could not read back under its own name", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    repo.git("worktree", "add", "-q", "-b", "side", join(m.dir, "web-side"));
    const side = new Repo(m, join(m.dir, "web-side"));
    side.note(finding());
    const parked = side.json("journal.ts", ["park"]) as { file: string };
    repo.git("worktree", "remove", "--force", side.root);
    writeFileSync(parked.file, "{ not json\n");
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = repo.script("reflect.ts", ["gather"]);
      expect(r.code).not.toBe(0);
      expect(files(dirname(parked.file))).toEqual([basename(parked.file)]);
    }
  });

  /** Park two findings in a side worktree, the first with a cut-off send. */
  function parkTwo(repo: Repo) {
    repo.git("worktree", "add", "-q", "-b", "side", join(m.dir, "web-side"));
    const side = new Repo(m, join(m.dir, "web-side"));
    const first = side.note(finding({ title: "First of two" }));
    const second = side.note(finding({ title: "Second of two" }));
    appendFileSync(
      journal(side),
      `${JSON.stringify({ type: "sending", id: first, at: "2026-10-12T15:04:05Z" })}\n`,
    );
    const parked = side.json("journal.ts", ["park"]) as { file: string };
    repo.git("worktree", "remove", "--force", side.root);
    const [line] = readFileSync(parked.file, "utf8").split("\n");
    const repository = (JSON.parse(line ?? "") as FindingEvent).change
      .repository;
    return { first, second, file: parked.file, repository };
  }

  /** Run `adoptPending` against the scratch machine's pending folder. */
  function adoptWith(
    path: string,
    repository: string,
    folder: string,
    append?: (path: string, lines: readonly object[]) => void,
  ): number {
    return adoptPending(path, repository, append, folder);
  }

  it("gives the whole file back when the adoption's write is cut off", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    const { first, second, file, repository } = parkTwo(repo);
    const path = journal(repo);

    expect(() =>
      adoptWith(path, repository, dirname(file), (target, lines) => {
        mkdirSync(dirname(target), { recursive: true });
        const text = JSON.stringify(lines[0]);
        appendFileSync(target, text.slice(0, text.length - 40));
        throw new Error("ENOSPC: no space left on device");
      }),
    ).toThrow("ENOSPC");

    expect(files(dirname(file))).toEqual([basename(file)]);
    const gathered = repo.json("reflect.ts", ["gather"]) as Gathered;
    expect(gathered.adopted_from_pending).toBe(2);
    expect(gathered.unsent.map((f) => f.id).sort()).toEqual(
      [first, second].sort(),
    );
    // The send mark came with its finding, so the finding cannot be revised.
    const revised = repo.script(
      "journal.ts",
      ["revise", first],
      JSON.stringify({ title: "Changed" }),
    );
    expect(revised.code).not.toBe(0);
    expect(revised.stderr).toContain("may already be in the store");
  });

  it("never lands a finding without its send mark when a write fails after its first line", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    const { first, file, repository } = parkTwo(repo);
    const path = journal(repo);

    expect(() =>
      adoptWith(path, repository, dirname(file), (target, lines) => {
        appendLines(target, lines.slice(0, 1));
        throw new Error("ENOSPC: no space left on device");
      }),
    ).toThrow("ENOSPC");

    repo.json("reflect.ts", ["gather"]);
    expect(files(dirname(file))).toEqual([]);
    const revised = repo.script(
      "journal.ts",
      ["revise", first],
      JSON.stringify({ title: "Changed" }),
    );
    expect(revised.code).not.toBe(0);
    expect(revised.stderr).toContain("may already be in the store");
  });

  it("keeps the file with the journal holding its findings when only a send mark was left and its write failed", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    const { first, file, repository } = parkTwo(repo);
    const folder = dirname(file);
    const path = journal(repo);
    // This journal already holds both findings, captured under the same ids,
    // but not the first one's send mark.
    const findings = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.includes('"type":"finding"'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, findings.map((line) => `${line}\n`).join(""));
    const revise = () =>
      repo.script(
        "journal.ts",
        ["revise", first],
        JSON.stringify({ title: "Changed" }),
      );

    expect(() =>
      adoptWith(path, repository, folder, () => {
        throw new Error("ENOSPC: no space left on device");
      }),
    ).toThrow("ENOSPC");
    const aside = files(folder)[0] ?? "";
    expect(aside).toStartWith(".claim-0-");

    // Another journal leaves it to the one that holds its findings.
    const other = join(m.dir, "other-journal.jsonl");
    expect(adoptWith(other, repository, folder)).toBe(0);
    expect(files(folder)).toEqual([aside]);
    expect(existsSync(other)).toBe(false);

    // A revision finishes the adoption first, so it meets the mark.
    const revised = revise();
    expect(revised.code).not.toBe(0);
    expect(revised.stderr).toContain("may already be in the store");
    expect(files(folder)).toEqual([]);
  });

  it("does not send again a finding whose mark waits in its journal's own claim", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    const { first, second, file, repository } = parkTwo(repo);
    const folder = dirname(file);
    const path = journal(repo);
    const findings = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.includes('"type":"finding"'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, findings.map((line) => `${line}\n`).join(""));
    // The cut-off send behind the first finding's mark reached the store.
    const sent = findings.find((line) => line.includes(first)) ?? "";
    const stored = m.run(
      process.execPath,
      [
        join(import.meta.dir, "..", "scripts", "filesystem-store.ts"),
        "--path",
        m.store,
        "append",
      ],
      repo.root,
      `${sent}\n`,
    );
    expect(stored.code).toBe(0);
    expect(() =>
      adoptWith(path, repository, folder, () => {
        throw new Error("ENOSPC: no space left on device");
      }),
    ).toThrow("ENOSPC");
    expect(files(folder)[0]).toStartWith(".claim-0-");

    const out = repo.json("reflect.ts", ["contribute"]) as {
      stored: Array<{ id: string }>;
    };
    expect(out.stored.map((entry) => entry.id)).toEqual([second]);
    expect(files(folder)).toEqual([]);
    expect(repo.script("journal.ts", ["unsent"]).stdout).toBe("");
  });

  it("adopts a claim it holds part of before parking, rather than giving it back", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    const { first, second, file, repository } = parkTwo(repo);
    const folder = dirname(file);
    const path = journal(repo);
    const findings = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.includes('"type":"finding"'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, findings.map((line) => `${line}\n`).join(""));
    expect(() =>
      adoptWith(path, repository, folder, () => {
        throw new Error("ENOSPC: no space left on device");
      }),
    ).toThrow("ENOSPC");

    const parked = repo.json("journal.ts", ["park"]) as {
      parked: number;
      file: string;
    };
    expect(parked.parked).toBe(2);
    expect(files(folder)).toEqual([basename(parked.file)]);
    const lines = readFileSync(parked.file, "utf8");
    expect(lines).toContain(first);
    expect(lines).toContain(second);
    expect(lines).toContain('"type":"sending"');
  });

  it("stamps a claim due for its own journal when that journal cannot be read", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    const { first, second, file, repository } = parkTwo(repo);
    const path = journal(repo);
    const before = existsSync(path) ? readFileSync(path, "utf8") : "";

    expect(() =>
      adoptWith(path, repository, dirname(file), (target) => {
        mkdirSync(dirname(target), { recursive: true });
        appendFileSync(target, "{ damaged\n");
        throw new Error("EIO: write failed");
      }),
    ).toThrow("EIO");
    const aside = files(dirname(file))[0] ?? "";
    expect(aside).toStartWith(".claim-0-");

    // Another journal reports the claim and leaves it.
    const other = join(m.dir, "other-journal.jsonl");
    expect(adoptWith(other, repository, dirname(file))).toBe(0);
    expect(files(dirname(file))).toEqual([aside]);

    // Its own journal refuses to go on while it cannot be read.
    expect(repo.script("reflect.ts", ["gather"]).code).not.toBe(0);
    expect(files(dirname(file))).toEqual([aside]);

    // Once it can, the next gather gives the claim back and adopts it.
    writeFileSync(path, before);
    const gathered = repo.json("reflect.ts", ["gather"]) as Gathered;
    expect(gathered.adopted_from_pending).toBe(2);
    expect(gathered.unsent.map((f) => f.id).sort()).toEqual(
      [first, second].sort(),
    );
    expect(files(dirname(file))).toEqual([]);
  });

  it("carries a cut-off send's mark through parking, and leaves another repository's file", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    repo.git("worktree", "add", "-q", "-b", "side", join(m.dir, "web-side"));
    const side = new Repo(m, join(m.dir, "web-side"));
    const id = side.note(finding());
    writeFileSync(
      journal(side),
      `${readFileSync(journal(side), "utf8")}${JSON.stringify({ type: "sending", id, at: "2026-10-12T15:04:05Z" })}\n`,
    );
    const parked = side.json("journal.ts", ["park"]) as { file: string };
    repo.git("worktree", "remove", "--force", side.root);
    const other = sampleFinding(newId(), "elsewhere");
    const foreign = join(dirname(parked.file), "foreign.jsonl");
    writeFileSync(foreign, `${JSON.stringify(other)}\n`);

    const gathered = repo.json("reflect.ts", ["gather"]) as Gathered;
    expect(gathered.unsent.map((f) => f.id)).toEqual([id]);
    expect(existsSync(foreign)).toBe(true);
    const revised = repo.script(
      "journal.ts",
      ["revise", id],
      JSON.stringify({ severity: "low" }),
    );
    expect(revised.code).toBe(1);
    expect(revised.stderr).toContain("may already be in the store");
  });

  it("escalates every open finding of a class to the issue it is given", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    const first = repo.note(finding());
    repo.json("reflect.ts", ["contribute"]);
    const second = repo.note(finding({ title: "Again" }));
    const tool = repo.note(toolFinding());
    const out = repo.json("reflect.ts", [
      "contribute",
      "--issue",
      "instruction-missing-precondition=ENG-40",
    ]) as {
      escalated: Array<{ finding: string; issue: string }>;
      comments: Array<{ issue: string; posted: boolean }>;
    };
    expect(out.escalated.map((e) => e.finding).sort()).toEqual(
      [first, second].sort(),
    );
    expect(out.escalated.every((e) => e.issue === "ENG-40")).toBe(true);
    expect(out.escalated.map((e) => e.finding)).not.toContain(tool);
    // No tracker is configured here, so the comment is reported, not posted.
    expect(out.comments).toMatchObject([{ issue: "ENG-40", posted: false }]);
  });

  it("refuses an --issue for a class no unsent finding of this repository has", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    repo.note(toolFinding());
    const r = repo.script("reflect.ts", [
      "contribute",
      "--issue",
      "narrow-fix-per-round=ENG-1",
    ]);
    expect(r.code).toBe(2);
  });
});

describe("planning escalation", () => {
  const web = "github.com/example/web";
  function owned(className: string): FindingEvent {
    const f = sampleFinding(newId(), className);
    return {
      ...f,
      class: className,
      change: { ...f.change, repository: web },
      target: { scope: "repository", name: "AGENTS.md" },
    };
  }
  function tracker(issues: Record<string, ClassIssues>): TrackerLookup {
    return {
      label: (c) => `pattern:${c}`,
      issues: async (c) => issues[c] ?? { open: [], closed: [] },
      comment: async () => undefined,
    };
  }

  it("files at the threshold, attaches to an open issue, and stores the rest", async () => {
    const stored = [owned("recurring"), owned("recurring")];
    const fresh = [
      owned("recurring"),
      owned("tracked"),
      owned("rare"),
      sampleFinding(newId(), "a tool's"),
    ];
    const plan = await planEscalation(
      fresh,
      computeState(stored),
      web,
      3,
      tracker({
        tracked: {
          open: [{ identifier: "ENG-9", state: "started" }],
          closed: [],
        },
      }),
    );
    expect(
      plan.classes.map((c) => [c.class, c.count, c.action, c.open_issue]),
    ).toEqual([
      ["rare", 1, "store", null],
      ["recurring", 3, "file", null],
      ["tracked", 1, "attach", "ENG-9"],
    ]);
  });

  it("files nothing when the tracker could not say whether an issue exists", async () => {
    const plan = await planEscalation(
      [owned("recurring"), owned("rare")],
      computeState([owned("recurring"), owned("recurring")]),
      web,
      3,
      {
        label: (c) => `pattern:${c}`,
        issues: async () => {
          throw new Error("the tracker is down");
        },
        comment: async () => undefined,
      },
    );
    expect(plan.classes.map((c) => [c.class, c.action])).toEqual([
      ["rare", "store"],
      ["recurring", "unverified"],
    ]);
    expect(plan.tracker).toContain("tracker unavailable");
  });

  it("ends a tracker call that never answers at its deadline, and cancels it", async () => {
    let given: AbortSignal | undefined;
    const never = (signal: AbortSignal) => {
      given = signal;
      return new Promise<ClassIssues>(() => undefined);
    };
    await expect(
      withinTrackerDeadline(never, "the lookup", 20),
    ).rejects.toThrow("the lookup did not finish within 0.02s");
    expect(given?.aborted).toBe(true);
    expect(await withinTrackerDeadline(async () => 7, "x", 20)).toBe(7);
  });

  it("does not count a closed issue, and names it for the new one to link", async () => {
    const fresh = [
      owned("fixed-once"),
      owned("fixed-once"),
      owned("fixed-once"),
    ];
    const plan = await planEscalation(
      fresh,
      computeState([]),
      web,
      3,
      tracker({
        "fixed-once": {
          open: [],
          closed: [{ identifier: "ENG-2", state: "completed" }],
        },
      }),
    );
    expect(plan.classes[0]).toMatchObject({
      action: "file",
      closed_issues: ["ENG-2"],
    });
  });

  it("escalates only the owner's open and deferred findings of the class", () => {
    const open = owned("recurring");
    const other = {
      ...owned("recurring"),
      change: { ...owned("x").change, repository: "github.com/example/api" },
    };
    const decisions = escalationDecisions(
      "recurring",
      `repository:${web}`,
      "ENG-5",
      [],
      computeState([open, other]),
      sampleFinding(newId(), "s").session,
    );
    expect(decisions.map((d) => [d.finding, d.decision, d.issue])).toEqual([
      [open.id, "escalated", "ENG-5"],
    ]);
  });
});

it("writes each run's events to a file of its own, never changing one", () => {
  m.userConfig();
  const repo = m.repository("web", "git@github.com:example/web.git");
  repo.note(finding());
  repo.json("reflect.ts", ["contribute"]);
  const month = readdirSync(m.store)[0] as string;
  const [file] = readdirSync(join(m.store, month));
  const before = readFileSync(join(m.store, month, file as string), "utf8");
  repo.note(finding({ title: "later" }));
  repo.json("reflect.ts", ["contribute"]);
  expect(readdirSync(join(m.store, month))).toHaveLength(2);
  expect(readFileSync(join(m.store, month, file as string), "utf8")).toBe(
    before,
  );
});

describe("cut-off writes", () => {
  beforeEach(() => m.userConfig());

  it("skips a torn last line, and starts the next write on a fresh line", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    const id = repo.note(finding());
    const path = journal(repo);
    writeFileSync(path, `${readFileSync(path, "utf8")}{"type":"find`);
    const second = repo.note(finding({ title: "after the tear" }));
    const unsent = repo.script("journal.ts", ["unsent"]).stdout;
    expect(unsent).toContain(id);
    expect(unsent).toContain(second);
    // The tear stays explained once more lines follow it.
    const third = repo.note(finding({ title: "later still" }));
    expect(repo.script("journal.ts", ["unsent"]).stdout).toContain(third);
  });

  it("stops at a line no cut-off write explains, rather than read past it", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    const id = repo.note(finding());
    const path = journal(repo);
    writeFileSync(path, `not json\n${readFileSync(path, "utf8")}`);
    for (const r of [
      repo.script("journal.ts", ["unsent"]),
      repo.script("journal.ts", ["park"]),
    ]) {
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("the journal is damaged");
    }
    expect(readFileSync(path, "utf8")).toContain(id);
  });

  it("does not send again, revise or drop a finding whose send may have landed", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    const id = repo.note(finding());
    const noted = repo.script("journal.ts", ["unsent"]).stdout.trim();
    // The store took the finding, but the journal never heard back.
    const stored = m.run(
      process.execPath,
      [
        join(import.meta.dir, "..", "scripts", "filesystem-store.ts"),
        "--path",
        m.store,
        "append",
      ],
      repo.root,
      `${noted}\n`,
    );
    expect(stored.code).toBe(0);
    writeFileSync(
      journal(repo),
      `${readFileSync(journal(repo), "utf8")}${JSON.stringify({ type: "sending", id, at: "2026-10-12T15:04:05Z" })}\n`,
    );
    const revised = repo.script(
      "journal.ts",
      ["revise", id],
      JSON.stringify({ severity: "low" }),
    );
    expect(revised.code).toBe(1);
    expect(revised.stderr).toContain("may already be in the store");
    const out = repo.json("reflect.ts", ["contribute"]) as {
      stored: unknown[];
    };
    expect(out.stored).toEqual([]);
    expect(repo.script("journal.ts", ["unsent"]).stdout).toBe("");
    const month = readdirSync(m.store)[0] as string;
    expect(readdirSync(join(m.store, month))).toHaveLength(1);
  });

  it("parks captured findings even after reflection was turned off", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    const id = repo.note(finding());
    repo.write(".config/jig.yaml", "reflection:\n  enabled: false\n");
    const parked = repo.json("journal.ts", ["park"]) as {
      parked: number;
      file: string;
    };
    expect(parked.parked).toBe(1);
    expect(readFileSync(parked.file, "utf8")).toContain(id);
  });

  it("parks from the configured journal after reflection was turned off", () => {
    const repo = m.repository("web", "git@github.com:example/web.git");
    repo.write(".gitignore", ".scratch/\n");
    repo.write(
      ".config/jig.yaml",
      "reflection:\n  journal: .scratch/journal.jsonl\n",
    );
    const id = repo.note(finding());
    repo.write(
      ".config/jig.yaml",
      "reflection:\n  enabled: false\n  journal: .scratch/journal.jsonl\n",
    );
    const parked = repo.json("journal.ts", ["park"]) as {
      parked: number;
      file: string;
    };
    expect(parked.parked).toBe(1);
    expect(readFileSync(parked.file, "utf8")).toContain(id);
  });
});
