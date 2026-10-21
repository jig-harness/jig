| Stage | Owner | Hands on |
|-------|-------|----------|
| both | `bun run gates && bun run lint` | a run |
| second | `bun run gates && bun run nope` | a run |
| after | `bun run gates; /jig:gone` | a run |
| quoted | `bun scripts/check.ts --message 'first;second && third'` | a run |
