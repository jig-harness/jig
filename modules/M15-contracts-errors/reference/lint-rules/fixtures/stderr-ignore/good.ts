// expect: 0
import { spawnSync } from "node:child_process";
export const a = Bun.spawnSync(["git", "status"], { stdout: "pipe", stderr: "pipe" });
export const b = Bun.spawnSync(["git", "status"], { stdout: "ignore" });
export const c = spawnSync("git", ["status"], { stdio: ["ignore", "ignore", "pipe"] });
export const d = spawnSync("git", ["status"], { stdio: "inherit" });
