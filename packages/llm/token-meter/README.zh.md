---
description: "由压缩、上下文显示与遥测共享的回放感知输入计量。"
kind: "package-reference"
---

# @deepseek-ai/dsh-token-meter

[English](README.md) | 中文

## 概述

使用 `ctx.tokenMeter`，根据持久用量与投影价格记录预测完整请求输入。测量、压力与构成使用同一个纯计算器；历史计费独立处理。显式捕获价格后，热读取、冷回放、恢复与分叉无需调用模型即可得到相同结果。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂载 `@deepseek-ai/dsh-token-meter` 及必需的 `sessionProjections` 服务。计量器没有配置。显式捕获价格可选用 `llm`，纯回放不使用它。适配器路由拥有容量与投影定价；压缩负责策略与事务时机。

### 测量压力

`measure(session, requestHeader?)` 返回独立、不可变的快照，不调用适配器，也不追加事件。`inputTokens` 及其兼容别名 `totalTokens` 仅预测输入。`outputReserveTokens` 单独预留未来输出。`surfaceTokens` 等于节点价格总和；`toolsTokens`、`quality`、`unattributedTokens` 与 `lastObservedPrompt` 解释完整预测。容量与可用空间属于同一生效路由。`estimateMessage(message)` 仍是替换影子价使用的固定启发式估算。

`refresh(session, requestHeader?, snapshot?)` 要求轮次打开且工具声明已记入日志，仅持久化变化的 `request/context` 事实。`preview` 不追加事件，返回 `{ measurement, context? }`，供空闲压缩事务在其开始事件中持久化。准备好的调用方通过 `snapshot` 提供回放／图片钩子、文件投影、输出预留，以及显式存在的 `toolUpdate`（undefined 表示不支持）。其他刷新解析运行时钩子，仅复用匹配请求头与路由记录的工具模式；未知工具投影保持不完整。图片记录包含保留／省略价格，文件保留准确的短句柄文本。工具记录计入历史／延迟声明和过滤后的 developer 消息，不复制工具声明。后续纯读取无需实时适配器或附件路径。

观测到的提示词输入是实际分发切点对应的 `inputTokens + cacheReadTokens + cacheWriteTokens`，不是 assistant 提交时的表面。压力绝不累计历史输入。符合条件的原生回放可以把自身已存储的输出用量作为提示；推理已包含其中，用量缺失时明确标为不完整。可比较的请求差值校准整个变化区间。细分节点的分配仍是估算，选择器必须保留完整的 `groups`，不能拆分共同观测的区间。

已记录的纯文本工具结果裁剪会把替换节点保留在原共同成本组中，保留整个旧组价格并加上替换内容的估算值，不扣除未经观测的份额。未知成本组仍标为不完整。会计版本变化时，压力和分解缓存会从未修改的日志重建。

### 会话投影

`tokenUsage` 按已结算尝试累计互斥计费桶，替换同一次尝试的重复样本，不重复计算推理。`llm/retry-started` 区分计费尝试。`contextPressure` 发布共享输入预测、证据质量、匹配容量、输出预留，以及带路由的最新历史输入。只有观测与预测校准匹配时，兼容别名 `pressureTokens` 才存在。卸载会移除全部三个注册。

`contextBreakdown` 把最后一个非空、存活的系统节点归为系统成本，其余节点归为消息成本。它与测量使用相同的原生／媒体价格，也处理没有计量声明的替换。分类是估算，不会缩放成提供方总量；全局剩余成本保持可见的未归属状态，不会被编造成精确的单节点价格。图片省略切换已存储的出现位置价格，不改变消息标识或启发式影子价。媒体价格记录缺失时，在显式捕获前保持不完整。

`deriveTurnTokenUsage(events)` 把完整轮次折叠为供浏览器使用的精确逐次尝试与整轮计费。生命周期证据缺失、计数不安全或精确总量冲突时不返回结果；只有每次参与的尝试都报告对应值时，才出现可选汇总。

### 解读数字

显示与压缩读取同一个预测。不得把历史观测与另一模型的容量配对、把输出用量解释为未来输出预留，或把不完整价格当作安全上界。旧日志仍可读取，但请求切点重建明确属于尽力估算。压力决策前必须显式捕获其原生／媒体价格；纯读取绝不追加这些事实。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

一个纯 fold 保留紧凑的当前节点、路由标识、投影价格、共同成本组与最新输入观测。步骤内的稀疏撤销记录可以在流式输出期间接纳输入或发生替换时重建实际分发切点。它不存储原生回放数据、凭据或消息正文。格式错误的转换会抛出，且不改变之前的状态。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 纯测量与显式 refresh／preview 操作 |
| [`src/accounting.ts`](src/accounting.ts) | 共享请求切点 fold 与完整输入计算器 |
| [`src/estimate.ts`](src/estimate.ts) | 固定文本／内容与影子价启发式规则 |
| [`src/surface-fold.ts`](src/surface-fold.ts) | 位置表面规划与验证 |
| [`src/surface-projection.ts`](src/surface-projection.ts) | 独立的启发式影子价协议 |
| [`src/usage-projection.ts`](src/usage-projection.ts) | 计费与压力投影 |
| [`src/breakdown-projection.ts`](src/breakdown-projection.ts) | 来自同一计量计算的构成 |
| [`src/turn-usage.ts`](src/turn-usage.ts) | 精确逐次尝试与轮次计费 |

压力与构成检查点包含紧凑计量状态，并丢弃旧检查点版本。当前节点读取为 O(保留表面)，不会重新扫描完整会话日志。原生回放价格引用已有的自身输出用量，不持久化重复 token 数。独立的启发式影子价协议保持原有含义与验证。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Token 计量子系统](../../../docs/subsystems/token-meter.zh.md)——公开测量类型。
- [LLM 服务](../llm/README.zh.md)——准备好的调用与提供方拥有的投影定价。
- [压缩](../../../docs/subsystems/compaction.zh.md)——选择与事务所有权。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-compaction-basic` 等消费方；服务本身不添加提示词、消息、schema、工具或模型调用。

#### KV Cache 影响

不直接失效；请求前缀变更属于消费方。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制适用于预测，不适用于历史计费。

- 没有可复用观测的可见文本使用近似字符密度启发式规则，而非提供方分词器。
- 原生输出用量是回放提示，不是普遍精确的未来输入。资格未知或用量缺失时保持不完整。
- 剩余观测输入不会作为精确成本分配到单节点。移除未测量区域的一部分不能证明必然释放空间。
- 测量会克隆当前节点；读取与检查点大小为 O(保留表面)。稀疏的进行中变更可能保留被替换的紧凑节点，直到步骤结束。
- envelope、路由、定价标识或媒体价格变化可能使校准失效。路由没有提供容量或输出预留时，相应值保持缺失。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
