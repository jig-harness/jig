/** A status read never repairs a released driver's forge ledger. */
import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { closeDatabase } from "../../../shared/records/db.ts";
import { Defect } from "../../../shared/errors.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";
import { writeState } from "./state-rows.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import { dbPathFor } from "../scripts/lib/state/db.ts";
import { writeDriverRecord } from "../scripts/lib/ledger-stop.ts";
import { ledgerFromState, renderLedger } from "../scripts/lib/state/ledger.ts";
import { cloneId } from "../scripts/lib/state/ledger-mirror.ts";
import { worktreePathKey } from "../scripts/lib/state/actor.ts";
import { thisHost } from "../../../shared/liveness.ts";
import { gitIdentityEnv } from "../scripts/lib/proc.ts";

it("read-only doctor leaves a released record and running ledger untouched without attempting settlement", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-hold-read-only-"));
  try {
    const dir = scopedStateDir(root);
    const state = freshState(123);
    writeState(dir, "123", state);
    const started = "2026-11-06T12:00:00.000Z";
    writeDriverRecord(dir, "123", {
      worktree: process.cwd(),
      started,
      pid: 999999999,
      host: thisHost().host,
      released: true,
    });
    const ledger = ledgerFromState(state, {
      generation: 1,
      claims: [],
      narrative: [],
      driver: {
        actor: `wt-${worktreePathKey(process.cwd())}`,
        clone: cloneId(dir),
        heartbeat: started,
        state: "running",
        started,
      },
    });
    const rendered = renderLedger(ledger);
    if (!("body" in rendered)) throw new Defect(rendered.error);
    const fixture = join(root, "ledger.json");
    writeFileSync(
      fixture,
      JSON.stringify([
        [
          {
            id: 1,
            body: rendered.body,
            user: { login: "operator" },
            author_association: "OWNER",
            updated_at: started,
          },
        ],
      ]),
    );
    const calls = join(root, "calls.jsonl");
    writeFakeProgram(
      join(root, "gh"),
      `#!/usr/bin/env bun\nimport {appendFileSync, readFileSync} from 'node:fs';\nconst args=process.argv.slice(2); appendFileSync(process.env.CI_HOLD_CALLS, JSON.stringify(args)+'\\n');\nif(args.includes('user')) console.log('operator'); else if(args.some(a=>a.includes('/comments'))) console.log(readFileSync(process.env.CI_HOLD_FIXTURE,'utf8')); else process.exit(1);\n`,
    );
    closeDatabase(dbPathFor(dir));
    const before = readFileSync(dbPathFor(dir));
    const child = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "../scripts/drives-read-only.ts"),
        "--json",
      ],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10000,
        env: {
          ...gitIdentityEnv(),
          DRIVE_PR_STATE_DIR: dir,
          DRIVE_PR_LEDGER: "on",
          PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
          CI_HOLD_CALLS: calls,
          CI_HOLD_FIXTURE: fixture,
        },
      },
    );
    expectSpawnExit(child, 0);
    expect(child.stderr.toString()).not.toContain("stop was not recorded");
    expect(existsSync(calls)).toBe(false);
    expect(readFileSync(dbPathFor(dir))).toEqual(before);
    const db = new Database(dbPathFor(dir), { readonly: true });
    try {
      expect(
        db.query("SELECT released FROM driver_records WHERE pr = '123'").get(),
      ).toEqual({ released: 1 });
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
