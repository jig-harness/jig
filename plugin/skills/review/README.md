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

Setup also writes the effective diff beside the list, with every Git
setting that could change what it shows fixed on the command line and
attributes read from the merge base, so neither the caller's Git
configuration nor a clean filter the change declares in its own attributes
file can hide an edit. That needs Git 2.41 or later; setup stops, naming the
requirement, on an older Git.

The semantic tier runs [review lenses](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md):
single checks, each one Markdown file. The plugin ships seed lenses in
[`lenses/`](lenses/), each the review form of one rule a Jig module states
(`jig.swallowed-failure`, for M15's rule that no failure is swallowed); a
repository adds its own in the folder `review.lenses.dir` names. A lens runs
only when the diff gives it something to check, and the summary's `Lenses:`
line says why each of the others was skipped. Each runs as its own reviewer
with fresh context, and its findings are at most warnings until a lens is
promoted to blocking on measured precision. Each seed lens ships with eval
fixtures in [`lenses/fixtures/`](lenses/fixtures/): a diff it must flag and
one it must stay quiet on, run live before the lens ships.

A configured validation plan runs through Bun's portable shell. A command
that explicitly requires another shell still requires that shell to be
installed. Jig's own review workflow does not require it.

The skill implements the author-side review practice in
[M7](https://github.com/jig-harness/jig/blob/main/modules/M7-pr-lifecycle-review/README.md). It reports findings
in the session; it does not post them to a pull request.
