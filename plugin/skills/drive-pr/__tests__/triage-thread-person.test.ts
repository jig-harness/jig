/** A fresh accepted reply to a bot's thread never overrules a person's thread on its file. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import { readState, writeState } from "./state-rows.ts";
import {
  type ListedThreadFixture,
  postedCount,
  runTriage,
  useTriageForge,
  writeFixtureDir,
  writeNode,
  writeThreads,
} from "./triage-thread-fixtures.ts";

useTriageForge();

const FILE = "docs/routing.md";
const ACCEPTED = "**accepted** — restored the refusal; not yet pushed.";

const bot = (body: string) => ({
  author: "review-bot",
  authorAssociation: "NONE",
  authorType: "Bot" as const,
  body,
});
const person = (body: string) => ({
  author: "maintainer",
  authorAssociation: "OWNER",
  body,
});

/** The bot's finding under triage, as the thread read and the list both serve it. */
function botFinding(dir: string, others: ListedThreadFixture[]): void {
  writeNode(dir, { comments: [bot("Reasserting: refuse these models.")] });
  writeThreads(dir, FILE, [
    { id: "PRRT_bot", path: FILE, line: 12, comments: [bot("Reasserting.")] },
    ...others,
  ]);
}

const ruling: ListedThreadFixture = {
  id: "PRRT_person",
  path: FILE,
  isResolved: true,
  comments: [
    person("Ruling: these models stay configurable per repository."),
    person("**accepted** — applied in abc1234."),
  ],
};

function seedRuling(
  stateDir: string,
  verdict: string,
  cls?: string,
  contextAt: string | null = "2026-01-01T00:00:00Z",
): void {
  const state = readState(stateDir, "999") ?? freshState(999);
  writeState(stateDir, "999", {
    ...state,
    rulings: [
      {
        key: "PRRT_bot",
        verdict,
        ...(cls === undefined ? {} : { class: cls }),
        humanDecision: false,
        ...(contextAt === null ? {} : { contextAt }),
        round: 0,
        at: "2026-01-01T00:00:00Z",
      },
    ],
  });
}

describe("triage-thread.ts and a person's thread on the same file", () => {
  it("refuses a fresh accepted reply while a person's resolved thread shares the file, naming the person's words", () => {
    const { dir, stateDir } = writeFixtureDir();
    botFinding(dir, [ruling]);
    const r = runTriage(["PRRT_bot", "999"], ACCEPTED, dir, stateDir);
    expectSpawnExit(r, 5);
    expect(postedCount(dir)).toBe(0);
    expect(r.stderr).toContain(`resolved thread PRRT_person`);
    expect(r.stderr).toContain("these models stay configurable");
    expect(r.stderr).not.toContain("applied in abc1234");
  });

  it("posts once the arbiter's fix-now ruling on the bot's thread is recorded", () => {
    const { dir, stateDir } = writeFixtureDir();
    botFinding(dir, [ruling]);
    seedRuling(stateDir, "fix-now");
    expectSpawnExit(runTriage(["PRRT_bot", "999"], ACCEPTED, dir, stateDir), 0);
    expect(postedCount(dir)).toBe(1);
  });

  it("refuses under a fix-now ruling recorded before a person spoke again on the file", () => {
    const { dir, stateDir } = writeFixtureDir();
    botFinding(dir, [
      {
        ...ruling,
        comments: [
          {
            ...person("Ruling, then a reversal."),
            createdAt: "2026-02-01T00:00:00Z",
          },
        ],
      },
    ]);
    seedRuling(stateDir, "fix-now");
    expectSpawnExit(runTriage(["PRRT_bot", "999"], ACCEPTED, dir, stateDir), 5);
    expect(postedCount(dir)).toBe(0);
  });

  it("refuses under a fix-now ruling when a person edited an older comment after its context was gathered", () => {
    const { dir, stateDir } = writeFixtureDir();
    botFinding(dir, [
      {
        ...ruling,
        comments: [
          {
            ...person("Do not make this change."),
            createdAt: "2025-12-01T00:00:00Z",
            lastEditedAt: "2026-01-02T00:00:00Z",
          },
        ],
      },
    ]);
    seedRuling(stateDir, "fix-now");
    expectSpawnExit(runTriage(["PRRT_bot", "999"], ACCEPTED, dir, stateDir), 5);
    expect(postedCount(dir)).toBe(0);
  });

  it("refuses under a fix-now ruling that names no context time", () => {
    const { dir, stateDir } = writeFixtureDir();
    botFinding(dir, [ruling]);
    seedRuling(stateDir, "fix-now", undefined, null);
    expectSpawnExit(runTriage(["PRRT_bot", "999"], ACCEPTED, dir, stateDir), 5);
    expect(postedCount(dir)).toBe(0);
  });

  it("still refuses under an escalate ruling, which parks the thread instead", () => {
    const { dir, stateDir } = writeFixtureDir();
    botFinding(dir, [ruling]);
    seedRuling(stateDir, "escalate", "human-thread");
    expectSpawnExit(runTriage(["PRRT_bot", "999"], ACCEPTED, dir, stateDir), 5);
    expect(postedCount(dir)).toBe(0);
  });

  it("posts a rejected reply that cites the person's thread", () => {
    const { dir, stateDir } = writeFixtureDir();
    botFinding(dir, [ruling]);
    const body = "**rejected** — the person's ruling on this file settled it.";
    expectSpawnExit(runTriage(["PRRT_bot", "999"], body, dir, stateDir), 0);
    expect(postedCount(dir)).toBe(1);
  });

  it("counts a bot's thread a person answered, but not one carrying only the drive's outcome reply", () => {
    const answered = writeFixtureDir();
    botFinding(answered.dir, [
      {
        id: "PRRT_answered",
        path: FILE,
        isResolved: true,
        comments: [bot("Another finding."), person("Keep it as it is.")],
      },
    ]);
    const a = runTriage(
      ["PRRT_bot", "999"],
      ACCEPTED,
      answered.dir,
      answered.stateDir,
    );
    expectSpawnExit(a, 5);
    expect(a.stderr).toContain("Keep it as it is.");

    const replied = writeFixtureDir();
    botFinding(replied.dir, [
      {
        id: "PRRT_replied",
        path: FILE,
        isResolved: true,
        comments: [
          bot("Another finding."),
          person("**wont-fix** — out of scope."),
        ],
      },
    ]);
    expectSpawnExit(
      runTriage(["PRRT_bot", "999"], ACCEPTED, replied.dir, replied.stateDir),
      0,
    );
  });

  it("does not count a person's thread on another file, or the person's own words on this thread", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, { comments: [bot("Finding."), person("Please fix it.")] });
    writeThreads(dir, FILE, [
      {
        id: "PRRT_bot",
        path: FILE,
        comments: [bot("Finding."), person("Please fix it.")],
      },
      { ...ruling, path: "docs/other.md" },
    ]);
    expectSpawnExit(runTriage(["PRRT_bot", "999"], ACCEPTED, dir, stateDir), 0);
    expect(postedCount(dir)).toBe(1);
  });

  it("counts a thread whose comments could not all be read", () => {
    const { dir, stateDir } = writeFixtureDir();
    botFinding(dir, [
      { id: "PRRT_long", path: FILE, truncated: true, comments: [bot("x")] },
    ]);
    const r = runTriage(["PRRT_bot", "999"], ACCEPTED, dir, stateDir);
    expectSpawnExit(r, 5);
    expect(r.stderr).toContain("more than 100 comments");
  });

  it("refuses without posting when the pull request's threads cannot be read", () => {
    const { dir, stateDir } = writeFixtureDir();
    botFinding(dir, []);
    writeFileSync(join(dir, "threads-fail"), "");
    const r = runTriage(["PRRT_bot", "999"], ACCEPTED, dir, stateDir);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain(
      "whether a person's thread shares its file is unknown",
    );
    expect(postedCount(dir)).toBe(0);
  });

  it("does not check a person's own thread, whose request the pass carries out", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, { comments: [person("Rename this.")] });
    writeThreads(dir, FILE, [ruling]);
    expectSpawnExit(
      runTriage(["PRRT_mine", "999"], ACCEPTED, dir, stateDir),
      0,
    );
    expect(postedCount(dir)).toBe(1);
  });
});
