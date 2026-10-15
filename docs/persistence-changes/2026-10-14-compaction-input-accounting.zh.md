---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-14-compaction-input-accounting

[English](2026-10-14-compaction-input-accounting.md) | 中文

## 概述

为助手结算、请求上下文和手动压缩开始记录添加可选的派发引用与限定范围的计价事实。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

缺少这些字段的已有事件仍可读取。日志保持当前写入版本，消息表面和 shadow-price 的含义不变。计价事实只包含范围、计数、消息引用和简短的附件句柄，不复制原生推理或凭据。缺失事实明确标记为估计；原生输出用量只是回放提示，并非未来输入的精确计数。独立压缩在已有开始事件中携带可选计价信息，不改变历史回合关系。

<a id="verification"></a>
## 验证

运行时、Session 计价和派发冻结的针对性检查通过了 29 项测试。实际 Loader、循环、Settings、JSONL 验收及派发测试通过了 10 项测试，覆盖独立的不透明输入计费、安全压缩、卸载提供方后的冷回放以及分叉一致性。当前事实验证拒绝不支持的版本、格式错误的模式、非有限计数和无效派发引用。历史版本文件未变更。

<a id="dev-note"></a>
## 开发备注

无。
