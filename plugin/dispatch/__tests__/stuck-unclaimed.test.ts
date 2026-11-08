/**
 * A pending launch record whose last launch the runtime answered as
 * started, and whose wrapper never claimed it: stuck once
 * `unclaimed_after` has passed since that answer, never within it, and
 * never while the runtime cannot say which sessions run. A session joined
 * to its target is named in why it is stuck.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLine } from "../lib/line.ts";
import type { ReadRecord } from "../lib/launches.ts";
import {
  readMachineConfig,
  UNCLAIMED_AFTER_MS,
} from "../lib/machine-config.ts";
import type { SessionsReport, Workspace } from "../lib/runtime/port.ts";
import { planStuck, stuckWhy } from "../lib/stuck-launches.ts";
import { input, NOW, PATH, record, REPO, report } from "./line-fixtures.ts";

const NOW_MS = Date.parse(NOW);
const ago = (minutes: number) =>
  new Date(NOW_MS - minutes * 60_000).toISOString();
const sent = (minutes: number) => ({
  at: ago(minutes),
  outcome: "sent" as const,
  detail: "started",
});
const pending = { kind: "pending" as const };

const NO_SESSIONS: SessionsReport = {
  ok: true,
  source: "orca",
  workspaces: [],
};

function workspace(fields: Partial<Workspace>): Workspace {
  return {
    id: "other",
    path: "/srv/work/web/other",
    branch: "feature/456",
    items: [],
    prs: [],
    agents: [],
    unverifiableTerminals: 0,
    comment: "",
    unread: false,
    name: "",
    ...fields,
  };
}

const clock = (
  sessions: SessionsReport = NO_SESSIONS,
  afterMs = UNCLAIMED_AFTER_MS,
) => ({
  nowMs: NOW_MS,
  unclaimedAfterMs: afterMs,
  sessions,
});

describe("a launch answered as started that no wrapper claimed", () => {
  it("is stuck past unclaimed_after, with no session joined to its target", () => {
    const read = record({ attempts: [sent(20)] }, pending);
    const [action] = planStuck(REPO, [read], clock());
    const why = String(action?.evidence.stuck);
    expect(action).toMatchObject({
      stage: "notify",
      cause: "needs-person",
      target: "PR #456",
      evidence: {
        record: read.record.id,
        stage: "rearm",
        stuck: expect.stringContaining("no session is joined to its target"),
      },
    });
    expect(why).toContain(`as started at ${ago(20)}`);
    expect(why).toContain("unclaimed_after (15m)");
    expect(action?.reason).toContain(`jig dispatch clear ${read.record.id}`);
  });

  it("is never stuck within unclaimed_after, nor with no clock to read it by", () => {
    const fresh = record({ attempts: [sent(14)] }, pending);
    expect(planStuck(REPO, [fresh], clock())).toEqual([]);
    expect(stuckWhy(record({ attempts: [sent(20)] }, pending))).toBeNull();
  });

  it("is never stuck once its wrapper claimed it, however long ago the answer came", () => {
    const claimed = record({ attempts: [sent(120)] });
    expect(claimed.state.kind).toBe("alive");
    expect(planStuck(REPO, [claimed], clock())).toEqual([]);
  });

  it("waits on the machine file's unclaimed_after", () => {
    const read = record({ attempts: [sent(20)] }, pending);
    expect(planStuck(REPO, [read], clock(NO_SESSIONS, 3_600_000))).toEqual([]);
    const [action] = planStuck(REPO, [read], clock(NO_SESSIONS, 10 * 60_000));
    expect(String(action?.evidence.stuck)).toContain("unclaimed_after (10m)");
  });

  it("names a session joined to its target as one its wrapper may have started without claiming", () => {
    const read = record({ attempts: [sent(20)] }, pending);
    const running: SessionsReport = {
      ok: true,
      source: "orca",
      workspaces: [
        workspace({
          prs: [456],
          agents: [
            { id: "a-1", state: "working", agentType: "claude", since: null },
          ],
        }),
      ],
    };
    const why = stuckWhy(read, clock(running));
    expect(why).toContain("a session is joined to its target");
    expect(why).toContain("without claiming the record");
    expect(why).not.toContain("no session is joined");
  });

  it("waits while the runtime cannot say which sessions run", () => {
    const read = record({ attempts: [sent(20)] }, pending);
    const unread: SessionsReport = {
      ok: false,
      source: "orca",
      reason: "orca is not running",
    };
    expect(planStuck(REPO, [read], clock(unread))).toEqual([]);
    const unverifiable: SessionsReport = {
      ok: true,
      source: "orca",
      workspaces: [workspace({ prs: [456], unverifiableTerminals: 1 })],
    };
    expect(planStuck(REPO, [read], clock(unverifiable))).toEqual([]);
  });

  it("shows on the dashboard as stuck, with the clear command on its need", () => {
    const stuck = record({ attempts: [sent(20)] }, pending);
    const fresh: ReadRecord = record(
      { id: "20261103T160000Z-cccccccc", pr: 457, attempts: [sent(1)] },
      pending,
    );
    const records = [stuck, fresh];
    const line = buildLine(
      input({
        inputs: new Map([
          [PATH, { drives: [], known: [], sessions: NO_SESSIONS }],
        ]),
        reports: [report({ actions: planStuck(REPO, records, clock()) })],
        records,
      }),
    );
    expect(line.sessions.map((s) => [s.target, s.launch, s.stuck])).toEqual([
      ["PR #456", "pending", expect.stringContaining("unclaimed_after")],
      ["PR #457", "pending", null],
    ]);
    expect(line.needs).toEqual([
      expect.objectContaining({
        cause: "needs-person",
        stage: "rearm",
        target: "PR #456",
        stuckRecord: stuck.record.id,
        reason: expect.stringContaining(
          `jig dispatch clear ${stuck.record.id}`,
        ),
      }),
    ]);
  });

  it("shows stuck sessions even when notification actions were filtered out", () => {
    const read = record({ attempts: [sent(20)] }, pending);
    const line = buildLine(
      input({
        inputs: new Map([
          [PATH, { drives: [], known: [], sessions: NO_SESSIONS }],
        ]),
        records: [read],
        reports: [report({ actions: [] })],
      }),
    );
    expect(line.sessions[0]?.stuck).toContain("unclaimed_after (15m)");
    expect(line.needs).toEqual([]);
  });
});

describe("the machine file's unclaimed_after", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  });
  const read = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), "jig-dispatch-unclaimed-"));
    dirs.push(dir);
    const file = join(dir, "dispatch.yaml");
    writeFileSync(file, body);
    const machine = readMachineConfig(file);
    return machine.ok ? machine.value?.unclaimedAfterMs : machine.failure;
  };

  it("is fifteen minutes unless the file says otherwise, and a duration when it does", () => {
    expect(read("interval: 5m\n")).toBe(15 * 60_000);
    expect(read("unclaimed_after: 40m\n")).toBe(40 * 60_000);
    expect(read("unclaimed_after: soon\n")).toEqual({
      code: "invalid",
      reason: expect.stringContaining(
        "unclaimed_after must be a positive duration",
      ),
    });
  });
});
