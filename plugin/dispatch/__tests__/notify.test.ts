/**
 * dispatch --apply: notifications. A drive parked with a decision
 * unanswered reaches a person as the comment of the repository's one
 * destination, the notices workspace or the workspace `notices_branch`
 * names, with the workspace marked unread (what Orca's phone app shows),
 * never the workspace joined to the pull request; the message names that
 * workspace, where the handoff is. The answer, a comment on the pull
 * request, makes the next tick re-arm the drive. A cause whose message did
 * not arrive is sent again; one that still stands `renotify_after` after its
 * last send is sent again, and with the cadence zero, once only.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { ParkedItem } from "../../skills/drive-pr/scripts/lib/state/schema.ts";
import type { TickReceipt } from "../receipts.ts";
import { statePath } from "../lib/state.ts";
import {
  ledgerComment,
  openPr,
  type OrcaRow,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import {
  account,
  dispatchState,
  driveRuns,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { notifyWrites, orcaCalls, withOrigin } from "./pickup-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
`;

const PARK: ParkedItem = {
  key: "F1",
  kind: "finding",
  reason: "Which retry budget should the client keep?",
  round: 2,
  at: "2026-10-30T21:00:00.000Z",
  class: "design-choice",
  record:
    "Question: which retry budget should the client keep?\nOptions: (a) three retries; (b) five retries\nRecommended: (a), the budget the timeout was sized for",
};

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** PR #7 parked on F1, in a workspace of its own that could take a comment; one account, `rearm` and `notify` enabled. */
function fixture(
  rows?: (ws: string) => OrcaRow[],
  config = CONFIG,
): { w: World; ws: string } {
  const w = world();
  current = w;
  w.setConfig(config);
  withOrigin(w);
  w.setPrs("open", [openPr(7, "feature/7-parked")]);
  w.setComments(7, [
    ledgerComment(701, stoppedLedger(7, 8, { parked: [PARK] })),
  ]);
  const ws = join(w.root, "ws-7");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces(
    rows?.(ws) ?? [{ branch: "feature/7-parked", linkedPR: 7, path: ws }],
  );
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["rearm", "notify"]);
  return { w, ws };
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

const notifications = (r: TickReceipt) => r.repos[0]?.notifications ?? [];

type PsRow = { path: string; comment: string; unread: boolean };

function psRows(w: World): { worktrees: PsRow[] } {
  return JSON.parse(readFileSync(join(w.dir, "orca-ps.json"), "utf8"));
}

/** The comment and unread mark Orca keeps for the workspace at `path`. */
function shown(w: World, path: string): { comment: string; unread: boolean } {
  const row = psRows(w).worktrees.find((r) => r.path === path);
  return { comment: row?.comment ?? "", unread: row?.unread ?? false };
}

/** A person opens the workspace at `path`: Orca clears its unread mark. */
function markRead(w: World, path: string): void {
  const ps = psRows(w);
  for (const row of ps.worktrees) if (row.path === path) row.unread = false;
  writeFileSync(join(w.dir, "orca-ps.json"), JSON.stringify(ps));
}

/** Move every suppression record's sends `hours` into the past, as if that long had passed. */
function agedBy(w: World, hours: number): void {
  const at = new Date(Date.now() - hours * 3_600_000).toISOString();
  const db = new Database(statePath(dispatchState(w)));
  try {
    db.query("UPDATE notices SET at = ?, sent_at = ?").run(at, at);
  } finally {
    db.close();
  }
}

describe("jig dispatch --apply notifies a person", () => {
  it("notifies a parked drive once across three ticks in the notices workspace, naming the drive's own, and re-arms it at the tick after the answer", async () => {
    const { w, ws } = fixture();

    const first = await tick(w);
    const [sent] = notifications(first);
    expect(sent).toMatchObject({
      target: "PR #7",
      cause: "parked",
      outcome: "sent",
    });
    const notices = sent?.workspace ?? "";
    expect(notices).not.toBe(ws);
    expect(shown(w, ws)).toEqual({ comment: "", unread: false });
    const { comment, unread } = shown(w, notices);
    expect(unread).toBe(true);
    expect(comment).toContain(
      `[jig dispatch: ${SLUG} PR #7 parked, ledger generation 3: finding F1]`,
    );
    expect(comment).toContain("[finding] F1 · class design-choice");
    expect(comment).toContain("Recommended: (a)");
    expect(comment).toContain("`answer <key>: …`");
    expect(comment).toContain(`Its workspace: ${ws}`);

    for (const later of [await tick(w), await tick(w)])
      expect(notifications(later)).toEqual([
        expect.objectContaining({ target: "PR #7", outcome: "suppressed" }),
      ]);
    expect(notifyWrites(w)).toHaveLength(1);
    expect(driveRuns(w)).toEqual([]);

    // The person answers on the pull request, from the phone or anywhere.
    w.setComments(7, [
      ledgerComment(701, stoppedLedger(7, 8, { parked: [PARK] })),
      {
        id: 750,
        body: "answer F1: keep three retries",
        user: { login: "maintainer" },
        author_association: "MEMBER",
        created_at: "2026-10-31T08:00:00Z",
        updated_at: "2026-10-31T08:00:00Z",
      },
    ]);
    const answered = await tick(w);
    expect(answered.repos[0]?.actions).toEqual([
      expect.objectContaining({ stage: "rearm", target: "PR #7" }),
    ]);
    expect(answered.repos[0]?.launches).toEqual([
      expect.objectContaining({ action: "rearm", outcome: "launched" }),
    ]);
    expect(notifications(answered)).toEqual([]);
    await waitFor("the re-armed drive", () => driveRuns(w).length === 1);
    expect(notifyWrites(w)).toHaveLength(1);
  });

  it("sends a message again when the workspace's comment did not take it", async () => {
    const { w } = fixture();
    writeFileSync(join(w.dir, "orca-set-noop"), "");
    const lost = await tick(w);
    expect(notifications(lost)).toEqual([
      expect.objectContaining({ target: "PR #7", outcome: "lost" }),
    ]);
    rmSync(join(w.dir, "orca-set-noop"));
    const again = notifications(await tick(w));
    expect(again).toEqual([
      expect.objectContaining({ target: "PR #7", outcome: "sent" }),
    ]);
    expect(shown(w, again[0]?.workspace ?? "").comment).toContain(
      "PR #7 parked",
    );
  });

  it("appends to a comment a person has not read yet rather than replacing it", async () => {
    const earlier = "[jig dispatch: an earlier cause]\nPR #3 stopped.";
    const { w, ws } = fixture((path) => [
      { branch: "feature/7-parked", linkedPR: 7, path },
      {
        branch: "jig-dispatch-notices",
        path: join(dirname(path), "notices"),
        comment: earlier,
        unread: true,
      },
    ]);
    const notices = join(dirname(ws), "notices");
    await tick(w);
    const { comment } = shown(w, notices);
    expect(comment.startsWith(earlier)).toBe(true);
    expect(comment).toContain("PR #7 parked");
    expect(orcaCalls(w, "worktree", "create")).toEqual([]);
  });

  it("sends every cause to the notices workspace in one message, even where the pull request's own workspace could take it", async () => {
    // PR #7's workspace runs an agent, so it could take a comment; PR #8 has none.
    const { w, ws } = fixture((path) => [
      {
        branch: "feature/7-parked",
        linkedPR: 7,
        path,
        agents: [{ state: "working" }],
      },
    ]);
    w.setPrs("open", [
      openPr(7, "feature/7-parked"),
      openPr(8, "feature/8-failed"),
    ]);
    w.setComments(8, [ledgerComment(801, stoppedLedger(8, 7))]);

    const first = await tick(w);
    const sent = notifications(first);
    expect(sent.map((n) => [n.target, n.cause, n.outcome])).toEqual([
      ["PR #7", "parked", "sent"],
      ["PR #8", "needs-person", "sent"],
    ]);
    const notices = sent[0]?.workspace ?? "";
    expect(notices).not.toBe(ws);
    expect(sent[1]?.workspace).toBe(notices);
    expect(shown(w, ws)).toEqual({ comment: "", unread: false });
    // Named as the dispatcher's, and its comment, rewritten by the message, keeps the mark.
    const [create] = orcaCalls(w, "worktree", "create");
    expect(create?.[create.indexOf("--name") + 1]).toBe(
      "⚙ dispatched · notices",
    );
    const { comment, unread } = shown(w, notices);
    expect(unread).toBe(true);
    expect(comment.split("\n")[0]).toBe("⚙ dispatched · notices");
    expect(comment).toContain("PR #7 parked");
    expect(comment).toContain(`[jig dispatch: ${SLUG} PR #8 stopped 7`);
    expect(comment).toContain(`Its workspace: ${ws}`);
    expect(notifyWrites(w)).toHaveLength(1);

    await tick(w);
    expect(orcaCalls(w, "worktree", "create")).toHaveLength(1);
    expect(notifyWrites(w)).toHaveLength(1);
  });

  it("sends the notice to the workspace notices_branch names, even when a workspace is joined to the pull request", async () => {
    const rows = (ws: string): OrcaRow[] => [
      {
        branch: "feature/7-parked",
        linkedPR: 7,
        path: ws,
        agents: [{ state: "working" }],
      },
      { branch: "desk", path: join(dirname(ws), "desk") },
    ];
    const { w, ws } = fixture(
      rows,
      `${CONFIG}dispatch:\n  notices_branch: desk\n`,
    );
    const desk = join(dirname(ws), "desk");
    expect(notifications(await tick(w))).toEqual([
      expect.objectContaining({
        target: "PR #7",
        outcome: "sent",
        workspace: desk,
      }),
    ]);
    expect(shown(w, desk).comment).toContain("PR #7 parked");
    expect(shown(w, desk).unread).toBe(true);
    expect(shown(w, ws).comment).toBe("");
    expect(orcaCalls(w, "worktree", "create")).toEqual([]);
  });

  it.each(["desk", "jig-dispatch-notices"])(
    "preserves a personal comment on named destination %s even after an agent started",
    async (branch) => {
      const { w, ws } = fixture(
        (ws) => [
          {
            branch,
            path: join(dirname(ws), "desk"),
            comment: "Remember to check the release",
            agents: [{ state: "done" }],
          },
        ],
        `${CONFIG}dispatch:\n  notices_branch: ${branch}\n`,
      );
      expect(notifications(await tick(w))).toEqual([
        expect.objectContaining({ outcome: "waits" }),
      ]);
      expect(shown(w, join(dirname(ws), "desk")).comment).toBe(
        "Remember to check the release",
      );
      expect(notifyWrites(w)).toEqual([]);
    },
  );

  it("leaves a notice waiting, opening nothing, while no workspace is on the branch notices_branch names", async () => {
    const { w } = fixture(
      undefined,
      `${CONFIG}dispatch:\n  notices_branch: desk\n`,
    );
    const [waits] = notifications(await tick(w));
    expect(waits).toMatchObject({ target: "PR #7", outcome: "waits" });
    expect(waits?.detail).toContain("dispatch.notices_branch");
    expect(notifyWrites(w)).toEqual([]);
    expect(orcaCalls(w, "worktree", "create")).toEqual([]);
  });

  it("sends a notice that still stands again once renotify_after has passed since it was sent, and not before", async () => {
    const { w } = fixture();
    const [sent] = notifications(await tick(w));
    const notices = sent?.workspace ?? "";
    markRead(w, notices);

    agedBy(w, 23);
    expect(notifications(await tick(w))).toEqual([
      expect.objectContaining({ target: "PR #7", outcome: "suppressed" }),
    ]);
    expect(notifyWrites(w)).toHaveLength(1);

    agedBy(w, 25);
    const again = notifications(await tick(w));
    expect(again).toEqual([
      expect.objectContaining({
        target: "PR #7",
        outcome: "sent",
        workspace: notices,
      }),
    ]);
    expect(again[0]?.detail).toContain("sent again");
    expect(notifyWrites(w)).toHaveLength(2);
    const { comment, unread } = shown(w, notices);
    expect(unread).toBe(true);
    expect(comment).toContain("Sent again: this still waits on a person");
    expect(comment).toContain("PR #7 parked");

    // The repeat is timed from its own send.
    expect(notifications(await tick(w))).toEqual([
      expect.objectContaining({ target: "PR #7", outcome: "suppressed" }),
    ]);
    expect(notifyWrites(w)).toHaveLength(2);
  });

  it("sends a notice once only when renotify_after is zero", async () => {
    const { w } = fixture(
      undefined,
      `${CONFIG}dispatch:\n  renotify_after: 0s\n`,
    );
    const [sent] = notifications(await tick(w));
    expect(sent?.outcome).toBe("sent");
    markRead(w, sent?.workspace ?? "");
    agedBy(w, 72);
    expect(notifications(await tick(w))).toEqual([
      expect.objectContaining({ target: "PR #7", outcome: "suppressed" }),
    ]);
    expect(notifyWrites(w)).toHaveLength(1);
  });

  it("keeps a suppression record while its pull request is outside the label scope", async () => {
    const { w } = fixture(
      undefined,
      `${CONFIG}dispatch:
  labels: { enabled: true, only_labeled: true }
`,
    );
    const labelled = {
      ...openPr(7, "feature/7-parked"),
      labels: [{ name: "jig:drive" }],
    };
    w.setPrs("open", [labelled]);
    const [sent] = notifications(await tick(w));
    expect(sent).toMatchObject({ target: "PR #7", outcome: "sent" });

    // The label comes off: the cause is not observed to change, only unread.
    w.setPrs("open", [openPr(7, "feature/7-parked")]);
    await tick(w);

    w.setPrs("open", [labelled]);
    expect(notifications(await tick(w))).toEqual([
      expect.objectContaining({ target: "PR #7", outcome: "suppressed" }),
    ]);
    expect(notifyWrites(w)).toHaveLength(1);
    expect(shown(w, sent?.workspace ?? "").unread).toBe(true);
  });
});
