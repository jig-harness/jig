/**
 * A repository's command for the runner's tests: one Bun program for every
 * behaviour, so it runs the same under `sh` and `cmd.exe`.
 *
 * Usage: bun program.ts <mode>
 */
const mode = process.argv[2];
if (mode === "env") {
  console.log(
    JSON.stringify({
      GH_TOKEN: process.env.GH_TOKEN ?? null,
      KEPT: process.env.KEPT ?? null,
    }),
  );
  process.exit(0);
}
if (mode === "stdin") {
  console.log(await Bun.stdin.text());
  process.exit(5);
}
if (mode === "flood") {
  process.stdout.write("x".repeat(70 * 1024));
  process.exit(0);
}
if (mode === "hang") await Bun.sleep(2_000_000);
process.exit(64);
