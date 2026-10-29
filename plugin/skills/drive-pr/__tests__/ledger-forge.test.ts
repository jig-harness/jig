/**
 * The drive ledger written to and read from a fake forge: `drive-state.ts
 * handoff` and `park` under a driver's `$DRIVE_PR_LEDGER_DRIVER`, the
 * read-modify-write against `updated_at`, the creation race, untrusted
 * markers, a newer claim stopping the write, `seed-ledger`, and the search
 * that finds the pull requests carrying a ledger.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  type Ledger,
  ledgerFromState,
  parseLedger,
  renderClaim,
} from "../scripts/lib/state/ledger.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import {
  SCRIPTS,
  driverEnv,
  fakeForge,
  forgeComment,
  ledgerBody,
  runScript,
} from "./ledger-forge-fixtures.ts";

const CLONE = "clone-b";

function ledger(generation: number, round = 2): Ledger {
  return ledgerFromState(
    { ...freshState(999), rounds: round, phase: "pass" },
    {
      generation,
      driver: {
        actor: "wt-aaaaaaaaaaaaaaaa",
        clone: "clone-a",
        heartbeat: "2026-10-01T11:00:00.000Z",
        state: "running",
      },
      narrative: [],
      claims: [],
    },
  );
}

/** The ledgers the fake forge holds, by comment id. */
function ledgersOn(forge: ReturnType<typeof fakeForge>): Map<number, Ledger> {
  const out = new Map<number, Ledger>();
  for (const c of forge.comments()) {
    const parsed = parseLedger(c.body);
    if (parsed?.kind === "ledger") out.set(c.id, parsed.ledger);
  }
  return out;
}

async function handoff(
  forge: ReturnType<typeof fakeForge>,
  env: Record<string, string> = {},
) {
  return runScript(forge, "drive-state.ts", ["handoff", "999"], {
    DRIVE_PR_LEDGER_DRIVER: driverEnv(CLONE),
    ...env,
  });
}

describe("the ledger written from the drive state", () => {
  it("creates the ledger at the first write and records its generation", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    const r = await handoff(forge);
    expectSpawnExit(r, 0);
    const ledgers = ledgersOn(forge);
    expect([...ledgers.values()].map((l) => l.generation)).toEqual([1]);
    expect(r.stderr).toContain("ledger: generation 1 written");
    const got = await runScript(forge, "drive-state.ts", ["get", "999"]);
    expect(JSON.parse(got.stdout).ledgerGeneration).toBe(1);
  });

  it("is not written by a session that is not a drive's child", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    const r = await runScript(forge, "drive-state.ts", ["handoff", "999"]);
    expectSpawnExit(r, 0);
    expect(forge.comments()).toEqual([]);
    expect(forge.calls()).toEqual([]);
  });

  it("writes the ledger at a park, with the parked decision", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    const r = await runScript(
      forge,
      "drive-state.ts",
      [
        "park",
        "999",
        "--key",
        "PRRT_x",
        "--kind",
        "thread",
        "--reason",
        "Pick the schema",
      ],
      { DRIVE_PR_LEDGER_DRIVER: driverEnv(CLONE) },
    );
    expectSpawnExit(r, 0);
    const [l] = [...ledgersOn(forge).values()];
    expect(l?.parked.map((p) => [p.key, p.reason])).toEqual([
      ["PRRT_x", "Pick the schema"],
    ]);
  });

  it("rebuilds from the newer read when the ledger moved under the write", async () => {
    const forge = fakeForge(
      [forgeComment(40, ledgerBody(ledger(3)), "maintainer")],
      { login: "drive-bot" },
    );
    // A concurrent writer lands generation 9 between the read and the write.
    writeFileSync(join(forge.dir, "bump-on-list"), "2");
    writeFileSync(
      join(forge.dir, "bump-body.json"),
      JSON.stringify({ id: 40, body: ledgerBody(ledger(9)) }),
    );
    const r = await handoff(forge);
    expectSpawnExit(r, 0);
    expect(ledgersOn(forge).get(40)?.generation).toBe(10);
    expect(forge.calls().filter((c) => c.includes("PATCH"))).toHaveLength(1);
  });

  it("rebuilds when the ledger moved within the same second", async () => {
    const forge = fakeForge(
      [forgeComment(40, ledgerBody(ledger(3)), "maintainer")],
      { login: "drive-bot" },
    );
    writeFileSync(join(forge.dir, "bump-on-list"), "2");
    writeFileSync(join(forge.dir, "bump-same-second"), "");
    writeFileSync(
      join(forge.dir, "bump-body.json"),
      JSON.stringify({ id: 40, body: ledgerBody(ledger(9)) }),
    );
    const r = await handoff(forge);
    expectSpawnExit(r, 0);
    expect(ledgersOn(forge).get(40)?.generation).toBe(10);
  });

  it("reads the ledger back after the write and says when another writer replaced it", async () => {
    const forge = fakeForge(
      [forgeComment(40, ledgerBody(ledger(3)), "maintainer")],
      { login: "drive-bot" },
    );
    // The third listing is the read-back: another writer landed right after.
    writeFileSync(join(forge.dir, "bump-on-list"), "3");
    writeFileSync(
      join(forge.dir, "bump-body.json"),
      JSON.stringify({ id: 40, body: ledgerBody(ledger(9)) }),
    );
    const r = await handoff(forge);
    expectSpawnExit(r, 0);
    expect(r.stderr).toContain("another writer replaced this write");
    expect(ledgersOn(forge).get(40)?.generation).toBe(9);
    const got = await runScript(forge, "drive-state.ts", ["get", "999"]);
    expect(JSON.parse(got.stdout).ledgerGeneration).toBeUndefined();
  });

  it("leaves the lower id canonical after a creation race, and deletes its own copy on the next write", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    // Another writer's creation lands, with a lower id, just before ours.
    writeFileSync(
      join(forge.dir, "race-on-post"),
      JSON.stringify(forgeComment(40, ledgerBody(ledger(1)), "other-bot")),
    );
    expectSpawnExit(await handoff(forge), 0);
    expect([...ledgersOn(forge).keys()].sort((a, b) => a - b)).toEqual([
      40, 101,
    ]);
    const second = await handoff(forge);
    expectSpawnExit(second, 0);
    expect([...ledgersOn(forge).keys()]).toEqual([40]);
    expect(ledgersOn(forge).get(40)?.generation).toBe(2);
    expect(second.stderr).toContain("deleted this login's duplicate(s) 101");
  });

  it("posts no account and no email address", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    const hash = "acct-0123456789abcdef";
    const steps: Array<[string[], string | undefined]> = [
      [
        [
          "park",
          "999",
          "--key",
          "PRRT_x",
          "--kind",
          "thread",
          "--reason",
          "Ask dev.person@example.com which schema",
        ],
        undefined,
      ],
      [
        [
          "quota-park",
          "999",
          "--vendor",
          "claude",
          "--window",
          "weekly",
          "--account",
          hash,
        ],
        undefined,
      ],
      [
        ["takeover", "999"],
        JSON.stringify({
          fromActor: null,
          fromAccount: hash,
          toAccount: hash,
          verdict: "DEAD",
          reopened: [],
        }),
      ],
    ];
    for (const [args, stdin] of steps)
      expectSpawnExit(
        await runScript(forge, "drive-state.ts", args, {}, stdin),
        0,
      );
    const handoffFile = join(
      forge.env.DRIVE_PR_HANDOFF_DIR ?? "",
      "pr-drive-999.md",
    );
    writeFileSync(
      handoffFile,
      `${readFileSync(handoffFile, "utf8")}\nAsked someone+drive@example.org about it.\n`,
    );
    expectSpawnExit(await handoff(forge), 0);
    const bodies = forge.comments().map((c) => c.body);
    expect(bodies).toHaveLength(1);
    const [body] = bodies;
    expect(body).not.toMatch(/[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}/i);
    expect(body).not.toContain(hash);
    expect(body).not.toMatch(/"(?:from|to)?[aA]ccount"/);
    const [posted] = [...ledgersOn(forge).values()];
    expect(posted?.parked[0]?.reason).toBe("Ask <redacted> which schema");
    expect(posted?.narrative).toContain("Asked <redacted> about it.");
    // The local state keeps the account its own re-arm reads.
    const got = await runScript(forge, "drive-state.ts", ["get", "999"]);
    expect(JSON.parse(got.stdout).quotaPark.account).toBe(hash);
  });

  it("ignores and reports a forged ledger from an unassociated author", async () => {
    const forge = fakeForge(
      [forgeComment(30, ledgerBody(ledger(50, 9)), "drive-by", "NONE")],
      { login: "drive-bot" },
    );
    const r = await handoff(forge);
    expectSpawnExit(r, 0);
    expect(r.stderr).toContain("ignored 1 comment(s)");
    expect(r.stderr).toContain("ids 30");
    // Untouched, and not read as the canonical ledger: ours starts at 1.
    const ledgers = ledgersOn(forge);
    expect(ledgers.get(30)?.generation).toBe(50);
    expect(
      [...ledgers.entries()]
        .filter(([id]) => id !== 30)
        .map(([, l]) => l.generation),
    ).toEqual([1]);
  });

  it("never overwrites a ledger in a version this code does not read", async () => {
    const v9 = ledgerBody(ledger(3)).replace(
      '"ledgerVersion":1',
      '"ledgerVersion":9',
    );
    const forge = fakeForge([forgeComment(40, v9)], { login: "drive-bot" });
    const r = await handoff(forge);
    expectSpawnExit(r, 0);
    expect(r.stderr).toContain("ledgerVersion 9");
    expect(forge.comments()[0]?.body).toBe(v9);
  });

  it("skips the write once another clone's claim is newer than this driver's", async () => {
    const claim = renderClaim({
      actor: "wt-cccccccccccccccc",
      clone: "clone-c",
      generation: 3,
      at: "2026-10-01T12:00:00.000Z",
    });
    const forge = fakeForge(
      [
        forgeComment(40, ledgerBody(ledger(3))),
        forgeComment(80, claim, "other-bot"),
      ],
      { login: "drive-bot" },
    );
    const r = await handoff(forge);
    expectSpawnExit(r, 0);
    expect(r.stderr).toContain("newer takeover claim (comment 80)");
    expect(ledgersOn(forge).get(40)?.generation).toBe(3);
  });
});

describe("seed-ledger", () => {
  it("seeds an older state and leaves a current one", async () => {
    const forge = fakeForge([]);
    const seeded = await runScript(
      forge,
      "drive-state.ts",
      ["seed-ledger", "999"],
      {},
      ledgerBody(ledger(4, 6)),
    );
    expectSpawnExit(seeded, 0);
    expect(seeded.stdout).toContain("seeded from generation 4: round 6");
    const older = await runScript(
      forge,
      "drive-state.ts",
      ["seed-ledger", "999"],
      {},
      ledgerBody(ledger(3, 1)),
    );
    expectSpawnExit(older, 0);
    expect(older.stdout).toContain("current");
    const got = await runScript(forge, "drive-state.ts", ["get", "999"]);
    expect(JSON.parse(got.stdout).rounds).toBe(6);
    // The seeded state regenerated the handoff file.
    const handoffFile = join(
      forge.env.DRIVE_PR_HANDOFF_DIR ?? "",
      "pr-drive-999.md",
    );
    expect(readFileSync(handoffFile, "utf8")).toContain("**Round**: 6");
  });

  it("does not seed back what a reset forgot", async () => {
    const forge = fakeForge([]);
    const body = ledgerBody(ledger(4, 6));
    expectSpawnExit(
      await runScript(
        forge,
        "drive-state.ts",
        ["seed-ledger", "999"],
        {},
        body,
      ),
      0,
    );
    expectSpawnExit(
      await runScript(forge, "drive-state.ts", ["reset", "999"]),
      0,
    );
    const again = await runScript(
      forge,
      "drive-state.ts",
      ["seed-ledger", "999"],
      {},
      body,
    );
    expectSpawnExit(again, 0);
    expect(again.stdout).toContain("current");
    const got = JSON.parse(
      (await runScript(forge, "drive-state.ts", ["get", "999"])).stdout,
    );
    expect([got.rounds, got.ledgerGeneration]).toEqual([0, 4]);
  });
});

describe("the population for the morning report", () => {
  async function population(forge: ReturnType<typeof fakeForge>) {
    const probe = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import(${JSON.stringify(join(SCRIPTS, "lib", "state", "ledger-forge.ts"))}).then(async (m) => console.log(JSON.stringify(await m.listLedgerPullRequests())))`,
      ],
      { cwd: forge.repo, env: forge.env, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
      probe.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, 0);
    return JSON.parse(stdout) as Array<{ number: number }> | null;
  }

  function search(forge: ReturnType<typeof fakeForge>, numbers: number[]) {
    writeFileSync(
      join(forge.dir, "search.json"),
      JSON.stringify({
        items: numbers.map((n) => ({
          number: n,
          html_url: `https://example.invalid/pull/${n}`,
          title: `pr ${n}`,
        })),
      }),
    );
  }

  it("lists the open pull requests whose comments hold a trusted ledger", async () => {
    const forge = fakeForge([]);
    search(forge, [12, 7, 9]);
    writeFileSync(
      join(forge.dir, "comments-7.json"),
      JSON.stringify([forgeComment(70, ledgerBody(ledger(2)))]),
    );
    // A comment that merely mentions the marker matches the search too.
    writeFileSync(
      join(forge.dir, "comments-12.json"),
      JSON.stringify([
        forgeComment(120, "Is the `drive-pr-ledger` comment current?"),
      ]),
    );
    // A forged ledger from an unassociated author is not one.
    writeFileSync(
      join(forge.dir, "comments-9.json"),
      JSON.stringify([
        forgeComment(90, ledgerBody(ledger(2)), "drive-by", "NONE"),
      ]),
    );
    expect((await population(forge))?.map((p) => p.number)).toEqual([7]);
    const query = await Bun.file(join(forge.dir, "search-query")).text();
    expect(query).toBe(
      'q=repo:example-org/example-repo is:pr is:open in:comments "drive-pr-ledger"',
    );
    // The search went through the deadlined gh chokepoint, as a GET.
    expect(forge.calls().some((c) => c.startsWith("api -X GET"))).toBe(true);
  });

  it("is empty when the search finds nothing", async () => {
    const forge = fakeForge([]);
    search(forge, []);
    expect(await population(forge)).toEqual([]);
  });

  it("is null when the search cannot be run", async () => {
    const forge = fakeForge([]);
    writeFileSync(join(forge.dir, "fail-search"), "");
    expect(await population(forge)).toBeNull();
  });
});
