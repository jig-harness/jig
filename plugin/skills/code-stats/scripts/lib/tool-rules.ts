/**
 * A table of tools for a default area: each tool or convention, its
 * ecosystem and the globs of its files, with one example path. The README,
 * CONFIGURATION.md, `--explain` and the tests all read the same rows.
 */

export interface ToolRule {
  tool: string;
  ecosystem: string;
  paths: readonly string[];
  /** A path the tool's globs match, for the documentation and the tests. */
  example: string;
}

/** A matcher over `rules`: the first row whose globs match a path, with the glob. */
export function compileTools(
  rules: readonly ToolRule[],
): (path: string) => { tool: ToolRule; pattern: string } | null {
  const compiled = rules.map((tool) => ({
    tool,
    globs: tool.paths.map((p) => [p, new Bun.Glob(p)] as const),
  }));
  return (path) => {
    for (const { tool, globs } of compiled)
      for (const [pattern, glob] of globs)
        if (glob.match(path)) return { tool, pattern };
    return null;
  };
}
