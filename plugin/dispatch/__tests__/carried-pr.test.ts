/**
 * dispatch and a claimed item an open pull request carries: in a repository
 * that names no `pr_open` state, an item with no running session past
 * `dispatch.stalled_after` whose open pull request links it raises no stall
 * need while that pull request's drive is live, converged, parked on a
 * question, stopped or undecided this tick, and is reported as carried by
 * it with the drive's state, on the tick's report and on the line; the
 * drive's own need stays. A merged pull request that links it settles it.
 * No linking pull request, a pull request with no drive, a fork's pull
 * request, and open pull requests or a drive that did not read leave the
 * stall need, which names what could not be told.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyLinker } from "../../skills/do-item/scripts/lib/linked-pr.ts";
import { numberKeys } from "../../skills/do-item/scripts/lib/tracker/keys.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { carrierInput } from "../lib/carried-pr.ts";
import type { LineCarried } from "../lib/dashboard-contract.ts";
import { buildLine } from "../lib/line.ts";
import { readBy } from "../lib/line-merge.ts";
import { readLine, writeLine } from "../lib/line-store.ts";
import { closeStateDb } from "../lib/state.ts";
import { type PickupInput, planPickups } from "../lib/plan-pickups.ts";
import { planTick } from "../lib/plan.ts";
import type { StalledPrInput } from "../lib/stalled-pr.ts";
import type {
  ClaimedItem,
  DispatchSection,
  DrivenPr,
  LedgerClass,
  MergedPr,
} from "../lib/types.ts";
import type { PrLinkText } from "../lib/work-links.ts";
import { input as lineInput, REPO, report } from "./line-fixtures.ts";
import { planInput } from "./plan-input-fixtures.ts";
import { BRANCH, endedPickup, idleSessions } from "./ended-pickup-fixtures.ts";
import { SLUG } from "./fixtures.ts";
import { parseMs } from "../../shared/time.ts";

const NOW = parseMs("2026-11-14T17:14:00Z");
const HOUR = 3_600_000;
const URL = `https://github.com/${SLUG}/pull/31`;

const launch = endedPickup("20261114T145000Z-abcdef12", "2026-11-14T14:54:00Z");
const sessions = idleSessions;

function pr(over: Partial<PrLinkText> = {}): PrLinkText {
  return {
    number: 31,
    url: URL,
    headRefName: BRANCH,
    body: "Closes #12",
    crossRepository: false,
    closing: [{ number: 12, repository: SLUG }],
    ...over,
  };
}

function drive(
  cls: LedgerClass,
  evidence: DrivenPr["evidence"] = {},
): DrivenPr {
  return {
    number: 31,
    url: URL,
    title: "issue 12",
    head: BRANCH,
    class: cls,
    why: cls === "parked" ? "the drive parked on a decision" : "",
    evidence,
  };
}

const LIVE = drive("driven");
const CONVERGED = drive("done", { exit: DRIVE_EXIT.CONVERGED });

/** What the stall watch reads in a repository whose tracker names no pr_open state. */
function stalled(
  prs: PrLinkText[] | null,
  drives: DrivenPr[],
  read: ReadonlySet<number> = new Set([31]),
  inScope?: ReadonlySet<number>,
  merged?: MergedPr[],
): StalledPrInput {
  return {
    prs,
    prOpen: () => null,
    owner: true,
    pickup: true,
    links: (body, key) =>
      bodyLinker(key, {
        repository: SLUG,
        keySource: "(?<![\\w&#])#[1-9]\\d*(?!\\w)",
        trackerRepository: SLUG,
      })(body),
    carried: carrierInput({
      prs,
      rules: {
        keys: numberKeys(SLUG),
        branchPattern: "{key_lower}-{slug}",
        repository: SLUG,
        issueRepository: SLUG,
      },
      drives,
      read,
      ...(inScope === undefined ? {} : { inScope }),
      ...(merged === undefined ? {} : { merged }),
      nowMs: NOW,
    }),
  };
}

function input(prOpen: StalledPrInput): PickupInput {
  const claimed: ClaimedItem[] = [
    { key: "#12", title: "issue 12", state: "In Progress" },
  ];
  return {
    slug: SLUG,
    section: {
      stalledAfterMs: HOUR / 2,
      blockedAfterMs: HOUR,
    } as DispatchSection,
    pickups: [],
    claimed,
    sessions,
    launches: [launch],
    idleSince: new Map([["#12", NOW - 2 * HOUR]]),
    nowMs: NOW,
    prOpen,
  };
}

function expectStalled(plan: ReturnType<typeof planPickups>): string {
  expect(plan.actions).toEqual([
    expect.objectContaining({ target: "#12", cause: "stalled" }),
  ]);
  expect(plan.quiet).not.toContainEqual(
    expect.objectContaining({ class: "claimed-carried" }),
  );
  return plan.actions[0]?.reason ?? "";
}

describe("a claimed item an open pull request carries", () => {
  it("raises no stall need while the pull request's drive is live, and is reported as carried by it", () => {
    const plan = planPickups(input(stalled([pr()], [LIVE])));
    expect(plan.actions).toEqual([]);
    expect(plan.moves).toEqual([]);
    expect(plan.quiet).toContainEqual({
      target: "#12",
      class: "claimed-carried",
      why: expect.stringContaining(`carried by pull request #31 (${URL})`),
      carried: { pr: 31, url: URL, drive: "driving" },
    });
  });

  it("raises no stall need while the drive has converged and the pull request waits for its merge", () => {
    const plan = planPickups(input(stalled([pr()], [CONVERGED])));
    expect(plan.actions).toEqual([]);
    const [quiet] = plan.quiet.filter((q) => q.class === "claimed-carried");
    expect(quiet?.carried).toEqual({ pr: 31, url: URL, drive: "converged" });
    expect(quiet?.why).toContain("waits for its merge");
  });

  it("is carried by a pull request the line links by its description alone, from a branch no launch worked on", () => {
    const other = pr({ headRefName: "someone-elses-fix", closing: [] });
    const plan = planPickups(
      input(stalled([other], [{ ...LIVE, head: "someone-elses-fix" }])),
    );
    expect(plan.actions).toEqual([]);
    expect(plan.quiet).toContainEqual(
      expect.objectContaining({ target: "#12", class: "claimed-carried" }),
    );
  });

  it("is still a stalled pickup naming the pull request when the pull request has no drive", () => {
    const reason = expectStalled(planPickups(input(stalled([pr()], []))));
    expect(reason).toContain("pull request #31: it has no drive");
  });

  it("raises no stall need while the drive is parked on a question, stopped, or undecided this tick, and is reported with the drive's state", () => {
    const unplaced = drive("unplaced", { exit: DRIVE_EXIT.CONVERGED });
    unplaced.why = "whether it conflicts with its base is not known yet";
    unplaced.forgeUndecided = true;
    for (const [ledger, state, text] of [
      [drive("parked"), "parked", "parked on a person's question"],
      [drive("needs-person"), "parked", "parked on a person's question"],
      [drive("stale"), "stopped", "waits for a re-arm or a re-drive"],
      [
        drive("stopped-by-person"),
        "stopped",
        "waits for a re-arm or a re-drive",
      ],
      [
        unplaced,
        "unplaced",
        "undecided this tick (unplaced: whether it conflicts",
      ],
    ] as const) {
      const plan = planPickups(input(stalled([pr()], [ledger])));
      expect(plan.actions).toEqual([]);
      const [quiet] = plan.quiet.filter((q) => q.class === "claimed-carried");
      expect(quiet?.carried).toEqual({ pr: 31, url: URL, drive: state });
      expect(quiet?.why).toContain(text);
    }
  });

  it("leaves the parked drive's own need as the only one", () => {
    const parked = drive("parked");
    const pickups = input(stalled([pr()], [parked]));
    const plan = planTick(planInput(NOW, { ...pickups, drives: [parked] }));
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ target: "PR #31", cause: "parked" }),
    );
    expect(plan.actions).not.toContainEqual(
      expect.objectContaining({ cause: "stalled" }),
    );
  });

  it("raises no stall need for an item a merged pull request links: its follow-up settles it", () => {
    const merged: MergedPr = {
      number: 30,
      url: `https://github.com/${SLUG}/pull/30`,
      title: "issue 12",
      head: BRANCH,
      mergedAt: "2026-11-14T16:00:00Z",
    };
    for (const open of [[], null]) {
      const plan = planPickups(
        input(stalled(open, [], new Set(), undefined, [merged])),
      );
      expect(plan.actions).toEqual([]);
      expect(plan.quiet).toContainEqual({
        target: "#12",
        class: "claimed-merged",
        why: expect.stringContaining("pull request #30"),
      });
    }
    // A day after its merge the follow-up has had its time: the item is a stalled pickup again.
    const old = { ...merged, mergedAt: "2026-11-13T16:00:00Z" };
    expectStalled(
      planPickups(input(stalled([], [], new Set(), undefined, [old]))),
    );
  });

  it("is a stalled pickup when no pull request links it", () => {
    const other = pr({
      number: 32,
      headRefName: "another-branch",
      body: "Closes #99",
      closing: [{ number: 99, repository: SLUG }],
    });
    for (const prs of [[], [other]]) {
      const reason = expectStalled(
        planPickups(input(stalled(prs, [LIVE], new Set([31, 32])))),
      );
      expect(reason).toContain("stalled pickup");
    }
  });

  it("is not quieted by a fork's pull request that links it, or one whose head repository did not read", () => {
    for (const crossRepository of [true, undefined]) {
      const { crossRepository: _, ...rest } = pr();
      const fork: PrLinkText =
        crossRepository === undefined ? rest : { ...rest, crossRepository };
      const reason = expectStalled(planPickups(input(stalled([fork], [LIVE]))));
      if (crossRepository === undefined)
        expect(reason).toContain(
          "its head repository did not read, so it cannot be told from a fork",
        );
    }
  });

  it("is a stalled pickup when the open pull requests did not read, and the need says what could not be told", () => {
    const reason = expectStalled(planPickups(input(stalled(null, []))));
    expect(reason).toContain(
      "the open pull requests' descriptions did not read this tick",
    );
    expect(reason).toContain(
      "whether an open pull request carries it cannot be told",
    );
  });

  it("is a stalled pickup when the linked pull request's drive did not read, and the need says so", () => {
    const unplaced: DrivenPr = {
      ...drive("unplaced", { exit: DRIVE_EXIT.CONVERGED }),
      why: "its comments did not read",
      readFailed: true,
    };
    // A stop that read but names no verified head is unplaced for a reason the forge does not clear.
    const unverified = {
      ...drive("unplaced", { exit: DRIVE_EXIT.CONVERGED }),
      why: "its ledger names no head the drive verified",
    };
    // An unplaced drive with no stop of its own (no ledger, a heartbeat that does not read) cannot be told either.
    const unstopped = {
      ...drive("unplaced"),
      why: "its heartbeat is unreadable",
    };
    for (const [drives, read] of [
      [[unplaced], new Set([31])],
      [[unstopped], new Set([31])],
      [[unverified], new Set([31])],
      [[], new Set<number>()],
    ] as const) {
      const reason = expectStalled(
        planPickups(input(stalled([pr()], [...drives], read))),
      );
      expect(reason).toContain("so whether a drive carries it cannot be told");
    }
  });

  it("says a pull request outside dispatch.labels.only_labeled's scope has no drive the tick reads", () => {
    const reason = expectStalled(
      planPickups(input(stalled([pr()], [], new Set(), new Set()))),
    );
    expect(reason).toContain(
      "it carries no dispatch label, so its drive is not read (dispatch.labels.only_labeled)",
    );
  });

  it("still moves the item to pr_open where the repository names one", () => {
    const named = { ...stalled([pr()], [LIVE]), prOpen: () => "PR Open" };
    const plan = planPickups(input(named));
    expect(plan.actions).toEqual([]);
    expect(plan.moves).toEqual([
      expect.objectContaining({ target: "#12", pr: 31, to: "PR Open" }),
    ]);
  });

  it("does not read an item already in pr_open as carried, whichever pull request links it", () => {
    const other = pr({ headRefName: "someone-elses-fix", closing: [] });
    const named = {
      ...stalled([other], [{ ...LIVE, head: "someone-elses-fix" }]),
      prOpen: () => "In Progress",
    };
    const plan = planPickups(input(named));
    expect(plan.quiet).not.toContainEqual(
      expect.objectContaining({ class: "claimed-carried" }),
    );
  });

  it("is a stalled pickup when the carriers are not read", () => {
    const { carried: _, ...without } = stalled([pr()], [LIVE]);
    expectStalled(planPickups(input(without)));
  });
});

describe("a claimed sibling of a whole-batch question whose anchor an open pull request carries", () => {
  it("raises the batch question itself, since its anchor cannot show it", () => {
    const batch = endedPickup(
      "20261114T145000Z-abcdef12",
      "2026-11-14T14:54:00Z",
    );
    Object.assign(batch.record, {
      batchItems: [{ key: "#12" }, { key: "#13" }],
      claimedItems: ["#12", "#13"],
    });
    if (batch.state.kind === "ended")
      batch.state.exit.said =
        "Question: Should the batch follow the shared approach?\n";
    const base = input(stalled([pr()], [LIVE]));
    const plan = planPickups({
      ...base,
      claimed: [
        { key: "#12", title: "issue 12", state: "In Progress" },
        { key: "#13", title: "issue 13", state: "In Progress" },
      ],
      launches: [batch],
      idleSince: new Map([
        ["#12", NOW - 2 * HOUR],
        ["#13", NOW - 2 * HOUR],
      ]),
    });
    expect(plan.quiet).toContainEqual(
      expect.objectContaining({ target: "#12", class: "claimed-carried" }),
    );
    expect(
      plan.actions.filter((a) => a.cause === "pickup-question"),
    ).toMatchObject([{ target: "#13" }]);
  });
});

describe("the line", () => {
  const why = `in In Progress with no running session: carried by pull request #31 (${URL}), which links it; its drive is live`;

  it("shows an item an open pull request carries, with the pull request, its link and its drive's state", () => {
    const r = report({
      quiet: [
        {
          target: "#12",
          class: "claimed-carried",
          why,
          carried: { pr: 31, url: URL, drive: "driving" },
        },
        { target: "#13", class: "claimed-idle", why: "not carried" },
      ],
    });
    expect(buildLine(lineInput({ reports: [r] })).carried).toEqual([
      {
        repo: REPO,
        target: "#12",
        pr: 31,
        url: URL,
        drive: "driving",
        why,
      },
    ]);
  });

  it("stores the carried items with the line", () => {
    const root = mkdtempSync(join(tmpdir(), "jig-carried-"));
    try {
      const line = readBy(
        buildLine(
          lineInput({
            reports: [
              report({
                quiet: [
                  {
                    target: "#12",
                    class: "claimed-carried",
                    why,
                    carried: { pr: 31, url: URL, drive: "converged" },
                  },
                ],
              }),
            ],
          }),
        ),
        "carried",
        "2026-11-14T17:14:00.000Z",
      );
      writeLine(line, "{}", root);
      const stored = readLine(root);
      expect(stored.ok).toBe(true);
      if (!stored.ok) return;
      expect(stored.value?.carried).toEqual(line.carried);
      expect(line.carried).toHaveLength(1);
      const [entry] = line.carried ?? [];
      writeLine(
        {
          ...line,
          carried: [{ ...entry, drive: "merged" } as unknown as LineCarried],
        },
        "{}",
        root,
      );
      expect(readLine(root).ok).toBe(false);
      for (const pr of [-1, 0, 1.5]) {
        writeLine(
          { ...line, carried: [{ ...entry, pr } as LineCarried] },
          "{}",
          root,
        );
        expect(readLine(root).ok).toBe(false);
      }
    } finally {
      closeStateDb(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a merged pull request whose link rests on the forge's closing references", () => {
  const merged: MergedPr = {
    number: 30,
    url: `https://github.com/${SLUG}/pull/30`,
    title: "issue 12",
    head: "unrelated-branch",
    mergedAt: "2026-11-14T16:00:00Z",
    body: "",
  };
  const rules = (issueRepository: string) => ({
    keys: numberKeys(issueRepository),
    branchPattern: "{key_lower}-{slug}",
    repository: SLUG,
    issueRepository,
  });
  const read = (issueRepository: string) =>
    carrierInput({
      prs: [],
      rules: rules(issueRepository),
      drives: [],
      read: new Set(),
      merged: [merged],
      nowMs: NOW,
    });

  it("settles nothing where the issues are in another repository, since the merged listing does not carry the references", () => {
    expect(read("example-org/issues").merged?.("#12")).toEqual([]);
  });

  it("keeps a link the branch affirms where the issues are in another repository", () => {
    const branch = { ...merged, head: "12-fix" };
    const input = carrierInput({
      prs: [],
      rules: rules("example-org/issues"),
      drives: [],
      read: new Set(),
      merged: [branch],
      nowMs: NOW,
    });
    expect(input.merged?.("#12")).toEqual([{ number: 30, url: branch.url }]);
  });

  it("is read as before where the issues are in the repository itself", () => {
    expect(read(SLUG).merged?.("#12")).toEqual([]);
  });
});
