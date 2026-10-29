/**
 * What the detector returns for each configuration value a repository
 * already implies.
 */

/** One value a repository implies, and what shows it. */
export interface Fact {
  /** The dotted configuration field, such as `review.bots`. */
  field: string;
  /** The value. A list field's facts add up when several are found. */
  value: unknown;
  /**
   * What the value was read from: each entry one observation, naming the
   * file or the command it comes from (`package.json defines a "gates"
   * script`, `the forge names this repository example/web`).
   */
  evidence: string[];
}
