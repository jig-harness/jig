/**
 * Copy the launcher's context cache to the machine the agent runs on.
 *
 * The prompt names the cache file, which the agent must be able to read; a
 * path on this machine would name nothing on a host. A provider that opens
 * the workspace on a host copies the file to the same path under the host
 * user's home first, whole and private, and names that copy in the prompt.
 */
import { relative } from "node:path";
import { HerdrError } from "../herdr/runner.ts";
import { shellQuote, ssh } from "../herdr/remote.ts";

/**
 * Write the cache file to the same path under the host user's home, whole
 * and private, and return where it went.
 */
export async function copyCacheOverSsh(
  host: string,
  file: string,
  signal: AbortSignal,
): Promise<string> {
  const home = process.env.HOME ?? "";
  const rel = relative(home, file);
  if (home === "" || rel.startsWith(".."))
    throw new HerdrError(`the cache file ${file} is not under ${home}`);
  const target = `"$HOME"/${shellQuote(rel)}`;
  const command = [
    "umask 077",
    `mkdir -p "$(dirname ${target})"`,
    `cat > ${target}.tmp.$$`,
    `mv ${target}.tmp.$$ ${target}`,
    `printf %s ${target}`,
  ].join(" && ");
  const content = await Bun.file(file).text();
  const done = await ssh(host, command, content, signal);
  if (done.status !== 0)
    throw new HerdrError(
      `could not copy ${file} to ${host}: ${done.stderr.trim()}`,
    );
  return done.stdout.trim();
}
