/** Reuse the drive's proof that a later bot post adds no new finding. */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fail, failFrom } from "../../../../shared/cli.ts";
import { siblingSkill } from "../../../../shared/consumer.ts";
import { isRecord } from "../../../../shared/guards.ts";

export interface ResolutionComment {
  author: string;
  at: number;
  body: string | null;
}
export type TransparentResolutionFollowUp = (
  comment: ResolutionComment,
) => boolean;

/** An absent drive stays strict; a present but broken integration is an error. */
export async function resolutionFollowUp(): Promise<TransparentResolutionFollowUp> {
  const drive = siblingSkill("drive-pr", join(import.meta.dirname, ".."));
  try {
    lstatSync(drive);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return () => false;
    failFrom(error, 1, "resolve-thread: cannot inspect drive follow-up proof");
  }
  try {
    const [confirmation, outcome] = await Promise.all([
      import(
        pathToFileURL(join(drive, "scripts/lib/bot-confirmation.ts")).href
      ),
      import(pathToFileURL(join(drive, "scripts/lib/outcome.ts")).href),
    ]);
    if (
      typeof confirmation.isTransparentFollowUp !== "function" ||
      typeof outcome.qualifyingOutcome !== "function"
    ) {
      fail(
        1,
        "resolve-thread: drive follow-up proof does not export its predicates",
      );
    }
    return (comment) =>
      confirmation.isTransparentFollowUp(
        { authorLogin: comment.author, body: comment.body },
        outcome.qualifyingOutcome,
      );
  } catch (error) {
    failFrom(
      error,
      1,
      "resolve-thread: cannot load drive follow-up proof; refusing resolution",
    );
  }
}
