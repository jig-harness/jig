/**
 * dispatch --apply: notifications. A drive parked with a decision
 * unanswered reaches a person once, as the workspace's comment carrying the
 * drive's framed decision with the workspace marked unread (what Orca's
 * phone app shows); the answer, a comment on the pull request, makes the
 * next tick re-arm the drive. A cause whose message did not arrive is sent
 * again; one the target has no workspace for goes to the repository's
 * notices workspace.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { ParkedItem } from "../../skills/drive-pr/scripts/lib/state/schema.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  ledgerComment,
  openPr,
  type OrcaRow,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import { account, driveRuns, machineFile, waitFor } from "./launch-fixtures.ts";
import { orcaCalls, withOrigin } from "./pickup-fixtures.ts";

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

/** PR #7 parked on F1, in a workspace of its own; one account, `rearm` and `notify` enabled. */
function fixture(rows?: (ws: string) => OrcaRow[]): { w: World; ws: string } {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
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

/** The comment and unread mark Orca keeps for the workspace at `path`. */
function shown(w: World, path: string): { comment: string; unread: boolean } {
  const ps = JSON.parse(readFileSync(join(w.dir, "orca-ps.json"), "utf8")) as {
    worktrees: Array<{ path: string; comment: string; unread: boolean }>;
  };
  const row = ps.worktrees.find((r) => r.path === path);
  return { comment: row?.comment ?? "", unread: row?.unread ?? false };
}

describe("jig dispatch --apply notifies a person", () => {
  it("notifies a parked drive once across three ticks, and re-arms it at the tick after the answer", async () => {
    const { w, ws } = fixture();

    const first = await tick(w);
    expect(notifications(first)).toEqual([
      expect.objectContaining({
        target: "PR #7",
        cause: "parked",
        outcome: "sent",
        workspace: ws,
      }),
    ]);
    const { comment, unread } = shown(w, ws);
    expect(unread).toBe(true);
    expect(comment).toContain(
      `[jig dispatch: ${SLUG} PR #7 parked, ledger generation 3: finding F1]`,
    );
    expect(comment).toContain("[finding] F1 · class design-choice");
    expect(comment).toContain("Recommended: (a)");
    expect(comment).toContain("`answer <key>: …`");

    for (const later of [await tick(w), await tick(w)])
      expect(notifications(later)).toEqual([
        expect.objectContaining({ target: "PR #7", outcome: "suppressed" }),
      ]);
    expect(orcaCalls(w, "worktree", "set")).toHaveLength(1);
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
    expect(orcaCalls(w, "worktree", "set")).toHaveLength(1);
  });

  it("sends a message again when the workspace's comment did not take it", async () => {
    const { w, ws } = fixture();
    writeFileSync(join(w.dir, "orca-set-noop"), "");
    const lost = await tick(w);
    expect(notifications(lost)).toEqual([
      expect.objectContaining({ target: "PR #7", outcome: "lost" }),
    ]);
    rmSync(join(w.dir, "orca-set-noop"));
    expect(notifications(await tick(w))).toEqual([
      expect.objectContaining({ target: "PR #7", outcome: "sent" }),
    ]);
    expect(shown(w, ws).comment).toContain("PR #7 parked");
  });

  it("appends to a comment a person has not read yet rather than replacing it", async () => {
    const earlier = "[jig dispatch: an earlier cause]\nPR #3 stopped.";
    const { w, ws } = fixture((path) => [
      {
        branch: "feature/7-parked",
        linkedPR: 7,
        path,
        comment: earlier,
        unread: true,
      },
    ]);
    await tick(w);
    const { comment } = shown(w, ws);
    expect(comment.startsWith(earlier)).toBe(true);
    expect(comment).toContain("PR #7 parked");
  });

  it("sends what has no workspace that can take it to the repository's notices workspace, in one message", async () => {
    // PR #7's workspace still holds a kickoff prompt; PR #8 has none.
    const { w, ws } = fixture((path) => [
      {
        branch: "feature/7-parked",
        linkedPR: 7,
        path,
        comment: "Fix the flaky retry test",
      },
    ]);
    withOrigin(w);
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
    expect(shown(w, ws).comment).toBe("Fix the flaky retry test");
    const { comment, unread } = shown(w, notices);
    expect(unread).toBe(true);
    expect(comment).toContain("PR #7 parked");
    expect(comment).toContain(`[jig dispatch: ${SLUG} PR #8 stopped 7`);
    expect(orcaCalls(w, "worktree", "set")).toHaveLength(1);

    await tick(w);
    expect(orcaCalls(w, "worktree", "create")).toHaveLength(1);
    expect(orcaCalls(w, "worktree", "set")).toHaveLength(1);
  });
});
