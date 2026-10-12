/**
 * The workspace-provider port: the one step that differs between ways of
 * starting an agent on an issue.
 *
 * Everything before it is shared (reading the issue, assigning it, writing the
 * context cache, choosing the repository from the label); this is the last step:
 * given the issue, the prompt and where the repository is for this provider,
 * open a workspace that runs the prompt. Conductor does that by opening a
 * deep link and returning; another provider may start a session on a remote
 * host and report what it started. Adding one means adding a file under
 * `providers/` and registering it in `providers/index.ts`; the launch code does
 * not change.
 */

export interface OpenRequest {
  /** The issue key, e.g. `ENG-123`. */
  issue: string;
  /** The first prompt for the agent: the skill command, the key and a hint. */
  prompt: string;
  /** The tracker's suggested branch name; empty when it gave none. */
  branch: string;
  /**
   * This provider's settings for the repository the issue belongs to, exactly
   * as the configuration holds them; null when the issue was not routed (no
   * label, no API key, or a label with no entry for this provider).
   */
  repo: unknown;
  /**
   * Aborted when the launch's deadline passes. A provider stops whatever it
   * started (a child process, a request) and rejects, so a stuck opener cannot
   * hold the launch forever.
   */
  signal: AbortSignal;
}

export interface Provider {
  /** The name `provider:` and each repository entry use. */
  readonly name: string;
  /** Throws, naming the problem, when a repository's settings are unusable. */
  validateRepo(settings: unknown, label: string): void;
  /** Start the workspace. Throws when it could not be started or `signal` aborted. */
  open(request: OpenRequest): Promise<void>;
}
