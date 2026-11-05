/**
 * The end of a launch reaches its shared claim when the wrapper exits: the
 * wrapper writes it onto the launch claim this host made for its record right
 * after it records the stage's exit, before any tick runs. A forge that
 * refuses that write leaves the claim open, the wrapper says so in one line,
 * and this host's next tick with `--apply` writes the end. The wrapper exits
 * as the stage did either way.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { claimBody } from "../../shared/records/forge-claims.ts";
import {
  LAUNCH_CLAIM,
  LAUNCH_MARKER,
  launchClaim,
} from "../../shared/records/launch-claims.ts";
import type { LaunchDraft } from "../../shared/records/shared.ts";
import { forgeComment } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { hostOf } from "../lib/shared-launches.ts";
import { SLUG, type World, world } from "./fixtures.ts";
import {
  account,
  dispatchState,
  earlierRecord,
  exitWritten,
  machineFile,
} from "./launch-fixtures.ts";

const RUN_TS = resolve(import.meta.dir, "../run.ts");
const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
`;

const ID = "20261105T120000Z-aaaaaaaa";
const TOKEN = "the-token";
const FACTS = "generation 3, exit 16, heartbeat 2026-10-30T22:00:00.000Z";
/** The drive's exit, which the wrapper's must be. */
const EXIT = DRIVE_EXIT.MAX_ROUNDS;

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** Run the wrapper on `id` under `token`, as the terminal a launch opens would. */
async function runWrapper(w: World, id: string, token: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      `--config=${BUNFIG}`,
      RUN_TS,
      id,
      token,
    ],
    { cwd: w.repo, env: w.env, stdout: "pipe", stderr: "pipe" },
  );
  const deadline = setTimeout(() => child.kill(), 60_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(deadline);
  return { exitCode, stdout, stderr };
}

/**
 * A re-arm of PR #7 as a tick launched it: its launch record, and beside it
 * on the pull request the launch claim this host posted for it, with no end.
 * The drive it starts exits `EXIT`. Returns this host as its claims name it.
 */
function launched(w: World): string {
  w.setConfig(CONFIG);
  machineFile(w, [account(w, "a", "a@example.com")]);
  earlierRecord(w, { id: ID, account: "a", token: TOKEN, facts: FACTS });
  const host = hostOf(dispatchState(w));
  const draft: LaunchDraft = {
    stage: "drive",
    pr: 7,
    run: "tick",
    action: "rearm",
    record: ID,
    host,
    owner: true,
    facts: FACTS,
    writer: { login: "drive-bot", host },
  };
  w.setComments(7, [
    forgeComment(
      705,
      claimBody(LAUNCH_CLAIM, launchClaim(draft, 1)),
      "drive-bot",
    ),
  ]);
  writeFileSync(join(w.dir, "drive-exit"), String(EXIT));
  return host;
}

/** The last line of PR #7's launch claim: what it says to a person, its end included. */
function claimLine(w: World): string {
  const all = JSON.parse(
    readFileSync(join(w.dir, "comments-7.json"), "utf8"),
  ) as Array<{ body: string }>;
  const claims = all.filter((c) => c.body.startsWith(LAUNCH_MARKER));
  expect(claims).toHaveLength(1);
  return claims[0]?.body.split("\n").at(-1) ?? "";
}

/** Whether any tick ran on this host: each one leaves a receipt. */
const ticked = (w: World) => existsSync(join(dispatchState(w), "receipts"));

describe("the wrapper ends its launch's shared claim", () => {
  it("writes the end onto the claim as the stage exits, before any tick, and exits as the stage did", async () => {
    const w = world();
    current = w;
    const host = launched(w);

    const r = await runWrapper(w, ID, TOKEN);
    expectSpawnExit(r, EXIT, "the wrapper");
    expect(claimLine(w)).toBe(
      `jig dispatch launch · rearm · record: ${ID} · host: ${host} · ended exit ${EXIT}`,
    );
    expect(ticked(w)).toBe(false);
  });

  it("leaves the claim open when the forge refuses the end, says so in one line, and the next tick writes it", async () => {
    const w = world();
    current = w;
    const host = launched(w);
    writeFileSync(join(w.dir, "comment-edit-fail"), "");

    const r = await runWrapper(w, ID, TOKEN);
    expectSpawnExit(r, EXIT, "the wrapper");
    expect(exitWritten(w, ID)).toBe(true);
    expect(claimLine(w)).toBe(
      `jig dispatch launch · rearm · record: ${ID} · host: ${host}`,
    );
    const said = r.stderr
      .split("\n")
      .filter((line) => line.includes("the next tick writes it"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("comment 705");
    expect(said[0]).toContain("HTTP 403");

    rmSync(join(w.dir, "comment-edit-fail"));
    const tick = await w.dispatch(["--apply", "--json"]);
    expectSpawnExit(tick, 0, "the next tick");
    expect(claimLine(w)).toBe(
      `jig dispatch launch · rearm · record: ${ID} · host: ${host} · ended exit ${EXIT}`,
    );
  });
});
