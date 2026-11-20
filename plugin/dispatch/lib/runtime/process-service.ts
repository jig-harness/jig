/** Service-manager command construction. Job definitions carry no request payload. */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../../shared/proc.ts";
import { processRunDirectory } from "./process-spool.ts";

export function processJobName(id: string): string {
  return `jig-run-${id}`;
}

function xml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** launchd starts the one-shot job when it adopts this definition. */
export function launchdCommand(id: string, argv: string[]): string[] {
  const dir = processRunDirectory(id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const plist = join(dir, "run.plist");
  const args = argv.map((arg) => `<string>${xml(arg)}</string>`).join("");
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${processJobName(id)}</string>
<key>ProgramArguments</key><array>${args}</array>
<key>RunAtLoad</key><true/>
</dict></plist>
`,
    { mode: 0o600 },
  );
  return ["/bin/launchctl", "bootstrap", `gui/${process.getuid?.()}`, plist];
}

export async function retireProcessJob(
  id: string,
  timeoutSec: number,
): Promise<string | null> {
  const name = processJobName(id);
  if (process.platform !== "darwin") return null;
  const job = `gui/${process.getuid?.()}/${name}`;
  const removed = await run(["/bin/launchctl", "bootout", job], { timeoutSec });
  if (removed.code !== 0 && !/could not find service/i.test(removed.stderr))
    return "the completed launchd job could not be removed";
  rmSync(join(processRunDirectory(id), "run.plist"), { force: true });
  return null;
}
