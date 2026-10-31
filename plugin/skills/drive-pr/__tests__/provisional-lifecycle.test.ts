/**
 * A provisional decision's whole life and the drive's recorded recoveries,
 * against the fake forge in `provisional-fixtures.ts`:
 *
 * - posted, reversed by a person's comment (an outcome token in a person's
 *   own words counts), parked under `human-thread`, answered, re-armed, and
 *   then triaged like any other thread: `triage-thread.ts` refuses only
 *   while the provisional decision stands;
 * - a reversal parks even where `autonomy.park_classes` leaves `human-thread`
 *   out, since that class is always kept;
 * - a `**deferred**` provisional reply must link where it is tracked;
 * - the self-restarts (pass deadline, stall) and the re-arm past a quota
 *   wall are recorded in the drive state, by cause.
 */
import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { ExitError } from "../scripts/lib/cli.ts";
import { quotaRearmCause } from "../scripts/lib/driver/rearm.ts";
import { refuseProvisional } from "../scripts/lib/provisional.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import { provisionalBody } from "../scripts/provisional-reply.ts";
import {
  type Comment,
  fakeForge,
  type Forge,
  RRC,
  runIn,
  SCRIPTS,
} from "./provisional-fixtures.ts";

const WIDE = "autonomy:\n  level: wide\n";
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
/** A person's reversal in their own words, outcome token and all. */
const REVERSAL: Comment = {
  author: "lead",
  association: "OWNER",
  body: "**accepted** — raise it to five after all.",
};
const PLAIN_REVERSAL: Comment = {
  author: "lead",
  association: "OWNER",
  body: "Please raise it to five after all.",
};

const drive = (forge: Forge, args: string[], stdin?: string) =>
  runIn(forge, join(SCRIPTS, "drive-state.ts"), args, {
    env: DRIVER,
    ...(stdin === undefined ? {} : { stdin }),
  });

async function state(forge: Forge) {
  const got = await drive(forge, ["get", "12"]);
  expectSpawnExit(got, 0);
  return JSON.parse(got.stdout);
}

/**
 * Run a module's export in the forge's tree: `call` is the expression after
 * `m.`, fixed test source. The module path and any data it needs reach the
 * script through the environment (`d` in `call`), never spliced into its code.
 */
async function inModule(
  forge: Forge,
  module: string,
  call: string,
  data: unknown = null,
) {
  return runIn(
    forge,
    "-e",
    [
      `const d = JSON.parse(process.env.JIG_TEST_DATA ?? "null"); import(process.env.JIG_TEST_MODULE).then(async (m) => console.log(JSON.stringify(await m.${call})))`,
    ],
    {
      env: {
        ...DRIVER,
        JIG_TEST_MODULE: join(SCRIPTS, ...module.split("/")),
        JIG_TEST_DATA: JSON.stringify(data),
      },
    },
  );
}

async function provisionalOn(forge: Forge) {
  forge.thread("PRRT_p", [FINDING]);
  expectSpawnExit(
    await drive(
      forge,
      ["rule", "12"],
      JSON.stringify({
        key: "PRRT_p",
        verdict: "escalate",
        class: "escalated",
      }),
    ),
    0,
  );
  const r = await runIn(
    forge,
    join(SCRIPTS, "provisional-reply.ts"),
    ["PRRT_p", "12", "--class", "escalated", "--what", "kept the budget"],
    { stdin: REPLY, env: DRIVER },
  );
  expectSpawnExit(r, 0);
}

const triage = (forge: Forge) =>
  runIn(forge, join(SCRIPTS, "triage-thread.ts"), ["PRRT_p", "12"], {
    stdin: "**accepted** — raised the retry budget to five.",
    env: DRIVER,
  });

describe("a provisional decision from reply to a person's answer", () => {
  it("is refused by triage while it stands, then reversed, parked, answered, re-armed and triaged", async () => {
    const forge = fakeForge(WIDE);
    forge.write("comments-12.json", []);
    await provisionalOn(forge);
    forge.thread("PRRT_p", [FINDING, PROVISIONAL]);
    expectSpawnExit(await triage(forge), 3);

    forge.thread("PRRT_p", [FINDING, PROVISIONAL, PLAIN_REVERSAL]);
    const swept = await inModule(
      forge,
      "lib/driver/provisional-sweep.ts",
      'sweepProvisional("12")',
    );
    expectSpawnExit(swept, 0);
    expect(swept.stdout.trim()).toBe("null");
    const parked = await state(forge);
    expect(parked.parked[0]).toMatchObject({
      key: "PRRT_p",
      class: "human-thread",
    });
    expect(parked.decisions[0].reversed.by).toBe("lead");
    // Reversed, the thread is open again.
    expect(forge.resolved()).toEqual([]);

    const answer: Comment = {
      author: "lead",
      association: "OWNER",
      body: "Raise it to five; the budget was set for a slower suite.",
      at: new Date(Date.now() + 60_000).toISOString(),
    };
    forge.thread("PRRT_p", [FINDING, PROVISIONAL, PLAIN_REVERSAL, answer]);
    const rearmed = await inModule(
      forge,
      "lib/driver/rearm.ts",
      'admitAnsweredParks(await m.readDriveState("12"), false)',
    );
    expectSpawnExit(rearmed, 0);
    expect(JSON.parse(rearmed.stdout.trim())).toStartWith(
      "RE-ARMED WITH HUMAN ANSWERS",
    );
    expect((await state(forge)).parked).toEqual([]);

    // The verdict supersedes the provisional reply, as any human verdict
    // does, and triage then takes the new reply: refused no longer.
    const verdict = "**accepted** — raised the retry budget to five.";
    const posted = await runIn(
      forge,
      join(RRC, "reply-to-thread.ts"),
      ["PRRT_p"],
      { stdin: verdict, env: DRIVER },
    );
    expectSpawnExit(posted, 0);
    expect(forge.replies().at(-1)?.body).toBe(verdict);
    forge.thread("PRRT_p", [
      FINDING,
      PROVISIONAL,
      PLAIN_REVERSAL,
      answer,
      { author: "operator", association: "MEMBER", body: verdict },
    ]);
    expectSpawnExit(await triage(forge), 0);
    expect(
      (await state(forge)).held.map((h: { key: string }) => h.key),
    ).toEqual(["PRRT_p"]);
  });

  it("triage refuses only while the provisional decision stands", () => {
    const listed = (comments: Comment[]) =>
      comments.map((c) => ({
        authorAssociation: c.association,
        body: c.body,
      }));
    expect(() =>
      refuseProvisional("PRRT_p", listed([FINDING, PROVISIONAL]), null),
    ).toThrow(ExitError);
    for (const reversal of [PLAIN_REVERSAL, REVERSAL])
      expect(() =>
        refuseProvisional(
          "PRRT_p",
          listed([FINDING, PROVISIONAL, reversal]),
          null,
        ),
      ).not.toThrow();
  });

  it("reads a person's comment carrying an outcome token as a reversal, and parks it even where park_classes leaves human-thread out", async () => {
    const forge = fakeForge(
      "autonomy:\n  level: wide\n  park_classes: [merge, escalated]\n",
    );
    await provisionalOn(forge);
    forge.thread("PRRT_p", [FINDING, PROVISIONAL, REVERSAL]);
    const swept = await inModule(
      forge,
      "lib/driver/provisional-sweep.ts",
      'sweepProvisional("12")',
    );
    expectSpawnExit(swept, 0);
    expect(swept.stdout.trim()).toBe("null");
    expect((await state(forge)).parked[0].class).toBe("human-thread");
  });
});

describe("a deferred provisional reply", () => {
  it("must link the follow-up issue or the pull request's Deferred section", () => {
    expect(() =>
      provisionalBody("**deferred** — out of scope here.", "escalated"),
    ).toThrow(ExitError);
    expect(
      provisionalBody(
        "**deferred** — out of scope; https://example.invalid/pull/12#deferred",
        "escalated",
      ),
    ).toStartWith("**deferred** **provisional** — out of scope;");
  });
});

describe("the recoveries the drive records", () => {
  const causes = async (forge: Forge) =>
    ((await state(forge)).events ?? []).map(
      (e: { kind: string; cause: string }) => `${e.kind}:${e.cause}`,
    );

  it("a pass-deadline restart, at its site", async () => {
    const forge = fakeForge("");
    const r = await inModule(
      forge,
      "lib/driver/restart.ts",
      'admitDeadlineRestart("12", 2)',
    );
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout)).toEqual({ admitted: true, taken: 1 });
    expect(await causes(forge)).toEqual(["restart:pass-deadline"]);
  });

  it("the stall's extra round, at its site", async () => {
    const forge = fakeForge("");
    const status = {
      head: { api: "a".repeat(40), local: "a".repeat(40), localSource: "git" },
      work: {
        unresolvedThreads: 1,
        summaryUnaddressed: 0,
        unresolvedThreadKeys: ["PRRT_x"],
        summaryUnaddressedKeys: [],
        parkedKeys: [],
      },
    };
    const context = {
      pr: "12",
      prevFingerprint: null,
      noopRounds: 0,
      stallExtraRound: false,
      passNotice: "",
      maxRoundsN: 10,
    };
    const r = await inModule(
      forge,
      "lib/driver/round-budget.ts",
      "checkRoundStall(d.status, globalThis.c ??= d.context, 1).then(() => m.checkRoundStall(d.status, globalThis.c, 1))",
      { status, context },
    );
    expectSpawnExit(r, 0);
    expect(await causes(forge)).toEqual(["restart:stall"]);
  });

  it("a re-arm past a quota wall, by its cause", async () => {
    const forge = fakeForge("");
    const park = (resetAt: string | null) => ({
      vendor: "claude",
      window: "weekly",
      resetAt,
      at: "2026-10-28T20:00:00.000Z",
    });
    const now = new Date();
    const past = new Date(now.getTime() - 3_600_000).toISOString();
    const parked = (resetAt: string | null) => ({
      ...freshState(12),
      quotaPark: park(resetAt),
    });
    expect(quotaRearmCause(parked(past), false, now)).toBe("quota-reset");
    expect(quotaRearmCause(parked(null), true, now)).toBe("window-reopened");
    expect(quotaRearmCause(parked(null), false, now)).toBe("quota-account");
    expect(quotaRearmCause(freshState(12), false, now)).toBeNull();

    writeFileSync(
      join(forge.stateDir, "drive-pr-12.json"),
      JSON.stringify(parked(past)),
    );
    const r = await inModule(
      forge,
      "lib/driver/takeover-complete.ts",
      'pickUpDrive("12", null, await import(d.rearm).then((r) => r.readDriveState("12")), { agent: [], botsOnly: true, dryRun: false, windowReopened: false })',
      { rearm: join(SCRIPTS, "lib", "driver", "rearm.ts") },
    );
    expectSpawnExit(r, 0);
    expect(await causes(forge)).toEqual(["rearm:quota-reset"]);
  });
});
