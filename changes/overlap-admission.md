---
release: minor
---

### Changed

- **Breaking:** The dispatcher orders ready pickups by overlap with work in flight and how long each pickup has waited. A free slot can take overlapping work. The retired `dispatch.epic_width` key is ignored and the dispatch receipt points to `dispatch.overlap`. **Consumer action:** advised at configuration, instructions. Remove `dispatch.epic_width` and update runbooks that use it. To require one child at a time, use execution plan dependency edges or a serialized area. Configure `dispatch.overlap` to tune shared-file admission. **Detect:** `config:dispatch.epic_width`.
- The advice to set an epic width of 1 is obsolete. **Consumer action:** retracts 0.244.0#b4855f8e.
