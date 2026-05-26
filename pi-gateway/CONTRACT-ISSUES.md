# RPC Contract Issues

Differences between `1.md` design document and actual pi RPC behavior, discovered during Phase 0.5 validation.

## Resolved

| Issue | Design | Actual | Resolution |
|-------|--------|--------|------------|
| streamingBehavior enum | `["steer", "default"]` | `["steer", "followUp"]` | Updated code to use `"followUp"` to match pi RPC |

## Open

None
