/**
 * The Conductor provider: open the issue in the Conductor app through its
 * deep-link scheme (https://www.conductor.build/docs/reference/deep-links).
 *
 * Two forms exist and they are not interchangeable:
 *
 *  - `conductor://prompt=<text>&path=<repository root>` forces the repository.
 *    It opens Conductor's new-workspace composer with the prompt filled in;
 *    the workspace starts, and the prompt is sent, when the user clicks Create.
 *    The prompt is capped in length, which is why the full issue context
 *    travels in the cache file and the prompt only names it.
 *  - `conductor://linear_id=<key>&prompt=<text>` lets Conductor detect the
 *    repository. With several repositories it guesses, and it appears to pick
 *    the most recently used one; a `path=` given alongside `linear_id` is
 *    ignored. It creates the workspace (or opens an existing one on the
 *    issue's branch) directly, without the composer. It is the fallback for an
 *    issue that could not be routed, and Conductor then attaches the issue
 *    itself.
 *
 * A repository's root is read from Conductor's own database (read-only), so the
 * configuration names a Conductor repository and holds no filesystem path, and
 * the same file works on every machine. That database is Conductor's private
 * storage, not a documented interface: when it is absent or unreadable the
 * provider falls back to detection rather than failing the launch.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenRequest, Provider } from "../provider.ts";

export function conductorDbPath(home = homedir()): string {
  return join(
    home,
    "Library",
    "Application Support",
    "com.conductor.app",
    "conductor.db",
  );
}

/** The on-disk root of a Conductor repository, or "" when it cannot be found. */
export function lookupRepoRoot(dbPath: string, name: string): string {
  if (!existsSync(dbPath)) return "";
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .query("SELECT root_path FROM repos WHERE name = ?")
        .get(name) as { root_path?: unknown } | null;
      return typeof row?.root_path === "string" ? row.root_path : "";
    } finally {
      db.close();
    }
  } catch (error) {
    console.error(
      `[launcher] Could not read Conductor's repositories from ${dbPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "";
  }
}

/**
 * Percent-encode a whole parameter value, `/` included: the link is a flat
 * `key=value&key=value` list straight after `conductor://`, and Conductor's
 * documentation encodes every value, slashes as `%2F`.
 */
export function encodeComponent(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The deep link for a request; `root` is "" when the repository is unknown. */
export function deepLink(
  request: Pick<OpenRequest, "issue" | "prompt">,
  root: string,
): string {
  const prompt = encodeComponent(request.prompt);
  return root === ""
    ? `conductor://linear_id=${encodeComponent(request.issue)}&prompt=${prompt}`
    : `conductor://prompt=${prompt}&path=${encodeComponent(root)}`;
}

export interface ConductorDeps {
  /** Resolves a Conductor repository name to its root; "" when unknown. */
  repoRoot: (name: string) => string;
  /** Opens a URL with the operating system; stops and rejects when `signal` aborts. */
  openUrl: (url: string, signal: AbortSignal) => Promise<void>;
}

async function openWithSystem(url: string, signal: AbortSignal): Promise<void> {
  // `signal` kills the child, which closes its stderr, so neither wait below
  // outlives the deadline.
  const proc = Bun.spawn(["open", url], {
    stdout: "ignore",
    stderr: "pipe",
    signal,
  });
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (signal.aborted)
    throw new Error("open did not finish before the deadline");
  if (code !== 0) throw new Error(`open exited ${code}: ${stderr.trim()}`);
}

export function conductorProvider(deps: Partial<ConductorDeps> = {}): Provider {
  const repoRoot =
    deps.repoRoot ?? ((name) => lookupRepoRoot(conductorDbPath(), name));
  const openUrl = deps.openUrl ?? openWithSystem;
  return {
    name: "conductor",
    validateRepo(settings, label) {
      if (typeof settings !== "string" || settings.trim() === "")
        throw new Error(
          `repos.${label}.conductor must be the repository's name in Conductor`,
        );
    },
    async open(request) {
      const name = typeof request.repo === "string" ? request.repo : "";
      const root = name === "" ? "" : repoRoot(name);
      if (name !== "" && root === "")
        console.error(
          `[launcher] Conductor has no repository named "${name}"; letting it detect the repository`,
        );
      await openUrl(deepLink(request, root), request.signal);
    },
  };
}
