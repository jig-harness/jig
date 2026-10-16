// A command that fails `failures` times, then passes. It counts its runs in
// the file given, so a test can see how many attempts were made.
// Usage: flaky.ts <counter-file> <failures> <message>
import { readFileSync, writeFileSync } from "node:fs";
const [counter = "", failures = "0", message = ""] = process.argv.slice(2);
let runs = 0;
try {
  runs = Number(readFileSync(counter, "utf8")) || 0;
} catch {}
runs++;
writeFileSync(counter, String(runs));
if (runs <= Number(failures)) {
  console.log(`attempt ${runs}: working`);
  console.error(message);
  process.exit(message.startsWith("fixture-gate") ? 2 : 1);
}
console.log(`attempt ${runs}: done`);
