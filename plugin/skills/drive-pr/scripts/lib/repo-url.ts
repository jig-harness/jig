import { JigError } from "../../../../shared/errors.ts";
import { existsSync } from "node:fs";
import { gitCallTimeoutSeconds, run } from "./proc.ts";

type SshResolver = (
  args: string[],
  options: {
    timeoutSec: number;
    env?: Record<string, string | undefined>;
    cwd?: string;
  },
) => Promise<{ code: number; stdout: string; stderr?: string }>;

/** The same forge selection gh accepts, including an explicit GH_REPO host. */
function forgeHost(env: Record<string, string | undefined>): string {
  const repo = env.GH_REPO ?? "";
  if (repo.startsWith("https://")) {
    if (!URL.canParse(repo)) return "";
    return new URL(repo).hostname.toLowerCase();
  }
  if (repo.split("/").length === 3)
    return (repo.split("/")[0] ?? "").toLowerCase();
  return (env.GH_HOST || "github.com").toLowerCase();
}

interface RemoteTransport {
  host: string;
  path: string;
  ssh: boolean;
  port: string;
  user: string;
}

function parseScpRemote(url: string): RemoteTransport | null {
  const match =
    /^(?:([a-zA-Z0-9_.-]+)@)?([a-zA-Z0-9][a-zA-Z0-9.-]*):([^/].*)$/.exec(url);
  if (!match) return null;
  return {
    user: match[1] ?? "",
    host: match[2] ?? "",
    path: match[3] ?? "",
    ssh: true,
    port: "",
  };
}

function parseRemote(url: string): RemoteTransport | null {
  if (!url.includes("://")) return parseScpRemote(url);
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (
    !["https:", "ssh:"].includes(parsed.protocol) ||
    parsed.search ||
    parsed.hash
  )
    return null;
  return {
    host: parsed.hostname,
    path: parsed.pathname.slice(1),
    ssh: parsed.protocol === "ssh:",
    port: parsed.port,
    user: parsed.username,
  };
}

function repositoryPath(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47) end -= 1;
  const withoutTrailingSlashes = path.slice(0, end);
  return withoutTrailingSlashes.endsWith(".git")
    ? withoutTrailingSlashes.slice(0, -4)
    : withoutTrailingSlashes;
}

function existingCwd(cwd: string | undefined): { cwd: string } | object {
  return cwd !== undefined && existsSync(cwd) ? { cwd } : {};
}

async function resolvedSshHost(
  remote: RemoteTransport,
  env: Record<string, string | undefined>,
  resolveSsh: SshResolver,
  cwd?: string,
  resolveConfig: SshResolver = run,
): Promise<string> {
  const { host, port, user } = remote;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)) return "";
  // `ssh -G` below must model the command Git will use for its push.  This
  // resolver intentionally supports the ordinary OpenSSH configuration, but
  // cannot safely interpret an arbitrary replacement command or its options.
  // Refusing those overrides is safer than certifying a destination Git could
  // resolve differently.
  const override =
    env.GIT_SSH_COMMAND || env.GIT_SSH ? "GIT_SSH_COMMAND or GIT_SSH" : "";
  if (override) {
    throw new JigError(
      "SSH_TRANSPORT_OVERRIDE",
      `Cannot verify SSH host ${host}: ${override} overrides Git's SSH transport.`,
    );
  }
  const configured = await resolveConfig(
    ["git", "config", "--get", "core.sshCommand"],
    {
      timeoutSec: gitCallTimeoutSeconds(),
      env,
      // The repository root is supplied by production callers. Test seams use
      // synthetic roots, so preserve the previous ambient read for a path that
      // does not exist rather than turning a mocked URL check into a spawn error.
      ...existingCwd(cwd),
    },
  );
  if (configured.code === 0 && configured.stdout.trim() !== "") {
    throw new JigError(
      "SSH_TRANSPORT_OVERRIDE",
      `Cannot verify SSH host ${host}: core.sshCommand overrides Git's SSH transport.`,
    );
  }
  if (configured.code !== 0 && configured.code !== 1) {
    throw new JigError(
      "SSH_TRANSPORT_UNREADABLE",
      `Cannot verify SSH host ${host}: git config --get core.sshCommand exited ${configured.code}: ${configured.stderr?.trim() || "no diagnostic output"}`,
    );
  }
  const result = await resolveSsh(
    [
      "ssh",
      "-G",
      ...(port ? ["-p", port] : []),
      "--",
      `${user ? `${user}@` : ""}${host}`,
    ],
    { timeoutSec: gitCallTimeoutSeconds(), env },
  );
  if (result.code !== 0) {
    throw new JigError(
      "REMOTE_HOST_UNRESOLVED",
      `Cannot resolve SSH host ${host}: ssh -G exited ${result.code}: ${result.stderr?.trim() || "no diagnostic output"}`,
      { cause: result },
    );
  }
  const hosts = result.stdout
    .split(/\r?\n/)
    .filter((line) => /^hostname\s/i.test(line));
  if (hosts.length !== 1) return "";
  return hosts[0]?.trim().split(/\s+/)[1] ?? "";
}

/**
 * Name a remote only after its transport and host resolve to the forge gh
 * reads. Local paths and unsupported schemes remain unresolved. SSH config
 * aliases resolve locally with a bounded `ssh -G`; no connection is made.
 */
export async function repoOfUrl(
  url: string,
  env: Record<string, string | undefined> = process.env,
  resolveSsh: SshResolver = run,
  forgeUrl?: string,
  cwd?: string,
  resolveConfig?: SshResolver,
): Promise<string> {
  const remote = parseRemote(url);
  if (!remote) return "";
  const repo = repositoryPath(remote.path);
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) return "";
  const allowedHost =
    forgeUrl && URL.canParse(forgeUrl)
      ? new URL(forgeUrl).hostname.toLowerCase()
      : forgeHost(env);
  if (!allowedHost) return "";
  const host = remote.ssh
    ? await resolvedSshHost(remote, env, resolveSsh, cwd, resolveConfig)
    : remote.host;
  return host.toLowerCase() === allowedHost ? repo : "";
}
