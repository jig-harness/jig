/**
 * Provisional decisions under the `wide` autonomy level: `provisional-reply.ts`
 * posts, resolves and records one only at `wide` and only for the class
 * `escalated`; `reply-to-thread.ts` refuses the marker from anyone else;
 * `reconcile-replied-threads.ts` and `triage-thread.ts` skip a thread that
 * stands on one; the round's sweep parks a thread a person commented on
 * under `human-thread` and leaves one a person only unresolved; and a re-arm
 * at `wide` hands unanswered `escalated` parks on to be decided
 * provisionally, refusing when one is a registry class. Every script runs
 * against the fake forge in `provisional-fixtures.ts`.
 */
import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { PROVISIONAL_MARKER } from "../scripts/lib/outcome.ts";
import { listedThreadStandsOnProvisional } from "../scripts/lib/provisional.ts";
import { provisionalBody } from "../scripts/provisional-reply.ts";
import { reversalParkedKeys } from "../scripts/lib/state/decisions.ts";
import {
  type Comment,
  commentNodes,
  fakeForge,
  type Forge,
  RRC,
  runIn,
  SCRIPTS,
  threadsPayload,
} from "./provisional-fixtures.ts";

const WIDE = "autonomy:\n  level: wide\n";
const UNATTENDED = "autonomy:\n  level: unattended\n";
const DRIVER = { DRIVE_PR_TARGET: "12" };
const FINDING: Comment = {
  author: "review-bot[bot]",
  association: "NONE",
  body: "The retry budget should be raised.",
};
const REPLY = "**wont-fix** — the retry budget is the configured one.";
const PROVISIONAL: Comment = {
  author: "operator",
  association: "MEMBER",
  body: provisionalBody(REPLY, "escalated"),
};

async function rule(forge: Forge, ruling: Record<string, unknown>) {
  const r = await runIn(
    forge,
    join(SCRIPTS, "drive-state.ts"),
    ["rule", "12"],
    {
      stdin: JSON.stringify({ key: "PRRT_p", ...ruling }),
      env: DRIVER,
    },
  );
  expectSpawnExit(r, 0);
}

async function provisionalReply(
  forge: Forge,
  cls = "escalated",
  ruling: Record<string, unknown> | null = {
    verdict: "escalate",
    class: "escalated",
  },
) {
  if (ruling !== null) await rule(forge, ruling);
  return runIn(
    forge,
    join(SCRIPTS, "provisional-reply.ts"),
    [
      "PRRT_p",
      "12",
      "--class",
      cls,
      "--what",
      "kept the configured retry budget",
    ],
    { stdin: REPLY, env: DRIVER },
  );
}

async function decisions(forge: Forge) {
  const got = await runIn(forge, join(SCRIPTS, "drive-state.ts"), [
    "get",
    "12",
  ]);
  expectSpawnExit(got, 0);
  const state = JSON.parse(got.stdout);
  return {
    decisions: state.decisions ?? [],
    parked: state.parked,
    events: state.events ?? [],
  };
}

describe("provisional-reply.ts", () => {
  it("under wide, replies provisionally, resolves the thread and records the decision", async () => {
    const forge = fakeForge(WIDE);
    forge.thread("PRRT_p", [FINDING]);
    const r = await provisionalReply(forge);
    expectSpawnExit(r, 0);
    const [reply] = forge.replies();
    expect(reply?.threadId).toBe("PRRT_p");
    expect(reply?.body).toStartWith(
      "**wont-fix** **provisional** — the retry budget is the configured one.",
    );
    expect(reply?.body).toContain("comment on this thread");
    expect(reply?.body.trimEnd().endsWith(PROVISIONAL_MARKER)).toBe(true);
    expect(forge.resolved()).toEqual(["PRRT_p"]);
    const { decisions: d } = await decisions(forge);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      class: "provisional-reply",
      level: "wide",
      key: "PRRT_p",
      outcome: "wont-fix",
      record: "https://example.invalid/reply-1",
    });
  });

  it("under unattended, refuses: nothing is posted, resolved or recorded", async () => {
    const forge = fakeForge(UNATTENDED);
    forge.thread("PRRT_p", [FINDING]);
    const r = await provisionalReply(forge);
    expectSpawnExit(r, 3);
    expect(r.stderr).toContain("only wide decides an escalation provisionally");
    expect(forge.replies()).toEqual([]);
    expect(forge.resolved()).toEqual([]);
    expect((await decisions(forge)).decisions).toEqual([]);
  });

  it("refuses a class a person must decide, even under wide", async () => {
    const forge = fakeForge(WIDE);
    forge.thread("PRRT_p", [FINDING]);
    const r = await provisionalReply(forge, "human-decision");
    expectSpawnExit(r, 3);
    expect(forge.replies()).toEqual([]);
  });

  it("takes the class from the arbiter's recorded ruling, not the caller's flag", async () => {
    const forge = fakeForge(WIDE);
    forge.thread("PRRT_p", [FINDING]);
    const none = await provisionalReply(forge, "escalated", null);
    expectSpawnExit(none, 3);
    expect(none.stderr).toContain("no arbiter ruling is recorded");
    const merge = await provisionalReply(forge, "escalated", {
      verdict: "escalate",
      class: "merge",
    });
    expectSpawnExit(merge, 3);
    expect(merge.stderr).toContain("with the class 'merge'");
    const person = await provisionalReply(forge, "escalated", {
      verdict: "escalate",
      humanDecision: true,
    });
    expectSpawnExit(person, 3);
    expect(forge.replies()).toEqual([]);
  });

  it("refuses a fix: only rejected, wont-fix or deferred", async () => {
    const forge = fakeForge(WIDE);
    forge.thread("PRRT_p", [FINDING]);
    const r = await runIn(
      forge,
      join(SCRIPTS, "provisional-reply.ts"),
      ["PRRT_p", "12", "--class", "escalated", "--what", "raised it"],
      { stdin: "**accepted** — raised the budget.", env: DRIVER },
    );
    expectSpawnExit(r, 2);
    expect(forge.replies()).toEqual([]);
  });

  it("a retry with the reply already on the thread posts nothing and records once", async () => {
    const forge = fakeForge(WIDE);
    forge.thread("PRRT_p", [FINDING]);
    expectSpawnExit(await provisionalReply(forge), 0);
    forge.thread("PRRT_p", [FINDING, PROVISIONAL]);
    expectSpawnExit(await provisionalReply(forge), 0);
    expect(forge.replies()).toHaveLength(1);
    expect((await decisions(forge)).decisions).toHaveLength(1);
  });

  it("a retry completes a posted reply after the level changed, with the outcome it posted", async () => {
    const forge = fakeForge(UNATTENDED);
    await rule(forge, { verdict: "escalate", class: "escalated" });
    forge.thread("PRRT_p", [FINDING, PROVISIONAL]);
    const r = await runIn(
      forge,
      join(SCRIPTS, "provisional-reply.ts"),
      ["PRRT_p", "12", "--class", "escalated", "--what", "kept the budget"],
      { stdin: "**rejected** — the budget is right.", env: DRIVER },
    );
    expectSpawnExit(r, 0);
    expect(forge.replies()).toEqual([]);
    expect(forge.resolved()).toEqual(["PRRT_p"]);
    const { decisions: d } = await decisions(forge);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ level: "wide", outcome: "wont-fix" });
  });

  it("a retry records but never resolves a reply a person commented after, and the sweep parks its reversal", async () => {
    const forge = fakeForge(WIDE);
    await rule(forge, { verdict: "escalate", class: "escalated" });
    forge.thread("PRRT_p", [
      FINDING,
      PROVISIONAL,
      { author: "lead", association: "OWNER", body: "Raise it." },
    ]);
    const r = await runIn(
      forge,
      join(SCRIPTS, "provisional-reply.ts"),
      ["PRRT_p", "12", "--class", "escalated", "--what", "kept the budget"],
      { stdin: REPLY, env: DRIVER },
    );
    expectSpawnExit(r, 3);
    expect(r.stderr).toContain("no longer stands");
    expect(forge.resolved()).toEqual([]);
    const recorded = (await decisions(forge)).decisions;
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      key: "PRRT_p",
      outcome: "wont-fix",
      record: "https://example.invalid/PRRT_p/comment-1",
    });
    expectSpawnExit(await sweep(forge), 0);
    const { decisions: d, parked } = await decisions(forge);
    expect(d[0].reversed).toMatchObject({ by: "lead" });
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ key: "PRRT_p", class: "human-thread" });
  });
});

describe("record-decision for decide's provisional ruling", () => {
  const ruling = JSON.stringify({
    class: "decide-provisional",
    what: "kept one parser module",
    record: "https://example.invalid/pull/12#issuecomment-1",
    reverse: "comment `answer parser-split: …` on the pull request",
    key: "parser-split",
  });
  const record = (forge: Forge) =>
    runIn(forge, join(SCRIPTS, "drive-state.ts"), ["record-decision", "12"], {
      stdin: ruling,
      env: DRIVER,
    });

  it("is recorded at wide", async () => {
    const forge = fakeForge(WIDE);
    expectSpawnExit(await record(forge), 0);
    expect((await decisions(forge)).decisions[0]).toMatchObject({
      class: "decide-provisional",
      key: "parser-split",
      level: "wide",
    });
  });

  it("is refused below wide", async () => {
    const forge = fakeForge(UNATTENDED);
    const r = await record(forge);
    expectSpawnExit(r, 3);
    expect(r.stderr).toContain("only at the wide autonomy level");
  });
});

describe("reply-to-thread.ts", () => {
  it("refuses a body carrying the provisional marker from any other producer", async () => {
    const forge = fakeForge(WIDE);
    const r = await runIn(forge, join(RRC, "reply-to-thread.ts"), ["PRRT_p"], {
      stdin: PROVISIONAL.body,
    });
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("PROVISIONAL_MARKER");
    expect(forge.replies()).toEqual([]);
  });
});

describe("the sweeps skip a thread standing on a provisional decision", () => {
  it("reconcile-replied-threads.ts leaves it unresolved, action provisional", async () => {
    const forge = fakeForge(WIDE);
    forge.write(
      "threads.json",
      threadsPayload([{ id: "PRRT_p", comments: [FINDING, PROVISIONAL] }]),
    );
    const r = await runIn(
      forge,
      join(SCRIPTS, "reconcile-replied-threads.ts"),
      ["12"],
    );
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({
      threadId: "PRRT_p",
      outcome: "wont-fix",
      action: "provisional",
    });
    expect(forge.resolved()).toEqual([]);
  });

  it("triage-thread.ts refuses to decide it again", async () => {
    const forge = fakeForge(WIDE);
    forge.thread("PRRT_p", [FINDING, PROVISIONAL]);
    const r = await runIn(
      forge,
      join(SCRIPTS, "triage-thread.ts"),
      ["PRRT_p", "12"],
      { stdin: "**rejected** — not a defect.", env: DRIVER },
    );
    expectSpawnExit(r, 3);
    expect(r.stderr).toContain("stands on a provisional decision");
    expect(forge.replies()).toEqual([]);
    expect(forge.resolved()).toEqual([]);
  });

  it("the round gate counts it as no work, until a person comments", () => {
    const listed = (comments: Comment[]) => ({
      threadId: "PRRT_p",
      commentsTruncated: false,
      comments: commentNodes("PRRT_p", comments),
    });
    const chat: Comment = {
      author: "coderabbitai[bot]",
      association: "NONE",
      body: "Acknowledged.\n<!-- coderabbit-ai-generated:v1 -->",
    };
    expect(
      listedThreadStandsOnProvisional(listed([FINDING, PROVISIONAL])),
    ).toBe(true);
    expect(
      listedThreadStandsOnProvisional(listed([FINDING, PROVISIONAL, chat])),
    ).toBe(true);
    expect(
      listedThreadStandsOnProvisional(
        listed([
          FINDING,
          PROVISIONAL,
          { author: "lead", association: "OWNER", body: "Please fix it." },
        ]),
      ),
    ).toBe(false);
    expect(
      listedThreadStandsOnProvisional({
        ...listed([FINDING, PROVISIONAL]),
        commentsTruncated: true,
      }),
    ).toBe(false);
  });
});

/** Run `sweepProvisional` for PR 12 in the forge's tree and environment. */
async function sweep(forge: Forge) {
  return runIn(
    forge,
    "-e",
    [
      `import(${JSON.stringify(join(SCRIPTS, "lib", "driver", "provisional-sweep.ts"))}).then(async (m) => console.log(JSON.stringify(await m.sweepProvisional("12"))));`,
    ],
    { env: DRIVER },
  );
}

async function recordProvisional(forge: Forge) {
  await rule(forge, { verdict: "escalate", class: "escalated" });
  const r = await runIn(
    forge,
    join(SCRIPTS, "drive-state.ts"),
    ["record-decision", "12"],
    {
      env: DRIVER,
      stdin: JSON.stringify({
        class: "provisional-reply",
        what: "kept the configured retry budget",
        record: "https://example.invalid/PRRT_p/comment-1",
        reverse: "comment on the thread",
        key: "PRRT_p",
        outcome: "wont-fix",
      }),
    },
  );
  expectSpawnExit(r, 0);
}

describe("a person reverses a provisional decision by commenting, never by an unresolve", () => {
  it("a trusted comment on the thread is recorded as the reversal and parked under human-thread", async () => {
    const forge = fakeForge(WIDE);
    await recordProvisional(forge);
    forge.thread("PRRT_p", [
      FINDING,
      PROVISIONAL,
      {
        author: "lead",
        association: "OWNER",
        body: "Please raise it after all.",
      },
    ]);
    const r = await sweep(forge);
    expectSpawnExit(r, 0);
    expect(r.stdout.trim()).toBe("null");
    const { decisions: d, parked } = await decisions(forge);
    expect(d[0].reversed).toMatchObject({
      by: "lead",
      url: "https://example.invalid/PRRT_p/comment-2",
    });
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      key: "PRRT_p",
      kind: "thread",
      class: "human-thread",
    });
    expect(parked[0].record).toContain("## Question");
    const keys = await runIn(forge, join(SCRIPTS, "drive-state.ts"), [
      "reversal-parked-keys",
      "12",
    ]);
    expectSpawnExit(keys, 0);
    expect(keys.stdout).toBe("PRRT_p\n");
  });

  it("the gate counts a reversed decision's park whatever its key, and nothing else", () => {
    const at = "2026-01-01T00:00:00Z";
    const decided = {
      what: "kept the budget",
      reverse: "answer on the pull request",
      record: "https://example.invalid/c/1",
      level: "wide",
      at,
    };
    const reversed = { by: "lead", url: "https://example.invalid/c/2", at };
    expect(
      reversalParkedKeys(
        [{ key: "budget" }, { key: "PRRT_other" }, { key: "standing" }],
        [
          { ...decided, class: "decide-provisional", key: "budget", reversed },
          { ...decided, class: "decide-provisional", key: "standing" },
          {
            ...decided,
            class: "decide-reversible",
            key: "PRRT_other",
            reversed,
          },
        ] as never,
      ),
    ).toEqual(["budget"]);
  });

  it("an unresolve alone, or a bot's comment, changes nothing", async () => {
    const forge = fakeForge(WIDE);
    await recordProvisional(forge);
    forge.thread("PRRT_p", [
      FINDING,
      PROVISIONAL,
      {
        author: "coderabbitai[bot]",
        association: "NONE",
        body: "Acknowledged.",
      },
    ]);
    const r = await sweep(forge);
    expectSpawnExit(r, 0);
    const { decisions: d, parked } = await decisions(forge);
    expect(d[0].reversed).toBeUndefined();
    expect(parked).toEqual([]);
  });

  it("a thread that cannot be read ends the round as INDETERMINATE", async () => {
    const forge = fakeForge(WIDE);
    await recordProvisional(forge);
    const r = await sweep(forge);
    expectSpawnExit(r, 0);
    expect(r.stdout.trim()).toBe("1");
  });

  it("a thread with more comments than one page reads as unreadable, never as no reversal", async () => {
    const forge = fakeForge(WIDE);
    await recordProvisional(forge);
    forge.thread("PRRT_p", [FINDING, PROVISIONAL]);
    forge.write("more-PRRT_p", "");
    const r = await sweep(forge);
    expectSpawnExit(r, 0);
    expect(r.stdout.trim()).toBe("1");
  });
});

const RECORD = (cls: string) =>
  [
    "## Question",
    "",
    "Should the retry budget be raised for this pull request?",
    "",
    "## Options",
    "",
    "- **Raise it** Changes: the budget. Costs: longer drives.",
    "- **Keep it** Changes: nothing. Costs: a stop at the budget.",
    "",
    "## Recommended",
    "",
    "**Keep it**: the budget is the configured policy.",
    "",
    "## Class",
    "",
    cls,
    "",
    "## Steps for a person",
    "",
    "None.",
    "",
    "## Already done",
    "",
    "Read the configuration.",
    "",
  ].join("\n");

async function park(forge: Forge, key: string, cls: string) {
  const r = await runIn(
    forge,
    join(SCRIPTS, "drive-state.ts"),
    ["park", "12", "--key", key, "--kind", "thread", "--class", cls],
    { stdin: RECORD(cls), env: DRIVER },
  );
  expectSpawnExit(r, 0);
  forge.thread(key, [FINDING]);
}

/** Run `admitAnsweredParks` for PR 12's state, as a re-arm does. */
async function rearm(forge: Forge) {
  return runIn(
    forge,
    "-e",
    [
      `import(${JSON.stringify(join(SCRIPTS, "lib", "driver", "rearm.ts"))}).then(async (m) => console.log(JSON.stringify(await m.admitAnsweredParks(await m.readDriveState("12"), false))));`,
    ],
    { env: DRIVER },
  );
}

describe("re-arming a HITL-parked drive with items unanswered", () => {
  it("at wide, unparks escalated items for the first round to decide provisionally", async () => {
    const forge = fakeForge(WIDE);
    forge.write("comments-12.json", []);
    await park(forge, "PRRT_e1", "escalated");
    await park(forge, "PRRT_e2", "escalated");
    const r = await rearm(forge);
    expectSpawnExit(r, 0);
    const notice = JSON.parse(r.stdout.trim()) as string;
    expect(notice).toStartWith("RE-ARMED TO DECIDE PROVISIONALLY");
    expect(notice).toContain("PRRT_e1");
    const { parked, events } = await decisions(forge);
    expect(parked).toEqual([]);
    expect(events.map((e: { cause: string }) => e.cause)).toEqual([
      "provisional",
    ]);
  });

  it("refuses when one unanswered item's class is a registry class", async () => {
    const forge = fakeForge(WIDE);
    forge.write("comments-12.json", []);
    await park(forge, "PRRT_e1", "escalated");
    await park(forge, "PRRT_m", "merge");
    const r = await rearm(forge);
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout.trim())).toBe("");
    expect(r.stderr).toContain("class merge, which only a person decides");
    expect((await decisions(forge)).parked).toHaveLength(2);
  });

  it("at wide, decides nothing provisionally when an item's thread could not be read", async () => {
    const forge = fakeForge(WIDE);
    forge.write("comments-12.json", []);
    await park(forge, "PRRT_e1", "escalated");
    rmSync(join(forge.dir, "thread-PRRT_e1.json"));
    const r = await rearm(forge);
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout.trim())).toBe("");
    expect(r.stderr).toContain("nothing is decided provisionally");
    expect((await decisions(forge)).parked).toHaveLength(1);
  });

  it("below wide, unparks nothing while an item is unanswered", async () => {
    const forge = fakeForge(
      "autonomy:\n  level: unattended\n  max_level: wide\n",
    );
    forge.write("comments-12.json", []);
    await park(forge, "PRRT_e1", "escalated");
    const r = await rearm(forge);
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout.trim())).toBe("");
    expect((await decisions(forge)).parked).toHaveLength(1);
  });
});
