/**
 * Compatibility surface for the existing mutation corpus. Helper tests use
 * the proven parser directly; every runCheck mutation runs Chapter.check,
 * including its process boundary, rather than bypassing the chapter gate.
 */
import { resolve } from "node:path";
import { checkDriveExitChapter } from "../../../../tools/protocol/drive-exit-gate.ts";

export async function runChapterCheck(): Promise<number> {
  return checkDriveExitChapter(resolve(import.meta.dir, "../../../..")).length
    ? 1
    : 0;
}
