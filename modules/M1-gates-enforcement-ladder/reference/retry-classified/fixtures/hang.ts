// A command that runs until it is stopped; it writes its pid to the file
// given, so a test knows it started.
import { writeFileSync } from "node:fs";
console.log("started");
writeFileSync(process.argv[2] ?? "", String(process.pid));
await Bun.sleep(30_000);
