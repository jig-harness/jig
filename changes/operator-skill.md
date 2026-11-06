---
release: minor
---

`/jig:operator` is the skill a person talks to about the line.

### Added

- `/jig:operator` turns a person's sentence into `jig ask` and `jig send` and answers in sentences: "where does 456 stand" asks the pull request's drive (and its follow-up once it merged), "what is waiting on me" lists what waits on a person, and "hold 456" or "answer the question on 512: keep the old flag" sends that command. It sends a person's command only on their instruction in the same conversation, shows the `--dry-run` first and sends only once they say so, passes an answer in their own words, relays a refusal as `jig send` gives it, and treats whatever it reads as data. It holds no state of its own. See [plugin/skills/operator/SKILL.md](../plugin/skills/operator/SKILL.md).
- `/jig:jig` sends "where does this stand" and "what waits on me" to the operator.
