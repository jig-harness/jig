import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { parseConfig } from "../scripts/lib/fleet-health-config.ts";
import {
  ceremonyRatioSignal,
  computeEpicUnits,
  type PrFact,
  type IssueFact,
  unattributedCeremony,
} from "../scripts/lib/fleet-health.ts";
import {
  forgeRearmReader,
  rearmsFromSnapshot,
} from "../scripts/lib/fleet-health-rearms.ts";
import * as forge from "../scripts/lib/state/ledger-forge.ts";
import {
  ledgerFromState,
  renderLedger,
  snapshotFrom,
} from "../scripts/lib/state/ledger.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import { type RunDeps, runFleetHealth } from "../scripts/fleet-health.ts";

const at = "2026-09-05T00:00:00Z";
const window = {
  sinceMs: Date.parse("2026-09-01"),
  untilMs: Date.parse("2026-09-15"),
};
const raw = yaml.load(
  readFileSync(join(import.meta.dir, "fixtures/fleet-health.yaml"), "utf8"),
) as {
  ceremony: {
    weights: Record<string, number>;
    unmeasured: Record<string, string>;
  };
};
raw.ceremony.weights.drive_rearms = 2;
raw.ceremony.unmeasured = {};

function depsFor(
  prs: Awaited<ReturnType<RunDeps["listCandidates"]>>["prs"],
  driveRearms: RunDeps["driveRearms"],
): RunDeps {
  return {
    cfg: parseConfig(raw),
    nowMs: () => window.untilMs,
    budget: async () => ({ remaining: 5000, resetAt: at }),
    listCandidates: async () => ({ prs, capped: false }),
    reviewedHeads: async () => 0,
    samplePr: async () => {
      throw new Error("no expensive sample needed");
    },
    driveRearms,
    prFiles: async () => [],
    prBody: async () => "",
    classifier: null,
    classifierError: "no catalog",
    tracker: null,
    trackerError: "no tracker",
    fetchIssues: async () => new Map(),
    fetchWindowIssues: async () => ({
      followups: [],
      sdlcIssues: [],
      completed: [],
    }),
    fetchEpicActivity: async () => [],
    fetchAcceptedEpics: async () => new Set(),
    fetchEpicComments: async () => ({ uuid: "epic", comments: [] }),
    note: () => undefined,
  };
}

test("re-arms contribute their configured weight only inside the window, without needing review rounds", () => {
  const cfg = parseConfig(raw);
  const pr: PrFact = {
    number: 1,
    title: "work",
    state: "OPEN",
    mergedAt: null,
    issueRefs: ["ENG-1"],
    rounds: [],
    postReviewShare: null,
    postReviewAdditions: 0,
    openingAdditions: 0,
    threads: { total: 0, answered: 0, accepted: 0 },
    productPr: null,
    driveRearms: [at, at, "2026-09-15T00:00:00Z", "2026-08-31T00:00:00Z"],
  };
  const issue: IssueFact = {
    id: "ENG-1",
    title: "Epic",
    labels: ["epic"],
    createdAt: at,
    completedAt: null,
    stateType: "started",
    description: "",
    ancestors: [],
  };
  const input = {
    cfg,
    window,
    prs: [pr],
    issues: new Map([["ENG-1", issue]]),
    followups: [],
    sdlcIssues: [],
    completed: [],
    acceptedEpics: new Set<string>(),
  };
  const u = computeEpicUnits(input).get("ENG-1");
  expect(u?.ceremony.weighted).toBe(4);
  if (u === undefined) throw new Error("the epic must have re-arm ceremony");
  const signal = ceremonyRatioSignal(u, cfg);
  expect(signal?.evidence.join(" ")).toContain("2 re-arm(s)");
  expect(signal?.evidence.join(" ")).not.toContain("lower bound");
  expect(unattributedCeremony({ ...input, issues: new Map() })).toBe(2);
});

test("the trusted canonical ledger supplies re-arms, and unreadable or older history stays unknown", () => {
  const ledger = ledgerFromState(
    {
      ...freshState(1),
      events: [
        { at, round: 1, kind: "rearm", cause: "answered" },
        { at, round: 1, kind: "restart", cause: "stall" },
      ],
    },
    {
      generation: 1,
      driver: {
        actor: "worker",
        clone: "clone-a",
        heartbeat: at,
        state: "running",
      },
      narrative: [],
      claims: [],
    },
  );
  const snapshot = () => {
    const rendered = renderLedger(ledger);
    if ("error" in rendered) throw new Error(rendered.error);
    return snapshotFrom(
      [
        {
          id: 1,
          login: "maintainer",
          association: "MEMBER",
          updatedAt: at,
          body: rendered.body,
        },
      ],
      "maintainer",
    );
  };
  expect(rearmsFromSnapshot(snapshot())).toEqual([at]);
  delete ledger.events;
  expect(rearmsFromSnapshot(snapshot())).toBe(
    "the ledger predates re-arm event history",
  );
  expect(rearmsFromSnapshot("comments unreadable: request timed out")).toBe(
    "comments unreadable: request timed out",
  );
  expect(rearmsFromSnapshot(snapshotFrom([], "maintainer"))).toEqual([]);
});

test("an unreadable forge identity leaves re-arm history unknown", async () => {
  const login = spyOn(forge, "resolveLogin").mockResolvedValue(null);
  const snapshot = spyOn(forge, "readLedgerSnapshot");
  try {
    await expect(forgeRearmReader("owner/repo")(1)).resolves.toBe(
      "the forge login could not be resolved",
    );
    expect(snapshot).not.toHaveBeenCalled();
  } finally {
    login.mockRestore();
    snapshot.mockRestore();
  }
});

test("older configurations receive the re-arm weight and drop only its obsolete unmeasured entry", () => {
  const old = structuredClone(raw);
  delete old.ceremony.weights.drive_rearms;
  old.ceremony.unmeasured = {
    drive_rearms: "per clone",
    handoffs: "no dated history",
  };
  const cfg = parseConfig(old);
  expect(cfg.ceremony.weights.driveRearms).toBe(1);
  expect(cfg.ceremony.unmeasured).toEqual({ handoffs: "no dated history" });
});

test("the collector reads a cheap PR's ledger and reports an unreadable history as a gap", async () => {
  const reads: number[] = [];
  const deps = depsFor(
    [
      {
        number: 1,
        title: "work",
        state: "OPEN",
        body: "",
        createdAt: at,
        updatedAt: at,
        mergedAt: null,
        closedAt: null,
      },
    ],
    async (pr) => {
      reads.push(pr);
      return "comments unreadable: request timed out";
    },
  );
  const result = await runFleetHealth(
    { until: "2026-09-15", days: 14, limit: 10, concurrency: 1 },
    deps,
  );
  expect(reads).toEqual([1]);
  expect(result.report.gaps).toContain(
    "#1: drive re-arms could not be read from the forge ledger (comments unreadable: request timed out)",
  );
  const successful = await runFleetHealth(
    { until: "2026-09-15", days: 14, limit: 10, concurrency: 1 },
    { ...deps, driveRearms: async () => [at] },
  );
  expect(successful.report.caveats.join(" ")).toContain(
    "1 ceremony unit(s) name no epic",
  );
  const thrown = await runFleetHealth(
    { until: "2026-09-15", days: 14, limit: 10, concurrency: 1 },
    {
      ...deps,
      driveRearms: async () => {
        throw new Error("permission denied");
      },
    },
  );
  expect(thrown.report.gaps).toContain(
    "#1: drive re-arms could not be read from the forge ledger (permission denied)",
  );
});

test("the collector retains a historical PR when a drive re-arm falls in the window", async () => {
  const reads: number[] = [];
  const result = await runFleetHealth(
    { until: "2026-09-15", days: 14, limit: 10, concurrency: 1 },
    depsFor(
      [
        {
          number: 2,
          title: "historical work",
          state: "CLOSED",
          body: "",
          createdAt: "2026-08-01T00:00:00Z",
          updatedAt: "2026-09-20T00:00:00Z",
          mergedAt: null,
          closedAt: "2026-09-20T00:00:00Z",
        },
      ],
      async (pr) => {
        reads.push(pr);
        return [at];
      },
    ),
  );
  expect(reads).toEqual([2]);
  expect(result.report.counts.prs).toBe(1);
});

test("the collector reports an unreadable re-arm ledger even when no fact is retained", async () => {
  const result = await runFleetHealth(
    { until: "2026-09-15", days: 14, limit: 10, concurrency: 1 },
    depsFor(
      [
        {
          number: 3,
          title: "historical work",
          state: "CLOSED",
          body: "",
          createdAt: "2026-08-01T00:00:00Z",
          updatedAt: "2026-08-02T00:00:00Z",
          mergedAt: null,
          closedAt: "2026-08-02T00:00:00Z",
        },
      ],
      async () => "comments unreadable: request timed out",
    ),
  );
  expect(result.report.counts.prs).toBe(0);
  expect(result.report.gaps).toContain(
    "#3: drive re-arms could not be read from the forge ledger (comments unreadable: request timed out)",
  );
});
