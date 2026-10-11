---
name: programmatic-execution
description: "Run bulk read-only analysis over many files (10 or more) as one script that prints a compact list of findings, instead of reading each file into context; use for cross-reference and link validation and other mechanical searches across a codebase."
user-invocable: false
context: fork
---

# Programmatic execution

Execute bulk file operations, validations, and analyses as one script that
prints a compact summary, instead of reading each file into context with
individual tool calls.

## When to use this skill

**Use this skill when:**

- Analyzing 10+ files for mechanical patterns (e.g., locating references to a
  changed API)
- Bulk validation operations (e.g., validating 20 SQL queries)
- Data aggregation across the codebase (e.g., locating API callers after a
  contract change)
- Cross-reference validation (e.g., checking the links in `AGENTS.md` across
  50 docs)
- Performance-critical operations where token usage matters

**Don't use when:**

- Single file operations (use the Read tool)
- Fewer than 5 files to process (individual tool calls are fine)
- Complex analysis requiring deep reasoning per file
- Files need interactive review

## Batch analysis

Use a script when a mechanical check spans many files. Read each file in the
script, keep the relevant findings, and print a compact report with file and
line references. Keep the full inputs available for follow-up inspection.

A text search cannot prove a semantic property, such as every query being
scoped to the current account or every endpoint being authorized, and it
cannot find every query shape. For such a verdict, use the repository's
dedicated audit or review skill, if it has one, and inspect each occurrence
against the repository's rule for it. A script can list the candidates; it
cannot clear them.

For API impact, inspect the changed routes and their request and response
schemas, including shared schemas the routes import, then trace the current
client contract (a generated client or shared types) to its callers with the
type checker or the repository's API review skill, if it has one. A text
match against a generated client path is not a reliable method-level impact
analysis.

## Example: cross-reference validation

**Goal:** find missing targets among simple `.md` links in agent instruction
files and docs.

**Programmatic implementation:**

```typescript
import fs, { globSync } from 'node:fs';
import path from 'node:path';

// Runs on Node 22.18+ (TypeScript and fs.globSync) or Bun.
// Drop dependency and build output.
const skip = (f: string) => /(^|\/)(node_modules|dist|build)\//.test(f);

// Find all agent instruction files
const instructionFiles = [
  ...globSync('**/AGENTS.md'),
  ...globSync('**/CLAUDE.md'),
].filter((f) => !skip(f));

// Find all markdown files in docs/
const docFiles = globSync('docs/**/*.md').filter((f) => !skip(f));

const brokenLinks: Array<{
  sourceFile: string;
  link: string;
  expectedPath: string;
  reason: string;
}> = [];

function extractMarkdownLinks(content: string): string[] {
  const linkRegex = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
  const links: string[] = [];
  let match;

  while ((match = linkRegex.exec(content)) !== null) {
    links.push(match[2]);
  }

  return links;
}

for (const sourceFile of [...instructionFiles, ...docFiles]) {
  const content = fs.readFileSync(sourceFile, 'utf-8');
  const links = extractMarkdownLinks(content);
  const sourceDir = path.dirname(sourceFile);

  for (const link of links) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue; // external URL
    // Absolute path from repo root, or relative to the source file
    const resolvedPath = link.startsWith('/')
      ? path.join(process.cwd(), link.substring(1))
      : path.join(sourceDir, link);

    if (!fs.existsSync(resolvedPath)) {
      brokenLinks.push({
        sourceFile,
        link,
        expectedPath: resolvedPath,
        reason: 'File not found'
      });
    }
  }
}

// Compact output
const totalFiles = instructionFiles.length + docFiles.length;
console.log(`✅ Scanned ${totalFiles} markdown files`);
console.log(`${brokenLinks.length === 0 ? '✅' : '❌'} Broken links: ${brokenLinks.length}\n`);

if (brokenLinks.length > 0) {
  console.log('Broken Links Found:\n');
  brokenLinks.forEach((b, idx) => {
    console.log(`${idx + 1}. ${b.sourceFile}`);
    console.log(`   Link: ${b.link}`);
    console.log(`   Expected: ${path.relative(process.cwd(), b.expectedPath)}`);
    console.log(`   Reason: ${b.reason}\n`);
  });

  console.log('\nNext Steps:');
  console.log('1. Fix broken links (update paths or restore missing files)');
  console.log('2. Consider using absolute paths from repo root');
  console.log('3. Re-run validation');
}
```

This simple regular expression does not parse the full Markdown link grammar;
inspect complex links separately.

## Best practices

### 1. Aggregate first, report later

```typescript
// ✅ GOOD - Process all, return compact summary
const results = files.map(processFile);
console.log(`Found ${results.filter(r => r.hasIssue).length} issues`);

// ❌ BAD - Report per file (verbose)
files.forEach(file => {
  const result = processFile(file);
  console.log(`File: ${file}, Status: ${result.status}, ...`); // Too verbose
});
```

### 2. Use the runtime's standard library

```typescript
import fs, { globSync } from 'node:fs';
import path from 'node:path';

// Built-in modules for file operations and pattern matching (Node 22.18+ or Bun)
// Avoid shell commands (less portable)
```

### 3. Handle errors explicitly

An unreadable input makes a validation pass inconclusive. Stop the scan with a
file-specific error; do not skip it and report zero findings from a partial
set.

```typescript
for (const file of files) {
  try {
    const content = fs.readFileSync(file, 'utf-8');
    // Process...
  } catch (error) {
    throw new Error(`Could not read ${file}`, { cause: error });
  }
}
```

### 4. Return structured data

```typescript
// ✅ GOOD - Structured, actionable
const violations = [
  { file: 'orders.service.ts', line: 45, issue: 'fetch() without a timeout' },
  { file: 'payments.service.ts', line: 78, issue: 'fetch() without a timeout' }
];

// ❌ BAD - Unstructured prose
console.log('Some files have issues, like orders.service.ts on line 45...');
```

### 5. Include next steps

```typescript
// Always provide clear next steps
if (issues.length > 0) {
  console.log('\nNext Steps:');
  console.log('1. Review violations above');
  console.log('2. Pass a timeout to each fetch() call');
  console.log('3. Re-run validation');
}
```

## Model Context Protocol tools are not callable from scripts

A script run through a shell cannot call Model Context Protocol
([MCP](https://modelcontextprotocol.io)) tools: the agent harness (Claude
Code, for one) has no bridge that lets a script call the agent's tools. When
several independent MCP lookups are needed, issue them as parallel tool calls
in one turn; if their results are large, write them to a file and filter or
aggregate that file in a script.

## Common patterns

### Pattern 1: file pattern matching

```typescript
import { globSync } from 'node:fs';

// Find all TypeScript service files
const services = globSync('src/**/*.service.ts');

// Find all frontend components
const components = globSync('web/src/components/**/*.tsx');

// Find all test files, without dependencies
const tests = globSync('**/*.spec.ts').filter(f => !f.includes('node_modules/'));
```

### Pattern 2: content analysis

```typescript
const content = fs.readFileSync(file, 'utf-8');
const lines = content.split('\n');

// Check for patterns
const hasImport = content.match(/import.*from ['"].*['"]/);

// Line-by-line analysis
lines.forEach((line, idx) => {
  if (line.includes('SELECT')) {
    console.log(`SQL query at line ${idx + 1}`);
  }
});
```

### Pattern 3: multi-file aggregation

```typescript
const summary = {
  totalFiles: files.length,
  violations: [] as Array<{file: string; issue: string}>,
  warnings: [] as Array<{file: string; warning: string}>,
  passed: [] as string[]
};

files.forEach(file => {
  const result = analyzeFile(file);
  if (result.hasViolation) {
    summary.violations.push({ file, issue: result.issue });
  } else if (result.hasWarning) {
    summary.warnings.push({ file, warning: result.warning });
  } else {
    summary.passed.push(file);
  }
});

// Compact summary
console.log(`Total: ${summary.totalFiles}`);
console.log(`Violations: ${summary.violations.length}`);
console.log(`Warnings: ${summary.warnings.length}`);
console.log(`Passed: ${summary.passed.length}`);
```

## Expected results

Processing every file in code and printing only a compact summary keeps the
per-file content out of context; the saving grows with the number of files.

## Limitations

**Not suitable for:**

- Deep semantic analysis per file (requires reasoning by the model)
- Interactive review workflows
- Complex refactoring (code transformation)
- Tasks requiring external knowledge

**Works best for:**

- Pattern matching and validation
- Structural analysis (imports, exports, function signatures)
- Cross-file aggregation
- Reference validation
- Impact analysis

## Requirements

- A JavaScript runtime the shell can start: Bun, or Node 22.18 or later (the first
  release that runs TypeScript files without a flag)
- File system access to the repository
- Built-in modules only: `node:fs` (including `globSync`) and `node:path`

## Intermediate result filtering

Filter large tool results to the fields needed for the task, while retaining
the original result for follow-up. Do not use a simulated validator or a
file-level string match as evidence that a query is safe.

### Common filtering patterns

```typescript
// Pattern 1: Map to compact format
const compact = largeResults.map(item => ({
  id: item.id,
  status: item.status,
}));

// Pattern 2: Filter + limit
const topErrors = results
  .filter(r => r.severity === 'error')
  .slice(0, 10);

// Pattern 3: Group and count
const grouped = results.reduce((acc, item) => {
  acc[item.type] = (acc[item.type] || 0) + 1;
  return acc;
}, {} as Record<string, number>);

// Pattern 4: Extract nested fields
const extracted = results.map(r => ({
  name: r.entity.name,
  owner: r.entity.owner_id,
}));
```
