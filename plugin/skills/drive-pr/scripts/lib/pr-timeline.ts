/** The pull request timeline, the server's record of its label transitions. */
import {
  attempt,
  failed,
  ok,
  type Outcome,
} from "../../../../shared/outcome.ts";
import { ghCall } from "./proc.ts";

/** Every timeline event, preserving why the forge or its response could not be read. */
export async function readTimeline(
  pr: string,
): Promise<Outcome<unknown[], "unreadable">> {
  const result = await ghCall([
    "api",
    "--paginate",
    "--slurp",
    `repos/{owner}/{repo}/issues/${pr}/timeline?per_page=100`,
  ]);
  if (result.code !== 0)
    return failed(
      "unreadable",
      `PR #${pr} timeline: gh api exited ${result.code}: ${result.stderrTail || result.stderr.trim().slice(-500)}`,
    );
  const decoded = attempt(
    "unreadable",
    `PR #${pr} timeline JSON could not be decoded`,
    (): unknown => JSON.parse(result.stdout),
  );
  if (!decoded.ok) return decoded;
  return Array.isArray(decoded.value)
    ? ok(decoded.value.flat())
    : failed(
        "unreadable",
        `PR #${pr} timeline response is not a list of pages`,
      );
}

/** Every event on the PR's timeline, or `null` when it cannot be read. */
export async function timelineEvents(pr: string): Promise<unknown[] | null> {
  const result = await readTimeline(pr);
  return result.ok ? result.value : null;
}
