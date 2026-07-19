# Example instruction file

A neutral stand-in for a repo's agent-instruction file, used as the fixture
for the two prose-facts checks.

There are 3 guides total, starting with [the setup guide](guides/setup.md).
When finished, follow `guides/teardown.md`. Incidental numbers like "spawn 3
workers" are not inventory claims and are never checked.

Path-like references in fenced code blocks are illustrations, not claims:

```sh
cat guides/does-not-exist.md   # ignored by the path check
```
