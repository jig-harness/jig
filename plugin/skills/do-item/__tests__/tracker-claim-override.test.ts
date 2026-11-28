/**
 * `tracker.ts claim` and the item's open blockers: a plain claim refuses an
 * item with an open or unreadable blocker, and a person's
 * `--override-blockers "<reason>"` in an interactive session starts it
 * anyway, recording the override, while every other refusal still stands.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { decodeMarker } from "../../../shared/records/envelope.ts";
import { currentIso, currentMs, isoFromMs } from "../../../shared/time.ts";
import {
  OVERRIDE_CONSEQUENCE,
  overrideAttemptsIn,
  overrideMarkerLine,
} from "../scripts/lib/blocker-override.ts";
import {
  claimMarkerBody,
  readClaimMarker,
} from "../scripts/lib/claim-marker.ts";
import { type Blocker, cli } from "./claim-cli.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "preflight-fixture.ts");
const REASON = "the person decided to start ahead of #3";
// An interactive session: no launch record, whatever the test runner inherits.
const INTERACTIVE = { JIG_LAUNCH: "" };
const OPEN: Blocker = {
  number: 3,
  state: "OPEN",
  title: "Ship the API",
  assignee: "dana",
};
const UNREADABLE: Blocker = { number: 4 };
const CLOSED: Blocker = { number: 6, state: "CLOSED" };

/** A claim of #5 over the fake GitHub, with the override's reason unless `args` says otherwise. */
const claim = (
  blockers: Blocker[],
  more: Parameters<typeof cli>[3] = {},
  holders: { labels?: string[]; logins?: string[] } = {},
) =>
  cli(holders.labels ?? [], holders.logins ?? [], undefined, {
    blockers,
    ...more,
    env: { ...INTERACTIVE, ...more.env },
  });
const overriding = (
  blockers: Blocker[],
  more: Parameters<typeof cli>[3] = {},
  holders: { labels?: string[]; logins?: string[] } = {},
) =>
  claim(
    blockers,
    { ...more, args: ["--override-blockers", REASON, ...(more.args ?? [])] },
    holders,
  );

const comments = (writes: string[]) =>
  writes
    .filter((w) => w.startsWith("TrackerComment "))
    .map((w) => w.slice("TrackerComment ".length));

describe("a plain claim and the item's open blockers", () => {
  it("refuses an item with an open blocker, writing nothing", async () => {
    const out = await claim([OPEN]);
    expectSpawnExit(out, 3);
    expect(JSON.parse(out.stdout)).toEqual({
      outcome: "refused",
      issue: "#5",
      why: "blockers",
      overridable: true,
      reason: expect.stringContaining("#5 waits on #3 (Todo)"),
      blockers: [
        {
          key: "#3",
          title: "Ship the API",
          state: "Todo",
          assignee: "dana",
          sharedVisibility: true,
        },
      ],
      consequence: OVERRIDE_CONSEQUENCE,
    });
    expect(out.stderr).toContain("#5 waits on #3");
    expect(out.stderr).toContain("--override-blockers");
    expect(out.writes).toEqual([]);
  });

  it("refuses an item whose blocker cannot be read, writing nothing", async () => {
    const out = await claim([UNREADABLE]);
    expectSpawnExit(out, 3);
    expect(JSON.parse(out.stdout)).toMatchObject({ why: "blockers" });
    expect(out.stderr).toContain("#4 (unreadable)");
    expect(out.writes).toEqual([]);
  });

  it("claims an item whose blockers are all closed", async () => {
    const out = await claim([CLOSED]);
    expectSpawnExit(out, 0);
    expect(JSON.parse(out.stdout).override).toBeUndefined();
  });

  it("reports the refusal the claim would meet anyway, unmarked, instead of the blockers'", async () => {
    const cases: Array<[string, Awaited<ReturnType<typeof cli>>]> = [
      ["in_progress", await claim([OPEN], {}, { labels: ["In Progress"] })],
      ["assigned", await claim([OPEN], {}, { logins: ["dana"] })],
      [
        "state",
        await claim([OPEN], {
          committed: "do_item:\n  claim_from: [in_review]\n",
        }),
      ],
    ];
    for (const [why, out] of cases) {
      expectSpawnExit(out, 3, why);
      const result = JSON.parse(out.stdout);
      expect(result.why).toBe(why);
      expect(result.overridable).toBeUndefined();
      expect(out.writes).toEqual([]);
    }
  });
});

describe("a claim that reads no blockers", () => {
  it("claims as before in a session the line started (JIG_LAUNCH set)", async () => {
    const out = await claim([OPEN], { env: { JIG_LAUNCH: "launch-1" } });
    expectSpawnExit(out, 0);
    const result = JSON.parse(out.stdout);
    expect(result.outcome).toBe("claimed");
    expect(result.override).toBeUndefined();
  });

  it("claims as before for a work-batch member", async () => {
    const out = await claim([OPEN], { args: ["--work-batch"] });
    expectSpawnExit(out, 0);
    expect(JSON.parse(out.stdout).outcome).toBe("claimed");
  });

  it("reads blanks in JIG_LAUNCH as unset", async () => {
    const out = await claim([OPEN], { env: { JIG_LAUNCH: "  " } });
    expectSpawnExit(out, 3);
    expect(JSON.parse(out.stdout).why).toBe("blockers");
  });
});

describe("--override-blockers", () => {
  it("claims the item, stating the blockers and the consequence before it writes", async () => {
    const out = await overriding([OPEN, UNREADABLE, CLOSED]);
    expectSpawnExit(out, 0);
    expect(out.stderr).toContain(
      `#5 will be claimed ahead of its blockers on factory's decision: ${REASON}`,
    );
    expect(out.stderr).toContain('#3 "Ship the API": Todo, assigned to dana');
    expect(out.stderr).toContain("#4: could not be read");
    expect(out.stderr).not.toContain("#6");
    expect(out.stderr).toContain(OVERRIDE_CONSEQUENCE);
    const result = JSON.parse(out.stdout);
    expect(result).toMatchObject({
      outcome: "claimed",
      override: {
        attempt: expect.any(String),
        reason: REASON,
        person: "factory",
        blockers: [
          {
            key: "#3",
            title: "Ship the API",
            state: "Todo",
            assignee: "dana",
            sharedVisibility: true,
          },
          {
            key: "#4",
            title: null,
            state: null,
            assignee: null,
            sharedVisibility: true,
          },
        ],
        comment: {
          status: "posted",
          posted: true,
          attempt: expect.any(String),
        },
      },
    });
    expect(result.override.label).toBeUndefined();
  });

  it("records the override in one comment after the claim's writes, adding no label when none is set", async () => {
    const out = await overriding([OPEN]);
    expectSpawnExit(out, 0);
    expect(out.writes.map((w) => w.split(" ")[0])).toEqual([
      "TrackerAssign",
      "TrackerAddLabels",
      "TrackerComment",
    ]);
    const [body] = comments(out.writes);
    expect(body).toStartWith("## Blocker override\n");
    expect(body).toContain(
      `factory started #5 ahead of its open blockers: ${REASON}`,
    );
    expect(body).toContain('- #3 "Ship the API": Todo, assigned to dana');
    expect(body).toContain(OVERRIDE_CONSEQUENCE);
    expect(out.writes.some((w) => w.includes("jig:started-early"))).toBe(false);
  });

  it("adds do_item.override_label where the default branch sets it, and never removes it", async () => {
    const out = await overriding([OPEN], {
      committed: "do_item:\n  override_label: jig:started-early\n",
      repoLabels: ["jig:started-early"],
    });
    expectSpawnExit(out, 0);
    expect(out.writes).toContain("TrackerAddLabels jig:started-early");
    expect(out.writes.some((w) => w.startsWith("TrackerRemoveLabels"))).toBe(
      false,
    );
    expect(JSON.parse(out.stdout).override.label).toEqual({
      name: "jig:started-early",
      added: true,
    });
  });

  it("keeps the claim and reports an indeterminate comment when posting fails ambiguously", async () => {
    const out = await overriding([OPEN], { failComment: true });
    expectSpawnExit(out, 0);
    const result = JSON.parse(out.stdout);
    expect(result.outcome).toBe("claimed");
    expect(result.override.comment).toMatchObject({
      status: "indeterminate",
      posted: false,
      attempt: result.override.attempt,
      marker: overrideMarkerLine(result.override.attempt),
    });
    expect(result.override.comment.reason).toBeTruthy();
    expect(out.stderr).toContain(
      `the override comment for #5 (attempt ${result.override.attempt}) could not be confirmed`,
    );
  });

  it("reconciles a lost comment response as posted when the comment actually landed", async () => {
    const out = await overriding([OPEN], { failCommentAfterWrite: true });
    expectSpawnExit(out, 0);
    const result = JSON.parse(out.stdout);
    expect(result.outcome).toBe("claimed");
    expect(result.override.comment).toEqual({
      status: "posted",
      posted: true,
      attempt: result.override.attempt,
      alreadyPresent: true,
    });
    expect(comments(out.writes)).toHaveLength(1);
  });

  it("redacts cross-repository blocker titles, states and assignees in persistent GitHub comments and claim markers", async () => {
    const crossRepo: Blocker = {
      repo: "acme/private",
      number: 9,
      state: "OPEN",
      title: "Confidential fix",
      assignee: "alice",
    };
    const out = await overriding([OPEN, crossRepo], {
      committed: "do_item:\n  claim_marker: true\n",
    });
    expectSpawnExit(out, 0);
    // Interactive stderr shows the claimant what they are overriding.
    expect(out.stderr).toContain(
      'acme/private#9 "Confidential fix": Todo, assigned to alice',
    );
    const [marker, , record] = comments(out.writes);
    // Persistent override comment keeps metadata for same-repo #3, redacts cross-repo acme/private#9 to key only.
    expect(record).toContain('- #3 "Ship the API": Todo, assigned to dana');
    expect(record).toContain("- acme/private#9\n");
    expect(record).not.toContain("Confidential fix");
    expect(record).not.toContain("alice");
    // Persistent claim marker keeps state for #3 and redacts state to null for cross-repo acme/private#9.
    const read = decodeMarker(
      marker as string,
      "jig-claim-data",
      "tracker-claim-marker",
    );
    expect(read.ok && read.value.payload.override).toMatchObject({
      blockers: [
        { key: "#3", state: "Todo" },
        { key: "acme/private#9", state: null },
      ],
    });
  });

  it("checks existing trusted comments before reposting via tracker.ts comment and reports indeterminate when unreadable", async () => {
    const marker = overrideMarkerLine("retry-attempt-1");
    const body = `## Blocker override\n\nfactory started #5 ahead of its open blockers: ${REASON}\n\n- #3\n\n${OVERRIDE_CONSEQUENCE}\n\n${marker}\n`;
    const skipped = await cli([], [], undefined, {
      command: "comment",
      stdin: body,
      comments: [
        {
          id: "IC_existing",
          body,
          createdAt: currentIso(),
          authorAssociation: "MEMBER",
          viewerDidAuthor: false,
        },
      ],
    });
    expectSpawnExit(skipped, 0);
    expect(JSON.parse(skipped.stdout)).toEqual({
      issue: "#5",
      commented: true,
      status: "posted",
      posted: true,
      attempt: "retry-attempt-1",
      alreadyPresent: true,
    });
    expect(comments(skipped.writes)).toEqual([]);

    const unreadable = await cli([], [], undefined, {
      command: "comment",
      stdin: body,
      failCommentsRead: true,
    });
    expectSpawnExit(unreadable, 1);
    expect(JSON.parse(unreadable.stdout)).toMatchObject({
      issue: "#5",
      commented: false,
      status: "indeterminate",
      posted: false,
      attempt: "retry-attempt-1",
      marker,
    });
    expect(comments(unreadable.writes)).toEqual([]);
  });

  it("reads a literal reason containing apostrophes and shell characters from --override-blockers-file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jig-override-file-"));
    try {
      const reasonFile = join(dir, "reason.txt");
      const literal = "It's safe to start ahead of #3: $(not expanded)";
      writeFileSync(reasonFile, `${literal}\n`);
      const out = await claim([OPEN], {
        args: ["--override-blockers-file", reasonFile],
      });
      expectSpawnExit(out, 0);
      const result = JSON.parse(out.stdout);
      expect(result.override.reason).toBe(literal);
      expect(comments(out.writes)[0]).toContain(literal);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the person's whole reason in the comment, control characters made spaces", async () => {
    const long = `${"a".repeat(400)}\tend`;
    const out = await claim([OPEN], { args: [`--override-blockers=${long}`] });
    expectSpawnExit(out, 0);
    const [body] = comments(out.writes);
    expect(body).toContain(`${"a".repeat(400)} end`);
  });

  it("escapes display controls in the statement and durable comment", async () => {
    const out = await claim([OPEN], {
      args: ["--override-blockers", "go\u001b[2Jnow"],
    });
    expectSpawnExit(out, 0);
    expect(out.stderr).toContain("go [2Jnow");
    expect(out.stderr).not.toContain("\u001b");
    expect(comments(out.writes).join("\n")).not.toContain("\u001b");
  });

  it("keeps the claim and reports a label the repository does not have", async () => {
    const out = await overriding([OPEN], {
      committed: "do_item:\n  override_label: jig:started-early\n",
    });
    expectSpawnExit(out, 0);
    expect(JSON.parse(out.stdout).override.label).toMatchObject({
      name: "jig:started-early",
      added: false,
    });
    expect(out.stderr).toContain("the label jig:started-early was not added");
  });

  it("adds no label on a claim without an override, even where one is set", async () => {
    const out = await claim([CLOSED], {
      committed: "do_item:\n  override_label: jig:started-early\n",
      repoLabels: ["jig:started-early"],
    });
    expectSpawnExit(out, 0);
    expect(out.writes.some((w) => w.includes("jig:started-early"))).toBe(false);
  });

  it("carries the override in the claim marker's payload with do_item.claim_marker", async () => {
    const out = await overriding([OPEN, UNREADABLE], {
      committed: "do_item:\n  claim_marker: true\n",
    });
    expectSpawnExit(out, 0);
    const [marker, , record] = comments(out.writes);
    const read = decodeMarker(
      marker as string,
      "jig-claim-data",
      "tracker-claim-marker",
    );
    expect(read.ok && read.value.payload.override).toEqual({
      attempt: JSON.parse(out.stdout).override.attempt,
      reason: REASON,
      person: "factory",
      blockers: [
        { key: "#3", state: "Todo" },
        { key: "#4", state: null },
      ],
    });
    expect(readClaimMarker(marker as string)?.override?.reason).toBe(REASON);
    expect(record).toStartWith("## Blocker override");
    expect(overrideAttemptsIn(record as string)).toEqual([
      JSON.parse(out.stdout).override.attempt,
    ]);
  });

  it("goes on as any claim, recording nothing, when there is nothing to override", async () => {
    const out = await overriding([CLOSED]);
    expectSpawnExit(out, 0);
    expect(out.stderr).toContain("overrides nothing");
    expect(JSON.parse(out.stdout).override).toBeUndefined();
    expect(comments(out.writes)).toEqual([]);
  });
});

describe("--override-blockers outside an interactive person's plain claim", () => {
  const refusedAsUsage = (
    out: Awaited<ReturnType<typeof cli>>,
    text: string,
  ) => {
    expectSpawnExit(out, 2);
    expect(out.stderr).toContain(text);
    expect(out.writes).toEqual([]);
  };

  it("is refused in a session the line started", async () => {
    refusedAsUsage(
      await overriding([OPEN], { env: { JIG_LAUNCH: "launch-1" } }),
      "JIG_LAUNCH is set",
    );
  });

  it("is refused beside a served or factory claim's options", async () => {
    refusedAsUsage(
      await overriding([OPEN], { args: ["--for", "dana"] }),
      "served or factory claim",
    );
    refusedAsUsage(
      await overriding([OPEN], { args: ["--factory-ancestor", "#1"] }),
      "served or factory claim",
    );
  });

  it("is refused in a work-batch member's claim, which otherwise claims as before", async () => {
    refusedAsUsage(
      await overriding([OPEN], { args: ["--work-batch"] }),
      "work-batch",
    );
    expectSpawnExit(await claim([], { args: ["--work-batch"] }), 0);
  });

  it("refuses an empty or blank reason", async () => {
    for (const reason of ["", "   "])
      refusedAsUsage(
        await claim([OPEN], { args: ["--override-blockers", reason] }),
        "--override-blockers requires a reason",
      );
    refusedAsUsage(
      await claim([OPEN], { args: ["--override-blockers=   "] }),
      "--override-blockers requires a reason",
    );
  });
});

describe("--override-blockers and the repository's preflight command", () => {
  const preflight = (mode: string) =>
    `do_item:\n  preflight_command: ${JSON.stringify(`bun ${JSON.stringify(FIXTURE)} ${mode}`)}\n`;

  it("marks a tagged refusal overridable only where the override could clear it", async () => {
    const launched = await claim([], {
      committed: preflight("refuse-blockers"),
      env: { JIG_LAUNCH: "launch-1" },
    });
    expectSpawnExit(launched, 3);
    expect(JSON.parse(launched.stdout)).not.toHaveProperty("overridable");
    const held = await claim(
      [],
      { committed: preflight("refuse-blockers") },
      { labels: ["In Progress"] },
    );
    expectSpawnExit(held, 3);
    expect(JSON.parse(held.stdout).why).toBe("in_progress");
  });

  it("clears an exit 3 whose second line is kind: blockers, recording its reason", async () => {
    const refused = await claim([], {
      committed: preflight("refuse-blockers"),
    });
    expectSpawnExit(refused, 3);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      why: "preflight",
      overridable: true,
    });
    const out = await overriding([], {
      committed: preflight("refuse-blockers"),
    });
    expectSpawnExit(out, 0);
    expect(JSON.parse(out.stdout).override).toMatchObject({
      preflight: "waits on #3",
      blockers: [],
    });
    expect(out.stderr).toContain(
      "the repository's preflight check: waits on #3",
    );
  });

  it("escapes display controls in a preflight refusal before printing or recording it", async () => {
    const out = await overriding([], {
      committed: preflight("refuse-blockers-control"),
    });
    expectSpawnExit(out, 0);
    expect(out.stderr).not.toContain("\u001b");
    expect(comments(out.writes).join("\n")).not.toContain("\u001b");
  });

  it("never clears an untagged exit 3 or a failed command", async () => {
    for (const mode of ["refuse", "refuse-tagged-otherwise", "fail"]) {
      const out = await overriding([OPEN], { committed: preflight(mode) });
      expectSpawnExit(out, 3, mode);
      const result = JSON.parse(out.stdout);
      expect(result).toMatchObject({ outcome: "refused", why: "preflight" });
      expect(result.overridable).toBeUndefined();
      expect(out.writes).toEqual([]);
    }
  });
});

describe("--override-blockers leaves every other refusal standing", () => {
  it("still refuses an epic with open blockers even with --override-blockers", async () => {
    const refused = await claim([OPEN], { subIssues: [{ number: 10 }] });
    expectSpawnExit(refused, 3);
    expect(JSON.parse(refused.stdout).why).toBe("epic");
    expect(JSON.parse(refused.stdout).overridable).toBeUndefined();
    const overridden = await overriding([OPEN], {
      subIssues: [{ number: 10 }],
    });
    expectSpawnExit(overridden, 3);
    expect(JSON.parse(overridden.stdout).why).toBe("epic");
    expect(overridden.writes).toEqual([]);
  });

  it("still refuses an item in progress or assigned to someone else", async () => {
    const inProgress = await overriding(
      [OPEN],
      {},
      { labels: ["In Progress"] },
    );
    expectSpawnExit(inProgress, 3);
    expect(JSON.parse(inProgress.stdout).why).toBe("in_progress");
    const assigned = await overriding([OPEN], {}, { logins: ["dana"] });
    expectSpawnExit(assigned, 3);
    expect(JSON.parse(assigned.stdout).why).toBe("assigned");
    expect([...inProgress.writes, ...assigned.writes]).toEqual([]);
  });

  it("still refuses a state outside do_item.claim_from", async () => {
    const out = await overriding([OPEN], {
      committed: "do_item:\n  claim_from: [in_review]\n",
    });
    expectSpawnExit(out, 3);
    expect(JSON.parse(out.stdout).why).toBe("state");
    expect(comments(out.writes)).toEqual([]);
  });

  it("still refuses an item in the blocked state", async () => {
    const out = await overriding(
      [OPEN],
      { overlay: '  states:\n    blocked: "state:blocked"\n' },
      { labels: ["state:blocked"] },
    );
    expectSpawnExit(out, 3);
    expect(JSON.parse(out.stdout).why).toBe("blocked");
    expect(out.writes).toEqual([]);
  });

  it("still refuses when another claim's marker is earlier", async () => {
    const theirs = claimMarkerBody({
      attempt: "other-host",
      session: "session-2",
      branch: "main",
      claimant: "factory",
      at: currentIso(),
    });
    const out = await overriding([OPEN], {
      committed: "do_item:\n  claim_marker: true\n",
      comments: [
        {
          id: "IC_0",
          body: theirs,
          createdAt: isoFromMs(currentMs() - 60_000),
          authorAssociation: "MEMBER",
          viewerDidAuthor: false,
        },
      ],
    });
    expectSpawnExit(out, 3);
    expect(JSON.parse(out.stdout).why).toBe("marker");
    // No override comment: the claim never landed.
    expect(
      comments(out.writes).some((c) => c.startsWith("## Blocker override")),
    ).toBe(false);
  });
});
