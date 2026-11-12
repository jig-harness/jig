import { readConfig } from "../../../../shared/consumer.ts";
import { linkLineKey } from "./linked-pr.ts";
import { trackerConfigFrom } from "./tracker/config.ts";
import {
  homeRepo,
  remoteUrl,
  repoFromRemote,
  slug,
} from "./tracker/github/refs.ts";

/**
 * The issue as the link line names it: qualified when the tracker is another
 * repository. A tracker repository the configuration names stays qualified
 * even when the code repository cannot be read, since a bare number would
 * then name the code repository's own issue.
 */
export function linkKeyFor(root: string, issue: string): string {
  try {
    const config = trackerConfigFrom(readConfig());
    if (config.adapter !== "github") return issue;
    const url = remoteUrl(root);
    const repo = url === null ? null : repoFromRemote(url);
    if (repo === null)
      return config.github.repository === null
        ? issue
        : linkLineKey(
            issue,
            slug(homeRepo(config.github.repository, () => url)),
            "",
          );
    const tracker = slug(homeRepo(config.github.repository, () => url));
    return linkLineKey(issue, tracker, slug(repo));
  } catch {
    return issue;
  }
}
