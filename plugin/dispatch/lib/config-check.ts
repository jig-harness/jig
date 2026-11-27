/**
 * What a tick reads from a repository's configuration, checked in a
 * checkout with the tick's own readers: the `dispatch` section
 * (`readSection`), the tracker the configuration names with its issue
 * facets (`openTracker`, which resolves the facets against the label
 * taxonomy), and the change-area catalog `drive.change_areas_catalog`
 * names (the tick's path rule and `loadCatalogText`). A tick reads these
 * from the default branch; a repository's CI runs the check on the tree a
 * pull request would merge, so an error the tick would refuse every turn is
 * refused before the merge instead, with the tick's sentence
 * (`configuration-refusals.ts`).
 *
 * The check reads files only: it sends nothing to the tracker or the forge,
 * so what only those can say (a field the organization lacks, a facet's
 * detected store) is left to the tick.
 */
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  attempt,
  Defect,
  failed,
  ok,
  type Outcome,
} from "../../shared/outcome.ts";
import { loadCatalogText } from "../../skills/drive-pr/scripts/lib/change-areas-catalog.ts";
import { facetsOf } from "../../skills/do-item/scripts/lib/tracker/config.ts";
import { openTracker } from "../../skills/do-item/scripts/lib/tracker/index.ts";
import {
  CONFIGURATION_FILE,
  catalogMissing,
  catalogRefusal,
  sectionRefusal,
  trackerRefusal,
} from "./configuration-refusals.ts";
import { readSection, trackerConfigOf } from "./section.ts";
import { configuredCatalog, repositoryPath } from "./sources/contention.ts";
import { failureText } from "./text.ts";

/** One reading the tick would refuse: which part, and the tick's sentence. */
export interface ConfigFinding {
  part: "dispatch" | "tracker" | "catalog";
  message: string;
}

/**
 * The repository a GitHub tracker with no `issue_tracker.github.repository`
 * is bound to here. The tick binds it to the forge's own repository; the
 * check sends no request, so any well-formed name reads alike.
 */
const UNSENT_SLUG = "checkout/repository";

/**
 * The most bytes the forge's contents answer carries inline: a larger file
 * comes back without content, which the tick refuses, so the check refuses
 * it too.
 */
export const INLINE_CONTENT_LIMIT = 1024 * 1024;

/**
 * The size of the file as the tick's forge read counts it: the committed
 * blob, which a checkout's line-ending conversion does not change. Where the
 * committed blob does not stand for the file's contents (an untracked or
 * modified file, no git), the size of the file on disk stands.
 */
function committedSize(root: string, path: string, onDisk: number): number {
  try {
    // Exits non-zero when the file differs from HEAD, which then is not the
    // blob the tick would read after a commit.
    execFileSync(
      "git",
      ["--literal-pathspecs", "diff", "--quiet", "HEAD", "--", path],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      },
    );
    const out = execFileSync("git", ["cat-file", "-s", `HEAD:${path}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    const size = Number(out.trim());
    return Number.isSafeInteger(size) && size >= 0 ? size : onDisk;
  } catch {
    return normalizedSize(root, path, onDisk);
  }
}

/**
 * The size a modified file would have once committed: git itself cleans it
 * (the attributes, filters and line-ending settings that apply to the path),
 * into a scratch object directory so the repository gains nothing, and the
 * stored blob's size is read back. A file too large to bother with, or a
 * failure of any step, counts its bytes on disk.
 */
function normalizedSize(root: string, path: string, onDisk: number): number {
  if (onDisk > 2 * INLINE_CONTENT_LIMIT) return onDisk;
  let scratch: string | null = null;
  try {
    const objects = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      },
    ).trim();
    scratch = mkdtempSync(join(tmpdir(), "jig-clean-"));
    const env = {
      ...process.env,
      GIT_OBJECT_DIRECTORY: scratch,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objects,
    };
    const run = (args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      }).trim();
    const oid = run([
      "--literal-pathspecs",
      "hash-object",
      "-w",
      `--path=${path}`,
      "--",
      join(root, path),
    ]);
    const size = Number(run(["cat-file", "-s", oid]));
    return Number.isSafeInteger(size) && size >= 0 ? size : onDisk;
  } catch {
    return onDisk;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/** Whether `inside` (a path relative to the checkout) leaves it: a whole `..` component, or another root. */
function leavesCheckout(inside: string): boolean {
  return inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
}

/**
 * A file of the checkout as text; `null` only when it is confirmed absent:
 * the entry itself does not exist (ENOENT on the entry, not on a link's
 * target). Any other way the lookup fails, a link whose target is missing,
 * a link that leaves the checkout and a file past the forge's inline limit
 * are unreadable, never absent.
 */
function fileText(
  root: string,
  path: string,
): Outcome<string | null, "unreadable"> {
  const read = attempt("unreadable", `${path} could not be read`, () => {
    const base = realpathSync(root);
    const entry = join(base, path);
    try {
      lstatSync(entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let real: string;
    try {
      real = realpathSync(entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { refused: `${path} is a link whose target does not exist` };
      throw error;
    }
    if (leavesCheckout(relative(base, real)))
      return { refused: `${path} resolves outside the checkout` };
    const onDisk = statSync(real).size;
    if (committedSize(base, path, onDisk) > INLINE_CONTENT_LIMIT)
      return { refused: `${path} is larger than the forge's inline limit` };
    if (onDisk > 2 * INLINE_CONTENT_LIMIT)
      return { refused: `${path} is larger than the forge's inline limit` };
    return { text: readFileSync(real, "utf8") };
  });
  if (!read.ok) return read;
  if (read.value === null) return ok(null);
  if ("refused" in read.value) return failed("unreadable", read.value.refused);
  return ok(read.value.text);
}

/**
 * A throw no configuration causes: a broken invariant or a programming
 * error in a reader. The check lets it travel, so a bug in the plugin is
 * reported as one and never as a fault of the repository's configuration.
 */
function isDefect(error: unknown): boolean {
  return (
    error instanceof Defect ||
    error instanceof TypeError ||
    error instanceof ReferenceError
  );
}

/** Why the label taxonomy at `path` may not be read from the checkout, or `null` when it may (a missing file is the tracker's to report). */
function boundedTaxonomy(root: string, path: string): string | null {
  if (isAbsolute(path) || path.split(/[\\/]/).includes(".."))
    return `issue_tracker.taxonomy ${path} is not a path inside the checkout`;
  const text = fileText(root, path);
  return text.ok ? null : text.failure.reason;
}

/** The tracker and its facets, as the tick opens them. */
function trackerFindings(
  values: Record<string, unknown>,
  root: string,
): ConfigFinding[] {
  let problem: string | null;
  try {
    const config = trackerConfigOf(values, UNSENT_SLUG);
    // The tracker reads the taxonomy itself; read it here first under the
    // checkout's bounds, so a path outside it never reaches that reader.
    const taxonomy = boundedTaxonomy(root, config.taxonomy);
    if (taxonomy !== null)
      return [{ part: "tracker", message: trackerRefusal(taxonomy) }];
    openTracker(config, root);
    problem = facetsOf(config, root).taxonomy.problem;
  } catch (error) {
    if (isDefect(error)) throw error;
    return [{ part: "tracker", message: trackerRefusal(failureText(error)) }];
  }
  // A taxonomy that fails its lint leaves type and size unreadable: the tick's facet record names this problem.
  return problem === null ? [] : [{ part: "tracker", message: problem }];
}

/** The change-area catalog, as the tick reads it for serialized areas. */
function catalogFindings(
  values: Record<string, unknown>,
  root: string,
): ConfigFinding[] {
  const configured = configuredCatalog(values);
  if (configured === null) return [];
  const refused = (why: string): ConfigFinding[] => [
    { part: "catalog", message: catalogRefusal(why) },
  ];
  const path = repositoryPath(configured);
  if (!path.ok) return refused(path.failure.reason);
  const text = fileText(root, path.value);
  if (!text.ok) return refused(text.failure.reason);
  if (text.value === null) return refused(catalogMissing(configured));
  const body = text.value;
  const parsed = attempt("invalid", "the change-area catalog", () =>
    loadCatalogText(body, path.value),
  );
  return parsed.ok ? [] : refused(failureText(parsed.failure.cause));
}

/**
 * Every reading of the configuration at `root` the tick would refuse, in
 * the order the tick reads them; none when the tick reads it whole. A
 * section that does not read ends the check, as it ends the tick's turn.
 */
export function checkConfiguration(root: string): ConfigFinding[] {
  const file = fileText(root, CONFIGURATION_FILE);
  if (!file.ok)
    return [{ part: "dispatch", message: sectionRefusal(file.failure.reason) }];
  const read = readSection(file.value, CONFIGURATION_FILE);
  if (!read.ok)
    return [
      {
        part: "dispatch",
        message: sectionRefusal(failureText(read.failure.reason)),
      },
    ];
  const { values } = read.value;
  return [...trackerFindings(values, root), ...catalogFindings(values, root)];
}
