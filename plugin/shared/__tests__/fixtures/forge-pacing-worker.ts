import { existsSync, writeFileSync } from "node:fs";
import { claimForgeSlot } from "../../outbound/forge-pacing.ts";
import { currentMs } from "../../time.ts";
import { systemClock } from "../../clock.ts";

const [path, owner, nowText, gate, ready] = process.argv.slice(2);
if (!path || !owner || !nowText || !gate || !ready) process.exit(2);
writeFileSync(ready, "");
const deadline = currentMs() + 10_000;
while (!existsSync(gate) && currentMs() < deadline) await systemClock.sleep(5);
if (!existsSync(gate)) process.exit(3);
let result = claimForgeSlot(owner, Number(nowText), path);
while (
  !result.ok &&
  typeof result.failure.cause === "object" &&
  result.failure.cause !== null &&
  "code" in result.failure.cause &&
  result.failure.cause.code === "SQLITE_BUSY" &&
  currentMs() < deadline
) {
  await systemClock.sleep(5);
  result = claimForgeSlot(owner, Number(nowText), path);
}
console.log(JSON.stringify(result));
