/** Where a `gh api` command line names its route, read without running it. */

/** `gh api`'s flags that take a value, which is never the route. */
export const VALUED: ReadonlySet<string> = new Set([
  "-X",
  "--method",
  "-H",
  "--header",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "--input",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "--cache",
  "-p",
  "--preview",
]);

/** Where a `gh api` command line names its route: its first argument that is neither a flag nor a flag's value; `-1` when it names none. */
export function apiRouteAt(args: readonly string[]): number {
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (VALUED.has(arg)) {
      i += 1;
      continue;
    }
    if (!arg.startsWith("-")) return i;
  }
  return -1;
}

/**
 * The route a `gh api` command line asks, without a leading slash or a
 * query; a full URL (the next page a paged read asks for) is read without
 * its scheme, host and an enterprise server's `api/v3/` prefix.
 */
export function apiRoute(args: readonly string[]): string {
  const at = apiRouteAt(args);
  if (at < 0) return "";
  return (
    (args[at] ?? "")
      .replace(/^https?:\/\/[^/]+\/(api\/v3\/)?/i, "")
      .replace(/^\/+/, "")
      .split("?")[0] ?? ""
  );
}
