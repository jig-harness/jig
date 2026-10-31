/**
 * The comment authors whose answers count. A pull request comment is
 * world-writable: anyone who can read a finding can post its outcome token
 * and marker themselves. GitHub's `author_association` (`authorAssociation`
 * in GraphQL) is computed server-side and cannot be spoofed by comment
 * content, so only an author it vouches for as having write access to the
 * repository is trusted.
 *
 * Every script that decides whether a comment answers a finding reads this
 * one set; a second copy would drift.
 */
export const TRUSTED_ASSOCIATIONS = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);
