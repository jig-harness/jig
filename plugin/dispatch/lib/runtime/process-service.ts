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

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

function powershell(script: string): string[] {
  return [
    join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(
      `$ErrorActionPreference = 'Stop'; ${script}`,
      "utf16le",
    ).toString("base64"),
  ];
}

export function windowsCommand(id: string, argv: string[]): string[] {
  const task = quote(processJobName(id));
  // Double the backslashes preceding a closing quote, as Windows argv
  // parsing would otherwise read that quote as part of the argument.
  const args = argv
    .slice(1)
    .map(
      (arg) => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, "$&$&")}"`,
    )
    .join(" ");
  return powershell(
    [
      `$action = New-ScheduledTaskAction -Execute ${quote(argv[0] as string)} -Argument ${quote(args)}`,
      "$who = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
      "$principal = New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Limited",
      `Register-ScheduledTask -TaskName ${task} -Action $action -Principal $principal | Out-Null`,
      `try { Start-ScheduledTask -TaskName ${task} } catch { Unregister-ScheduledTask -TaskName ${task} -Confirm:$false; throw }`,
    ].join("; "),
  );
}

export async function retireProcessJob(
  id: string,
  timeoutSec: number,
): Promise<string | null> {
  const name = processJobName(id);
  if (process.platform === "win32") {
    const task = quote(name);
    const removed = await run(
      powershell(
        `if (Get-ScheduledTask -TaskName ${task} -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName ${task} -Confirm:$false }`,
      ),
      { timeoutSec },
    );
    return removed.code === 0
      ? null
      : "the completed scheduled task could not be removed";
  }
  if (process.platform !== "darwin") return null;
  const job = `gui/${process.getuid?.()}/${name}`;
  const removed = await run(["/bin/launchctl", "bootout", job], { timeoutSec });
  if (removed.code !== 0 && !/could not find service/i.test(removed.stderr))
    return "the completed launchd job could not be removed";
  rmSync(join(processRunDirectory(id), "run.plist"), { force: true });
  return null;
}
