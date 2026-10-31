/**
 * The driver's side of the drive ledger (`lib/driver/ledger.ts`) against the
 * fake forge, each call in a subprocess of its own: a claim whose read-back
 * fails, two clones claiming at the same moment, a lagging read that hides
 * the earlier claim, a driver that starts without reading the comments, and
 * the stopped ledger a thrown refusal leaves.
 */
import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { type DriveEvent, lastStop } from "../scripts/lib/state/events.ts";
import {
  type Ledger,
  ledgerFromState,
  parseLedger,
  renderClaim,
} from "../scripts/lib/state/ledger.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import {
  SCRIPTS,
  type FakeForge,
  driverEnv,
  fakeForge,
  forgeComment,
  ledgerBody,
} from "./ledger-forge-fixtures.ts";

const DRIVER = JSON.stringify(join(SCRIPTS, "lib", "driver", "ledger.ts"));
const LEDGER = JSON.stringify(join(SCRIPTS, "lib", "state", "ledger.ts"));
const FORGE = JSON.stringify(join(SCRIPTS, "lib", "state", "ledger-forge.ts"));
const ID = `{ actor: "wt-bbbbbbbbbbbbbbbb", clone: "clone-b", login: "drive-bot" }`;

/** Run `body` (an async function body with `d`, `l`, `f` and `fs` in scope) in a subprocess. */
async function probe(
  forge: FakeForge,
  body: string,
  env: Record<string, string> = {},
) {
  const code = `const d = await import(${DRIVER}); const l = await import(${LEDGER}); const f = await import(${FORGE}); const fs = await import("node:fs");
try { ${body} } catch (e) { if (e && typeof e.code === "number") { console.log("EXIT " + e.code); } else { throw e; } }`;
  const proc = Bun.spawn([process.execPath, "-e", code], {
    cwd: forge.repo,
    env: { ...forge.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/** A claim posted now, or `minutesAgo` before now. */
function claim(clone: string, generation: number, minutesAgo = 0): string {
  return renderClaim({
    actor: "wt-cccccccccccccccc",
    clone,
    generation,
    at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  });
}

describe("claiming a drive from another clone", () => {
  it("refuses the takeover when the claims cannot be read back", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    writeFileSync(join(forge.dir, "fail-list-after"), "0");
    const r = await probe(
      forge,
      `const own = await d.claimDrive("999", ${ID}, 3); console.log("WON " + own.id);`,
    );
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("EXIT 1");
    expect(r.stdout).not.toContain("WON");
    expect(r.stderr).toContain("whether an earlier claim beat it is unknown");
  });

  it("stands down when another clone's claim on the same generation landed first", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    // Both clones claim at once; the rival's lands with the lower id.
    writeFileSync(
      join(forge.dir, "race-on-claim"),
      JSON.stringify(forgeComment(50, claim("clone-c", 3), "other-bot")),
    );
    const r = await probe(
      forge,
      `console.log("CLAIM " + JSON.stringify(await d.claimDrive("999", ${ID}, 3)));`,
    );
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("CLAIM null");
    expect(r.stderr).toContain("standing down. Claim 50");
  });

  it("stands down once a lagging read shows the earlier claim it missed", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    writeFileSync(
      join(forge.dir, "race-on-claim"),
      JSON.stringify(forgeComment(50, claim("clone-c", 3), "other-bot")),
    );
    // The read after posting does not show the rival yet; the next one does.
    writeFileSync(
      join(forge.dir, "hide-ids"),
      JSON.stringify({ ids: [50], until: 2 }),
    );
    const r = await probe(
      forge,
      `const own = await d.claimDrive("999", ${ID}, 3);
console.log("WON " + own.id);
const snap = await f.readLedgerSnapshot("999", "drive-bot");
console.log("BEATEN BY " + l.newerClaim(snap.claims, own.id, "clone-b", own)?.id);`,
    );
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("WON 101");
    expect(r.stdout).toContain("BEATEN BY 50");
  });

  it("wins over a rival claim on the same generation older than the lease window", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    // The rival claimed and never wrote the ledger: its claim lapsed.
    writeFileSync(
      join(forge.dir, "race-on-claim"),
      JSON.stringify(forgeComment(50, claim("clone-c", 3, 300), "other-bot")),
    );
    const r = await probe(
      forge,
      `console.log("CLAIM " + (await d.claimDrive("999", ${ID}, 3))?.id);`,
    );
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("CLAIM 101");
  });

  it("drives by this clone's own earlier claim when a retry claims again", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    writeFileSync(
      join(forge.dir, "race-on-claim"),
      JSON.stringify(forgeComment(50, claim("clone-b", 3), "drive-bot")),
    );
    const r = await probe(
      forge,
      `console.log("CLAIM " + (await d.claimDrive("999", ${ID}, 3))?.id);`,
    );
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("CLAIM 50");
  });
});

describe("arming the ledger", () => {
  it("refuses to start when the comments cannot be read", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    writeFileSync(join(forge.dir, "fail-list-after"), "0");
    const r = await probe(
      forge,
      `await d.armLedger("999", ${ID}, null, null, "take-over");
console.log("ARMED");`,
    );
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("EXIT 1");
    expect(r.stdout).not.toContain("ARMED");
    expect(r.stderr).toContain("not starting the drive");
  });

  it("claims a pull request no ledger names yet, and stands down at a later claim", async () => {
    const forge = fakeForge([forgeComment(60, claim("clone-c", 1))], {
      login: "drive-bot",
    });
    const r = await probe(
      forge,
      `await d.armLedger("999", ${ID}, null, null, "take-over");
const env = JSON.parse(process.env.DRIVE_PR_LEDGER_DRIVER);
console.log("OWN " + env.claim?.id + " FLOOR " + env.floor);
console.log("FIRST " + (await d.standDownOnNewerClaim("999")));
const all = JSON.parse(fs.readFileSync(process.env.LEDGER_FAKE_DIR + "/comments.json", "utf8"));
all.push({ id: 900, body: ${JSON.stringify(claim("clone-c", 2))}, user: { login: "other" }, author_association: "MEMBER", updated_at: "2026-10-01T12:00:00Z" });
fs.writeFileSync(process.env.LEDGER_FAKE_DIR + "/comments.json", JSON.stringify(all));
console.log("SECOND " + (await d.standDownOnNewerClaim("999")));`,
    );
    expectSpawnExit(r, 0);
    // An earlier claim does not end the drive; a claim after its own does.
    expect(r.stdout).toMatch(/OWN (\d+) FLOOR \1/);
    expect(r.stdout).toContain("FIRST null");
    expect(r.stdout).toContain("SECOND 20");
  });

  it("refuses to start beside a ledger comment it cannot read", async () => {
    const damaged = ownLedger().replace(
      /"heartbeat":"[^"]*"/,
      '"heartbeat":"not-a-date"',
    );
    const forge = fakeForge([forgeComment(50, damaged)], {
      login: "drive-bot",
    });
    const r = await probe(
      forge,
      `await d.armLedger("999", ${ID}, null, null, "take-over");
console.log("ARMED");`,
    );
    expectSpawnExit(r, 0);
    expect(damaged).toContain("not-a-date");
    expect(r.stdout).toContain("EXIT 1");
    expect(r.stdout).not.toContain("ARMED");
    expect(r.stderr).toContain("holds no ledger this drive can read");
  });

  /** This clone's own stopped ledger, recording claim position 30. */
  function ownLedger(): string {
    return ledgerBody(
      ledgerFromState(freshState(999), {
        generation: 4,
        driver: {
          actor: "wt-bbbbbbbbbbbbbbbb",
          clone: "clone-b",
          heartbeat: new Date().toISOString(),
          state: "stopped",
          position: 30,
        },
        narrative: [],
        claims: [],
      }),
    );
  }

  it("does not adopt another clone's claim posted past its own ledger's position", async () => {
    // Another clone claimed this clone's stopped ledger and is still seeding.
    const forge = fakeForge(
      [
        forgeComment(40, ownLedger(), "drive-bot"),
        forgeComment(60, claim("clone-c", 4), "other-bot"),
      ],
      { login: "drive-bot" },
    );
    const r = await probe(
      forge,
      `await d.armLedger("999", ${ID}, null, null, "take-over");
console.log("ARMED " + JSON.parse(process.env.DRIVE_PR_LEDGER_DRIVER).floor);`,
    );
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("EXIT 20");
    expect(r.stdout).not.toContain("ARMED");
    expect(r.stderr).toContain("past this clone's recorded position 30");
  });

  it("continues its own ledger from the recorded position past an older claim", async () => {
    const forge = fakeForge(
      [
        forgeComment(20, claim("clone-c", 1), "other-bot"),
        forgeComment(40, ownLedger(), "drive-bot"),
      ],
      { login: "drive-bot" },
    );
    const r = await probe(
      forge,
      `await d.armLedger("999", ${ID}, null, null, "take-over");
console.log("ARMED " + JSON.parse(process.env.DRIVE_PR_LEDGER_DRIVER).floor);`,
    );
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("ARMED 30");
    expect(forge.calls().filter((c) => c.includes("--input"))).toHaveLength(0);
  });
});

describe("the driver's last ledger write", () => {
  it("marks the ledger stopped when a refusal is thrown mid-drive", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    const r = await probe(
      forge,
      `const cli = await import(${JSON.stringify(join(SCRIPTS, "lib", "cli.ts"))});
async function drive() {
  await using settlement = d.ledgerSettlement("999", [{ dir: "held-lock" }]);
  void settlement;
  throw new cli.ExitError(1);
}
await drive();`,
      { DRIVE_PR_LEDGER_DRIVER: driverEnv("clone-b") },
    );
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("EXIT 1");
    const ledgers: Ledger[] = forge
      .comments()
      .map((c) => parseLedger(c.body))
      .flatMap((p) => (p?.kind === "ledger" ? [p.ledger] : []));
    expect(ledgers.map((l) => l.driver.state)).toEqual(["stopped"]);
  });

  it("publishes a thrown stop's unknown exit over an earlier run's, in the ledger's events", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    const r = await probe(
      forge,
      `const cli = await import(${JSON.stringify(join(SCRIPTS, "lib", "cli.ts"))});
const seeded = Bun.spawnSync([process.execPath, ${JSON.stringify(join(SCRIPTS, "drive-state.ts"))}, "record-event", "999"], { stdin: Buffer.from('{"kind":"stop","cause":"0"}') });
if (seeded.exitCode !== 0) throw new Error("seed: " + seeded.stderr.toString());
async function drive() {
  await using settlement = d.ledgerSettlement("999", [{ dir: "held-lock" }]);
  void settlement;
  throw new cli.ExitError(1);
}
await drive();`,
      { DRIVE_PR_LEDGER_DRIVER: driverEnv("clone-b") },
    );
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("EXIT 1");
    const ledgers: Ledger[] = forge
      .comments()
      .map((c) => parseLedger(c.body))
      .flatMap((p) => (p?.kind === "ledger" ? [p.ledger] : []));
    const last = ledgers.at(-1);
    expect(last?.driver.state).toBe("stopped");
    expect(last?.driver.exit).toBeUndefined();
    const stops = (last?.events ?? []).filter((e) => e.kind === "stop");
    expect(stops.map((e) => e.cause)).toEqual(["0", "unknown"]);
    expect(lastStop(last?.events ?? [])).toBeNull();
  });

  it("names the exit a returned stop ends with, and writes once", async () => {
    const forge = fakeForge(
      [
        forgeComment(
          40,
          ledgerBody(
            ledgerFromState(freshState(999), {
              generation: 2,
              driver: {
                actor: "wt-bbbbbbbbbbbbbbbb",
                clone: "clone-b",
                heartbeat: "2026-10-01T11:00:00.000Z",
                state: "running",
              },
              narrative: [],
              claims: [],
            }),
          ),
        ),
      ],
      { login: "drive-bot" },
    );
    const r = await probe(
      forge,
      `async function drive() {
  await using settlement = d.ledgerSettlement("999", [{ dir: "held-lock" }]);
  return settlement.done(8);
}
console.log("RETURNED " + (await drive()));`,
      { DRIVE_PR_LEDGER_DRIVER: driverEnv("clone-b") },
    );
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("RETURNED 8");
    const parsed = parseLedger(forge.comments()[0]?.body ?? "");
    expect(parsed?.kind === "ledger" && parsed.ledger.driver).toMatchObject({
      state: "stopped",
      exit: 8,
    });
    expect(forge.calls().filter((c) => c.includes("PATCH"))).toHaveLength(1);
  });

  it("leaves the ledger running while the drive retains its locks", async () => {
    const forge = fakeForge(
      [
        forgeComment(
          40,
          ledgerBody(
            ledgerFromState(freshState(999), {
              generation: 2,
              driver: {
                actor: "wt-bbbbbbbbbbbbbbbb",
                clone: "clone-b",
                heartbeat: "2026-10-01T11:00:00.000Z",
                state: "running",
              },
              narrative: [],
              claims: [],
            }),
          ),
        ),
      ],
      { login: "drive-bot" },
    );
    // An unwitnessed pass termination empties `held`: its locks stay on disk.
    const r = await probe(
      forge,
      `async function drive() {
  await using settlement = d.ledgerSettlement("999", []);
  return settlement.done(15);
}
console.log("RETURNED " + (await drive()));`,
      { DRIVE_PR_LEDGER_DRIVER: driverEnv("clone-b") },
    );
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("RETURNED 15");
    expect(r.stderr).toContain("left naming this driver running");
    const parsed = parseLedger(forge.comments()[0]?.body ?? "");
    expect(parsed?.kind === "ledger" && parsed.ledger.driver.state).toBe(
      "running",
    );
    expect(forge.calls().filter((c) => c.includes("PATCH"))).toHaveLength(0);
  });

  it("writes no ledger when the stop cannot be recorded in the drive state", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    // Another live session's lease refuses `record-event`; `handoff` is not leased.
    const other = Bun.spawn([
      process.execPath,
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    try {
      const seeded = Bun.spawnSync(
        [
          process.execPath,
          join(SCRIPTS, "drive-state.ts"),
          "record-event",
          "999",
        ],
        {
          cwd: forge.repo,
          env: { ...forge.env, DRIVE_PR_SESSION: String(other.pid) },
          stdin: Buffer.from('{"kind":"stop","cause":"3"}'),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expectSpawnExit(seeded, 0);
      // A ledger written now would mirror the earlier run's stop (3) as this one's.
      const r = await probe(
        forge,
        `async function drive() {
  await using settlement = d.ledgerSettlement("999", [{ dir: "held-lock" }]);
  return settlement.done(8);
}
console.log("RETURNED " + (await drive()));`,
        {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_LEDGER_DRIVER: driverEnv("clone-b"),
        },
      );
      expectSpawnExit(r, 0);
      expect(r.stdout).toContain("RETURNED 8");
      expect(r.stderr).toContain("its stop is not in the drive state");
      expect(forge.comments()).toHaveLength(0);
    } finally {
      other.kill();
    }
  });

  it("with the ledger off, records the returned stop once, never an unknown one after it", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    const r = await probe(
      forge,
      `async function drive() {
  await using settlement = d.ledgerSettlement("999", [{ dir: "held-lock" }]);
  return settlement.done(8);
}
await drive();
const got = Bun.spawnSync([process.execPath, ${JSON.stringify(join(SCRIPTS, "drive-state.ts"))}, "get", "999"]);
console.log("EVENTS " + JSON.stringify(JSON.parse(got.stdout.toString()).events));`,
      { DRIVE_PR_LEDGER: "off" },
    );
    expectSpawnExit(r, 0);
    const events = JSON.parse(
      r.stdout.split("EVENTS ")[1] ?? "null",
    ) as DriveEvent[];
    expect(events.filter((e) => e.kind === "stop")).toEqual([
      expect.objectContaining({ cause: "8" }),
    ]);
    expect(lastStop(events)).toBe(8);
  });
});

describe("renewing the heartbeat through a wait", () => {
  it("writes as the wait starts and not again inside the renewal interval", async () => {
    const forge = fakeForge(
      [
        forgeComment(
          40,
          ledgerBody(
            ledgerFromState(freshState(999), {
              generation: 2,
              driver: {
                actor: "wt-bbbbbbbbbbbbbbbb",
                clone: "clone-b",
                heartbeat: "2026-10-01T11:00:00.000Z",
                state: "running",
              },
              narrative: [],
              claims: [],
            }),
          ),
        ),
      ],
      { login: "drive-bot" },
    );
    const r = await probe(
      forge,
      `const renew = d.ledgerRenewal("999");
await renew();
await renew();
console.log("RENEW_MS " + d.LEDGER_RENEW_MS);`,
      // A longer local stall threshold must not stretch the renewal: other
      // clones apply their own, as short as the default.
      {
        DRIVE_PR_LEDGER_DRIVER: driverEnv("clone-b"),
        DRIVE_PR_STALL_MIN: "1440",
      },
    );
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(`RENEW_MS ${60 * 60_000}`);
    expect(forge.calls().filter((c) => c.includes("PATCH"))).toHaveLength(1);
    const parsed = parseLedger(forge.comments()[0]?.body ?? "");
    const heartbeat =
      parsed?.kind === "ledger"
        ? Date.parse(parsed.ledger.driver.heartbeat)
        : 0;
    expect(Date.now() - heartbeat).toBeLessThan(10 * 60_000);
  });

  it("reports a write that did not land and does not count it as renewed", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    writeFileSync(join(forge.dir, "fail-list-after"), "0");
    const r = await probe(
      forge,
      `console.log("RENEWED " + (await d.ledgerRenewal("999")()));`,
      { DRIVE_PR_LEDGER_DRIVER: driverEnv("clone-b") },
    );
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("RENEWED null");
    expect(r.stderr).toContain("heartbeat write did not land");
  });

  it("stands down when another clone's newer claim refuses the write", async () => {
    const forge = fakeForge(
      [
        forgeComment(
          40,
          ledgerBody(
            ledgerFromState(freshState(999), {
              generation: 2,
              driver: {
                actor: "wt-bbbbbbbbbbbbbbbb",
                clone: "clone-b",
                heartbeat: "2026-10-01T11:00:00.000Z",
                state: "running",
                position: 40,
              },
              narrative: [],
              claims: [],
            }),
          ),
        ),
        forgeComment(50, claim("clone-c", 2)),
      ],
      { login: "drive-bot" },
    );
    const r = await probe(
      forge,
      `console.log("RENEWED " + (await d.ledgerRenewal("999")()));`,
      { DRIVE_PR_LEDGER_DRIVER: driverEnv("clone-b", 40) },
    );
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("RENEWED 20");
    expect(r.stderr).toContain("taken over");
    expect(forge.calls().filter((c) => c.includes("PATCH"))).toHaveLength(0);
  });

  it("stands down on a newer claim even when its own write did not land", async () => {
    const forge = fakeForge(
      [
        forgeComment(
          40,
          ledgerBody(
            ledgerFromState(freshState(999), {
              generation: 2,
              driver: {
                actor: "wt-bbbbbbbbbbbbbbbb",
                clone: "clone-b",
                heartbeat: "2026-10-01T11:00:00.000Z",
                state: "running",
                position: 40,
              },
              narrative: [],
              claims: [],
            }),
          ),
        ),
      ],
      { login: "drive-bot" },
    );
    writeFileSync(
      join(forge.dir, "fail-patch"),
      JSON.stringify(forgeComment(50, claim("clone-c", 2))),
    );
    const r = await probe(
      forge,
      `console.log("RENEWED " + (await d.ledgerRenewal("999")()));`,
      { DRIVE_PR_LEDGER_DRIVER: driverEnv("clone-b", 40) },
    );
    expectSpawnExit(r, 0);
    expect(forge.calls().filter((c) => c.includes("PATCH"))).toHaveLength(1);
    expect(r.stderr).toContain("heartbeat write did not land");
    expect(r.stdout).toContain("RENEWED 20");
    expect(r.stderr).toContain("taken over");
  });
});
