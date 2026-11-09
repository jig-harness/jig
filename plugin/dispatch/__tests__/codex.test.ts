/**
 * dispatch --apply on Codex accounts: the account's vendor picks the agent.
 * A drive stopped on a Claude Code account's wall is re-armed on a Codex
 * account in one tick, running Codex's documented pass command bound
 * through `CODEX_HOME` with the Claude Code variables gone; an account of a
 * vendor with no documented pass command is reported and never launched; a
 * Codex account is reported and never launched for a drive's pass while the
 * pass deadline is `0`, since nothing else would bound the pass, or for any
 * launch on a host that has not opted in with `drive.codex_bypass`; and a
 * pickup on a Codex account starts Codex on the route's Codex model and
 * effort.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { readRecord } from "../lib/launches.ts";
import { bootId } from "../../shared/liveness.ts";
import { formatReceipt } from "../lib/report.ts";
import { writeWall } from "../lib/walls.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  assignedIssue,
  ledgerComment,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import {
  account,
  claimed,
  codexAccount,
  dispatchState,
  driveRuns,
  earlierRecord,
  exitWritten,
  machineFile,
  recordIds,
  terminalCreates,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, withOrigin } from "./pickup-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
`;

const HEAD = "feature/7-parked";

/** Codex's documented pass command for PR #7. */
const CODEX_PASS = [
  "codex",
  "exec",
  "--dangerously-bypass-approvals-and-sandbox",
  "Use the jig:drive-pr skill: /jig:drive-pr --bots-only 7",
];

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

/** The host's opt-in: `drive.codex_bypass: true` in its user file. */
function hostOptsIn(w: World): void {
  delete w.env.JIG_USER_LAYER;
  mkdirSync(join(w.home, ".jig"), { recursive: true });
  writeFileSync(
    join(w.home, ".jig", "jig.yaml"),
    "drive:\n  codex_bypass: true\n",
  );
}

/** A quota-parked PR #7 whose workspace exists, on a host that opted in. */
function fixture(): World {
  const w = world();
  current = w;
  hostOptsIn(w);
  w.setConfig(CONFIG);
  w.setPrs("open", [openPr(7, HEAD)]);
  w.setComments(7, [ledgerComment(701, stoppedLedger(7, 16))]);
  const ws = join(w.root, "ws-7");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces([{ branch: HEAD, linkedPR: 7, path: ws }]);
  return w;
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

const launches = (r: TickReceipt) => r.repos[0]?.launches ?? [];

/** The record of the run's first launch. */
function launchedRecord(r: TickReceipt): string {
  const id = launches(r)[0]?.record;
  if (typeof id !== "string") throw new TypeError("no launch record");
  return id;
}

/** Credentials and directories of other accounts the tick's environment carries, none of which a pass may inherit. */
function inheritOtherAccounts(w: World): void {
  w.env.CLAUDE_CODE_OAUTH_TOKEN = "a-token-for-another-account";
  w.env.ANTHROPIC_API_KEY = "an-api-key-for-another-account";
  w.env.OPENAI_API_KEY = "an-openai-key-for-another-account";
  w.env.CLAUDE_CONFIG_DIR = join(w.root, "another-claude-account");
  w.env.CODEX_HOME = join(w.root, "another-codex-account");
}

describe("jig dispatch --apply on Codex accounts", () => {
  it("re-arms a drive quota-parked on a Claude Code account on a Codex account in one tick, bound through CODEX_HOME", async () => {
    const w = fixture();
    const a = account(w, "a", "a@example.com");
    const c = codexAccount(w, "c", "codex-account-c");
    machineFile(w, [a, c]);
    earlierRecord(w, { id: "20261030T200000Z-aaaaaaaa", account: "a" });
    claimed(
      w,
      "20261030T200000Z-aaaaaaaa",
      {
        hostId: "",
        host: hostname(),
        bootId: bootId(),
        pid: 1,
        start: "x",
        claimedAt: "2026-10-30T20:00:00.000Z",
      },
      16,
    );
    writeWall(
      { account: "a", resetAt: "2099-01-01T00:00:00.000Z", source: "test" },
      dispatchState(w),
    );
    inheritOtherAccounts(w);

    const receipt = await tick(w);
    expect(launches(receipt)[0]).toMatchObject({
      outcome: "launched",
      account: "c",
    });
    expect(receipt.accountsNotAdmitted).toBeUndefined();
    const id = launchedRecord(receipt);
    expect(readRecord(id, dispatchState(w))).toMatchObject({
      vendor: "codex",
      passTimeoutSec: 5400,
      codexBypass: true,
      sessionId: null,
    });

    await waitFor("the drive", () => driveRuns(w).length === 1);
    expect(driveRuns(w)).toEqual([
      {
        argv: [
          "7",
          "--bots-only",
          "--pass-timeout",
          "5400",
          "--",
          ...CODEX_PASS,
        ],
        cwd: expect.any(String),
        codexHome: c.dir,
        configDir: null,
        token: null,
        anthropicKey: null,
        openaiKey: null,
        launch: id,
      },
    ]);
    await waitFor("the exit", () => exitWritten(w, id));
  });

  it("reports an account of a vendor with no documented pass command and never launches on it", async () => {
    const w = fixture();
    const g = {
      ...account(w, "g", "g@example.com"),
      vendor: "another-agent",
    };
    machineFile(w, [g]);

    const receipt = await tick(w);
    expect(receipt.accountsNotAdmitted).toEqual([
      {
        account: "g",
        vendor: "another-agent",
        reason:
          "the drive documents no pass command for its vendor another-agent, so it is accepted and not admitted",
      },
    ]);
    const [waiting] = launches(receipt);
    expect(waiting?.outcome).toBe("waits");
    expect(waiting?.detail).toContain(
      "g (the drive documents no pass command for its vendor another-agent",
    );
    expect(formatReceipt(receipt, "receipt.json")).toContain(
      "account g (vendor another-agent) accepted, not admitted",
    );
    expect(terminalCreates(w)).toEqual([]);
    expect(recordIds(w)).toEqual([]);
  });

  it.each([
    ["has no user file", undefined],
    [
      "sets it to false",
      (w: World) =>
        writeFileSync(
          join(w.home, ".jig", "jig.yaml"),
          "drive:\n  codex_bypass: false\n",
        ),
    ],
    [
      "leaves the user layer out",
      (w: World) => {
        hostOptsIn(w);
        w.env.JIG_USER_LAYER = "off";
      },
    ],
  ])(
    "reports a Codex account and never launches on it on a host that %s",
    async (_, host) => {
      const w = fixture();
      rmSync(join(w.home, ".jig", "jig.yaml"), { force: true });
      machineFile(w, [codexAccount(w, "c", "codex-account-c")]);
      host?.(w);

      const receipt = await tick(w);
      expect(receipt.accountsNotAdmitted).toEqual([
        {
          account: "c",
          vendor: "codex",
          reason: expect.stringContaining("drive.codex_bypass"),
        },
      ]);
      const [waiting] = launches(receipt);
      expect(waiting?.outcome).toBe("waits");
      expect(waiting?.detail).toContain("drive.codex_bypass");
      expect(formatReceipt(receipt, "receipt.json")).toContain(
        "account c (vendor codex) accepted, not admitted",
      );
      expect(terminalCreates(w)).toEqual([]);
      expect(recordIds(w)).toEqual([]);
    },
  );

  it("takes the host's opt-in from a variable as well, and never from the repository's file", async () => {
    const w = fixture();
    rmSync(join(w.home, ".jig", "jig.yaml"), { force: true });
    machineFile(w, [codexAccount(w, "c", "codex-account-c")]);
    w.setConfig(`${CONFIG}drive:\n  codex_bypass: true\n`);
    const refused = await tick(w);
    expect(refused.accountsNotAdmitted?.[0]?.reason).toContain(
      "drive.codex_bypass",
    );
    expect(recordIds(w)).toEqual([]);

    w.setConfig(CONFIG);
    w.env.JIG__DRIVE__CODEX_BYPASS = "true";
    const allowed = await tick(w);
    expect(allowed.accountsNotAdmitted).toBeUndefined();
    await waitFor("the drive", () => driveRuns(w).length === 1);
    expect(driveRuns(w)[0]?.argv).toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    await waitFor("the exit", () => exitWritten(w, launchedRecord(allowed)));
  });

  it("replays a lost launch under what the tick judged, and not once the host has stopped opting in", async () => {
    const w = fixture();
    machineFile(w, [codexAccount(w, "c", "codex-account-c")], {
      runtime_timeout: "2s",
    });
    writeFileSync(join(w.dir, "orca-terminal-hang"), "");
    const [lost] = launches(await tick(w));
    expect(lost?.outcome).toBe("lost");
    rmSync(join(w.dir, "orca-terminal-hang"));

    rmSync(join(w.home, ".jig", "jig.yaml"));
    const [held] = launches(await tick(w));
    expect(held?.outcome).toBe("waits");
    expect(held?.detail).toContain("drive.codex_bypass");
    expect(driveRuns(w)).toEqual([]);

    hostOptsIn(w);
    const [replayed] = launches(await tick(w));
    expect(replayed).toMatchObject({
      outcome: "retried",
      record: lost?.record,
    });
    await waitFor("the drive", () => driveRuns(w).length === 1);
    expect(driveRuns(w)[0]?.argv).toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    await waitFor("the exit", () => exitWritten(w, lost?.record ?? ""));
  });

  it("says why when the host's setting cannot be read, and admits nothing", async () => {
    const w = fixture();
    writeFileSync(
      join(w.home, ".jig", "jig.yaml"),
      "drive:\n  codex_bypass: yes please\n",
    );
    machineFile(w, [codexAccount(w, "c", "codex-account-c")]);
    const receipt = await tick(w);
    expect(receipt.accountsNotAdmitted?.[0]?.reason).toContain(
      "drive.codex_bypass must be true or false",
    );
    expect(recordIds(w)).toEqual([]);
  });

  it("reports a Codex account and never launches a pass on it while the pass deadline is 0, and launches under a positive one", async () => {
    const w = fixture();
    const c = codexAccount(w, "c", "codex-account-c");
    machineFile(w, [c]);
    w.env.DRIVE_PR_PASS_TIMEOUT = "0";

    const unbounded = await tick(w);
    expect(unbounded.accountsNotAdmitted).toEqual([
      {
        account: "c",
        vendor: "codex",
        reason: expect.stringContaining(
          "the pass deadline (DRIVE_PR_PASS_TIMEOUT) is 0",
        ),
      },
    ]);
    expect(launches(unbounded)[0]?.outcome).toBe("waits");
    expect(terminalCreates(w)).toEqual([]);
    expect(recordIds(w)).toEqual([]);

    w.env.DRIVE_PR_PASS_TIMEOUT = "120";
    const bounded = await tick(w);
    expect(bounded.accountsNotAdmitted).toBeUndefined();
    expect(launches(bounded)[0]).toMatchObject({
      outcome: "launched",
      account: "c",
    });
    await waitFor("the drive", () => driveRuns(w).length === 1);
    expect(driveRuns(w)).toMatchObject([
      {
        argv: [
          "7",
          "--bots-only",
          "--pass-timeout",
          "120",
          "--",
          ...CODEX_PASS,
        ],
      },
    ]);
    await waitFor("the exit", () => exitWritten(w, launchedRecord(bounded)));
  });
});

const PICKUP_CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
routing:
  models:
    codex: { execution: terra, strategic: astra }
  efforts:
    codex: { max: xhigh }
`;

/** The sessions the fake Codex recorded. */
function codexRuns(w: World): Array<{
  argv: string[];
  cwd: string;
  codexHome: string | null;
  configDir: string | null;
  token: string | null;
}> {
  const path = join(w.dir, "codex-runs.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("jig dispatch --apply picks up an item on a Codex account", () => {
  it("waits, naming the setting, on a host that has not opted in", async () => {
    const w = world();
    current = w;
    w.setConfig(PICKUP_CONFIG);
    w.setIssues([assignedIssue(12, "factory-bot", [])]);
    w.setAssigner(12, "maintainer", "WRITE");
    const overlay = join(w.root, "routing.yaml");
    writeFileSync(overlay, PICKUP_CONFIG);
    w.env.JIG_OVERLAY = overlay;
    withOrigin(w);
    machineFile(w, [codexAccount(w, "c", "codex-account-c")], {}, ["pickup"]);

    const receipt = await applyTick(w, true);
    expect(launches(receipt)[0]).toMatchObject({
      action: "pickup",
      outcome: "waits",
      detail: expect.stringContaining("drive.codex_bypass"),
    });
    expect(codexRuns(w)).toEqual([]);
    expect(recordIds(w)).toEqual([]);
  });

  it("starts Codex on the route's Codex model and effort, bound through CODEX_HOME", async () => {
    const w = world();
    current = w;
    w.setConfig(PICKUP_CONFIG);
    w.setIssues([assignedIssue(12, "factory-bot", [])]);
    w.setAssigner(12, "maintainer", "WRITE");
    // The configuration the route is derived from in the item's workspace.
    const overlay = join(w.root, "routing.yaml");
    writeFileSync(overlay, PICKUP_CONFIG);
    w.env.JIG_OVERLAY = overlay;
    withOrigin(w);
    const c = codexAccount(w, "c", "codex-account-c");
    machineFile(w, [c], {}, ["pickup"]);
    inheritOtherAccounts(w);
    hostOptsIn(w);

    const receipt = await applyTick(w, true);
    expect(launches(receipt)[0]).toMatchObject({
      action: "pickup",
      outcome: "launched",
      account: "c",
      // An item of no known type takes the strictest row: the complex tier, at high effort,
      // on the model the family names.
      detail: expect.stringContaining(
        "route complex for Codex, high, gpt-6-astra",
      ),
    });
    expect(readRecord(launchedRecord(receipt), dispatchState(w))).toMatchObject(
      {
        vendor: "codex",
        sessionId: null,
        model: "gpt-6-astra",
        effort: "high",
      },
    );

    await waitFor("the session", () => codexRuns(w).length === 1);
    expect(codexRuns(w)).toEqual([
      {
        argv: [
          "-m",
          "gpt-6-astra",
          "-c",
          'model_reasoning_effort="high"',
          expect.stringMatching(
            /^Use the jig:do-item skill: \/jig:do-item #12\n/,
          ),
        ],
        cwd: expect.any(String),
        codexHome: c.dir,
        configDir: null,
        token: null,
      },
    ]);
    expect(existsSync(join(w.dir, "claude-runs.jsonl"))).toBe(false);
  });
});
