# From a broad topic to started work

When several linked ideas have no single work item yet, `/jig:orchestrate`
keeps one session with the person while fresh sessions gather evidence,
record decisions and file work. Without it, investigation fills the
discussion's context and the session can end in advice with nothing started.

The session splits the topic into tracks, surveys them in parallel, brings
back decisions with recommendations, and records the person's answers.
Verified defects are filed separately. Work spanning several pull requests
gets a plan for review; after approval the first wave becomes issues and
starts through the host's configured delivery mechanism. A separate plan
keeper keeps the plan, and the topic's notebook keeps what was agreed and
what is still owed.

The notebook is a folder on your machine, `~/.jig/orchestrate/<topic>/`
(under `JIG_HOME` when that is set), outside every repository and never
committed. Claude Code and Codex read it alike. It holds:

- `state.md`, the topic as it stands now, rewritten whole at every change:
  the focus, the decisions waiting on you with a recommendation each, what
  the session owes and by when, what is running, cautions, the next act,
  and links to the issues, plans and pull requests involved.
- `journal/`, a folder with one file a day, `<date>.md`, only ever added to: each decision,
  ruling and action with its reason, for when someone needs the history.

Reports and notebook entries link directly to issues and pull requests in
other repositories using full Markdown URL links.

A session started with `/jig:orchestrate <topic>` reads `state.md` first and
picks up from it alone. It rewrites the state and adds to the journal at
each natural pause. When the session has run long, it suggests at a quiet
moment that a fresh session take over: once you agree, it writes the state,
starts the successor with the same `/jig:orchestrate <topic>` (or gives you
the command to run), checks that the successor is running, and stops
acting.

Run `/jig:orchestrate <topic>`. It requires no configuration section of its
own. It uses the repository's existing plan review facility, with chat
review as the fallback, and keeps its record in the notebook, with a plain
file outside the repository as the fallback. If the runtime
cannot start fresh sessions, it provides briefs for separate sessions and
waits for their results. A person owns the decisions; unattended use stops
at a question. The coordinating session writes no repository files and
does no implementation or merge; the notebook is the one thing it writes.

For one work item use [do-item](../do-item/README.md), one technical dilemma
[decide](../decide/SKILL.md), a system explanation
[explain](../explain/SKILL.md), or a command to a delivery station
[operator](../operator/SKILL.md). This skill prepares work for those skills;
it is separate from a host's general worker-agent orchestration facility.

The [agent procedure](SKILL.md) holds the steps and runtime fallbacks.
