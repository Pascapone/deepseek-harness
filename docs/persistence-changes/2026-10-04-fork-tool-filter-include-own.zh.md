---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-04-fork-tool-filter-include-own

[English](2026-10-04-fork-tool-filter-include-own.md) | 中文

## 概述

子 agent 描述符在 toolFilter 设置中保留可选的 includeOwn 标志。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

这个可选布尔字段扩展 event:subagent/descriptor，不改变必填字段或 Session 写入格式。标志缺省时仍只过滤继承来的工具；设为 true 时还会过滤该作用域自身拥有的注册，而后代作用域拥有的工具和保留的 PTC 传输仍不受限制。已有格式 4 的历史记录不会被重写。

<a id="verification"></a>
## 验证

持久化分类器只报告一项 optional-property-added 变化，无需提高版本。28 项作用域工具测试全部通过，包括直接注册屏蔽、不暴露全局同名工具以及过滤器卸载。46 项进程内子 agent 测试通过。双语精确声明通过 verify-type-equiv。

<a id="dev-note"></a>
## 开发备注

无。
