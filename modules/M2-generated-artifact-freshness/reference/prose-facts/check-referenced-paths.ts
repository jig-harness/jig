// Conservative prose-path extraction. Only a reference containing a `/` is
// checked. Skipped: URLs, placeholders, globs, and in code spans quoted text,
// a word with a quote or a caret (a fragment of a shell command), and a slash
// command (`/review`, `/tool:skill`). Fenced code (backticks or tildes,
// indented up to three spaces) is skipped.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cli } from "../../../../lib/cli.ts";
import { repoFiles } from "../../../../lib/files.ts";
// A leading-slash Markdown link is relative to the repository root, not to the
// prose file's directory or the filesystem root. Outside a git checkout the
// working directory stands in for the root.
function repoRoot(from: string): string {
  const top = Bun.spawnSync([
    "git",
    "-C",
    from,
    "rev-parse",
    "--show-toplevel",
  ]);
  return top.exitCode === 0 ? top.stdout.toString().trim() : process.cwd();
}
const SLASH_COMMAND = /^\/[\w-]+(?::[\w-]+)*$/;
const FOLDER_NAME = /^[\w.-]+\/$/;
// A double-quoted argument may hold escaped quotes; a single-quoted one cannot.
const QUOTED = /'[^']*'|"(?:\\.|[^"\\])*"/g;
const SHELL_TEXT = /['"^]/;
// A fence line, by CommonMark's grammar: up to three spaces, then three or more
// backticks or tildes. A backtick fence's info string holds no backtick, so
// ```example``` is an inline code span, not a fence.
const FENCE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})(.*)$/;
/** The fence open after `line`, given the one open before it: a fence closes
 * only on a line of its own character, at least as long, with nothing after. */
function fenceAfter(
  open: string | undefined,
  line: string,
): string | undefined {
  const [, marks = "", rest = ""] = FENCE.exec(line) ?? [];
  if (open === undefined) return marks || undefined;
  const closes =
    marks[0] === open[0] && marks.length >= open.length && rest.trim() === "";
  return closes ? undefined : open;
}
interface Target {
  part: string;
  link: boolean;
}
/** The link targets and code-span words of one line of prose. A code span's
 * quoted text is dropped before it is split into words, so the words of a
 * quoted shell argument are not read as paths. */
function targetsOf(line: string): Target[] {
  return [
    { link: true, pattern: /\]\(([^)]+)\)/g, text: (s: string) => s },
    {
      link: false,
      pattern: /`([^`]+)`/g,
      text: (s: string) => s.replace(QUOTED, " "),
    },
  ].flatMap(({ link, pattern, text }) =>
    [...line.matchAll(pattern)].flatMap((match) =>
      text(match[1] ?? "")
        .split(/\s+/)
        .map((part) => ({ part, link })),
    ),
  );
}
/** The path a target names, or null when it does not name one. */
function pathOf({ part, link }: Target): string | null {
  const candidate = part.replace(/[#?].*$/, "").replace(/[.,;:)]*$/, "");
  if (
    !candidate.includes("/") ||
    /:\/\/|^(http:|https:|mailto:)|[<{$*?[ ]/.test(candidate)
  )
    return null;
  if (!link && (SHELL_TEXT.test(candidate) || SLASH_COMMAND.test(candidate)))
    return null;
  return candidate;
}
/** Every folder name that holds a repository file under `base`: the files
 * git lists (ignored ones left out), or every file outside `.git` and
 * `node_modules` when `base` is not in a git checkout. */
function folderNames(base: string): Set<string> {
  return new Set(
    repoFiles(base).flatMap((file) =>
      file.replaceAll("\\", "/").split("/").slice(0, -1),
    ),
  );
}
/**
 * `base` is where a code-span path that does not resolve from the prose
 * file's directory is tried next: the working directory unless given. A
 * code-span path starting with `/` is rooted there too, never at the
 * filesystem root. A bare folder name in a code span (`templates/`) also
 * resolves when a folder of that name exists anywhere under `base`, since it
 * can name a kind of folder rather than one path.
 */
export function checkPaths(files: string[], base = process.cwd()): number {
  if (!files.length)
    throw new Error("usage: check-referenced-paths.ts <prose-file>...");
  let failed = false,
    checked = 0,
    folders: Set<string> | undefined;
  const folderNamed = (name: string) => {
    folders ??= folderNames(base);
    return folders.has(name);
  };
  const codeSpanResolves = (candidate: string) =>
    existsSync(join(base, candidate)) ||
    (FOLDER_NAME.test(candidate) && folderNamed(candidate.slice(0, -1)));
  for (const file of files) {
    let fence: string | undefined;
    const root = repoRoot(resolve(dirname(file)));
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        const open = fence;
        fence = fenceAfter(open, line);
        if (open !== undefined || fence !== undefined) return;
        for (const target of targetsOf(line)) {
          const candidate = pathOf(target);
          if (candidate === null) continue;
          checked++;
          const found =
            existsSync(
              candidate.startsWith("/")
                ? join(root, candidate)
                : join(dirname(file), candidate),
            ) ||
            (!target.link && codeSpanResolves(candidate));
          if (!found) {
            console.error(`${file}:${index + 1}  ${candidate}`);
            failed = true;
          }
        }
      });
  }
  if (!failed)
    console.log(`OK: all ${checked} extracted path reference(s) resolve.`);
  return failed ? 1 : 0;
}
if (import.meta.main) cli(() => checkPaths(process.argv.slice(2)));
