/** The pull request timeline, the server's record of its label transitions. */
import { ghCall } from "./proc.ts";

/** Every event on the PR's timeline, or `null` when it cannot be read. */
export async function timelineEvents(pr: string): Promise<unknown[] | null> {
  const result = await ghCall([
    "api",
    "--paginate",
    "--slurp",
    `repos/{owner}/{repo}/issues/${pr}/timeline?per_page=100`,
  ]);
  if (result.code !== 0) return null;
  try {
    const pages = JSON.parse(result.stdout) as unknown;
    return Array.isArray(pages) ? pages.flat() : null;
  } catch {
    return null;
  }
}
