/** Physical source-file lines above a shared limit. */
export interface FileLinesCounter {
  name: string;
  format: "file-lines";
  /** Maximum physical lines before each additional line counts. */
  limit: number;
  /** Repository-relative file paths to include and optionally exclude. */
  files: string;
  exclude?: string;
}

/**
 * A command printing `{"counts": {"<rule>": {"<file>": n}}}`. With
 * `per: "file"` each file's count is its own ceiling, so moving findings
 * from one file to another fails too.
 */
export interface JsonCounter {
  name: string;
  format: "json";
  command: string[];
  per?: "file";
}

/** A command, pattern set or source-file size to measure. */
export type Counter =
  | FileLinesCounter
  | JsonCounter
  | { name: string; format: "biome-json" | "tsc"; command: string[] }
  | {
      name: string;
      format: "grep";
      patterns: Record<string, string>;
      /** Only files whose path matches this pattern (default: all). */
      files?: string;
    };

/** A configuration file whose strictness is compared between the trees. */
export interface ConfigFile {
  path: string;
  kind: "biome" | "tsconfig" | "fallow";
}

export interface RatchetConfig {
  counters: Counter[];
  configs: ConfigFile[];
  /** Files or directories the head's configuration needs (plugins, extends). */
  support?: string[];
}

/** Findings of one tree: rule key → file → count. */
export type Counts = Map<string, Map<string, number>>;

/**
 * One counter's findings: `ratcheted` are those the ratchet holds (Biome's
 * warnings); `all` adds the enforced ones (Biome's errors), so that promoting
 * a rule to an error is not mistaken for loosening it.
 */
export interface Measured {
  ratcheted: Counts;
  all: Counts;
}
