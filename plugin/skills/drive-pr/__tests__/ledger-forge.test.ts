/**
 * The drive ledger written to and read from a fake forge: `drive-state.ts
 * handoff` and `park` under a driver's `$DRIVE_PR_LEDGER_DRIVER`, the
 * read-modify-write against `updated_at`, the creation race, untrusted
 * markers, a newer claim stopping the write, `seed-ledger`, and the search
 * that finds the pull requests carrying a ledger.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { formatClaim } from "../scripts/lib/claim.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";
import {
  type Ledger,
  ledgerFromState,
  parseLedger,
  renderClaim,
} from "../scripts/lib/state/ledger.ts";
import { LEDGER_NOT_WRITTEN_EXIT } from "../scripts/lib/state/ledger-mirror.ts";
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

  it("rebuilds with the notes as they stand when the ledger moved under the write", async () => {
    const forge = fakeForge(
      [forgeComment(40, ledgerBody(ledger(3)), "maintainer")],
      { login: "drive-bot" },
    );
    expectSpawnExit(
      await runScript(forge, "drive-state.ts", ["handoff", "999"]),
      0,
    );
    const file = join(forge.env.DRIVE_PR_HANDOFF_DIR ?? "", "pr-drive-999.md");
    const withNotes = (notes: string) =>
      readFileSync(file, "utf8").replace(
        /\*\*Resume:\*\*/,
        `${notes}\n\n**Resume:**`,
      );
    writeFileSync(file, withNotes("Old notes."));
    const newer = withNotes("New notes.").replace("Old notes.\n\n", "");
    // Another writer updates the notes and the ledger between this write's
    // build and its landing.
    writeFileSync(join(forge.dir, "bump-on-list"), "2");
    writeFileSync(
      join(forge.dir, "bump-body.json"),
      JSON.stringify({ id: 40, body: ledgerBody(ledger(9)) }),
    );
    writeFileSync(
      join(forge.dir, "write-on-list"),
      JSON.stringify({ n: 2, path: file, text: newer }),
    );
    const r = await handoff(forge);
    expectSpawnExit(r, 0);
    const written = ledgersOn(forge).get(40);
    expect(written?.generation).toBe(10);
    expect(written?.narrative).toEqual(["New notes."]);
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
    expectSpawnExit(r, LEDGER_NOT_WRITTEN_EXIT);
    expect(r.stderr).toContain("another writer replaced this write");
    expect(ledgersOn(forge).get(40)?.generation).toBe(9);
    const got = await runScript(forge, "drive-state.ts", ["get", "999"]);
    expect(JSON.parse(got.stdout).ledgerGeneration).toBeUndefined();
  });

  it("tells a replacement with the same generation and heartbeat from its own write", async () => {
    const forge = fakeForge(
      [forgeComment(40, ledgerBody(ledger(3)), "maintainer")],
      { login: "drive-bot" },
    );
    // The read-back finds another writer's ledger built from the same read.
    writeFileSync(join(forge.dir, "twin-on-list"), "3");
    const r = await handoff(forge);
    expectSpawnExit(r, LEDGER_NOT_WRITTEN_EXIT);
    expect(r.stderr).toContain("another writer replaced this write");
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
    expectSpawnExit(r, LEDGER_NOT_WRITTEN_EXIT);
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

  it("skips the write when a claim appears beside a ledger that did not move", async () => {
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
    // The first read misses the claim; the re-read before the write sees it.
    writeFileSync(
      join(forge.dir, "hide-ids"),
      JSON.stringify({ ids: [80], until: 2 }),
    );
    const r = await handoff(forge);
    expectSpawnExit(r, 0);
    expect(r.stderr).toContain("newer takeover claim (comment 80)");
    expect(forge.calls().filter((c) => c.includes("PATCH"))).toHaveLength(0);
  });

  it("is not written for a driver that no longer holds the PR's lock", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    const env = JSON.parse(driverEnv(CLONE));
    const r = await handoff(forge, {
      DRIVE_PR_LEDGER_DRIVER: JSON.stringify({
        ...env,
        started: "2026-10-01T09:00:00.000Z",
      }),
    });
    expectSpawnExit(r, 0);
    expect(r.stderr).toContain("no longer holds PR #999's lock");
    expect(forge.comments()).toEqual([]);
  });

  it("is not written once its driver loses the PR's lock during the reads", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    const started = "2026-10-01T09:00:00.000Z";
    const lock = join(
      scopedStateDir(forge.stateDir, forge.repo),
      "pr-drive-999.lock",
    );
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "claim.feedc0de"),
      formatClaim(process.pid, hostname(), {
        pr: "999",
        worktree: forge.repo,
        log: join(lock, "drive.log"),
        started,
        account: {
          account: null,
          vendor: null,
          provenance: "none",
          reason: "test",
        },
      }),
    );
    // The driver releases its lock while the write reads the comments.
    writeFileSync(
      join(forge.dir, "remove-on-list"),
      JSON.stringify({ n: 1, path: lock }),
    );
    const env = JSON.parse(driverEnv(CLONE));
    const r = await handoff(forge, {
      DRIVE_PR_LEDGER_DRIVER: JSON.stringify({ ...env, started }),
    });
    expectSpawnExit(r, 0);
    expect(r.stderr).toContain("no longer holds PR #999's lock");
    expect(forge.comments()).toEqual([]);
  });

  it("does not mark stopped, in a recovery, a ledger that names another driver", async () => {
    const forge = fakeForge([forgeComment(40, ledgerBody(ledger(3)))], {
      login: "drive-bot",
    });
    const env = JSON.parse(driverEnv(CLONE));
    const r = await handoff(forge, {
      DRIVE_PR_LEDGER_DRIVER: JSON.stringify({
        ...env,
        started: "2026-10-01T09:00:00.000Z",
        stopped: null,
        recovering: true,
      }),
    });
    expectSpawnExit(r, 0);
    expect(r.stderr).toContain("is not the stopped driver's");
    expect(ledgersOn(forge).get(40)?.driver.state).toBe("running");
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

  it("installs the last driver's narrative in the handoff file", async () => {
    const forge = fakeForge([]);
    const l = {
      ...ledger(4, 6),
      narrative: ["Round 6 left the parser half done."],
    };
    const seeded = await runScript(
      forge,
      "drive-state.ts",
      ["seed-ledger", "999"],
      {},
      ledgerBody(l),
    );
    expectSpawnExit(seeded, 0);
    const handoffFile = join(
      forge.env.DRIVE_PR_HANDOFF_DIR ?? "",
      "pr-drive-999.md",
    );
    const text = readFileSync(handoffFile, "utf8");
    expect(text).toContain("Round 6 left the parser half done.");
    expect(text.trimEnd().endsWith("**Resume:** `/drive-pr 999`")).toBe(true);
  });

  it("installs the narrative over a handoff file that lost its marker", async () => {
    const forge = fakeForge([]);
    const handoffDir = forge.env.DRIVE_PR_HANDOFF_DIR ?? "";
    mkdirSync(handoffDir, { recursive: true });
    const handoffFile = join(handoffDir, "pr-drive-999.md");
    writeFileSync(handoffFile, "edited by hand\n");
    const seeded = await runScript(
      forge,
      "drive-state.ts",
      ["seed-ledger", "999"],
      {},
      ledgerBody({ ...ledger(4, 6), narrative: ["Notes to keep."] }),
    );
    expectSpawnExit(seeded, 0);
    expect(readFileSync(handoffFile, "utf8")).toContain("Notes to keep.");
  });

  it("does not advance the generation when the notes cannot be installed", async () => {
    const forge = fakeForge([]);
    const blocker = join(forge.dir, "not-a-directory");
    writeFileSync(blocker, "");
    const body = ledgerBody({ ...ledger(4, 6), narrative: ["Notes to keep."] });
    const refused = await runScript(
      forge,
      "drive-state.ts",
      ["seed-ledger", "999"],
      { DRIVE_PR_HANDOFF_DIR: join(blocker, "handoff") },
      body,
    );
    expectSpawnExit(refused, 1);
    expect(refused.stderr).toContain("could not be installed");
    const retried = await runScript(
      forge,
      "drive-state.ts",
      ["seed-ledger", "999"],
      {},
      body,
    );
    expectSpawnExit(retried, 0);
    expect(retried.stdout).toContain("seeded from generation 4");
    expect(
      readFileSync(
        join(forge.env.DRIVE_PR_HANDOFF_DIR ?? "", "pr-drive-999.md"),
        "utf8",
      ),
    ).toContain("Notes to keep.");
  });

  it("replaces this clone's notes with a newer ledger's empty narrative", async () => {
    const forge = fakeForge([]);
    expectSpawnExit(
      await runScript(
        forge,
        "drive-state.ts",
        ["seed-ledger", "999"],
        {},
        ledgerBody({ ...ledger(4, 6), narrative: ["Older notes."] }),
      ),
      0,
    );
    // The newer ledger's narrative was cut to fit the forge's size limit.
    const seeded = await runScript(
      forge,
      "drive-state.ts",
      ["seed-ledger", "999"],
      {},
      ledgerBody(ledger(5, 7)),
    );
    expectSpawnExit(seeded, 0);
    const text = readFileSync(
      join(forge.env.DRIVE_PR_HANDOFF_DIR ?? "", "pr-drive-999.md"),
      "utf8",
    );
    expect(text).not.toContain("Older notes.");
    expect(text.trimEnd().endsWith("**Resume:** `/drive-pr 999`")).toBe(true);
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
