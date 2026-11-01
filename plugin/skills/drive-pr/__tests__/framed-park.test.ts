/**
 * A park is a framed decision: `drive-state.ts park` refuses a bare reason,
 * a missing or unknown class and a missing or incomplete decision record,
 * and records the class and the record when both are given. The record's
 * sections are checked mechanically (`lib/state/framed-park.ts`).
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { parseDecisionRecord } from "../scripts/lib/state/framed-park.ts";
import { framedDecisionLines } from "../scripts/lib/state/park-frame.ts";
import { useDrivePrSuite } from "./drive-pr-harness.ts";
import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";
import { parkArgs, parkRecord } from "./park-record-fixture.ts";

useDrivePrSuite();

const { stateDirFor, state } = createStateDurabilityFixtures();

const QUESTION = "Should the retention window stay at thirty days?";

describe("park refuses what is not a framed decision", () => {
  it("refuses a park with no class: decide and record it", async () => {
    const d = stateDirFor("park-no-class");
    const r = await state(
      d,
      ["park", "999", "--key", "PRRT_a", "--kind", "thread"],
      {},
      parkRecord(QUESTION),
    );
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("park requires --class: decide and record it");
    expect((await state(d, ["parked-keys", "999"])).stdout).toBe("");
  });

  it("refuses a class outside the park classes", async () => {
    const d = stateDirFor("park-unknown-class");
    const r = await state(
      d,
      parkArgs("PRRT_a", "thread", "style"),
      {},
      parkRecord(QUESTION, "style"),
    );
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("is not a park class: decide and record it");
    expect(r.stderr).toContain("human-decision");
  });

  it("refuses a park with no decision record on stdin", async () => {
    const d = stateDirFor("park-no-record");
    const r = await state(d, parkArgs("PRRT_a", "thread"));
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("decision record on stdin");
  });

  it("refuses the old bare --reason", async () => {
    const d = stateDirFor("park-bare-reason");
    const r = await state(
      d,
      [...parkArgs("PRRT_a", "thread"), "--reason", "needs a human"],
      {},
      parkRecord(QUESTION),
    );
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("no longer takes --reason");
  });

  it("refuses an incomplete record, naming each missing part", async () => {
    const d = stateDirFor("park-incomplete");
    const r = await state(
      d,
      parkArgs("PRRT_a", "thread"),
      {},
      "## Question\n\nShould it stay?\n",
    );
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("no '## Options' section");
    expect(r.stderr).toContain("no '## Already done' section");
  });
});

describe("park records a framed decision", () => {
  it("accepts a class and a complete record, and keeps both", async () => {
    const d = stateDirFor("park-framed");
    const r = await state(
      d,
      parkArgs("PRRT_a", "thread", "human-decision"),
      { DRIVE_PR_HANDOFF_DIR: join(d, "handoff") },
      parkRecord(QUESTION, "human-decision"),
    );
    expectSpawnExit(r, 0);
    const got = JSON.parse((await state(d, ["get", "999"])).stdout) as {
      parked: Array<{
        key: string;
        class: string;
        reason: string;
        record: string;
      }>;
    };
    expect(got.parked).toHaveLength(1);
    expect(got.parked[0]?.class).toBe("human-decision");
    expect(got.parked[0]?.reason).toBe(QUESTION);
    expect(got.parked[0]?.record).toContain("## Steps for a person");
    const handoff = readFileSync(join(d, "handoff", "pr-drive-999.md"), "utf8");
    expect(handoff).toContain("## Recommended");
    expect(handoff).toContain("**Keep it**, because");
  });

  it("accepts a class the repository adds in autonomy.park_classes", async () => {
    const d = stateDirFor("park-own-class");
    const overlay = join(
      mkdtempSync(join(tmpdir(), "park-overlay-")),
      "jig.yaml",
    );
    writeFileSync(
      overlay,
      "autonomy:\n  park_classes: [merge, data-retention]\n",
    );
    const r = await state(
      d,
      parkArgs("PRRT_a", "thread", "data-retention"),
      { JIG_OVERLAY: overlay },
      parkRecord(QUESTION, "data-retention"),
    );
    expectSpawnExit(r, 0);
  });
});

describe("the class is the arbiter's ruling", () => {
  const rule = (d: string, ruling: Record<string, unknown>) =>
    state(d, ["rule", "999"], {}, JSON.stringify(ruling));

  it("an escalate ruling needs its class", async () => {
    const r = await rule(stateDirFor("rule-no-class"), {
      key: "PRRT_a",
      verdict: "escalate",
    });
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("an escalate ruling needs its class");
  });

  it("a call touching a person's decision is always human-decision", async () => {
    const d = stateDirFor("rule-human-decision");
    const refused = await rule(d, {
      key: "PRRT_a",
      verdict: "escalate",
      class: "escalated",
      humanDecision: true,
    });
    expectSpawnExit(refused, 2);
    expect(refused.stderr).toContain("has the class human-decision");
    expectSpawnExit(
      await rule(d, {
        key: "PRRT_a",
        verdict: "escalate",
        humanDecision: true,
      }),
      0,
    );
    const got = JSON.parse((await state(d, ["get", "999"])).stdout) as {
      rulings: Array<{ class: string }>;
    };
    expect(got.rulings[0]?.class).toBe("human-decision");
    const park = await state(
      d,
      parkArgs("PRRT_a", "thread", "escalated"),
      {},
      parkRecord(QUESTION, "escalated"),
    );
    expectSpawnExit(park, 2);
    expect(park.stderr).toContain(
      "the arbiter ruled the class 'human-decision' for PRRT_a",
    );
    expectSpawnExit(
      await state(
        d,
        parkArgs("PRRT_a", "thread", "human-decision"),
        {},
        parkRecord(QUESTION, "human-decision"),
      ),
      0,
    );
  });

  it("a thread the arbiter ruled on with another verdict is not parked", async () => {
    const d = stateDirFor("rule-rejected");
    expectSpawnExit(await rule(d, { key: "PRRT_a", verdict: "rejected" }), 0);
    const park = await state(
      d,
      parkArgs("PRRT_a", "thread"),
      {},
      parkRecord(QUESTION),
    );
    expectSpawnExit(park, 2);
    expect(park.stderr).toContain("the arbiter ruled 'rejected'");
  });

  it("a humanDecision or class that is not the right type is refused, not read as no", async () => {
    const d = stateDirFor("rule-wrong-type");
    for (const ruling of [
      { key: "PRRT_a", verdict: "fix-now", humanDecision: "yes" },
      { key: "PRRT_a", verdict: "escalate", class: "legal", humanDecision: 1 },
      { key: "PRRT_a", verdict: "rejected", class: 5 },
    ]) {
      const r = await rule(d, ruling);
      expectSpawnExit(r, 2);
      expect(r.stderr).toMatch(
        /must be (true or false|a class name) when given/,
      );
    }
  });
});

describe("the decision record's sections", () => {
  const complete = parkRecord(QUESTION);
  const problems = (text: string, cls = "escalated") => {
    const parsed = parseDecisionRecord(text, cls);
    return "problems" in parsed ? parsed.problems : [];
  };

  it("a complete record has none", () => {
    expect(problems(complete)).toEqual([]);
  });

  it("the question is one line ending with a question mark", () => {
    expect(
      problems(
        complete.replace(QUESTION, "Should it keep, e.g. the thirty days?"),
      ),
    ).toEqual([]);
    expect(problems(complete.replace(QUESTION, "Keep the window"))).toContain(
      "Question must end with '?'",
    );
  });

  it("each option says what it changes and what it costs", () => {
    const text = complete.replace(
      " Costs: one more review round.",
      " It is quick.",
    );
    expect(problems(text)).toContain(
      "option 2 must say what it costs ('Costs: …')",
    );
  });

  it("one field's label is never the other field's value", () => {
    const emptyChanges = complete.replace(
      "Changes: nothing in the code. Costs:",
      "Changes: Costs:",
    );
    expect(problems(emptyChanges)).toEqual([
      "option 1 must say what it changes ('Changes: …')",
    ]);
    const emptyCosts = complete.replace(
      "Changes: the anchored function. Costs: one more review round.",
      "Costs: Changes: the anchored function.",
    );
    expect(problems(emptyCosts)).toEqual([
      "option 2 must say what it costs ('Costs: …')",
    ]);
    expect(
      problems(
        complete.replace(
          "Costs: one more review round.",
          "Costs: one more review round. Costs: a second one.",
        ),
      ),
    ).toEqual(["option 2 gives 'Costs:' more than once"]);
  });

  it("the recommendation names one option and says why", () => {
    expect(
      problems(
        complete.replace(
          "**Keep it**, because the current value matches the decision the pull request records.",
          "**Keep it**.",
        ),
      ),
    ).toContain("Recommended must say why, not only which");
    expect(
      problems(
        complete.replace("**Keep it**, because", "**Something else**, because"),
      ),
    ).toContain(
      "Recommended must name exactly one of the options by its **name**",
    );
  });

  it("the class matches --class", () => {
    expect(problems(complete, "legal")).toContain(
      "Class says 'escalated' but --class is 'legal'",
    );
  });

  it("the steps are None. or items, each a command or a named action", () => {
    expect(
      problems(complete.replace("None.", "Ask someone, maybe.")),
    ).toContain(
      "Steps for a person must be 'None.' or '- ' items, each a command or a named action",
    );
    expect(
      problems(
        complete.replace(
          "None.",
          "- `gh pr comment 999 --body 'answer PRRT_a: keep'`\n- Approve the retention change in the legal register",
        ),
      ),
    ).toEqual([]);
    for (const empty of ["- \n- \n- Approve it", "- Approve it\n- "])
      expect(problems(complete.replace("None.", empty))).toContain(
        "Steps for a person must be 'None.' or '- ' items, each a command or a named action",
      );
  });

  it("the sections come in order, each once", () => {
    const swapped = complete.replace("## Options", "## Recommended (x)");
    expect(problems(swapped).join("\n")).toContain("unknown section");
  });
});

describe("a parked decision printed in full", () => {
  it("carries its key, class and every section", () => {
    const lines = framedDecisionLines({
      key: "PRRT_a",
      kind: "thread",
      reason: QUESTION,
      class: "escalated",
      record: complete(),
      round: 3,
    }).join("\n");
    expect(lines).toContain("[thread] PRRT_a · class escalated");
    expect(lines).toContain("## Question");
    expect(lines).toContain("## Steps for a person");
  });

  function complete(): string {
    const parsed = parseDecisionRecord(parkRecord(QUESTION), "escalated");
    if ("problems" in parsed) throw new Error(parsed.problems.join("; "));
    return Object.entries(parsed.record)
      .map(([s, t]) => `## ${s}\n\n${t}`)
      .join("\n\n");
  }
});
