// The environment a test hands a child that may run `foreground-wait.ts
// launch`. `launch` refuses under Codex, which it recognises by any `CODEX_…`
// variable, so a suite run from a Codex session must not pass that session's
// variables on; a case that exercises the refusal adds them back itself.
export const hostEnv: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("CODEX_")),
);
