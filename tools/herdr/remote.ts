/**
 * Run the workspace tool on the host that holds the Herdr server and the
 * clones, over SSH.
 *
 * The tool runs where Herdr and git are: its checks of the clone and of the
 * agent must happen on the machine that has them. It is bundled into one
 * script and handed to `bun run -` on the host's standard input, so the host
 * needs `bun`, `git` and `herdr` on the `PATH` of a non-interactive SSH
 * session and nothing from Jig: no checkout to install or keep current, and
 * no version on the host that can drift from the caller's.
 */
import { join } from "node:path";
import { HerdrError } from "./runner.ts";

const ENTRY = join(import.meta.dir, "workspace.ts");

/**
 * The longest a `--host` command may run: a create or remove hook (up to 15
 * minutes), the agent's start and the kickoff all fit in it.
 */
export const REMOTE_TIMEOUT_MS = 30 * 60_000;

/** Options every SSH call takes: no prompt for a password, and a bounded connect. */
export const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];

/** Refuse a host SSH would read as an option. */
export function assertHost(host: string): void {
  if (host === "" || host.startsWith("-") || /\s/.test(host))
    throw new HerdrError(`"${host}" is not an SSH destination`);
}

/** Quote one argument for the remote shell, which SSH hands the command to. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg)
    ? arg
    : `'${arg.replaceAll("'", `'"'"'`)}'`;
}

/** The workspace tool as one self-contained script. */
export async function bundleTool(): Promise<string> {
  const built = await Bun.build({ entrypoints: [ENTRY], target: "bun" });
  const [output] = built.outputs;
  if (!built.success || output === undefined)
    throw new HerdrError(
      `could not bundle the workspace tool: ${built.logs.map(String).join("; ")}`,
    );
  return output.text();
}

export interface Completed {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run an SSH command with `input` on its standard input. `signal` is the
 * session's deadline, and required: `ConnectTimeout` bounds only the
 * connection, not a session whose transport or remote process stalls. A
 * stopped SSH ends the session, and the tool on the host bounds each of its
 * own steps.
 */
export async function ssh(
  host: string,
  command: string,
  input: string,
  signal: AbortSignal,
  onStderr?: (chunk: string) => void,
): Promise<Completed> {
  assertHost(host);
  const proc = Bun.spawn(["ssh", ...SSH_OPTIONS, host, command], {
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  const decoder = new TextDecoder();
  let stderr = "";
  const readErr = (async () => {
    for await (const chunk of proc.stderr) {
      const text = decoder.decode(chunk, { stream: true });
      stderr += text;
      onStderr?.(text);
    }
  })();
  const [status, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    readErr,
  ]);
  if (signal.aborted)
    throw new HerdrError(`ssh ${host} did not finish before the deadline`);
  return { status, stdout, stderr };
}

/** Run the workspace tool on the host with these arguments. */
export async function runToolOnHost(
  host: string,
  args: string[],
  signal: AbortSignal,
  onStderr?: (chunk: string) => void,
): Promise<Completed> {
  const script = await bundleTool();
  return ssh(
    host,
    ["bun", "run", "-", ...args].map(shellQuote).join(" "),
    script,
    signal,
    onStderr,
  );
}
