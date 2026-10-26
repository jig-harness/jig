# Review

A clean working tree can still contain a branch that needs review, and a
change that edits its own rules must not select weaker rules for itself.
The review skill checks the cumulative change against a detached snapshot
of its base branch, then combines pattern, contract and specialist reviews.

Run `/jig:review` from the consumer repository. Bun, Git and GitHub CLI are
required. Its commands run under PowerShell as well as POSIX shells without
Git Bash or Unix text utilities. The [procedure](SKILL.md) documents the
bootstrap flags, session setup, policy execution and cleanup.

The helper stores one null-byte-delimited list covering committed, staged,
unstaged, untracked and deleted paths. Explicit file arguments replace that
list. Spaces, Unicode and shell punctuation retain their path boundaries;
line breaks are rejected because configured validation plans use one path
per line. Content checks read reviewed files, while their scripts, rules,
configuration and runtime settings come from the base snapshot. Policy
children receive an enumerated environment and cannot inherit the reviewed
tree's `.env` or Bun preloads. Snapshot preloads run before content checks
enter the reviewed tree, and setup removes executable search paths inside
that tree before invoking Git. The shared process runner bounds calls to
60 seconds and cancels descendant processes.

A configured validation plan runs through Bun's portable shell. A command
that explicitly requires another shell still requires that shell to be
installed. Jig's own review workflow does not require it.

The skill implements the author-side review practice in
[M7](https://github.com/jig-harness/jig/blob/main/modules/M7-pr-lifecycle-review/README.md). It reports findings
in the session; it does not post them to a pull request.
