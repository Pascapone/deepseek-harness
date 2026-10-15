---
kind: upgrade-guide
description: "Token 计量改为仅输入预测，压缩要求完整计价的输入与明确的回答预留。"
---

# 仅输入计量与持久化保留设置

[English](guide.md) | 中文

## 变更

以前，`TokenMeasurement.totalTokens` 包含请求与回答压力，而展示使用单独的 usage 锚定近似值。现在它是共享 `inputTokens` 预测的别名。上次观测的提供方输入、当前预测、质量与未来输出预留是独立值。检查点更小不再能证明预算已充分释放。

新增的可选调度引用与带 scope 的定价收据保留实际请求切点、原生回放资格、媒体表示及投影工具。旧日志仍可读取，不会补造提供方证据；缺失覆盖的估算保持不完整。历史用量不变，推理仍是输出的子集。

## 迁移

1. 更新计量消费方，分别读取 `inputTokens`、`quality`、`lastObservedPrompt` 与 `outputReserveTokens`。不要把历史输出加入输入，不要累加过去的提示词观测，也不要把不完整成本显示为安全上界。计费继续使用累计用量投影。参见 [Token 计量](../../../subsystems/token-meter.zh.md)。
2. 用打开轮次中的显式 `refresh()` 替换通过 `measure()` 隐式查询实时报价的行为。刷新前先在 `request/header` 记录变化后的生效工具。空闲维护之前使用 `preview()`，并把捕获的 context 保存在 `compaction/start.pricing`；普通读取保持纯函数。
3. 更新自定义 adapter，把回放/图片定价、原生路由身份及回答预留计算绑定到与调度相同的已准备代次。明确未知的预留应保持未知，而不是换成普通生成上限。已准备调用拒绝后续 `llm/stream` 调用配置改写。参见[已准备调用](../../../subsystems/llm-streaming.zh.md#service-and-provider-contracts)。
4. 使用设置 → 上下文与压缩，选择固定 Token 数或上下文容量减去回答预留后的百分比。切换模式移除固定 Token 值的优先级；模型专用策略仍然优先。保存的修改影响下次压缩，不影响正在运行的操作。自定义组合必须挂载[保留设置所有者](../../../../packages/compaction/compaction-basic/src/retention-settings.ts)才能提供该偏好。
5. 为摘要路由提供真实上下文容量与已知的已准备回答预留。预算覆盖完整摘要输入，包括指令、投影工具、原生回放、媒体及检查点包裹。不要静默改路由到另一提供方。有界摘要可能已提交进展但仍报告预算不可达；应处理该失败，而不是重试单独的检查点。
6. 确认固定/比例设置持久化、保存前拒绝不符合已知模型预算的值，以及运行中快照不变。比较相同请求事实的实时与冷回放，包括缺失 usage 和切换路由的情况。[压缩参考](../../../subsystems/compaction.zh.md#input-budgets-and-bounded-summaries)定义安全范围与完成行为。
