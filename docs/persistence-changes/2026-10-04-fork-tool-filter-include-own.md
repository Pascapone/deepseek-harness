---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-04-fork-tool-filter-include-own

English | [中文](2026-10-04-fork-tool-filter-include-own.zh.md)

## Summary

Subagent descriptors retain the optional includeOwn flag in their toolFilter settings.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-04-fork-tool-filter-include-own
baseline: false
changes:
  - root: "event:subagent/descriptor"
    previous: "2026-09-11-initial"
    after: "4e0a4d434b7b9623312e634c4f5099627cbb1f2657cd532a31290d2e50e50181"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

This optional boolean extends event:subagent/descriptor without changing required fields or the Session writer format. An absent flag preserves the inherited-tool-only filter. Setting it to true also filters registrations owned by that exact scope, while descendant-owned tools and the reserved PTC transport remain exempt. Existing format-4 generations are not rewritten.

<a id="verification"></a>
## Verification

The persistence classifier reports one optional-property-added transition and no required version bump. All 28 scoped-tool tests pass, including direct registration masking, global-shadow exclusion, and filter disposal. The 46 in-process subagent tests pass. Exact bilingual declarations pass verify-type-equiv.

<a id="dev-note"></a>
## Dev Note

None.
