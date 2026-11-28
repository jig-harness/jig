/**
 * A preflight command the tests run through the shell: one Bun program for
 * every behaviour, so a fixture needs no shell syntax and runs the same on
 * every platform's interpreter.
 *
 * Usage: bun preflight-fixture.ts <mode>
 */
import { writeFileSync } from "node:fs";

const mode = process.argv[2];
if (mode === "ok") process.exit(0);
if (mode === "refuse") {
  console.log("other repo");
  console.log("more");
  process.exit(3);
}
if (mode === "refuse-blockers") {
  // A refusal for open blockers alone, tagged on its second line.
  process.stdout.write("waits on #3\r\n kind: blockers \n");
  process.exit(3);
}
if (mode === "refuse-blockers-control") {
  process.stdout.write("waits on \u001b[2J#3\nkind: blockers\n");
  process.exit(3);
}
if (mode === "refuse-tagged-otherwise") {
  console.log("waits on legal");
  console.log("kind: blockers, and legal");
  process.exit(3);
}
if (mode === "refuse-silent") process.exit(3);
if (mode === "refuse-long") {
  console.log("a".repeat(1000));
  process.exit(3);
}
if (mode === "refuse-control") {
  console.log("a\tb\rc");
  process.exit(3);
}
if (mode === "touch") {
  writeFileSync(process.argv[3] as string, "");
  process.exit(0);
}
if (mode === "fail") {
  console.error("broke");
  process.exit(2);
}
if (mode === "hang") {
  await Bun.sleep(2_000_000);
}
const input = await Bun.stdin.text();
if (mode === "save") {
  writeFileSync("seen.json", input);
  process.exit(0);
}
if (mode === "check") {
  if (JSON.parse(input).identifier === "#5") process.exit(0);
  console.log("not seen");
  process.exit(3);
}
console.error(`unknown mode ${String(mode)}`);
process.exit(64);
