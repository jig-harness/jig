import { describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import {
  recordPendingExit,
  writeDriverRecord,
} from "../scripts/lib/ledger-stop.ts";
import { worktreePathKey } from "../scripts/lib/state/actor.ts";
import {
  type Ledger,
  ledgerFromState,
  parseLedger,
} from "../scripts/lib/state/ledger.ts";
import { cloneId } from "../scripts/lib/state/ledger-mirror.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import {
  SCRIPTS,
  type FakeForge,
  fakeForge,
  forgeComment,
  ledgerBody,
} from "./ledger-forge-fixtures.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";
import { labelForge } from "./state-labels-forge.ts";
import { driverRecordRow } from "./state-rows.ts";

interface Stage {
  forge: FakeForge;
  leaf: string;
  actor: string;
  started: string;
}

function stage(driver: Partial<Ledger["driver"]> = {}): Stage {
  const forge = fakeForge([], { login: "drive-bot" });
  const leaf = scopedStateDir(forge.stateDir, forge.repo);
  const actor = `wt-${worktreePathKey(forge.repo)}`;
  const started = new Date(Date.now() - 1000).toISOString();
  const ledger = ledgerFromState(
    { ...freshState(999), rounds: 2 },
    {
      generation: 3,
      driver: {
        actor,
        clone: cloneId(leaf),
        heartbeat: new Date().toISOString(),
        state: "stopped",
        recoveryVersion: 1,
        started,
        position: 0,
        ...driver,
      },
      narrative: [],
      claims: [],
    },
  );
  writeFileSync(
    join(forge.dir, "comments.json"),
    JSON.stringify([forgeComment(40, ledgerBody(ledger))]),
  );
  return { forge, leaf, actor, started };
}

async function drives(
  s: Stage,
  args: string[],
  env: Record<string, string> = {},
) {
  const proc = Bun.spawn(scriptArgv(join(SCRIPTS, "drives.ts"), ...args), {
    cwd: s.forge.repo,
    env: {
      ...s.forge.env,
      DRIVE_PR_STATE_DIR: s.leaf,
      DRIVE_PR_STOP_GRACE_SEC: "1",
      ...env,
    },
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

function driverOf(s: Stage): Ledger["driver"] | null {
  const parsed = parseLedger(s.forge.comments()[0]?.body ?? "");
  return parsed?.kind === "ledger" ? parsed.ledger.driver : null;
}

async function plantRecord(s: Stage): Promise<void> {
  const child = Bun.spawn(["sh", "-c", ":"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  writeDriverRecord(s.leaf, "999", {
    worktree: s.forge.repo,
    started: s.started,
    pid: child.pid,
    host: hostname(),
    released: true,
  });
}

describe("recovering a stopped ledger's pending state-label projection", () => {
  async function labelsFor(s: Stage) {
    const forgeGh = Bun.which("gh", { PATH: s.forge.env.PATH ?? "" });
    if (forgeGh === null) throw new Error("the fake forge's gh is not on PATH");
    const labels = labelForge(s.forge.dir, forgeGh, ["jig:converged"], "");
    const env = { PATH: `${labels.bin}${delimiter}${s.forge.env.PATH ?? ""}` };
    await plantRecord(s);
    recordPendingExit(s.leaf, "999", s.started, 8);
    return { labels, env };
  }

  async function expectRecoveryToRemainPending(
    s: Stage,
    prepare: (labels: ReturnType<typeof labelForge>) => void,
  ) {
    const { labels, env } = await labelsFor(s);
    prepare(labels);
    expectSpawnExit(await drives(s, ["--doctor"], env), 0);
    expect(driverRecordRow(s.leaf, "999")?.released).toBe(1);
    expect(labels.labels()).toEqual(["jig:converged"]);
    return { labels, env };
  }

  it("retries the recorded CI exit against the same acquired stopped ledger", async () => {
    const s = stage({ exit: 0 });
    const { env } = await expectRecoveryToRemainPending(s, () =>
      writeFileSync(join(s.forge.dir, "fail-patch"), ""),
    );
    expect(driverOf(s)).toMatchObject({ state: "stopped", exit: 0 });
    rmSync(join(s.forge.dir, "fail-patch"));
    expectSpawnExit(await drives(s, ["--doctor"], env), 0);
    expect(driverOf(s)).toMatchObject({ state: "stopped", exit: 8 });
    expect(driverRecordRow(s.leaf, "999")).toBeNull();
  });

  it("keeps a pending ordinary stop for a refused state-label projection", async () => {
    const s = stage({ exit: 0 });
    const { labels, env } = await expectRecoveryToRemainPending(
      s,
      (labelState) => writeFileSync(join(labelState.bin, "edit-refused"), ""),
    );
    rmSync(join(labels.bin, "edit-refused"));
    expectSpawnExit(await drives(s, ["--doctor"], env), 0);
    expect(driverOf(s)).toMatchObject({ state: "stopped", exit: 8 });
    expect(labels.labels()).toEqual(["jig:parked"]);
  });

  it("keeps a pending ordinary stop when its state-label configuration is unreadable", async () => {
    const s = stage({ exit: 0 });
    const { labels, env } = await expectRecoveryToRemainPending(
      s,
      (labelState) =>
        writeFileSync(join(labelState.bin, "jig.yaml"), ": invalid"),
    );
    writeFileSync(
      join(labels.bin, "jig.yaml"),
      "dispatch:\n  labels:\n    enabled: true\n",
    );
    expectSpawnExit(await drives(s, ["--doctor"], env), 0);
    expect(driverOf(s)).toMatchObject({ state: "stopped", exit: 8 });
    expect(labels.labels()).toEqual(["jig:parked"]);
  });

  for (const [name, marker] of [
    [
      "when the label ownership recheck is unreadable",
      "fail-ownership-recheck",
    ],
    ["when its label projection is unavailable", "malformed-label-read"],
  ] as const) {
    it(`keeps a pending ordinary stop ${name}`, async () => {
      const s = stage({ exit: 0 });
      await expectRecoveryToRemainPending(s, (labels) =>
        writeFileSync(join(labels.bin, marker), ""),
      );
    });
  }
});
