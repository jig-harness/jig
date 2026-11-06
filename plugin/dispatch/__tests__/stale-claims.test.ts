/**
 * dispatch --apply: stale follow-up claims. A follow-up claim with no done
 * mark, no session joined to its pull request and an age past
 * `followup_stale_after` is released once: the tick deletes its marker, and
 * the next tick starts the follow-up again. A claim on the same pull request
 * that goes stale after that release is notified to a person, with its age
 * and whose claim it is, and never released a second time. A person's run
 * and another host's count the same; a claim inside the window, or one a
 * session is joined to, is held as before.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { forgeComment } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import { MARKER, manualMarker, tickMarker } from "../lib/followup-marker.ts";
import { existingStateDb } from "../lib/state.ts";
import type { TickReceipt } from "../receipts.ts";
import { mergedPr, type OrcaRow, SLUG, type World, world } from "./fixtures.ts";
import { account, dispatchState, machineFile } from "./launch-fixtures.ts";
import { applyTick, withOrigin } from "./pickup-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  followup_command: /followup
`;

const HEAD = "feature/9-done";
/** Who posts the markers this suite seeds: on PR #9. */
const POST = { pr: 9, writer: { host: "sha256:0123456789abcdef" } };
/** Another host dispatching the repository, as its markers name it. */
const OTHER = "sha256:fedcba9876543210";

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

const hoursAgo = (hours: number) =>
  new Date(Date.now() - hours * 3_600_000).toISOString();

/** A marker comment posted `hours` ago by a member. */
function posted(id: number, body: string, hours: number, login = "maintainer") {
  return { ...forgeComment(id, body, login), created_at: hoursAgo(hours) };
}

/** PR #9 merged, its workspace with no agent unless `rows` says otherwise; `followup` and `notify` enabled. */
function fixture(rows?: (ws: string) => OrcaRow[]): { w: World; ws: string } {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  withOrigin(w);
  w.setPrs("merged", [mergedPr(9, HEAD, "2026-10-31T12:00:00Z")]);
  w.setComments(9, []);
  const ws = join(w.root, "ws-9");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces(rows?.(ws) ?? [{ branch: HEAD, linkedPR: 9, path: ws }]);
  machineFile(
    w,
    [account(w, "a", "a@example.com")],
    {},
    ["followup", "notify"],
    { followup_since: "2026-10-30T00:00:00Z" },
  );
  return { w, ws };
}

type Comment = { id: number; body: string };

function markers(w: World): number[] {
  const all = JSON.parse(
    readFileSync(join(w.dir, "comments-9.json"), "utf8"),
  ) as Comment[];
  return all.filter((c) => c.body.startsWith(MARKER)).map((c) => c.id);
}

const repo = (r: TickReceipt) => r.repos[0];

function events(w: World): Array<{ event: string; class: string | null }> {
  const db = existingStateDb(dispatchState(w));
  return (
    (db?.query("SELECT row FROM log WHERE kind = 'event'").all() as Array<{
      row: string;
    }>) ?? []
  ).map((r) => JSON.parse(r.row));
}

describe("jig dispatch --apply releases a stale follow-up claim", () => {
  it("releases a person's stale claim once, says whose it was, and starts the follow-up again at the next tick", async () => {
    const { w } = fixture();
    w.setComments(9, [posted(901, manualMarker(false, POST), 30)]);

    const first = await applyTick(w, false);
    const [release] = repo(first)?.actions ?? [];
    expect(release).toMatchObject({ stage: "followup", target: "PR #9" });
    expect(release?.reason).toContain(
      "maintainer's /followup run claimed it 30h ago",
    );
    expect(release?.reason).toContain("dispatch.followup_stale_after 24h");
    expect(repo(first)?.releases).toEqual([
      expect.objectContaining({
        target: "PR #9",
        marker: 901,
        claimant: "maintainer's /followup run",
        outcome: "released",
      }),
    ]);
    expect(repo(first)?.launches).toEqual([]);
    expect(markers(w)).toEqual([]);
    expect(events(w)).toContainEqual(
      expect.objectContaining({ event: "followup-released", class: "stalled" }),
    );

    const second = await applyTick(w, false);
    expect(repo(second)?.releases).toBeUndefined();
    expect(repo(second)?.launches).toEqual([
      expect.objectContaining({
        action: "followup",
        target: "PR #9",
        outcome: "launched",
      }),
    ]);
  });

  it("notifies a person, never releasing a second time, when a claim on the pull request goes stale again", async () => {
    const { w } = fixture();
    w.setComments(9, [posted(901, manualMarker(false, POST), 30)]);
    await applyTick(w, false);
    // A person's run claimed it again after the release, and stopped short too.
    w.setComments(9, [posted(920, manualMarker(false, POST), 26, "reviewer")]);

    const again = await applyTick(w, false);
    expect(repo(again)?.releases).toBeUndefined();
    expect(repo(again)?.launches).toEqual([]);
    expect(markers(w)).toEqual([920]);
    const [stale] = repo(again)?.actions ?? [];
    expect(stale).toMatchObject({
      stage: "notify",
      target: "PR #9",
      cause: "followup-stale",
    });
    expect(stale?.reason).toContain(
      "reviewer's /followup run claimed it 26h ago",
    );
    expect(stale?.notice?.text).toContain("marker comment 920");
    expect(stale?.notice?.text).toContain("marker comment 901");
    expect(repo(again)?.notifications).toEqual([
      expect.objectContaining({ cause: "followup-stale", outcome: "sent" }),
    ]);

    const later = await applyTick(w, false);
    expect(repo(later)?.notifications).toEqual([
      expect.objectContaining({
        cause: "followup-stale",
        outcome: "suppressed",
      }),
    ]);
    expect(markers(w)).toEqual([920]);
  });

  it("treats another host's claim with no answer the same, naming that host", async () => {
    const { w } = fixture();
    w.setComments(9, [
      posted(
        902,
        tickMarker("20261030T200000Z-aaaaaaaa", { ...POST, host: OTHER }),
        30,
        "drive-bot",
      ),
    ]);
    const r = await applyTick(w, false);
    expect(repo(r)?.releases).toEqual([
      expect.objectContaining({
        marker: 902,
        claimant: `host ${OTHER}'s launch record 20261030T200000Z-aaaaaaaa`,
        outcome: "released",
      }),
    ]);
    expect(markers(w)).toEqual([]);
  });

  it("holds a claim inside the window as before", async () => {
    const { w } = fixture();
    w.setComments(9, [posted(903, manualMarker(false, POST), 2)]);
    const r = await applyTick(w, false);
    expect(repo(r)?.actions).toEqual([]);
    expect(repo(r)?.quiet).toContainEqual(
      expect.objectContaining({ target: "PR #9", class: "followup-held" }),
    );
    expect(markers(w)).toEqual([903]);
  });

  it("holds a claim past the window while a session is joined to its pull request", async () => {
    const { w } = fixture((ws) => [
      {
        branch: HEAD,
        linkedPR: 9,
        path: ws,
        agents: [{ state: "working" }],
      },
    ]);
    w.setComments(9, [posted(904, manualMarker(false, POST), 30)]);
    const r = await applyTick(w, false);
    expect(repo(r)?.actions).toEqual([]);
    expect(repo(r)?.quiet).toContainEqual(
      expect.objectContaining({ target: "PR #9", class: "followup-held" }),
    );
    expect(markers(w)).toEqual([904]);
  });
});
