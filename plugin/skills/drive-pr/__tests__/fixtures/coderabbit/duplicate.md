**Actionable comments posted: 1**

<details>
<summary>♻️ Duplicate comments (2)</summary><blockquote>

<details>
<summary>package.json (2)</summary><blockquote>

`55-55`: _⚠️ Potential issue_ | _🟡 Minor_

**Check the runtime floor for the build tool.**

The root `engines.node` range admits versions the build tool does not support. If root build commands must run on every declared version, raise the range or document a separate build-tool requirement.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Review comment at @package.json at line 55:
Confirm whether the root engines.node range must cover the build commands.
```

</details>

<!-- cr-comment:v1:000000000000000000000004 -->

---

`55-55`: _⚠️ Potential issue_ | _🟠 Major_

**Check the build configuration migration.**

The new build tool release removes deprecated options. Confirm the build configurations in this branch use supported options.

```shell
#!/usr/bin/env bash
set -eu
rg -n '\bexternal\s*:' build.config.ts || true
```

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Review comment at @package.json at line 55:
Check the build configuration for deprecated options and migrate them.
```

</details>

<!-- cr-comment:v1:000000000000000000000005 -->

</blockquote></details>

</blockquote></details>

---

<details>
<summary>🤖 Prompt to fix review comments</summary>

```
Duplicate comments:
Review comments at @package.json:
- Line 55: Confirm whether the root engines.node range must cover the build
commands.
- Line 55: Check the build configuration for deprecated options and migrate
them.
```

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
