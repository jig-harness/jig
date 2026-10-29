/** Repository labels for a listing of one clone's state, without network calls. */
import { consumerRoot, readRemoteName } from "../../../../shared/consumer.ts";
import { git, gitCallTimeoutSeconds, gitIdentityEnv } from "./proc.ts";
import { resolveLegacyStateDir } from "./state/store.ts";

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** The path part of a remote URL, scp-like form or local path. */
function remotePath(url: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
    return URL.parse(url)?.pathname ?? "";
  }
  const scp = /^(?:[^/@:]+@)?[^/:]+:(.*)$/.exec(url);
  return (scp?.[1] ?? url).replace(/[?#].*$/s, "");
}

/**
 * `owner/name` from a remote URL, or `""` when no label is certain to be free
 * of credentials. A URL is parsed whole, so userinfo, query and fragment never
 * reach the label, and a segment holding anything beyond plain name
 * characters is refused rather than printed.
 */
export function repositoryLabel(url: string): string {
  const segments = remotePath(url)
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/");
  if (segments.length < 2) return "";
  const label = segments.slice(-2);
  return label.every((s) => SAFE_SEGMENT.test(s) && s !== "." && s !== "..")
    ? label.join("/")
    : "";
}

export async function driveRepository(): Promise<string> {
  const cwd = process.env.DRIVE_PR_WORKTREE || process.cwd();
  // The label is decoration on a listing whose rows are the recovery
  // information: a configuration that cannot be read (a broken or conflicted
  // file, an unusable remote setting) falls back like a missing remote.
  const read = readRemoteName(consumerRoot(cwd));
  const result =
    "remote" in read
      ? await git(["remote", "get-url", read.remote], {
          cwd,
          timeoutSec: gitCallTimeoutSeconds(),
          env: gitIdentityEnv(),
        })
      : null;
  // Local-only clones and remotes without a safe label fall back to the Git
  // common directory. Never print a raw remote URL: it may carry credentials.
  return (
    (result?.code === 0 ? repositoryLabel(result.stdout.trim()) : "") ||
    (await resolveLegacyStateDir())
  );
}
