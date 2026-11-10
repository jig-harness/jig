/**
 * jig dispatch with an adoption rule (`dispatch.adopt`): an open pull
 * request with no drive ledger is driven as if a person had labelled it
 * `drive` when its author is one the rule names (by default, the login the
 * dispatcher reads the forge as), it was updated within the rule's window,
 * draft or not. A bot's pull request is adopted only when the rule names
 * the bot, one a person's `hold` label is on never is, and an adopted pull
 * request is armed once per head commit. Without the rule nothing changes.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { adoptionOf, adopts, type Adoption } from "../lib/adopt.ts";
import { dispatchSection } from "../lib/section.ts";
import type { TickReceipt } from "../receipts.ts";
import { labeled, openPr, SLUG, type World, world } from "./fixtures.ts";
import {
  account,
  driveRuns,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";

const config = (dispatch: string) => `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
${dispatch}
`;

const ADOPT = config(
  "  labels: { enabled: true }\n  adopt: { enabled: true, within: 72h }",
);
const NAMED = config(
  '  labels: { enabled: true }\n  adopt:\n    enabled: true\n    authors: [someone-else, "dependabot[bot]"]',
);
const NONE = config("  labels: { enabled: true }");

const HOUR = 3_600_000;
it("adds served authors while retaining the default forge login", () => {
  expect(
    adoptionOf(
      {
        adopt: {
          enabled: true,
          authors: null,
          withinMs: HOUR,
          servedAuthors: ["served"],
        },
      },
      "factory",
    )?.authors,
  ).toEqual(["factory", "served"]);
});
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** An open pull request as the listing returns it, by `login` (a bot when `bot`), updated `updatedAt`. */
function authored(
  number: number,
  login: string,
  updatedAt: string,
  extra: { bot?: boolean; isDraft?: boolean; headRefOid?: string } = {},
) {
  return {
    ...openPr(number, `feature/${number}`, {
      ...(extra.headRefOid === undefined
        ? {}
        : { headRefOid: extra.headRefOid }),
    }),
    author: { login, is_bot: extra.bot === true },
    isDraft: extra.isDraft === true,
    updatedAt,
  };
}

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

function fixture(yaml: string): World {
  const w = world();
  current = w;
  w.setConfig(yaml);
  machineFile(w, [account(w, "a", "a@example.com")]);
  return w;
}

async function tick(w: World, args: string[] = []): Promise<TickReceipt> {
  const r = await w.dispatch([...args, "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

const rearms = (r: TickReceipt) =>
  (r.repos[0]?.actions ?? []).filter((a) => a.stage === "rearm");

/** The pull requests the world lists: its own recent draft, its own stale one, another author's, a bot's, and its own on hold. */
function population(w: World): void {
  w.setPrs("open", [
    authored(8, "drive-bot", ago(HOUR), { isDraft: true }),
    authored(9, "drive-bot", ago(100 * HOUR)),
    authored(10, "someone-else", ago(HOUR)),
    authored(11, "app/dependabot", ago(HOUR), { bot: true }),
    labeled(authored(12, "drive-bot", ago(HOUR)), "jig:hold"),
  ]);
  for (const n of [8, 9, 10, 11, 12]) w.setComments(n, []);
}

describe("jig dispatch adopts a repository's own recent pull requests", () => {
  it("drives an own pull request with no ledger updated inside the window, a draft included, and names the rule", async () => {
    const w = fixture(ADOPT);
    population(w);
    const r = await tick(w);
    const planned = rearms(r);
    expect(planned.map((a) => a.target)).toEqual(["PR #8"]);
    expect(planned[0]?.reason).toContain("dispatch.adopt");
    expect(String(planned[0]?.evidence.adopted)).toContain("drive-bot");
    const forge = r.repos[0]?.records.find((x) => x.record === "forge");
    expect(forge?.detail).toContain("1 adopted by dispatch.adopt");
  });

  it("adopts the authors the rule names, a bot only when named", async () => {
    const w = fixture(NAMED);
    population(w);
    const planned = rearms(await tick(w));
    expect(planned.map((a) => a.target)).toEqual(["PR #10", "PR #11"]);
  });

  it("adopts nothing without the rule", async () => {
    const w = fixture(NONE);
    population(w);
    expect(rearms(await tick(w))).toEqual([]);
  });

  it("arms an adopted pull request once per head commit", async () => {
    const w = fixture(ADOPT);
    w.setPrs("open", [authored(8, "drive-bot", ago(HOUR))]);
    w.setComments(8, []);
    const ws = join(w.root, "ws-8");
    mkdirSync(ws, { recursive: true });
    w.setWorkspaces([{ branch: "feature/8", linkedPR: 8, path: ws }]);

    const [launched] = (await tick(w, ["--apply"])).repos[0]?.launches ?? [];
    expect(launched).toMatchObject({ action: "rearm", outcome: "launched" });
    await waitFor("the exit", () => exitWritten(w, launched?.record ?? ""));

    // The arm left no ledger: the same head is not armed again.
    const second = await tick(w, ["--apply"]);
    expect(second.repos[0]?.launches).toEqual([]);
    expect(second.repos[0]?.quiet).toContainEqual(
      expect.objectContaining({ target: "PR #8", class: "unarmed" }),
    );
    expect(driveRuns(w)).toHaveLength(1);

    // A new head is a new arm.
    w.setPrs("open", [
      authored(8, "drive-bot", ago(0), { headRefOid: "d".repeat(40) }),
    ]);
    const [again] = (await tick(w, ["--apply"])).repos[0]?.launches ?? [];
    expect(again).toMatchObject({ action: "rearm", outcome: "launched" });
    await waitFor("the exit", () => exitWritten(w, again?.record ?? ""));
    expect(driveRuns(w)).toHaveLength(2);
  }, 90_000);
});

describe("dispatch.adopt", () => {
  /** The section read from `dispatch`, which the test expects to validate. */
  const section = (dispatch: unknown) => {
    const read = dispatchSection({ dispatch });
    if (!read.ok) throw new Error(read.failure.reason);
    return read.value;
  };

  it("is off when absent, and on with its defaults when enabled", () => {
    expect(section(undefined).adopt).toEqual({
      enabled: false,
      authors: null,
      withinMs: 168 * HOUR,
    });
    expect(
      section({ labels: { enabled: true }, adopt: { enabled: true } }).adopt,
    ).toEqual({ enabled: true, authors: null, withinMs: 168 * HOUR });
  });

  it("refuses an unknown key, an empty author, a window that is no duration, and only_labeled beside it", () => {
    const refusal = (dispatch: unknown, reason: string) =>
      expect(dispatchSection({ dispatch })).toEqual({
        ok: false,
        failure: { code: "invalid", reason: expect.stringContaining(reason) },
      });
    refusal({ adopt: { enabled: true } }, "labels.enabled");
    refusal(
      { labels: { enabled: true }, adopt: { enabled: true, age: "1h" } },
      "dispatch.adopt has unknown key(s): age",
    );
    refusal(
      { adopt: { enabled: true, authors: [""] } },
      "dispatch.adopt.authors",
    );
    refusal(
      { adopt: { enabled: true, within: "a week" } },
      "dispatch.adopt.within",
    );
    refusal(
      {
        labels: { enabled: true, only_labeled: true },
        adopt: { enabled: true },
      },
      "only_labeled",
    );
  });
});

describe("the default author", () => {
  const pr = {
    author: { login: "drive-app[bot]", bot: true },
    updatedAt: new Date().toISOString(),
  };
  const section = (authors: string[] | null) => ({
    adopt: { enabled: true, authors, withinMs: 168 * HOUR },
  });

  it("never adopts a bot the dispatcher's own login makes the default, only one the rule names", () => {
    const implicit = adoptionOf(section(null), "drive-app[bot]");
    expect(adopts(pr, implicit as Adoption, null, Date.now())).toBeNull();
    const named = adoptionOf(section(["drive-app[bot]"]), "drive-bot");
    expect(adopts(pr, named as Adoption, null, Date.now())).not.toBeNull();
  });
});
