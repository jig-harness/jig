/**
 * `drives.ts --report`: the dispatcher's part of the morning report. A
 * receipt the dispatcher wrote in the report's home since the report's
 * time gives its launches, refusals and notifications; what waits for a
 * later tick, or is only reported, stays out; a receipt from before the
 * report's time is not news.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  newRunId,
  type TickReceipt,
  writeReceipt,
} from "../../../dispatch/receipts.ts";
import type { LaunchOutcome, RepoReport } from "../../../dispatch/lib/types.ts";
import {
  fakeForge,
  type Forge,
  runIn,
  SCRIPTS,
} from "./provisional-fixtures.ts";

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000);

function launch(
  target: string,
  action: LaunchOutcome["action"],
  outcome: LaunchOutcome["outcome"],
  detail: string,
): LaunchOutcome {
  return { target, action, outcome, account: "a", record: null, detail };
}

function repo(fields: Partial<RepoReport>): RepoReport {
  return {
    path: "/repos/example",
    slug: "example-org/example-repo",
    refused: null,
    section: null,
    followupSince: null,
    records: [],
    actions: [],
    running: [],
    unplaced: [],
    launches: [],
    notifications: [],
    quiet: [],
    ...fields,
  };
}

function receipt(at: Date, repos: RepoReport[]): TickReceipt {
  return {
    version: 1,
    runId: newRunId(at),
    startedAt: at.toISOString(),
    finishedAt: at.toISOString(),
    completed: true,
    apply: true,
    exitStatus: 0,
    repos,
  };
}

function setUp(extra: RepoReport[] = []): Forge {
  const forge = fakeForge("");
  forge.write("login", "drive-bot");
  forge.write("search.json", { items: [] });
  const root = join(
    forge.env.HOME as string,
    ".local",
    "state",
    "jig",
    "dispatch",
  );
  writeReceipt(
    receipt(ago(48), [
      repo({ launches: [launch("PR #3", "rearm", "launched", "too old")] }),
    ]),
    root,
  );
  for (const hours of [3, 2])
    writeReceipt(
      receipt(ago(hours), [
        repo({
          launches: [
            launch("#12", "pickup", "refused", "identity check: no login"),
            launch("PR #8", "followup", "reported", "cannot bind"),
          ],
        }),
      ]),
      root,
    );
  writeReceipt(
    receipt(ago(1), [
      repo({
        launches: [
          launch("PR #9", "followup", "launched", "orca terminal create"),
          launch("PR #10", "rearm", "waits", "no account admits it"),
        ],
        notifications: [
          {
            target: "PR #7",
            cause: "parked",
            key: "example-org/example-repo PR #7 parked, ledger generation 3: finding F1",
            outcome: "sent",
            workspace: "/ws/7",
            detail: "marked unread",
          },
          {
            target: "PR #6",
            cause: "parked",
            key: "example-org/example-repo PR #6 parked",
            outcome: "suppressed",
            workspace: "/ws/6",
            detail: "sent earlier",
          },
        ],
      }),
    ]),
    root,
  );
  if (extra.length > 0) writeReceipt(receipt(ago(1), extra), root);
  return forge;
}

const report = (forge: Forge, args: string[]) =>
  runIn(forge, join(SCRIPTS, "drives.ts"), ["--report", ...args]);

describe("drives.ts --report: what the dispatcher did", () => {
  it("lists the launches, refusals and notifications since the report's time, a repeated refusal once", async () => {
    const forge = setUp();
    const r = await report(forge, ["--json"]);
    expectSpawnExit(r, 0);
    const out = JSON.parse(r.stdout);
    expect(out.unread).toEqual([]);
    expect(
      out.dispatch.map((d: Record<string, string>) => [
        d.kind,
        d.what,
        d.target,
      ]),
    ).toEqual([
      ["refusal", "pickup", "#12"],
      ["launch", "followup", "PR #9"],
      ["notification", "parked", "PR #7"],
    ]);
    expect(out.dispatch[2].detail).toContain("PR #7 parked");
  });

  it("prints them after the pull requests", async () => {
    const forge = setUp();
    const r = await report(forge, []);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("Dispatched on this machine");
    expect(r.stdout).toContain("launch followup PR #9: launched on a");
    expect(r.stdout).not.toContain("too old");
  });

  it("reports a receipt entry missing the fields it reads as unread", async () => {
    const bad = repo({
      launches: [{}] as unknown as LaunchOutcome[],
      notifications: [{}] as unknown as RepoReport["notifications"],
    });
    const r = await report(setUp([bad]), ["--json"]);
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout).unread).toHaveLength(1);
  });

  it("reports an entry whose outcome is not one a receipt records as unread", async () => {
    const bad = repo({
      launches: [
        launch("PR #9", "followup", "launchd" as LaunchOutcome["outcome"], "x"),
      ],
    });
    const r = await report(setUp([bad]), ["--json"]);
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout).unread).toHaveLength(1);
  });
});
