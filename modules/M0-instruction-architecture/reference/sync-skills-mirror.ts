// One canonical skill directory, with a derived runtime discovery mirror.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { cli } from "../../../lib/cli.ts";
export function syncSkills(check = process.argv[2] === "--check"): number {
  const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]);
  if (git.exitCode) throw new Error("not inside a git repository");
  const root = git.stdout.toString().trim();
  const canonical = resolve(
    root,
    process.env.CANONICAL_DIR || ".claude/skills",
  );
  const mirror = resolve(root, process.env.MIRROR_DIR || ".agents/skills");
  const skills = existsSync(canonical)
    ? readdirSync(canonical).filter(
        (name) =>
          !name.startsWith(".") &&
          existsSync(join(canonical, name, "SKILL.md")),
      )
    : [];
  if (!skills.length) {
    console.error(
      `ERROR: no skills found in ${canonical} (expected <name>/SKILL.md)`,
    );
    return 1;
  }
  let drift = false;
  for (const name of skills) {
    const link = join(mirror, name);
    const want = join(relative(mirror, canonical), name);
    let stat: ReturnType<typeof lstatSync> | undefined;
    try {
      stat = lstatSync(link);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (stat?.isSymbolicLink() && readlinkSync(link) === want) continue;
    if (stat && !stat.isSymbolicLink()) {
      console.error(
        `ERROR: ${link} exists as a regular file/directory — remove manually`,
      );
      drift = true;
    } else if (check) {
      console.log(`DRIFT: ${link} should link to ${want}`);
      drift = true;
    } else {
      mkdirSync(mirror, { recursive: true });
      if (stat) unlinkSync(link);
      symlinkSync(want, link, "dir");
      console.log(`  + ${link} -> ${want}`);
    }
  }
  if (existsSync(mirror))
    for (const name of readdirSync(mirror)) {
      const link = join(mirror, name);
      if (
        name.startsWith(".") ||
        !lstatSync(link).isSymbolicLink() ||
        existsSync(join(canonical, name, "SKILL.md"))
      )
        continue;
      if (check) {
        console.log(`DRIFT: stale ${link}`);
        drift = true;
      } else {
        unlinkSync(link);
        console.log(`  - ${link} (stale)`);
      }
    }
  console.log(
    drift
      ? "FAIL — run sync-skills-mirror.ts to fix"
      : `OK — ${mirror} in sync with ${canonical}`,
  );
  return drift ? 1 : 0;
}
if (import.meta.main) cli(() => syncSkills());
