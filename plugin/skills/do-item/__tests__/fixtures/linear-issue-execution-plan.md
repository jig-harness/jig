## Execution Plan

### Recommended Execution Order
1. ENG-1 and ENG-2 in parallel
2. ENG-3 after ENG-1

```execution-plan-v1
{
  "epic": "ENG-100",
  "intent": "Deliver the scoped workflow",
  "steps": [
    {
      "issue": "ENG-1",
      "band": 1,
      "lane": "schema",
      "gate": "agent"
    },
    {
      "issue": "ENG-2",
      "band": 1,
      "lane": "copy",
      "gate": "human"
    },
    {
      "issue": "ENG-3",
      "band": 2,
      "lane": "consumer",
      "gate": "agent"
    }
  ],
  "edges": [
    {
      "from": "ENG-1",
      "to": "ENG-3",
      "kind": "dependency",
      "reason": "consumer requires schema",
      "completion": "done"
    }
  ],
  "gates": [
    {
      "issue": "ENG-2",
      "gate": "human",
      "reason": "approve copy"
    }
  ]
}
```
