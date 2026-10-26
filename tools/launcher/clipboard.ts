/**
 * Put text on this machine's clipboard, for a launch that hands the agent's
 * start to a person: they open the agent in the workspace app with the agent,
 * model and effort they choose, and paste the first prompt.
 *
 * The launcher runs where the tracker's desktop app runs, so this is the
 * person's own clipboard. Each platform's command is tried in turn (macOS
 * `pbcopy`; Linux `wl-copy`, then `xclip`, then `xsel`; Windows `clip`), and
 * a machine with none of them gets null: the caller prints the text instead.
 */

import { swallow } from "../../plugin/shared/errors.ts";

/** How long one clipboard command may take. */
const COPY_TIMEOUT_MS = 5_000;

/** The commands that write stdin to the clipboard, in the order they are tried. */
export function clipboardCommands(platform: NodeJS.Platform): string[][] {
  if (platform === "darwin") return [["pbcopy"]];
  if (platform === "win32") return [["clip"]];
  return [
    ["wl-copy"],
    ["xclip", "-selection", "clipboard"],
    ["xsel", "--clipboard", "--input"],
  ];
}

/** Runs `argv` with `text` on stdin, ended when `signal` aborts; true when it exited 0. The seam tests replace. */
export type CopyRunner = (
  argv: string[],
  text: string,
  signal: AbortSignal,
) => Promise<boolean>;

const runCopy: CopyRunner = async (argv, text, signal) => {
  try {
    const proc = Bun.spawn(argv, {
      stdin: new Blob([text]),
      stdout: "ignore",
      stderr: "pipe",
      signal: AbortSignal.any([signal, AbortSignal.timeout(COPY_TIMEOUT_MS)]),
    });
    // A command that refuses (no display for xclip, say) says why on stderr;
    // read it so the pipe drains, and let the next command be tried.
    const [status] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    return status === 0;
  } catch (error) {
    swallow(error, `${argv[0]} is not installed: the next command is tried`);
    return false;
  }
};

/**
 * Copy `text`; the command that took it, or null when none could. Once
 * `signal` aborts, no further command is tried and the running one is ended,
 * so a cancelled launch leaves the clipboard alone.
 */
export async function copyToClipboard(
  text: string,
  signal: AbortSignal,
  platform: NodeJS.Platform = process.platform,
  run: CopyRunner = runCopy,
): Promise<string | null> {
  for (const argv of clipboardCommands(platform)) {
    if (signal.aborted) return null;
    if (await run(argv, text, signal)) return argv[0] ?? null;
  }
  return null;
}
