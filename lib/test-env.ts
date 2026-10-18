// Windows spells the search path variable `Path`, and Bun's `process.env` keeps
// that spelling when it is spread into an object. A test that builds a child's
// environment as `{ ...process.env, PATH: stubDir + delimiter + ... }` then
// holds both `Path` and `PATH`; the child's environment block carries both,
// Windows reads the first (`Path`), and the stub directory is silently
// ignored, so the real `gh` runs. Spelling the variable `PATH` in the test
// process makes the spread, and every override of it, name the one variable.
// Applied by test-env-preload.ts; a no-op where the variable is already
// spelled `PATH`, as it is everywhere but Windows.

/** Renames every case variant of `PATH` in `env` to `PATH`, in place. */
export function normalizePathKey(
  env: Record<string, string | undefined>,
): void {
  let value: string | undefined;
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() !== "path") continue;
    value ??= env[key];
    if (key !== "PATH") delete env[key];
  }
  if (value !== undefined) env.PATH = env.PATH ?? value;
}
