/** Apply-only reconciliation of silent local acquisitions whose pass termination is witnessed or observed. */
import { resolve } from "node:path";
import {
  helperTimeoutSeconds,
  run,
  tsArgv,
} from "../../skills/drive-pr/scripts/lib/proc.ts";
import { adoptionOf } from "./adopt.ts";
import { readDrives } from "./sources/ledgers.ts";
import type { TickContext } from "./tick-context.ts";
import type { RepoObservation } from "./tick-observe.ts";

/** A report never writes a drive ledger; recovery runs only for the machine's owned, scoped, unheld PRs. */
export async function recoverLedgers(
  context: TickContext,
  observation: RepoObservation,
): Promise<void> {
  const { opened, forge, ctx, held } = observation;
  if (
    context.apply === null ||
    !opened.listed ||
    !opened.stages.has("rearm") ||
    !ctx.owner ||
    !forge.ok
  )
    return;
  for (let i = 0; i < forge.drives.length; i++) {
    const drive = forge.drives[i];
    if (
      drive === undefined ||
      drive.class !== "silent" ||
      held.has(drive.number) ||
      forge.disputed.has(drive.number) ||
      (forge.scoped && !forge.inScope.has(drive.number))
    )
      continue;
    const result = await run(
      tsArgv(
        resolve(
          import.meta.dir,
          "../../skills/drive-pr/scripts/recover-ledger.ts",
        ),
        [String(drive.number)],
      ),
      {
        cwd: opened.repo.path,
        stdout: "ignore",
        stderr: "inherit",
        timeoutSec: helperTimeoutSeconds(),
      },
    );
    context.reads.comments.forget(opened.repo.slug, drive.number);
    if (result.code !== 0) {
      opened.report.unplaced.push({
        target: `PR #${drive.number}`,
        record: "forge",
        reason: `local ledger recovery exited ${result.code}; its original classification is retained`,
      });
      continue;
    }
    const pr = forge.open.find((p) => p.number === drive.number);
    if (pr === undefined) continue;
    const [fresh] = await readDrives(
      opened.repo.slug,
      forge.login,
      [pr],
      context.nowMs,
      observation.labels,
      adoptionOf(opened.section, forge.login),
    );
    if (fresh !== undefined) forge.drives[i] = fresh;
  }
}
