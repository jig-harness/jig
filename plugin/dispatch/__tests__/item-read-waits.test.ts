/**
 * dispatch: a read a tick makes for one item, a failed call stopped. The
 * item's row carries the call's failure class, so a class that clears by
 * waiting (a rate limit, a forge that did not answer) leaves the tick's exit
 * at 0 below `failures.notify_after`, as the same refusal of a repository's
 * read does, and a refused credential fails the tick and is told at once.
 * Each tick runs as the installed command in a child with its own home.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { ParkedItem } from "../../skills/drive-pr/scripts/lib/state/schema.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { FAILURE_DEFAULTS, readFailures } from "../lib/failures.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  ledgerComment,
  mergedPr,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import { account, dispatchState, machineFile } from "./launch-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
`;

/**
 * With follow-ups on, the merged pull requests are listed after the open
 * ones' comments: a forge held after an open pull request's read did not
 * answer would refuse that listing, a repository's read, and hide the
 * item's own row. The open pull requests' kinds are read without them.
 */
const FOLLOWUPS = `${CONFIG}  followup_command: /followup
`;

/** What `gh` prints for each refusal, as the forge's client says it. */
const SAYS = {
  "rate-limited": "gh: API rate limit exceeded for user ID 1. (HTTP 403)",
  unreachable: "dial tcp: lookup api.github.com: no such host",
  unauthorized: "gh: Bad credentials (HTTP 401)",
} as const;
type Refusal = keyof typeof SAYS;

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** A world with open pull request #7 and merged pull request #5, followed up where `followups` says. */
function fixture(followups = false): World {
  const w = world();
  current = w;
  w.setConfig(followups ? FOLLOWUPS : CONFIG);
  w.setPrs("open", [openPr(7, "feature/7-open")]);
  w.setPrs("merged", [mergedPr(5, "feature/5-merged", "2026-10-30T12:00:00Z")]);
  return w;
}

/** One tick of the world's repository, with `--apply` where asked; its exit and its receipt. */
async function tick(
  w: World,
  apply = false,
): Promise<{ exit: number; receipt: TickReceipt }> {
  const r = await w.dispatch([
    "--repo",
    w.repo,
    "--followup-since",
    "2026-10-30T00:00:00Z",
    ...(apply ? ["--apply"] : []),
    "--json",
  ]);
  expectSpawnExit(r, r.exitCode === 0 ? 0 : 1);
  return { exit: r.exitCode ?? -1, receipt: JSON.parse(r.stdout) };
}

/** The failed read of `target` the receipt's repository shows. */
function rowOf(receipt: TickReceipt, target: string) {
  return receipt.repos[0]?.unplaced.find(
    (u) => u.target === target && u.readFailed === true,
  );
}

/** A thread park on a drive that stopped parked, its answers read from the thread. */
const THREAD_PARK: ParkedItem = {
  key: "PRRT_t1",
  kind: "thread",
  reason: "Which retry budget should the client keep?",
  round: 2,
  at: "2026-10-30T21:00:00.000Z",
};

/** Each read kind: what it reads for its item, how a refusal of it is set up, and the item's target. */
const KINDS: Array<{
  kind: string;
  target: string;
  followups?: true;
  refuse: (w: World, says: string) => void;
}> = [
  {
    kind: "an open pull request's comments, which hold its drive ledger",
    target: "PR #7",
    refuse: (w, says) => w.failCall("issues/7/comments?per_page", says),
  },
  {
    kind: "a merged pull request's follow-up markers",
    target: "PR #5",
    followups: true,
    refuse: (w, says) => w.failCall("issues/5/comments?per_page", says),
  },
  {
    kind: "the answers to a parked drive's thread",
    target: "PR #7",
    refuse: (w, says) => {
      w.setComments(7, [
        ledgerComment(
          701,
          stoppedLedger(7, DRIVE_EXIT.HITL_PARKED, { parked: [THREAD_PARK] }),
        ),
      ]);
      w.failCall(`id=${THREAD_PARK.key}`, says);
    },
  },
  {
    kind: "the head of a conflicting drive's base branch",
    target: "PR #7",
    refuse: (w, says) => {
      w.setPrs("open", [
        openPr(7, "feature/7-open", { mergeable: "CONFLICTING" }),
      ]);
      w.setComments(7, [ledgerComment(701, stoppedLedger(7, 9))]);
      w.failCall("git/ref/heads/main", says);
    },
  },
];

describe("a read for one item a failed call stopped", () => {
  for (const { kind, target, followups, refuse } of KINDS) {
    for (const refusal of ["rate-limited", "unreachable"] as Refusal[])
      it(`waits out ${kind}, ${refusal}, with the tick's exit at 0`, async () => {
        const w = fixture(followups);
        refuse(w, SAYS[refusal]);
        const { exit, receipt } = await tick(w);
        expect(rowOf(receipt, target)?.failure?.class).toBe(refusal);
        expect(exit).toBe(0);
      }, 60_000);

    it(`fails the tick for ${kind} refused for its credential`, async () => {
      const w = fixture(followups);
      refuse(w, SAYS.unauthorized);
      const { exit, receipt } = await tick(w);
      expect(rowOf(receipt, target)?.failure?.class).toBe("unauthorized");
      expect(exit).toBe(1);
    }, 60_000);
  }

  it("answers an item's read of an absence on its row without failing the tick or the ledger", async () => {
    const w = fixture();
    machineFile(w, [account(w, "a", "a@example.com")], {}, ["notify"]);
    w.setComments(7, [
      ledgerComment(
        701,
        stoppedLedger(7, DRIVE_EXIT.HITL_PARKED, { parked: [THREAD_PARK] }),
      ),
    ]);
    w.failCall(
      `id=${THREAD_PARK.key}`,
      "gh: Could not resolve to a node with the global id 'PRRT_t1' (HTTP 404)",
    );
    const { exit, receipt } = await tick(w, true);
    expect(rowOf(receipt, "PR #7")?.failure?.class).toBe("not-found");
    expect(exit).toBe(0);
    expect(readFailures(undefined, dispatchState(w))).toEqual([]);
  }, 60_000);

  it("tells a person at once of an item's read refused for its credential", async () => {
    const w = fixture();
    machineFile(w, [account(w, "a", "a@example.com")], {}, ["notify"]);
    w.failCall("issues/7/comments?per_page", SAYS.unauthorized);
    const { exit } = await tick(w, true);
    expect(exit).toBe(1);
    expect(
      readFailures(undefined, dispatchState(w)).find(
        (r) => r.kind === "repository",
      )?.count,
    ).toBe(FAILURE_DEFAULTS.notifyAfter);
  }, 60_000);

  it("counts an item's read that did not answer, and waits it out below the threshold", async () => {
    const w = fixture();
    machineFile(w, [account(w, "a", "a@example.com")], {}, ["notify"]);
    w.failCall("issues/7/comments?per_page", SAYS.unreachable);
    const { exit } = await tick(w, true);
    expect(exit).toBe(0);
    expect(
      readFailures(undefined, dispatchState(w)).find(
        (r) => r.kind === "repository",
      )?.count,
    ).toBe(1);
  }, 60_000);
});
