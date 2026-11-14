/**
 * The tracker preflight's parts that need no tick: what a failed answer
 * says of the credential and how its reason reads, the line's one need per
 * account for the whole host, and a launch the tick has no time left to
 * ask for.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrackerRateLimited } from "../../shared/outbound/budget.ts";
import { TrackerConfigError } from "../../skills/do-item/scripts/lib/tracker/config-error.ts";
import { admitAccount, type ApplyState } from "../lib/actions/launch.ts";
import type { LineNeed } from "../lib/dashboard-contract.ts";
import { parseMachineConfigText } from "../lib/machine-config.ts";
import {
  HOST_NEED_REPO,
  heldAccounts,
  newPreflight,
  preflightNeeds,
} from "../lib/preflight.ts";
import { answerKind, answerText } from "../lib/tracker-probe.ts";
import type { PreflightHold, RepoReport } from "../lib/types.ts";

describe("what a failed answer says of the credential", () => {
  it("reads a configuration error as config, wherever it is in the cause chain", () => {
    const config = new TrackerConfigError(
      "issue_tracker.team",
      "issue_tracker.team names ENG, which is no Jira project",
    );
    expect(answerKind(config)).toBe("config");
    expect(answerKind(new Error("reach failed", { cause: config }))).toBe(
      "config",
    );
  });

  it("reads a rate limit, a server error and the network as transient", () => {
    expect(
      answerKind(
        new TrackerRateLimited("linear", Date.now() + 60_000, "spent"),
      ),
    ).toBe("transient");
    const status = Object.assign(new Error("Linear API HTTP 503: down"), {
      status: 503,
    });
    expect(answerKind(status)).toBe("transient");
    expect(
      answerKind(new Error("GitHub API unreachable: connection refused")),
    ).toBe("transient");
  });

  it("reads a refusal and a client that timed out as unreachable", () => {
    expect(answerKind(new Error("GitHub API errors: Bad credentials"))).toBe(
      "unreachable",
    );
    expect(answerKind(new Error("linear api timed out"))).toBe("unreachable");
  });

  it("keeps the whole message and its causes in the reason, within its bound", () => {
    const hint = new Error(
      "gh api graphql returned no JSON (exit 4):\nTo get started with GitHub CLI, please run: gh auth login",
      { cause: new Error("the keyring is locked") },
    );
    const reason = answerText(hint);
    expect(reason).toContain("please run: gh auth login");
    expect(reason).toContain("caused by: the keyring is locked");
    expect(answerText(new Error("x".repeat(1000))).length).toBeLessThanOrEqual(
      300,
    );
  });
});

/** A repository's report that holds `holds`. */
function report(slug: string, holds: PreflightHold[]): RepoReport {
  return {
    path: `/work/${slug}`,
    slug,
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
    preflight: holds,
  };
}

describe("the line's need for held tracker stages", () => {
  const hold = (
    account: string,
    reason: string,
    stages: PreflightHold["stages"],
  ): PreflightHold => ({ probe: "tracker", account, reason, stages });

  it("is one need per account for the whole host, naming each repository it holds", () => {
    const needs = preflightNeeds(
      [
        report("example-org/web", [
          hold("a", "keychain", ["followup"]),
          hold("b", "lapsed", ["followup"]),
        ]),
        report("example-org/api", [hold("a", "keychain", ["pickup"])]),
      ],
      [],
      "2026-11-13T10:00:00.000Z",
    );
    expect(needs).toEqual([
      expect.objectContaining({
        cause: "tracker-unreachable",
        act: "Authorize",
        repo: HOST_NEED_REPO,
        target: "account a",
        stage: "followup",
        reason:
          "account a cannot reach the tracker, so its followup and pickup launches in example-org/web, example-org/api are held: keychain",
      }),
      expect.objectContaining({ repo: HOST_NEED_REPO, target: "account b" }),
    ]);
  });

  it("keeps the time it was first seen, and names each repository's answer when they differ", () => {
    const previous = [
      {
        cause: "tracker-unreachable",
        repo: HOST_NEED_REPO,
        target: "account a",
        since: "2026-11-12T08:00:00.000Z",
      } as LineNeed,
    ];
    const [need] = preflightNeeds(
      [
        report("example-org/web", [hold("a", "keychain", ["followup"])]),
        report("example-org/api", [hold("a", "no team", ["followup"])]),
      ],
      previous,
      "2026-11-13T10:00:00.000Z",
    );
    expect(need?.since).toBe("2026-11-12T08:00:00.000Z");
    expect(need?.reason).toEndWith(
      "held: example-org/web: keychain; example-org/api: no team",
    );
  });
});

describe("a launch the tick has no time left to ask for", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  });

  it("waits without asking the tracker", async () => {
    const read = parseMachineConfigText(
      "accounts:\n  - {name: a, vendor: claude, config_dir: /tmp/config-a, identity: a@example.com}\n",
      "dispatch.yaml",
    );
    if (!read.ok) throw new Error(read.failure.reason);
    const machine = read.value;
    let asked = 0;
    const preflight = newPreflight(machine, async () => {
      asked += 1;
      return { ok: true };
    });
    const root = mkdtempSync(join(tmpdir(), "jig-preflight-room-"));
    dirs.push(root);
    preflight.targets.set("example-org/web", {
      slug: "example-org/web",
      path: root,
      tracker: "github:example-org/web",
      values: {},
      report: report("example-org/web", []),
    });
    const state = {
      machine,
      records: [],
      table: [],
      last: null,
      passDeadlineSec: 0,
      codexOptIn: { on: false, why: "not opted in" },
      // Started long before the launcher's deadline, so no time is left.
      startedAt: Date.now() - 30 * 86_400_000,
      root,
      preflight,
    } as unknown as ApplyState;
    const admitted = await admitAccount(state, "example-org/web", {
      stage: "followup",
      target: "PR #9",
      record: "forge",
      reason: "merged",
      evidence: {},
    });
    expect(admitted).toEqual({
      outcome: expect.objectContaining({
        outcome: "waits",
        detail: expect.stringContaining("no room for the tracker preflight"),
      }),
    });
    expect(asked).toBe(0);
  });
});

it("bounds new tracker probes while retaining each account's answer", async () => {
  let running = 0;
  let peak = 0;
  const preflight = newPreflight({ preflight: ["tracker"] }, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return { ok: true };
  });
  preflight.targets.set("example-org/web", {
    slug: "example-org/web",
    path: process.cwd(),
    tracker: "github:example-org/web",
    values: {},
    report: report("example-org/web", []),
  });
  const accounts = Array.from(
    { length: 6 },
    (_, i) => ({ name: `account-${i}` }) as never,
  );

  await heldAccounts(preflight, "example-org/web", "followup", accounts, 30);

  expect(peak).toBe(4);
  expect(preflight.answers.size).toBe(6);
});
