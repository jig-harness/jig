/**
 * The argv that runs a Bun script from a test. On POSIX the script is the
 * program, executed through its `#!/usr/bin/env bun` line, as a consumer's
 * hook or a skill's instructions run it. Windows does not read a shebang
 * (`EFTYPE`), so Bun runs the script instead.
 */
export function scriptArgv(script: string, ...args: string[]): string[] {
  return process.platform === "win32"
    ? [process.execPath, script, ...args]
    : [script, ...args];
}
