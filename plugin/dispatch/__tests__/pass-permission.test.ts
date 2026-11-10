/**
 * dispatch --apply: the permission mode of a Claude Code pass the dispatcher
 * starts. The launch adds nothing of its own, so the real `drive.ts` under the
 * wrapper resolves `drive.pass_args` across the layers: a host opts in through
 * its user layer, at the default path under the child's own `HOME`.
 *
 * A terminal can run with an independent environment, proving the opener's
 * configuration selectors survive the hop to the real drive.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  ledgerComment,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import {
  account,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
`;
const HEAD = "feature/7-answered";

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/**
 * One tick that re-arms PR #7 through the wrapper into the real `drive.ts`,
 * whose user layer is `~/.jig/jig.yaml` under the child's `HOME` and holds
 * `userLayer` (no file when absent); what the drive printed.
 */
async function drivePrinted(
  userLayer?: string,
  cleanTerminal = false,
): Promise<string> {
  const w = world();
  current = w;
  // Only the home directory places the user layer, and no other layer speaks.
  delete w.env.JIG_HOME;
  delete w.env.JIG_USER_LAYER;
  delete w.env.JIG_OVERLAY;
  delete w.env.JIG_DISPATCH_DRIVE_SCRIPT;
  w.setConfig(CONFIG);
  w.setPrs("open", [openPr(7, HEAD)]);
  w.setComments(7, [ledgerComment(701, stoppedLedger(7, 4))]);
  // A real clone: the drive's state directory needs one.
  w.setWorkspaces([{ branch: HEAD, linkedPR: 7, path: w.repo }]);
  machineFile(w, [account(w, "a", "a@example.com")]);
  if (userLayer !== undefined)
    writeFileSync(join(w.home, ".jig", "jig.yaml"), userLayer);

  if (cleanTerminal) {
    // The terminal has its own environment, without any tick configuration.
    const terminalEnv = Object.fromEntries(
      Object.entries(w.env).filter(
        ([key]) =>
          !key.startsWith("JIG__") &&
          !["JIG_HOME", "JIG_OVERLAY", "JIG_USER_LAYER"].includes(key),
      ),
    );
    writeFileSync(
      join(w.dir, "orca-terminal-env.json"),
      JSON.stringify(terminalEnv),
    );
    writeFileSync(join(w.dir, "orca-terminal-cwd"), w.home);
    // The opener uses a relative custom home; its terminal starts elsewhere.
    w.env.JIG_HOME = "custom-jig-home";
    mkdirSync(join(w.repo, w.env.JIG_HOME), { recursive: true });
    writeFileSync(join(w.repo, w.env.JIG_HOME, "jig.yaml"), userLayer ?? "");
    writeFileSync(
      join(w.repo, w.env.JIG_HOME, "dispatch.yaml"),
      readFileSync(join(w.home, ".jig", "dispatch.yaml")),
    );
    writeFileSync(
      join(w.home, ".jig", "jig.yaml"),
      "drive:\n  pass_args: [--permission-mode, default]\n",
    );
  }

  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  const receipt = JSON.parse(r.stdout) as TickReceipt;
  const record = receipt.repos[0]?.launches[0]?.record ?? "";
  expect(record).not.toBe("");
  await waitFor("the exit", () => exitWritten(w, record), 60_000);
  return readFileSync(join(w.dir, "terminal.log"), "utf8");
}

describe("a Claude Code pass the dispatcher starts", () => {
  it("carries a relative custom JIG_HOME through a terminal with its own environment", async () => {
    const printed = await drivePrinted(
      "drive:\n  pass_args: [--permission-mode, bypassPermissions]\n",
      true,
    );
    expect(printed).toContain(
      "pass args: --permission-mode bypassPermissions (drive.pass_args)",
    );
  }, 90_000);

  it("runs in the mode a host's user layer names", async () => {
    const printed = await drivePrinted(
      "drive:\n  pass_args: [--permission-mode, bypassPermissions]\n",
    );
    expect(printed).toContain(
      "pass args: --permission-mode bypassPermissions (drive.pass_args)",
    );
    expect(printed).toContain(
      "permission mode: bypassPermissions (the pass command's --permission-mode)",
    );
  }, 90_000);

  it("has no words added and inherits its mode where no layer names one", async () => {
    const printed = await drivePrinted();
    expect(printed).toContain(
      "pass args: none (the default; drive.pass_args is not set)",
    );
    expect(printed).toContain(
      "permission mode: inherited (the pass command sets no --permission-mode; Claude Code's settings decide)",
    );
  }, 90_000);
});
