import { filedByLine } from "../../../../shared/issue-provenance.ts";
import { JigError } from "../../../../shared/outcome.ts";
import { TrackerRequestError } from "../../../do-item/scripts/lib/tracker/port.ts";
import { deferInPr, type DeferInPrArgs } from "../defer-in-pr.ts";
import type { PrBodyForge } from "./pr-body.ts";

/** Preserve a decided finding when the tracker cannot provide a verified link. */
export async function fileDriveDeferral<T>(
  forge: PrBodyForge,
  args: DeferInPrArgs,
  file: (filedBy: string) => Promise<T>,
): Promise<T | { link: string; added: boolean; why: string }> {
  const pr = new URL(args.source);
  pr.hash = "";
  try {
    return await file(filedByLine("drive-pr", pr.href, args.reason));
  } catch (error) {
    if (!(error instanceof JigError || error instanceof TrackerRequestError))
      throw error;
    const why = error.message;
    try {
      // The source may have named a fork through --repo-slug, while the
      // body forge addresses the checkout's repository.
      if ((await forge.read(args.pr)).url !== pr.href)
        throw new JigError(
          "deferral",
          "The checkout's pull request differs from the finding's source",
        );
      return { ...(await deferInPr(forge, args)), why };
    } catch (fallback) {
      throw new JigError(
        "deferral",
        `Tracker filing failed: ${why}. Deferred section failed: ${fallback instanceof Error ? fallback.message : String(fallback)}`,
        {
          cause: new AggregateError(
            [error, fallback],
            "Both deferral destinations failed",
          ),
        },
      );
    }
  }
}
