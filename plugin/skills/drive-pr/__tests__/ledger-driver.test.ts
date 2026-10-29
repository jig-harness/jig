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

function claim(clone: string, generation: number): string {
  return renderClaim({
    actor: "wt-cccccccccccccccc",
    clone,
    generation,
    at: "2026-10-01T12:00:00.000Z",
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
});

describe("a driver that starts without reading the comments", () => {
  it("takes its position from the first round boundary that reads them", async () => {
    const forge = fakeForge([forgeComment(60, claim("clone-c", 1))], {
      login: "drive-bot",
    });
    writeFileSync(join(forge.dir, "fail-list-after"), "0");
    const r = await probe(
      forge,
      `await d.armLedger("999", ${ID}, null, null, "take-over");
console.log("FLOOR " + JSON.parse(process.env.DRIVE_PR_LEDGER_DRIVER).floor);
fs.rmSync(process.env.LEDGER_FAKE_DIR + "/fail-list-after");
console.log("FIRST " + (await d.standDownOnNewerClaim("999")));
console.log("FLOOR " + JSON.parse(process.env.DRIVE_PR_LEDGER_DRIVER).floor);
const all = JSON.parse(fs.readFileSync(process.env.LEDGER_FAKE_DIR + "/comments.json", "utf8"));
all.push({ id: 70, body: ${JSON.stringify(claim("clone-c", 2))}, user: { login: "other" }, author_association: "MEMBER", updated_at: "2026-10-01T12:00:00Z" });
fs.writeFileSync(process.env.LEDGER_FAKE_DIR + "/comments.json", JSON.stringify(all));
console.log("SECOND " + (await d.standDownOnNewerClaim("999")));`,
    );
    expectSpawnExit(r, 0);
    // An old claim does not end the drive; a claim after the position does.
    expect(r.stdout).toContain("FLOOR null");
    expect(r.stdout).toContain("FIRST null");
    expect(r.stdout).toContain("FLOOR 60");
    expect(r.stdout).toContain("SECOND 20");
  });
});

describe("the driver's last ledger write", () => {
  it("marks the ledger stopped when a refusal is thrown mid-drive", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    const r = await probe(
      forge,
      `const cli = await import(${JSON.stringify(join(SCRIPTS, "lib", "cli.ts"))});
async function drive() {
  await using settlement = d.ledgerSettlement("999");
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
  await using settlement = d.ledgerSettlement("999");
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
});
