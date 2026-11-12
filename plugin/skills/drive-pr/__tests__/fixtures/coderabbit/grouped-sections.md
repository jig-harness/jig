**Actionable comments posted: 1**

> [!CAUTION]
> Some comments are outside the diff and can’t be posted inline due to platform limitations.
> 
> 
> 
> <details>
> <summary>⚠️ Outside diff range comments (2)</summary><blockquote>
> 
> <details>
> <summary>package.json (2)</summary><blockquote>
> 
> `50-50`: **Same patch path issue for the parser package**
> 
> Point to a repository-local patch and commit it.
> 
> 
> ```diff
> -    "parser": "patch:parser@npm%3A2.6.1#~/.yarn/patches/parser.patch",
> +    "parser": "patch:parser@npm%3A2.6.1#./.yarn/patches/parser.patch",
> ```
> 
> ---
> 
> `1-116`: **Avoid absolute patch paths**
> 
> Two patch entries point at `~/.yarn/patches/...`, which will not resolve in CI or another clone. Commit the patch files under `.yarn/patches/` and refer to them with a relative path.
> 
> </blockquote></details>
> 
> </blockquote></details>

<details>
<summary>♻️ Duplicate comments (1)</summary><blockquote>

<details>
<summary>src/routes.ts (1)</summary><blockquote>

`134-135`: **Fix the segment order of the export route**

Sort the segments alphabetically.


```diff
-  'export/zip-csv',
+  'export/csv-zip',
```

</blockquote></details>

</blockquote></details>

<details>
<summary>🧹 Nitpick comments (1)</summary><blockquote>

<details>
<summary>src/routes.ts (1)</summary><blockquote>

`5-317`: **Expose a Set beside the array for membership checks**

Keep the array for compatibility, and also export a Set for constant-time lookups.

</blockquote></details>

</blockquote></details>

<details>
<summary>📜 Review details</summary>

**Configuration used**: CodeRabbit UI

**Review profile**: CHILL

<details>
<summary>📒 Files selected for processing (2)</summary>

* `package.json` (3 hunks)
* `src/routes.ts` (1 hunks)

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
