/** Open issue counts before and after the configured pool scope is applied. */
export interface PoolScopeCounts {
  /** Open issues in the project, visible to the credential. */
  project: number;
  /** Open issues within the configured pool scope, visible to the credential. */
  pool: number;
  /** Whether a pool scope is configured. */
  scoped: boolean;
  /** True when the tracker supplies estimates rather than exact counts. */
  approximate: boolean;
}
