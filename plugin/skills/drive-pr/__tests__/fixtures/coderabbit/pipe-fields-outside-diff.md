> [!CAUTION]
> Some comments are outside the diff and can’t be posted inline due to GitHub limitations.
> 
> **⚠️ Outside diff range comments (1)**
> 
> <details>
> <summary><strong>🟡 Minor</strong> · Update the default store in the later configuration example. · <code>setup.md:277</code></summary><blockquote>
> 
> `docs/setup.md:277`
> **🎯 Functional Correctness** | **🟡 Minor** | **⚡ Quick win**
> 
> **Update the default store in the later configuration example.**
> 
> The fallback sentence is correct, but the same page says the later block uses the defaults from `config.yml` while showing `store: memory`. Readers who copy this block configure a different store from the default.
> 
> <details>
> <summary>Suggested fix</summary>
> 
> ```diff
> -  store: "memory"  # Can be overridden by the STORE env var
> +  store: "disk"  # Can be overridden by the STORE env var
> ```
> 
> </details>
> 
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Review comment at @docs/setup.md at line 277:
> Update the store value in the later configuration example to match the
> default, keeping the existing STORE override comment.
> ```
> 
> </details>
> 
> <!-- cr-comment:v1:000000000000000000000003 -->
> 
> </blockquote></details>

---

<details>
<summary>🤖 Prompt to fix review comments</summary>

```
Outside diff comments:
Review comments at @docs/setup.md:
- Line 277: Update the store value in the later configuration example to
match the default, keeping the existing STORE override comment.
```

</details>

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

- **Configuration used**: Organization UI
- **Review profile**: CHILL
- **Run ID**: `00000000-0000-0000-0000-000000000000`

</details>

<details>
<summary>📒 Files selected for processing: 1</summary>

* `docs/setup.md`

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
