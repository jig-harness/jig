/**
 * dispatch --apply with a serialized change area: the pull requests that
 * touch it are driven one at a time, the one closest to merge first, and
 * the rest are held with no launch until they lead; a pull request outside
 * every serialized area is driven beside them, and a drive a person armed
 * on a held pull request is reported, never stopped.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { type EventRow, readRows } from "../lib/log.ts";
import type { TickReceipt } from "../receipts.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import {
  HEAD_SHA,
  ledgerComment,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import {
  account,
  dispatchState,
  driveRuns,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";

const CATALOG = `areas:
  migrations:
    title: Migrations
    category: data
    paths: ["db/migrations/**"]
    workspace: []
    impliedBy: []
    deployTier: none
    serialize: true
  app:
    title: App
    category: app
    paths: ["src/**"]
    workspace: []
    impliedBy: []
    deployTier: none
`;

const config = (labels: boolean) => `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
drive:
  change_areas_catalog: .config/change-areas.yaml
${labels ? "dispatch:\n  labels: { enabled: true }\n" : ""}`;

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** A converged drive the forge now reports conflicting with its base: a re-drive is wanted. */
const conflicting = (n: number) =>
  openPr(n, `feature/${n}`, { mergeable: "CONFLICTING" });

/**
 * Open pull requests `prs`, each with a ledger and its changed files, its
 * unresolved threads (`threads`), and a world whose catalog serializes
 * `db/migrations/**`; account a may bill two sessions.
 */
function fixture(
  prs: Array<{
    n: number;
    ledger: Ledger;
    files: string[];
    threads: number;
    mergeable?: string;
  }>,
  labels = false,
): World {
  const w = world();
  current = w;
  w.setConfig(config(labels));
  w.setRepoFile(".config/change-areas.yaml", CATALOG);
  w.setPrs(
    "open",
    prs.map((p) =>
      p.mergeable === undefined
        ? openPr(p.n, `feature/${p.n}`)
        : openPr(p.n, `feature/${p.n}`, { mergeable: p.mergeable }),
    ),
  );
  for (const p of prs) {
    w.setComments(p.n, [ledgerComment(p.n * 100 + 1, p.ledger)]);
    w.setFiles(p.n, p.files);
    writeFileSync(join(w.dir, `threads-${p.n}`), String(p.threads));
  }
  // Each pull request's workspace exists, on its head branch.
  w.setWorkspaces(
    prs.map((p) => {
      const path = join(w.root, `ws-${p.n}`);
      mkdirSync(path, { recursive: true });
      return { branch: `feature/${p.n}`, linkedPR: p.n, path };
    }),
  );
  machineFile(w, [account(w, "a", "a@example.com")]);
  return w;
}

const converged = (n: number) => stoppedLedger(n, 0, { verifiedSha: HEAD_SHA });

/** A drive running now, at `round`: a person armed it, or the dispatcher did. */
function running(n: number, round: number): Ledger {
  const now = new Date().toISOString();
  const ledger = stoppedLedger(n, undefined, { round });
  return {
    ...ledger,
    driver: {
      ...ledger.driver,
      state: "running",
      heartbeat: now,
      started: now,
    },
  };
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

const repo = (r: TickReceipt) => r.repos[0];

const launched = (r: TickReceipt) =>
  (repo(r)?.launches ?? []).map((l) => [l.target, l.outcome]);

/** The held targets and the reasons' head (`held: serialized behind #N in <area>`). */
const held = (r: TickReceipt) =>
  (repo(r)?.serialized?.held ?? []).map((h) => [
    h.target,
    h.reason.split(";")[0],
  ]);

/** Wait for every launch of a tick to record its exit. */
async function settled(w: World, r: TickReceipt): Promise<void> {
  for (const l of repo(r)?.launches ?? [])
    await waitFor("the exit", () => exitWritten(w, l.record ?? ""));
}

const holdRows = (w: World) =>
  readRows(undefined, undefined, dispatchState(w)).filter(
    (r): r is EventRow =>
      r.kind === "event" && (r.event === "held" || r.event === "hold-ended"),
  );

/** Three converged pull requests on the serialized area, all conflicting after a merge to main; #9 has the fewest unresolved threads, then #8. */
const THREE = [
  {
    n: 7,
    ledger: converged(7),
    files: ["db/migrations/007.sql"],
    threads: 2,
    mergeable: "CONFLICTING",
  },
  {
    n: 8,
    ledger: converged(8),
    files: ["db/migrations/008.sql", "src/a.ts"],
    threads: 1,
    mergeable: "CONFLICTING",
  },
  {
    n: 9,
    ledger: converged(9),
    files: ["db/migrations/009.sql"],
    threads: 0,
    mergeable: "CONFLICTING",
  },
];

describe("jig dispatch serializes the pull requests of a serialized area", () => {
  it("re-drives one pull request per tick, closest to merge first, and holds the other two with no launch", async () => {
    const w = fixture(THREE);
    const first = await tick(w);
    expect(launched(first)).toEqual([["PR #9", "launched"]]);
    expect(held(first)).toEqual([
      ["PR #7", "held: serialized behind #9 in migrations"],
      ["PR #8", "held: serialized behind #9 in migrations"],
    ]);
    const group = repo(first)?.serialized?.groups[0];
    expect(group?.area).toBe("migrations");
    expect(group?.leader).toBe("PR #9");
    expect(group?.order.map((o) => o.target)).toEqual([
      "PR #9",
      "PR #8",
      "PR #7",
    ]);
    await settled(w, first);

    // The next tick keeps the order: nothing for the held two, and #9 is not re-driven twice.
    const second = await tick(w);
    expect(launched(second)).toEqual([]);
    expect(held(second)).toEqual(held(first));
    expect(driveRuns(w).map((r) => r.argv[0])).toEqual(["9"]);
  }, 120_000);

  it("promotes the next pull request when the leader merges, re-drives it once, and logs how long it was held", async () => {
    const w = fixture(THREE, true);
    const first = await tick(w);
    expect(launched(first)).toEqual([["PR #9", "launched"]]);
    await settled(w, first);
    expect(labelsOf(w, 7)).toContain("jig:held");
    expect(labelsOf(w, 8)).toContain("jig:held");

    // #9 merged: #8 leads now, and #7 waits behind it.
    w.setPrs("open", [conflicting(7), conflicting(8)]);
    const second = await tick(w);
    expect(launched(second)).toEqual([["PR #8", "launched"]]);
    expect(held(second)).toEqual([
      ["PR #7", "held: serialized behind #8 in migrations"],
    ]);
    expect(labelsOf(w, 8)).toEqual(["jig:stale"]);
    expect(labelsOf(w, 7)).toEqual(["jig:held"]);
    await settled(w, second);

    const third = await tick(w);
    expect(launched(third)).toEqual([]);
    expect(driveRuns(w).map((r) => r.argv[0])).toEqual(["9", "8"]);

    const rows = holdRows(w).map((r) => [r.target, r.event]);
    expect(rows).toEqual([
      ["PR #8", "held"],
      ["PR #7", "held"],
      ["PR #8", "hold-ended"],
    ]);
    const ended = holdRows(w).find((r) => r.event === "hold-ended");
    expect(ended?.reason).toContain(
      "last behind #9 in migrations; it leads its serialized area now",
    );
    expect(typeof ended?.durationMs).toBe("number");
  }, 120_000);

  it("drives a pull request outside every serialized area beside a held group, and reports a person's drive on a held pull request without stopping it", async () => {
    const w = fixture([
      {
        n: 7,
        ledger: running(7, 5),
        files: ["db/migrations/007.sql"],
        threads: 0,
      },
      {
        n: 8,
        ledger: running(8, 1),
        files: ["db/migrations/008.sql"],
        threads: 0,
      },
      {
        n: 9,
        ledger: converged(9),
        files: ["db/migrations/009.sql"],
        threads: 0,
        mergeable: "CONFLICTING",
      },
      {
        n: 10,
        ledger: converged(10),
        files: ["src/app.ts"],
        threads: 0,
        mergeable: "CONFLICTING",
      },
    ]);
    const before = readFileSync(join(w.dir, "comments-8.json"), "utf8");
    const receipt = await tick(w);
    expect(launched(receipt)).toEqual([["PR #10", "launched"]]);
    expect(held(receipt)).toEqual([
      ["PR #9", "held: serialized behind #7 in migrations"],
    ]);
    const group = repo(receipt)?.serialized?.groups[0];
    expect(group?.order.map((o) => o.target)).toEqual([
      "PR #7",
      "PR #8",
      "PR #9",
    ]);
    expect(group?.drives).toBe(
      "2 drives run in this group (PR #7, PR #8): the dispatcher starts one at a time, and a drive a person armed on a held pull request is reported, never stopped",
    );
    expect(repo(receipt)?.quiet).toContainEqual(
      expect.objectContaining({ target: "PR #8", class: "driven" }),
    );
    expect(readFileSync(join(w.dir, "comments-8.json"), "utf8")).toBe(before);
    await settled(w, receipt);
  }, 120_000);
});

/** The label names PR `n` carries now, as the fake forge keeps them. */
function labelsOf(w: World, n: number): string[] {
  const prs = JSON.parse(
    readFileSync(join(w.dir, "prs-open.json"), "utf8"),
  ) as Array<{
    number: number;
    labels?: Array<{ name: string }>;
  }>;
  return (prs.find((p) => p.number === n)?.labels ?? []).map((l) => l.name);
}
