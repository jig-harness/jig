/**
 * The `notices_read` event: each tick of the `notify` stage records one row
 * with the notices workspace's read state as the tick's listing found it,
 * before its own notice marks the workspace unread; with no workspace open,
 * no mark reported or a listing that did not read, the state is `null` and
 * the reason says why.
 */
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplyState } from "../lib/actions/launch.ts";
import { applyNotices } from "../lib/actions/notify.ts";
import { stewardHistory } from "../lib/actions/steward.ts";
import { type EventRow, readRows, writeRow } from "../lib/log.ts";
import { NOTICES_READ, noticesReadRow } from "../lib/notices-read.ts";
import type {
  SessionRuntime,
  SessionsReport,
  Workspace,
} from "../lib/runtime/port.ts";
import { closeStateDb } from "../lib/state.ts";
import type { RepoReport, RepoTarget } from "../lib/types.ts";

const SLUG = "example-org/example-repo";
const KEY = `${SLUG} PR #7 parked, ledger generation 3: finding F1`;

const roots: string[] = [];
afterEach(() => {
  setSystemTime();
  for (const root of roots.splice(0)) {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function workspace(root: string, unread: boolean | null): Workspace {
  return {
    id: "notices",
    path: join(root, "notices"),
    branch: "jig-dispatch-notices",
    prs: [],
    items: [],
    agents: [],
    unverifiableTerminals: 0,
    comment: "",
    unread,
    name: "notices",
  };
}

/** A notices workspace, read, and a runtime that writes its comment and marks it unread. */
function host() {
  const root = mkdtempSync(join(tmpdir(), "jig-notices-read-"));
  roots.push(root);
  const notices = workspace(root, false);
  const runtime = {
    async notify(_target, message) {
      notices.comment = [notices.comment, message].filter(Boolean).join("\n\n");
      notices.unread = true;
      return {
        ok: true,
        detail: "written",
        comment: notices.comment,
        unread: true,
      };
    },
  } satisfies Partial<SessionRuntime>;
  const state = {
    root,
    runtime,
    machine: { runtimeTimeoutMs: 1000 },
  } as unknown as ApplyState;
  const repo: RepoTarget = { path: root, slug: SLUG, defaultBranch: "main" };
  return { root, notices, state, repo };
}

function parkedReport(repo: RepoTarget): RepoReport {
  return {
    path: repo.path,
    slug: repo.slug,
    refused: null,
    section: null,
    followupSince: null,
    records: [],
    running: [],
    unplaced: [],
    launches: [],
    notifications: [],
    quiet: [],
    actions: [
      {
        stage: "notify",
        target: "PR #7",
        cause: "parked",
        reason: "a decision waits",
        record: "forge",
        evidence: {},
        notice: { key: KEY, text: `[jig dispatch: ${KEY}]\nWhich budget?` },
      },
    ],
  };
}

async function tick(h: ReturnType<typeof host>, at: string): Promise<void> {
  setSystemTime(new Date(at));
  await applyNotices(
    h.state,
    h.repo,
    parkedReport(h.repo),
    { ok: true, source: "test", workspaces: [h.notices] },
    { branch: null, lingerMs: 3_600_000, renotifyAfterMs: 0 },
  );
}

function readEvents(root: string): EventRow[] {
  return readRows(undefined, undefined, root).filter(
    (r): r is EventRow => r.kind === "event" && r.event === NOTICES_READ,
  );
}

describe("the notices_read event", () => {
  it("records the workspace's read state once per tick, as the tick found it before its own notice", async () => {
    const h = host();
    await tick(h, "2026-11-05T10:00:00.000Z");
    // The first tick's notice marked the workspace unread; the second finds it so.
    await tick(h, "2026-11-05T10:05:00.000Z");
    const events = readEvents(h.root);
    expect(events.map((e) => [e.at, e.read])).toEqual([
      ["2026-11-05T10:00:00.000Z", true],
      ["2026-11-05T10:05:00.000Z", false],
    ]);
    expect(events[0]).toMatchObject({
      stage: "notify",
      repo: SLUG,
      target: "",
      class: null,
      account: null,
    });
    expect(events[1]?.reason).toContain("is unread");
  });

  it("records an unknown state, and why, when the destination's state cannot be read", () => {
    const root = "/srv/state";
    const cases: Array<[SessionsReport, string | null, string]> = [
      [
        { ok: true, source: "test", workspaces: [] },
        null,
        "no workspace on jig-dispatch-notices",
      ],
      [
        { ok: true, source: "test", workspaces: [workspace(root, null)] },
        null,
        "reports no read mark",
      ],
      [
        { ok: false, source: "test", reason: "the runtime did not answer" },
        null,
        "did not read",
      ],
      [
        { ok: true, source: "test", workspaces: [workspace(root, false)] },
        "notes-branch",
        "no workspace on notes-branch",
      ],
    ];
    for (const [sessions, branch, says] of cases) {
      const row = noticesReadRow(
        SLUG,
        sessions,
        branch,
        "2026-11-05T10:00:00.000Z",
      );
      expect(row.read).toBeNull();
      expect(row.reason).toContain(says);
    }
  });
});

describe("the steward's history", () => {
  it("leaves the notices_read rows out, so a tick's observation never crowds out what ended", () => {
    const root = mkdtempSync(join(tmpdir(), "jig-notices-steward-"));
    roots.push(root);
    const sessions: SessionsReport = {
      ok: true,
      source: "test",
      workspaces: [workspace(root, false)],
    };
    for (let i = 0; i < 60; i++)
      writeRow(
        noticesReadRow(
          SLUG,
          sessions,
          null,
          `2026-11-05T10:${String(i).padStart(2, "0")}:00.000Z`,
        ),
        root,
      );
    const outlived: EventRow = {
      kind: "event",
      key: `outlived ${SLUG} PR #7`,
      at: "2026-11-05T09:00:00.000Z",
      repo: SLUG,
      stage: "pickup",
      target: "PR #7",
      event: "outlived",
      account: null,
      class: null,
      reason: "the run outlived its tick",
    };
    writeRow(outlived, root);
    const history = stewardHistory(SLUG, root) as EventRow[];
    expect(history.map((r) => r.event)).toEqual(["outlived"]);
  });
});
