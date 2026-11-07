/**
 * Two hosts dispatching one repository, over the fake forge the dispatch
 * tests use: each host its own state root, machine file and Orca, the forge
 * and the agents shared. Between them they start one follow-up and one
 * re-arm, each naming the other's launch as held by that host; the host that
 * does not own the repository writes no notification and no history row for
 * it; a follow-up one host launched reads as done on the other as soon as its
 * pass ended, the answer its wrapper wrote; a driver one host started that
 * fell silent past the lease window is taken over from the other; and a
 * launch another host's claim holds is reported, not started, until that
 * host writes its end.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { claimBody } from "../../shared/records/forge-claims.ts";
import {
  endedClaim,
  LAUNCH_CLAIM,
  LAUNCH_MARKER,
  launchClaim,
} from "../../shared/records/launch-claims.ts";
import type { LaunchDraft } from "../../shared/records/shared.ts";
import { dump } from "../../shared/yaml.ts";
import { MARKER } from "../lib/followup-marker.ts";
import { readRecord, writeRecord } from "../lib/launches.ts";
import { existingStateDb } from "../lib/state.ts";
import type { TickReceipt } from "../receipts.ts";
import { forgeComment } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import {
  ledgerComment,
  mergedPr,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import { account, driveRuns, waitFor } from "./launch-fixtures.ts";
import { claudeRuns, withOrigin } from "./pickup-fixtures.ts";

const JIG = resolve(import.meta.dir, "../../jig.ts");
const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  followup_command: /followup
`;

const HEAD_7 = "feature/7-parked";
const HEAD_9 = "feature/9-done";

/** One dispatching host: its own home (state root and machine file) and its own Orca. */
interface Host {
  name: string;
  home: string;
  orca: string;
  /** Its dispatcher's state directory. */
  state: string;
  dispatch(args: string[]): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>;
}

let current: World | null = null;
afterEach(() => {
  if (current !== null) {
    writeFileSync(join(current.dir, "claude-exit"), "");
    rmSync(join(current.dir, "drive-hold"), { force: true });
  }
  current?.close();
  current = null;
});

/** A host of the world `w`: its machine file lists the world's repository with `stages`, owning it or not, and bills account `name`; its Orca holds a workspace for each of `prs`. */
function host(
  w: World,
  name: string,
  opts: {
    stages: string[];
    owner: boolean;
    prs: Array<{ number: number; head: string }>;
  },
): Host {
  const home = join(w.root, `home-${name}`);
  const orca = join(w.root, `orca-${name}`);
  mkdirSync(join(home, ".jig"), { recursive: true });
  mkdirSync(orca, { recursive: true });
  const a = account(w, name, `${name}@example.com`);
  writeFileSync(
    join(home, ".jig", "dispatch.yaml"),
    dump({
      repositories: [
        {
          path: w.repo,
          stages: opts.stages,
          followup_since: "2026-10-30T00:00:00Z",
          owner: opts.owner,
        },
      ],
      accounts: [
        { name, vendor: "claude", config_dir: a.dir, identity: a.identity },
      ],
    }),
  );
  writeFileSync(
    join(orca, "orca-repos.json"),
    readFileSync(join(w.dir, "orca-repos.json"), "utf8"),
  );
  const rows = opts.prs.map((pr, i) => {
    const path = join(w.root, `ws-${name}-${pr.number}`);
    mkdirSync(path, { recursive: true });
    return {
      worktreeId: `repo-1::${path}`,
      repoId: "repo-1",
      path,
      branch: `refs/heads/${pr.head}`,
      isArchived: false,
      linkedPR: { number: pr.number, state: "open" },
      linkedIssue: null,
      linkedLinearIssue: null,
      linkedItems: [],
      comment: "",
      unread: false,
      displayName: `${name}-${i}`,
      unverifiableTerminalCount: 0,
      agents: [],
    };
  });
  writeFileSync(
    join(orca, "orca-ps.json"),
    JSON.stringify({
      worktrees: rows,
      hostScope: { hostIds: ["local"], omittedHostIds: [] },
      totalCount: rows.length,
      truncated: false,
    }),
  );
  const env = {
    ...w.env,
    HOME: home,
    USERPROFILE: home,
    JIG_HOME: join(home, ".jig"),
    DISPATCH_ORCA_DIR: orca,
  };
  return {
    name,
    home,
    orca,
    state: join(home, ".local", "state", "jig", "dispatch"),
    async dispatch(args) {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          `--config=${BUNFIG}`,
          JIG,
          "dispatch",
          ...args,
        ],
        { cwd: w.repo, env, stdout: "pipe", stderr: "pipe" },
      );
      const deadline = setTimeout(() => child.kill(), 60_000);
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      clearTimeout(deadline);
      return { exitCode, stdout, stderr };
    },
  };
}

/** One tick with `--apply` on host `h`, its receipt. */
async function tick(h: Host): Promise<TickReceipt> {
  const r = await h.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0, `host ${h.name}'s tick`);
  return JSON.parse(r.stdout) as TickReceipt;
}

const repoOf = (r: TickReceipt) => r.repos[0];
const launches = (r: TickReceipt) => repoOf(r)?.launches ?? [];
const running = (r: TickReceipt, target: string) =>
  repoOf(r)?.running.find((x) => x.target === target);
const hostIn = (r: TickReceipt) => String(repoOf(r)?.shared?.host);

/** The one launch a tick made. */
function onlyLaunch(r: TickReceipt) {
  const all = launches(r);
  expect(all).toHaveLength(1);
  return all[0] as NonNullable<(typeof all)[number]>;
}

/** Why a tick reports `target` running: held by a launch record or another host's claim. */
const heldWhy = (r: TickReceipt, target: string) =>
  running(r, target)?.reason ?? "";

/** The shared records' part of a tick's report. */
function sharedIn(r: TickReceipt) {
  const shared = repoOf(r)?.shared;
  if (shared === undefined) throw new Error("the report has no shared part");
  return shared;
}

/** Whether the wrapper recorded the stage's exit on host `h`'s record `id`. */
function exitWritten(h: Host, id: string): boolean {
  const row = existingStateDb(h.state)
    ?.query("SELECT exit FROM launches WHERE id = ?")
    .get(id) as { exit: string | null } | null | undefined;
  return typeof row?.exit === "string";
}

type Comment = { id: number; body: string; user: { login: string } };

function comments(w: World, pr: number): Comment[] {
  return JSON.parse(readFileSync(join(w.dir, `comments-${pr}.json`), "utf8"));
}

function writeComments(w: World, pr: number, all: unknown[]): void {
  writeFileSync(join(w.dir, `comments-${pr}.json`), JSON.stringify(all));
}

/** The bodies of the launch claims on pull request `pr`, joined. */
const launchClaims = (w: World, pr: number) =>
  comments(w, pr)
    .filter((c) => c.body.startsWith(LAUNCH_MARKER))
    .map((c) => c.body)
    .join("\n");

/** PR #7's ledger, its driver running since `started`, its last heartbeat at `heartbeat`. */
function runningLedger(started: string, heartbeat: string) {
  const ledger = stoppedLedger(7, undefined, { generation: 4 });
  return ledgerComment(701, {
    ...ledger,
    driver: { ...ledger.driver, state: "running", started, heartbeat },
  });
}

const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

/** The world: PR #7 quota-parked (a re-arm wanted), PR #9 not merged yet. */
function fixture(): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  w.setPrs("open", [openPr(7, HEAD_7)]);
  w.setComments(7, [ledgerComment(701, stoppedLedger(7, 16))]);
  w.setComments(9, []);
  return w;
}

const PRS = [
  { number: 7, head: HEAD_7 },
  { number: 9, head: HEAD_9 },
];

describe("two hosts dispatching one repository", () => {
  it("start one re-arm and one follow-up between them, and each one's report names the other's launch", async () => {
    const w = fixture();
    const a = host(w, "a", {
      stages: ["rearm", "followup"],
      owner: true,
      prs: PRS,
    });
    const b = host(w, "b", {
      stages: ["rearm", "followup"],
      owner: false,
      prs: PRS,
    });

    // Host A's re-arm runs until the test lets its drive end.
    writeFileSync(join(w.dir, "drive-hold"), "");
    const first = await tick(a);
    const rearm = onlyLaunch(first);
    expect(rearm).toMatchObject({
      action: "rearm",
      target: "PR #7",
      outcome: "launched",
    });
    await waitFor("the re-arm", () => driveRuns(w).length === 1);
    expect(launchClaims(w, 7)).toContain(`record: ${rearm.record}`);

    // PR #9 merges; host B's tick finds host A's re-arm still claimed, and follows #9 up.
    w.setPrs("merged", [mergedPr(9, HEAD_9, "2026-10-31T12:00:00Z")]);
    const second = await tick(b);
    const followup = onlyLaunch(second);
    expect(followup).toMatchObject({
      action: "followup",
      target: "PR #9",
      outcome: "launched",
    });
    const held = heldWhy(second, "PR #7");
    expect(held).toContain(`held by host ${hostIn(first)}`);
    expect(held).toContain(String(rearm.record));
    await waitFor("the follow-up's pass", () => claudeRuns(w).length === 1);

    // Host A's drive ends: its wrapper writes the re-arm's end onto its claim, with no tick of host A's between.
    rmSync(join(w.dir, "drive-hold"));
    await waitFor("its exit", () => exitWritten(a, String(rearm.record)));
    await waitFor("its end on the claim", () =>
      launchClaims(w, 7).includes("· ended exit 0"),
    );

    // The re-armed driver runs; host A's next tick finds host B's follow-up claimed.
    w.setComments(7, [
      runningLedger(ago(5), ago(1)),
      ...comments(w, 7).filter((c) => c.id !== 701),
    ]);
    const third = await tick(a);
    expect(launches(third)).toEqual([]);
    const claimed = heldWhy(third, "PR #9");
    expect(claimed).toContain(`held by host ${hostIn(second)}`);
    expect(claimed).toContain(String(followup.record));

    expect(driveRuns(w)).toHaveLength(1);
    expect(claudeRuns(w)).toHaveLength(1);
    expect(
      comments(w, 9).filter((c) => c.body.startsWith(MARKER)),
    ).toHaveLength(1);
    expect(sharedIn(second)).toMatchObject({
      owner: false,
      medium: "forge",
      owners: [hostIn(first)],
    });
    expect(sharedIn(first).budget).toMatchObject({
      remaining: 4990,
      limit: 5000,
    });
  }, 90_000);

  it("leaves the notifications and the history rows to the host that owns the repository", async () => {
    const w = fixture();
    // The owner tells a person in the notices workspace, opened from the default branch.
    withOrigin(w);
    w.setComments(7, [ledgerComment(701, stoppedLedger(7, 15))]);
    const a = host(w, "a", {
      stages: ["rearm", "notify"],
      owner: true,
      prs: PRS,
    });
    const b = host(w, "b", {
      stages: ["rearm", "notify"],
      owner: false,
      prs: PRS,
    });
    const events = (h: Host) =>
      (
        existingStateDb(h.state)
          ?.query("SELECT count(*) AS n FROM log WHERE kind = 'event'")
          .get() as { n: number } | undefined
      )?.n ?? 0;
    const notified = (h: Host) =>
      readFileSync(join(h.orca, "orca-calls.log"), "utf8")
        .split("\n")
        .filter((l) => l.includes('"set"') && l.includes('"--unread"')).length;

    const other = await tick(b);
    expect(repoOf(other)?.actions).toContainEqual(
      expect.objectContaining({
        stage: "notify",
        target: "PR #7",
        cause: "needs-person",
      }),
    );
    expect(repoOf(other)?.notifications).toEqual([]);
    expect(notified(b)).toBe(0);
    expect(events(b)).toBe(0);

    const owner = await tick(a);
    expect(repoOf(owner)?.notifications).toEqual([
      expect.objectContaining({
        target: "PR #7",
        cause: "needs-person",
        outcome: "sent",
      }),
    ]);
    expect(notified(a)).toBe(1);
    expect(events(a)).toBe(1);
    expect(repoOf(owner)?.shared?.owner).toBe(true);
  }, 60_000);

  it("reads a follow-up one host ran as done on the other as soon as its pass ended", async () => {
    const w = fixture();
    w.setPrs("merged", [mergedPr(9, HEAD_9, "2026-10-31T12:00:00Z")]);
    const a = host(w, "a", { stages: ["followup"], owner: true, prs: PRS });
    const b = host(w, "b", { stages: ["followup"], owner: false, prs: PRS });

    const first = await tick(a);
    const id = String(launches(first)[0]?.record);
    await waitFor("the pass", () => claudeRuns(w).length === 1);

    // While the pass runs, host B reads the follow-up as host A's.
    const before = await tick(b);
    expect(launches(before)).toEqual([]);
    expect(running(before, "PR #9")?.reason).toContain(
      `held by host ${hostIn(first)}`,
    );

    // The pass records done and ends: its wrapper writes the answer onto the marker, with no tick of host A's between.
    const token = readRecord(id, a.state)?.token ?? "";
    expectSpawnExit(await a.dispatch(["result", id, token, "done"]), 0);
    writeFileSync(join(w.dir, "claude-exit"), "");
    await waitFor("the exit", () => exitWritten(a, id));
    const answered = () =>
      comments(w, 9)
        .find((c) => c.body.startsWith(MARKER))
        ?.body.split("\n")
        .at(-1);
    await waitFor(
      "the answer on the marker",
      () =>
        answered() === `jig dispatch follow-up · record: ${id} · outcome: done`,
    );

    const after = await tick(b);
    expect(launches(after)).toEqual([]);
    expect(repoOf(after)?.actions.filter((x) => x.target === "PR #9")).toEqual(
      [],
    );
    const done = repoOf(after)?.quiet.find((q) => q.target === "PR #9");
    expect(done?.class).toBe("followup-done");
    expect(done?.why).toContain(`host ${hostIn(first)}`);

    const settled = await tick(a);
    expect(repoOf(settled)?.quiet).toContainEqual(
      expect.objectContaining({ target: "PR #9", class: "followup-done" }),
    );
    expect(claudeRuns(w)).toHaveLength(1);
  }, 90_000);

  it("takes over from one host a driver the other host started that fell silent past the lease window", async () => {
    const w = fixture();
    const a = host(w, "a", { stages: ["rearm"], owner: true, prs: PRS });
    const b = host(w, "b", { stages: ["rearm"], owner: false, prs: PRS });

    const first = await tick(a);
    const record = String(launches(first)[0]?.record);
    await waitFor("the re-arm", () => driveRuns(w).length === 1);
    await waitFor("its exit", () => exitWritten(a, record));
    await waitFor("its end on the claim", () =>
      launchClaims(w, 7).includes("· ended exit 0"),
    );

    // Host A's claim was made six hours ago; the driver its launch started has been silent for five.
    const claimed = comments(w, 7)
      .filter((c) => c.id !== 701)
      .map((c) =>
        c.body.startsWith(LAUNCH_MARKER)
          ? { ...c, body: c.body.replace(/"at":"[^"]+"/, `"at":"${ago(360)}"`) }
          : c,
      );
    writeComments(w, 7, [runningLedger(ago(359), ago(300)), ...claimed]);

    const second = await tick(b);
    expect(launches(second)).toEqual([
      expect.objectContaining({
        action: "takeover",
        target: "PR #7",
        outcome: "launched",
        account: "b",
      }),
    ]);
    const wanted = repoOf(second)?.actions.find((x) => x.target === "PR #7");
    expect(wanted?.reason).toContain(`host ${hostIn(first)}'s launch claim`);
    await waitFor("the takeover", () => driveRuns(w).length === 2);
    expect(driveRuns(w)[1]?.argv.slice(0, 2)).toEqual(["7", "--take-over"]);
  }, 90_000);

  it("claims a launch a stopped tick wrote down and never launched before it replays it", async () => {
    const w = fixture();
    const b = host(w, "b", { stages: ["rearm"], owner: false, prs: PRS });
    const id = "20261105T000000Z-dddddddd";
    const path = join(w.root, "ws-b-7");
    writeRecord(
      {
        version: 1,
        id,
        token: "never-launched",
        action: "rearm",
        repo: SLUG,
        repoPath: w.repo,
        pr: 7,
        item: null,
        account: "b",
        vendor: "claude",
        configDir: join(w.root, "config-b"),
        wallBackoffMs: 3_600_000,
        replaces: null,
        facts: "generation 3, exit 16, heartbeat 2026-10-30T22:00:00.000Z",
        createdAt: ago(1),
        workspace: { id: `repo-1::${path}`, path },
        attempts: [],
        agentId: null,
        model: null,
        effort: null,
        released: false,
        command: null,
        marker: null,
      },
      b.state,
    );

    const receipt = await tick(b);
    expect(launches(receipt)).toEqual([
      expect.objectContaining({ record: id, outcome: "retried" }),
    ]);
    const claims = comments(w, 7).filter((c) =>
      c.body.startsWith(LAUNCH_MARKER),
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.body).toContain(`record: ${id}`);
    await waitFor("the re-arm", () => driveRuns(w).length === 1);
  }, 60_000);

  it("reports a launch another host's claim holds and starts nothing, however old the claim, until that host writes its end", async () => {
    const w = fixture();
    const b = host(w, "b", { stages: ["rearm"], owner: false, prs: PRS });
    const draft: LaunchDraft = {
      stage: "drive",
      pr: 7,
      run: "tick",
      action: "rearm",
      record: "20261105T010000Z-cccccccc",
      host: "sha256:cccccccccccccccc",
      owner: true,
      facts: "generation 3, exit 16, heartbeat 2026-10-30T22:00:00.000Z",
      writer: { host: "sha256:cccccccccccccccc" },
    };
    const posted = launchClaim(draft, 1, ago(600));
    const open = forgeComment(
      705,
      claimBody(LAUNCH_CLAIM, posted),
      "drive-bot",
    );
    w.setComments(7, [ledgerComment(701, stoppedLedger(7, 16)), open]);

    const first = await tick(b);
    expect(launches(first)).toEqual([]);
    expect(running(first, "PR #7")?.reason).toContain(
      "held by host sha256:cccccccccccccccc",
    );
    expect(driveRuns(w)).toHaveLength(0);

    // That host writes its launch's end: the ledger still wants a re-arm, which host B now starts.
    const ended = endedClaim(
      "drive",
      {
        key: posted.key,
        generation: 1,
        at: posted.at ?? "",
        writer: draft.writer,
        payload: posted.payload,
        legacy: false,
      },
      7,
      { state: "ended", at: ago(500), exit: 0, outcome: null },
      draft.writer,
    );
    w.setComments(7, [
      ledgerComment(701, stoppedLedger(7, 16)),
      { ...open, body: claimBody(LAUNCH_CLAIM, ended) },
    ]);
    const second = await tick(b);
    expect(launches(second)).toEqual([
      expect.objectContaining({
        action: "rearm",
        target: "PR #7",
        outcome: "launched",
        account: "b",
      }),
    ]);
    await waitFor("the re-arm", () => driveRuns(w).length === 1);
    const claims = comments(w, 7).filter((c) =>
      c.body.startsWith(LAUNCH_MARKER),
    );
    expect(claims).toHaveLength(2);
    expect(claims[1]?.body).toContain('"generation":2');
  }, 90_000);
});
