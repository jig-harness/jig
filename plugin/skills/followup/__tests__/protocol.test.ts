/**
 * The protocol's rules as functions: which arms a run settles, a verdict's
 * evidence, how a run ends, and the authority table configuration can only
 * tighten.
 */
import { describe, expect, test } from "bun:test";
import { CORE_ARMS, planArms } from "../scripts/lib/arms.ts";
import { ACTS, authorityTable } from "../scripts/lib/authority.ts";
import { recordVerdict, type RunFile } from "../scripts/lib/run.ts";
import { parseFollowupSettings } from "../scripts/lib/settings.ts";
import { pendingArm, renderSettled, settle } from "../scripts/lib/settle.ts";
import { factsOf } from "./helpers.ts";

const everything = {
  mode: "post-merge" as const,
  changelog: true,
  orca: true,
  off: [],
};

function runOf(over: Partial<RunFile> = {}): RunFile {
  const facts = factsOf();
  return {
    schema: 1,
    pr: facts.pr,
    startedAt: "2026-11-16T00:00:00.000Z",
    facts,
    arms: planArms(everything),
    verdicts: {},
    marker: 42,
    ...over,
  };
}

/** `run` with every arm settled `not-owed`, then `verdicts` laid on top. */
function settled(run: RunFile, verdicts: Record<string, string> = {}): RunFile {
  let current = run;
  for (const arm of run.arms.apply) {
    const recorded = recordVerdict(
      current,
      arm,
      verdicts[arm] ?? "not-owed",
      `${arm}: checked`,
      [],
    );
    if (!recorded.ok) throw new Error(recorded.failure.reason);
    current = recorded.value;
  }
  return current;
}

describe("the arms a run settles", () => {
  test("every core arm applies after a merge in Orca with a changelog", () => {
    expect(planArms(everything).apply).toEqual(CORE_ARMS.map((a) => a.id));
  });

  test("followup.off removes an arm and names why", () => {
    const plan = planArms({ ...everything, off: ["live-verification"] });
    expect(plan.apply).not.toContain("live-verification");
    expect(plan.skipped).toEqual([
      {
        id: "live-verification",
        reason: "turned off by the repository (followup.off)",
      },
    ]);
  });

  test("the release arm needs changelog.file, the board needs Orca and a merge", () => {
    expect(planArms({ ...everything, changelog: false }).apply).not.toContain(
      "release",
    );
    expect(planArms({ ...everything, orca: false }).apply).not.toContain(
      "workspace-board",
    );
    expect(planArms({ ...everything, mode: "preview" }).apply).not.toContain(
      "workspace-board",
    );
  });

  test("followup.off is read from the configuration, and an unknown arm is refused", () => {
    const read = parseFollowupSettings({
      followup: { off: ["workspace-board"] },
    });
    expect(read.ok && read.value.off).toEqual(["workspace-board"]);
    const unknown = parseFollowupSettings({ followup: { off: ["website"] } });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.failure.reason).toContain("no core arm");
  });
});

describe("recording a verdict", () => {
  test("empty evidence is refused", () => {
    const refused = recordVerdict(runOf(), "tracker", "owed", "   ", ["#3"]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.failure.code).toBe("empty-evidence");
  });

  test("'nothing found' is not evidence", () => {
    const refused = recordVerdict(
      runOf(),
      "scaffolding",
      "not-owed",
      "Nothing found.",
      [],
    );
    expect(refused.ok).toBe(false);
  });

  test("a skipped arm and an unknown verdict are refused", () => {
    const run = runOf({ arms: planArms({ ...everything, orca: false }) });
    const skipped = recordVerdict(
      run,
      "workspace-board",
      "not-owed",
      "no card",
      [],
    );
    expect(skipped.ok).toBe(false);
    if (!skipped.ok) expect(skipped.failure.code).toBe("skipped-arm");
    const verdict = recordVerdict(run, "tracker", "done", "moved", []);
    expect(verdict.ok).toBe(false);
  });

  test("a verdict keeps its evidence and its items", () => {
    const recorded = recordVerdict(
      runOf(),
      "deferred-findings",
      "owed",
      "two deferred threads had no item; filed both",
      ["ENG-40", " ", "ENG-41"],
    );
    expect(recorded.ok).toBe(true);
    if (recorded.ok)
      expect(recorded.value.verdicts["deferred-findings"]).toMatchObject({
        verdict: "owed" as const,
        items: ["ENG-40", "ENG-41"],
      });
  });
});

describe("settling a run", () => {
  test("done is refused while an arm has no verdict, naming it", () => {
    const run = settled(runOf());
    const { "next-step": _, ...rest } = run.verdicts;
    const refused = settle({ ...run, verdicts: rest });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.failure.code).toBe("unsettled");
      expect(refused.failure.reason).toContain("next-step");
    }
  });

  test("every arm settled ends done, with one row per arm", () => {
    const answer = settle(settled(runOf()));
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value.ending).toBe("done");
    expect(answer.value.rows.map((r) => r.arm)).toEqual(
      CORE_ARMS.map((a) => a.id),
    );
    const text = renderSettled(answer.value);
    expect(text).toContain("Nothing is owed.");
    expect(text).toContain("jig dispatch marker done 7 --comment 42");
  });

  test("escapes backslashes before table delimiters in report evidence", () => {
    const run = settled(runOf());
    const changed = {
      ...run,
      verdicts: {
        ...run.verdicts,
        release: {
          verdict: "owed" as const,
          items: [],
          at: run.startedAt,
          evidence: "path\\|value",
        },
      },
    };
    const answer = settle(changed);
    expect(answer.ok).toBe(true);
    if (answer.ok)
      expect(renderSettled(answer.value)).toContain("path\\\\\\|value");
  });

  test("a pending arm ends as a wait, an unread one as failed", () => {
    const wait = settle(settled(runOf(), { release: "pending" }));
    expect(wait.ok && wait.value.ending).toBe("wait");
    expect(wait.ok && wait.value.because).toEqual(["release"]);
    const failedRun = settle(
      settled(runOf(), { release: "pending", tracker: "unread" }),
    );
    expect(failedRun.ok && failedRun.value.ending).toBe("failed");
    expect(failedRun.ok && failedRun.value.because).toEqual(["tracker"]);
  });

  test("a wait tells a dispatched pass to record a pending wait naming the arm, and a hand run to mark done", () => {
    const wait = settle(settled(runOf(), { release: "pending" }));
    expect(wait.ok).toBe(true);
    if (!wait.ok) return;
    const text = renderSettled(wait.value);
    expect(text).toContain(
      'waits --until <when to look again> --reason pending --arm "<arm>"',
    );
    expect(pendingArm(wait.value)).toStartWith("release: ");
    expect(text).toContain(pendingArm(wait.value));
    expect(text).toContain("jig dispatch marker done 7 --comment 42");
    expect(text).not.toContain("record done");
  });

  test("the pending arm stays within what --arm takes", () => {
    const wait = settle(settled(runOf(), { release: "pending" }));
    if (!wait.ok) throw new Error(wait.failure.reason);
    const long = {
      ...wait.value,
      rows: wait.value.rows.map((r) =>
        r.verdict === "pending" ? { ...r, evidence: "x ".repeat(300) } : r,
      ),
    };
    expect(pendingArm(long).length).toBeLessThanOrEqual(200);
  });

  test("a preview carries out nothing: no marker, no result to record", () => {
    const preview = runOf({
      facts: factsOf({ mode: "preview", mergeSha: null }),
      arms: planArms({ ...everything, mode: "preview" }),
    });
    const answer = settle(settled(preview, { tracker: "owed" }));
    expect(answer.ok && answer.value.ending).toBe("preview");
    if (!answer.ok) return;
    const text = renderSettled(answer.value);
    expect(text).toContain("Nothing was carried out");
    expect(text).not.toContain("jig dispatch");
    expect(
      answer.value.rows.find((r) => r.arm === "workspace-board")?.verdict,
    ).toBe("skipped");
  });
});

describe("the authority table", () => {
  test("configuration may tighten an act", () => {
    const read = parseFollowupSettings({
      followup: { authority: { "file-items": "ask" } },
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const row = authorityTable(read.value.authority).find(
      (r) => r.id === "file-items",
    );
    expect(row).toMatchObject({ level: "ask", tightened: true });
  });

  test("configuration never loosens an act", () => {
    for (const [id, level] of [
      ["merge", "own"],
      ["other-repository", "ask"],
      ["origin-boundary", "own"],
      ["stop-driver", "own"],
    ] as const) {
      const read = parseFollowupSettings({
        followup: { authority: { [id]: level } },
      });
      expect([id, read.ok]).toEqual([id, false]);
      if (!read.ok) expect(read.failure.reason).toContain("would loosen it");
    }
  });

  test("the fixed table never merges, and leaves another repository to a person", () => {
    const table = authorityTable({});
    expect(table.find((r) => r.id === "merge")?.level).toBe("never");
    expect(table.find((r) => r.id === "other-repository")?.level).toBe(
      "person",
    );
    expect(table.map((r) => r.id)).toEqual(ACTS.map((a) => a.id));
  });

  test("an unknown act or key in the section is refused", () => {
    expect(
      parseFollowupSettings({ followup: { authority: { deploy: "ask" } } }).ok,
    ).toBe(false);
    expect(parseFollowupSettings({ followup: { arms: [] } }).ok).toBe(false);
  });
});
