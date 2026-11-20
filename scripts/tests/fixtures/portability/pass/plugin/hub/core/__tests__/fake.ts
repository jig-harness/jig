// A test's helper is no portable code: the check skips `__tests__/`.
import { spawnSync } from "node:child_process";
export const run = () => spawnSync(process.execPath, ["--version"]);
