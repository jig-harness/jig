/** The staging the drive ledger's stop tests share: a forge holding a running drive's ledger, its lock, and `drives.ts` run against them. */
import { writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import { skipsOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";
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
import { putLock } from "./state-rows.ts";

export interface Stage {
  forge: FakeForge;
  leaf: string;
  actor: string;
  started: string;
}

export function stage(
  driver: Partial<Ledger["driver"]> = {},
  extra: unknown[] = [],
  parked: Ledger["parked"] = [],
): Stage {
  const forge = fakeForge([], { login: "drive-bot" });
  const leaf = scopedStateDir(forge.stateDir, forge.repo);
  const actor = `wt-${worktreePathKey(forge.repo)}`;
  const started = new Date(Date.now() - 1000).toISOString();
  const ledger = ledgerFromState(
    { ...freshState(999), rounds: 2, parked },
    {
      generation: 3,
      driver: {
        actor,
        clone: cloneId(leaf),
        heartbeat: new Date().toISOString(),
        state: "running",
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
    JSON.stringify([forgeComment(40, ledgerBody(ledger)), ...extra]),
  );
  return { forge, leaf, actor, started };
}

export function plantLock(s: Stage, pid: number, diagnosticPr = "999"): void {
  putLock(s.leaf, "pr-drive-999", {
    token: "feedc0de",
    pid,
    host: hostname(),
    diag: {
      pr: diagnosticPr,
      worktree: s.forge.repo,
      log: join(s.leaf, "drive-pr-999.log"),
      started: s.started,
      account: {
        account: null,
        vendor: null,
        provenance: "none",
        reason: "test",
      },
    },
  });
}

export async function drives(
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

export function ledgerOf(s: Stage): Ledger | null {
  const parsed = parseLedger(s.forge.comments()[0]?.body ?? "");
  return parsed?.kind === "ledger" ? parsed.ledger : null;
}

export function driverOf(s: Stage): Ledger["driver"] | null {
  return ledgerOf(s)?.driver ?? null;
}

export async function deadPid(): Promise<number> {
  const child = Bun.spawn(["sh", "-c", ":"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  return child.pid;
}

export const posixStop = skipsOnWindows(
  "process-lifecycle",
  "the stand-in driver is stopped through the POSIX process table",
);
