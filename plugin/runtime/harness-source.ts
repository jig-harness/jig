/** Source addresses, pins and release channels for agent marketplaces. */
import { existsSync, statSync } from "node:fs";
/** The release channels, each a branch of the repository (plugin/README.md). */
export const CHANNELS = ["latest", "stable"] as const;
export type Channel = (typeof CHANNELS)[number];
export interface Registered {
  location: string;
  git: boolean;
}

/** Split `<base>#<ref>` into the address and the ref, if it names one. */
export function splitSource(source: string): { base: string; ref?: string } {
  const at = source.indexOf("#");
  return at < 0
    ? { base: source }
    : { base: source.slice(0, at), ref: source.slice(at + 1) };
}

/** Whether a source is a Git address rather than a directory. */
export function isGitAddress(source: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git@|git:\/\/)/.test(source);
}

/** A recorded Git source stays remote even when a same-named directory exists. */
export function isLocalSource(source: string, git?: boolean): boolean {
  return git !== true && existsSync(source) && statSync(source).isDirectory();
}

/**
 * What a registered source follows, in words: a channel, `main` (the source
 * address, which receives each version before its gates pass, with or
 * without `#main`), a version tag it is pinned to, another ref, or a
 * directory.
 */
export function describeSource(registered: Registered): string {
  const { ref } = splitSource(registered.location);
  if (!registered.git) return `the directory ${registered.location}`;
  if (followsMain(ref)) return "main, the source address";
  if ((CHANNELS as readonly string[]).includes(ref as string))
    return `the ${ref} channel`;
  if (/^v\d+\.\d+\.\d+$/.test(ref as string)) return `${ref}, pinned`;
  return `the ref ${ref}`;
}

/**
 * Whether a registered source receives new releases: a Git address at a
 * channel or at `main`. A version tag or another ref is a pin, and a
 * directory is a folder someone maintains by hand.
 */
export function followsReleases(registered: Registered): boolean {
  const { ref } = splitSource(registered.location);
  return (
    registered.git &&
    (followsMain(ref) || (CHANNELS as readonly string[]).includes(ref ?? ""))
  );
}

/** Whether a registered ref follows `main`: none, or `main` named outright. */
export function followsMain(ref: string | undefined): boolean {
  return ref === undefined || ref === "main" || ref === "refs/heads/main";
}

/**
 * Compare GitHub shorthand and HTTPS sources ignoring a trailing `.git` or slash. A requested `#ref` must
 * match the registered one; a request without a ref accepts any registered
 * ref, so an existing pin is kept unless the caller asks for another.
 */
export function sameSource(
  registered: string,
  requested: string,
  registeredGit?: boolean,
): boolean {
  const norm = (value: string, git?: boolean) => {
    const [base = "", ref] = value.split("#");
    let address = base;
    while (address.endsWith("/")) address = address.slice(0, -1);
    address = address.replace(/\.git$/, "");
    const canonical =
      /^[\w.-]+\/[\w.-]+$/.test(address) &&
      (git === true || (git !== false && !isLocalSource(value)))
        ? `https://github.com/${address}`
        : address;
    return { base: canonical, ref };
  };
  const a = norm(registered, registeredGit);
  const b = norm(requested);
  return a.base === b.base && (b.ref === undefined || a.ref === b.ref);
}
