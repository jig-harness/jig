// The addresses a hosting service gives a repository's pull requests,
// commits, tags and comparisons, from the address of the `origin` remote.

export interface HostLinks {
  /** The repository's web address, such as `https://github.com/owner/repo`. */
  web: string;
  commit: (hash: string) => string;
  pullRequest: (number: number) => string;
  /** What changed between two tags. */
  compare: (from: string, to: string) => string;
  tag: (tag: string) => string;
}

/** The host and path of a remote's address, credentials dropped; null for one it cannot read. */
export function parseRemote(
  address: string,
): { host: string; path: string } | null {
  const trimmed = address.trim();
  const url =
    /^(?:https?|ssh|git):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/*$/i.exec(
      trimmed,
    );
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+?)(?:\.git)?\/*$/.exec(
    trimmed,
  );
  const found = url ?? scp;
  return found?.[1] && found[2]
    ? { host: found[1].toLowerCase(), path: found[2] }
    : null;
}

/** How a host spells the paths of a repository's pages. */
interface Paths {
  commit: string;
  pullRequest: string;
  compare: string;
  tag: string;
}

const GITHUB: Paths = {
  commit: "commit",
  pullRequest: "pull",
  compare: "compare",
  tag: "releases/tag",
};

const GITLAB: Paths = {
  commit: "-/commit",
  pullRequest: "-/merge_requests",
  compare: "-/compare",
  tag: "-/tags",
};

/**
 * The links for a repository on GitHub or GitLab (including their
 * self-hosted forms, named by `github` or `gitlab` in the host); null for any
 * other host, whose paths Jig does not know.
 */
export function hostLinks(address: string): HostLinks | null {
  const remote = parseRemote(address);
  if (!remote) return null;
  const web = `https://${remote.host}/${remote.path}`;
  const paths = /(^|\.)github/.test(remote.host)
    ? GITHUB
    : /(^|\.)gitlab/.test(remote.host)
      ? GITLAB
      : null;
  if (!paths) return null;
  return {
    web,
    commit: (hash) => `${web}/${paths.commit}/${hash}`,
    pullRequest: (n) => `${web}/${paths.pullRequest}/${n}`,
    compare: (from, to) => `${web}/${paths.compare}/${from}...${to}`,
    tag: (tag) => `${web}/${paths.tag}/${tag}`,
  };
}
