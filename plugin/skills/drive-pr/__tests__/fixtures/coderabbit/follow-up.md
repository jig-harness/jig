<!-- coderabbit-ai-generated:v1 -->

**Actionable comments posted: 1**

> [!NOTE]
> Follow-up findings are listed below so you can review them separately from inline comments.
> 
> <details>
> <summary>Follow-up (1)</summary><blockquote>
> <dl>
> <dd>
> <br>
> 
> <details>
> <summary><picture><img src="https://storage.googleapis.com/coderabbit_public_assets/review-comment-icons-v1/amber-16.svg" width="16" height="16" align="absmiddle" alt=""></picture> Minor (1)</summary><blockquote>
> <dl>
> <dd>
> <br>
> 
> <details>
> <summary><strong><picture><img src="https://storage.googleapis.com/coderabbit_public_assets/review-comment-icons-v1/amber-16.svg" width="16" height="16" align="absmiddle" alt=""></picture> Minor</strong> · Re-read the pending list in the statement that deletes the draft. · <code>drafts.ts:608</code></summary><blockquote>
> <dl>
> <dd>
> <br>
> 
> `src/store/drafts.ts:608`
> **<picture><img src="https://storage.googleapis.com/coderabbit_public_assets/review-comment-icons-v1/amber-16.svg" width="16" height="16" align="absmiddle" alt=""></picture> Minor** · **Functional Correctness** · **Low value**
> 
> **Re-read the pending list in the statement that deletes the draft.**
> 
> An item added while the draft is being finished is appended to `pending` after `finish` loaded the draft, so deleting only the earlier list leaves it behind. Delete the draft with `RETURNING pending` and use that list.
> 
> <!-- ai-agent-prompt:start -->
> 
> <details>
> <summary><picture><source media="(prefers-color-scheme: dark)" srcset="https://storage.googleapis.com/coderabbit_public_assets/review-comment-icons-v1/bot-dark.svg"><img src="https://storage.googleapis.com/coderabbit_public_assets/review-comment-icons-v1/bot.svg" width="16" height="16" align="absmiddle" alt=""></picture> Prompt for AI Agents</summary>
> <dl>
> <dd>
> 
> ```
> Review comment at @src/store/drafts.ts at line 608:
> Delete the draft and return its latest pending list in one statement.
> ```
> 
> </dd>
> </dl>
> </details>
> 
> <!-- ai-agent-prompt:end -->
> 
> <!-- cr-comment:v1:000000000000000000000006 -->
> 
> </dd>
> </dl>
> </blockquote></details>
> 
> </dd>
> </dl>
> </blockquote></details>
> 
> </dd>
> </dl>
> </blockquote></details>

---

<!-- This is an auto-generated comment by CodeRabbit for review status -->
