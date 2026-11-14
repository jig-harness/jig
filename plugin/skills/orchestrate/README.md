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
keeper and durable record preserve what was agreed and what is still owed.

Run `/jig:orchestrate <topic>`. It requires no configuration section of its
own. It uses the repository's existing plan review and record facilities,
with chat review and an external plain file as fallbacks. If the runtime
cannot start fresh sessions, it provides briefs for separate sessions and
waits for their results. A person owns the decisions; unattended use stops
at a question. The coordinating session writes no repository files and
does no implementation or merge.

For one work item use [do-item](../do-item/README.md), one technical dilemma
[decide](../decide/SKILL.md), a system explanation
[explain](../explain/SKILL.md), or a command to a delivery station
[operator](../operator/SKILL.md). This skill prepares work for those skills;
it is separate from a host's general worker-agent orchestration facility.

The [agent procedure](SKILL.md) holds the steps and runtime fallbacks.
