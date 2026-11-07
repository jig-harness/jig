/** Apply-only recovery of one confirmed-dead driver's ledger in the caller's repository. */
import { recoverIdleStop } from "./lib/ledger-stop.ts";
import { fail } from "./lib/cli.ts";
import { resolveStateDir } from "./lib/state/store.ts";

const pr = process.argv[2] ?? "";
if (!/^[1-9]\d*$/.test(pr) || process.argv.length !== 3)
  fail(2, "recover-ledger: expected one pull request number");
await recoverIdleStop(await resolveStateDir(), pr, { diag: null });
