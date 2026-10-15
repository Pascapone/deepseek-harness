---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-14-compaction-input-accounting

English | [中文](2026-10-14-compaction-input-accounting.zh.md)

## Summary

Adds optional dispatch references and scoped pricing facts to assistant settlements, request context, and manual compaction openings.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-14-compaction-input-accounting
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "44c6909dd7cdaafad3777755affa5703dddbe3db9068b7393b7ca7eb040b8651"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "d240fce72a0b3d867ebd9c3574cb5477994a734dd4f0a8c80aaa3ebd9b40a48e"
    decision: same-version
  - root: "event:compaction/start"
    previous: "2026-09-11-initial"
    after: "4743dcdb58937e88bb068f94c608a881906c04af367de8cc6d90c977347cd1bb"
    decision: same-version
  - root: "event:request/context"
    previous: "2026-09-11-initial"
    after: "f88e7b8bf60b8d44e3350cfa891d5e3934133248de3116d0e2f9666f1e4bf2a1"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing events remain readable without these fields. The log keeps its current writer version and unchanged surface/shadow-price meaning. Pricing facts contain only scopes, counts, message references, and short attachment handles, never copied native reasoning or credentials. Missing facts remain explicit estimates; native output usage is a replay hint, not an exact future-input count. Standalone compaction carries optional pricing inside its existing opening event without changing historical turn relationships.

<a id="verification"></a>
## Verification

Focused runtime, Session accounting, and dispatch-freeze checks passed 29 tests. The actual Loader/loop/Settings/JSONL acceptance and dispatch tests passed 10 tests, including independent opaque-input billing, safe compaction, provider-unloaded cold replay, and fork agreement. Current fact validation rejects unsupported versions, malformed modes, nonfinite counts, and invalid dispatch references. Historical generation files are unchanged.

<a id="dev-note"></a>
## Dev Note

None.
