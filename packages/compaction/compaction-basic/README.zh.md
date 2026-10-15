---
description: "面向部署场景的自动会话压缩（compaction）：用于选择、调优或排查随 token 压力上升对较早历史进行摘要的方式。"
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-basic

[English](README.md) | 中文

## 概述

本包压缩较早历史并保留近期消息。自动压力检查、已确认溢出后的恢复以及 `/compact` 使用相同的输入计量。可选剪枝能够避免模型调用；否则有界摘要请求处理选定历史，并保留摘要文本。系统头节点保持不变，工具调用／结果对以及共同测量的成本组不能拆分。

类型导出 `./retention-settings` 中的可选 `CompactionRetentionProvider` 提供独立的全局覆盖快照，并接收引擎持有的同步验证器。设置 schema、持久化与 UI 由提供方插件负责；没有提供方时，引擎使用原生配置。精确模型覆盖仍优先；操作快照、计量、容量检查及安全历史选择仍由引擎负责。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已提供 LLM（大语言模型）、会话存储与 token 测量的组合中挂载本包，即可获得自动会话压缩。随附 `dsh` 基础配置默认启用它；需要控制压缩发生的时机时请显式挂载。

### 你会得到什么

默认设置下你会获得四种行为：会话向模型上下文上限增长时自动压缩；提供方确认上下文溢出错误后的恢复（先压缩再重试该请求）；通过 `/compact` 命令按需压缩；以及——挂载修剪器时——压缩前对超大工具输出的修剪。

### 最小可用组合

挂载会话存储、token 测量、可选修剪器、本后端，以及可选的按需命令：

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-token-meter'
- name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
- name: '@deepseek-ai/dsh-compaction-basic'
- name: '@deepseek-ai/dsh-command-compact'
```

你可以通过观察会话越过本来会溢出的位置继续工作、以及运行 `/compact` 立即压缩一次来确认成功。如果组合缺少 LLM、会话存储或 token 测量，插件会加载失败。同一个后端可以服务上下文大小不同的模型；用按模型覆盖为每条路由设置各自的阈值与保留：

```yaml
- name: '@deepseek-ai/dsh-compaction-basic'
  config:
    thresholdRatio: 0.8
    retainRatio: 0.16
    modelPolicies:
      - provider: local
        model: small-context
        thresholdRatio: 0.7
        retainTokens: 2048
```

### 调整压缩开始的时机

所有设置都可选。设上下文窗口为 `W`、准备好的响应预留为 `O`、余量为 `B`，默认触发阈值为 `floor(min(W × 0.8, W − O − B))`，其中 `B = 65,536` tokens。近期历史保留目标是 `W − O` 的 16%，并保持完整单元。[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-compaction-basic)还列出字段类型。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `thresholdRatio` | `0.8` | 用于 `floor(min(W × thresholdRatio, W − O − headroomTokens))` 的窗口比例。 |
| `headroomTokens` | `65536` | 触发余量和压缩后期望释放的空间；必须为非负整数。 |
| `retainRatio` | `0.16` | 以 `W − O` 的一部分表示逐字保留的近期对话；与 `retainTokens` 互斥。 |
| `retainTokens` | — | 逐字保留的近期对话绝对预算；与 `retainRatio` 互斥，并且必须低于已解析阈值。 |
| `summarizationProvider` | `''` | 与 `summarizationModel` 一起设置；空对使用最新已路由请求目标，再回退到 `AgentOptions` 对。 |
| `summarizationModel` | `''` | 与 `summarizationProvider` 一起设置；空对使用最新已路由请求目标，再回退到 `AgentOptions` 对。 |
| `maxTokens` | `headroomTokens`（`65536`） | 正数摘要上限；准备好的提供方预留还可能包含额外推理。显式模型上限优先于显式全局上限。 |
| `compactionRetries` | `1` | 摘要调用最多为此值加一，包含分块与恢复重试。 |
| `maxOverflowRetries` | `1` | 已确认上下文窗口溢出后的最大重试次数；`0` 只禁用恢复。 |
| `modelPolicies` | `[]` | 针对个别模型路由的精确 `{ provider, model, ...partialPolicy }` 覆盖。 |
| `auto` | `true` | 启用自动压缩与溢出恢复；设为 `false` 则仅手动执行。 |

配置错误会快速失败：未知设置、重复的按模型覆盖、无效 token 数、两种保留形式同时出现，或保留比例不小于阈值比例，都会在加载时拒绝插件。模型首次使用时，`W − O − B` 必须为正，且解析出的保留预算必须低于触发阈值。余量为零时，必须在全局或对应模型策略中显式设置正数 `maxTokens`。小窗口部署必须配置适合其容量的余量；降低 `thresholdRatio` 可以提早压缩。

### 压缩运行时会发生什么

选定的较早范围变为有框定标记的摘要，近期尾部保持逐字不变。超大输入使用安全的有界分块，后续分块包含前一检查点；完成前必须压缩全部最初选定的节点。后端随后刷新并检查完整的估算输入。低于压力时没有有用范围则不做操作；临界输入没有安全范围、调用次数耗尽或目标未达到时抛出 `CompactionBudgetError`。后续分块失败时，先前已提交的进展仍然持久有效。

单独的已有检查点绝不再次摘要；检查点与新增原始历史一起仍可选。每次操作固定一个低于触发阈值的目标：期望释放量使用已有余量，但最多为当前固定输入、完整保留单元与最小检查点成本之上区间的一半。余量为零时保留触发阈值减一的目标。最低成本空间不足时，在付费摘要前失败；检查点变小本身不代表成功。活动锁仍报告 `busy`。

### 通过 /compact 按需压缩

挂载 `dsh-command-compact` 后，`/compact` 在低于压力阈值时也可运行，并预留空闲接纳直到清理与 flush 完成。轮次中或并发压缩时报告不可用；已接纳的提示词会等待。手动操作遵守显式配置、Settings 或模型保留设置；只有继承的隐式保留使用旧有零 token 目标。空闲定价与最近使用的保留设置持久化在 `compaction/start.pricing`，不写空闲 `request/context`，也不制造轮次。

### 修剪超大工具输出

在本包之前挂载 `dsh-compaction-tool-result-pruner`，即可在压缩过程中修剪超大工具结果。修剪不发起模型调用，并可能完全省去摘要：当修剪后的对话在阈值之内时，压缩会跳过摘要。修剪只在压缩触发条件满足后运行——低于压力的对话绝不会被触碰。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释后端背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该后端建立在四项承诺之上：

- **一个测量服务为每个决策定价。** 开放轮次中的决策显式刷新持久的原生、媒体与工具投影价格；空闲操作先预览。压力、保留、选择与缩减检查使用共享纯预测。完整的校准组保持不拆分，替换影子价仍保留独立的启发式含义。
- **日志记录的标记对就是事务。** 所有入口点共享一个先记录标记的区域事务：验证范围与活动锁，同步追加 `compaction/start`，准备并等待摘要，重新验证，再追加 `compaction/summary` 与替换，最后恰好进行一次闭合尝试。自动调用与显式范围调用要求数字标识的开放轮次归属与整个表层稳定；`compactNow()` 会预留空闲接纳，使用 `turn: null`，允许所选 span 之外追加仅追加上下文，flush 每次已闭合尝试，并在 `finally` 中释放接纳预留。
- **摘要保留兼容前缀。** 系统头节点、已路由工具与选定消息按原历史回放，不重新编写。相同目标的推理强度会保留，不使用模型名称白名单；路由特定的工具投影决定提供方能否复用此前缀。
- **`summarize()` 是唯一的子类钩子。** 基于模板或远程摘要器的子类可以覆盖它，同时压力、保留、被引用的源事件、缩减验证与已遮蔽 token 计量仍由 token meter 负责。

### 自动触发与溢出恢复

当 `auto: true` 时，串行 `agent/pre-step` listener 会在请求派生前检查压力：它通过 `ctx.tokenMeter` 为最新持久路由请求 envelope 定价，当压力越过路由模型的阈值时，先剪枝，再在保留已定价近期尾部的同时摘要最旧的平衡范围。每个选定范围都从第一个不是 `system/message` 的 surface 节点开始，因此位于 surface 节点 0 的系统提示词永不会被遮蔽；由历史内提示词更新追加的后续 `system/message` 是普通历史，范围可以遮蔽它，agent loop（智能体循环）的投影随后会在二者文本不同时用当前提示词替换节点 0（[决策规则](../../core/agent-loop/README.zh.md#understand-the-implementation)）。`agent/request-error` listener 响应提供方确认的 `CONTEXT_WINDOW_EXCEEDED`：它绕过常规阈值与保留策略，尝试一次最大平衡头部缩减，并且只在表层替换 generation 前进后才授权重试。取消全程保持最终决定权。

压力策略从持久路由的适配器解析容量。目标特定配置错误保留原有警告行为。预算失败会重新抛出，不变成警告后继续另一条无效请求。在临界付费压缩前，未知原生或媒体输入必须先定价或省略。未归属的观测剩余成本完整保留；只有剩余成本不完整时仍属于估算，而非保证的实际释放量，也绝不触发付费用量探测。

### 摘要机制

默认摘要器准备已配置的提供方／模型对，再回退到已记录路由与 `AgentOptions`。分发前，用完整的投影前缀、系统、工具、指令、原生／媒体输入、剩余成本与准备好的响应预留验证已知容量。超大不可分单元在付费调用前失败。分发使用同一个单次使用的 `PreparedLlmCall.stream` 和已捕获的工具历史；会使准备预算无效的 middleware 重新路由被拒绝。覆盖 `summarize()` 的模板子类绕过这项 LLM 预检，自行负责外部调用预算。

尾随指令是冻结的 `RequestUserInput`，没有持久身份或来源，purpose 为 `compaction`。只有返回文本进入 `<compacted-summary>` 检查点；原始输出与用量保留在摘要事件中。推理与工具调用不进入检查点，图片输出以 `UNSUPPORTED_CONTENT` 失败。[共享压缩参考](../../../docs/subsystems/compaction.zh.md#input-budgets-and-bounded-summaries)定义计量与有界摘要语义。

### 区域事务

摘要请求失败后，后端先检查取消和选区稳定性，再触发同步的 `compaction/summary-error`。恢复监听器必须先记录持久的输入变更，才能请求重试。后端重新派生所选消息，更新 token 价格及判断摘要是否缩短输入的基准。图片省略插件负责选图；后续摘要失败或取消后，已经记录的省略仍然有效。

事务验证表层范围与持久锁，追加 `compaction/start`，通过钩子生成摘要，重新验证稳定性（自动调用要求整个表层、手动调用只要求所选范围），拒绝不缩小源内容的摘要，追加 `compaction/summary` 与替换 `user/message`，并恰好进行一次 `compaction/end` 尝试。活动的未匹配 start 是持久锁：位于较新 `session/end-seed` 之前的未匹配标记是先前生命周期留下的陈旧证据，不会阻塞；位于该边界之后的标记报告 `busy`。闭合失败会有意留下阻塞性的未匹配标记。完成清理与持久化后，取消仍具有最终决定权。

### 配置解析

`resolveConfig` 验证默认值；`resolveTargetPolicy` 在精确模型覆盖之下快照全局 Settings 保留设置。模式切换移除不生效的固定值／比例形式，拥有的活动模型或缓存模型预算在 Settings 持久化前同步验证。`resolveCompactSpec` 使用路由容量和已捕获的提供方调整预留。旧有会话策略可以从请求头上限、适配器默认值或零估算预留；这项回退绝不持久化为实际预留，没有实际预留时可用空间保持未知。付费默认摘要要求已知准备容量与预留。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`BasicCompactionEngine`、自动 listener、入口点分发 |
| [`src/region.ts`](src/region.ts) | 保留选择与共享的先记录标记压缩事务 |
| [`src/summarizer.ts`](src/summarizer.ts) | 准备好的 LLM 预检与分发、检查点框定、安全摘要投影 |
| [`src/config.ts`](src/config.ts) | 加载时验证与路由模型策略解析 |
| [`src/types.ts`](src/types.ts) | `BasicCompactionConfig` 与已解析策略词汇 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从共享 seam 逐步进入可选配套工具与决策证据。

- [压缩 seam](../compaction/README.zh.md)——本后端实现的压缩约定。
- [压缩子系统参考](../../../docs/subsystems/compaction.zh.md)——压缩词汇、结果与服务行为。
- [工具结果修剪器](../compaction-tool-result-pruner/README.zh.md)——先修剪超大工具输出的可选配套工具。
- [人类 /compact 命令](../command-compact/README.zh.md)——无需等待压力的按需压缩。
- [Token meter](../../llm/token-meter/README.zh.md)——决定何时压缩的测量服务。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-compaction-basic)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 会话历史

#### 模型看到的内容

成功步骤越过阈值后，如果已加载可选修剪器，超大工具结果会先被改写。如果仍需摘要，下一个请求会收到下方检查点前导、一个空行、`<compacted-summary>`、根据数据生成的摘要以及 `</compacted-summary>`。溢出恢复会根据使表层前进的任何替换重建立即重试。检查点会替换已选较早范围，后面跟随已保留的近期单元。

##### 会话检查点前导

```markdown
This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.
```

#### Token 影响

不依赖模型的剪枝可以完全避免辅助调用；否则它会在摘要替换较早范围之前缩减该调用的 transcript（文本记录）。替换会缩减未来输入历史，而非追加第二份副本。摘要会保留到后续压缩将其替换，但不可分的非工具单元仍可能超出预算。

#### KV Cache 影响

它是替换，而非仅追加。每个检查点都会使从第一个已替换历史 token 起的复用失效；该范围之前未更改的请求前缀仍可复用。

### 辅助摘要器请求

#### 模型看到的内容

摘要模型接收系统头节点与选定前缀，其中工具声明和 developer 更新按其路由投影，随后是下方压缩指令。后续分块包含前一检查点。会话只接收摘要文本；完整输出仍记入日志供诊断。

##### 压缩指令（最终 user 消息）

```markdown
You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.

Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.

## Primary Request and Intent
- [the user's original and evolving goals; quote verbatim where the exact wording matters]

## Key Technical Concepts
- [technologies, frameworks, patterns, and conventions in play]

## Files and Code
- [exact path: why it matters, key changes or snippets]

## Errors and Fixes
- [error: how it was resolved, plus any related user feedback]

## Pending Jobs
- [explicitly requested work not yet completed]

## Current Work
- [precisely what was in progress at this checkpoint]

## Next Step
- [the single next action, directly in line with the most recent request, or "(none)"]

## Critical Context
- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]

Rules:
- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.
- Capture user feedback and explicit instructions faithfully, especially corrections.
- Do NOT mention this summarization request or that the context was compacted.
- Output only the checkpoint text: do not call any tool or take any other action.
- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.
```

#### Token 影响

每次有界调用支付其回放前缀与固定指令的成本，提供方准备好的响应预留计入输出及额外推理。分块与持久输入恢复共享已配置的摘要调用额度。

#### KV Cache 影响

兼容的系统、工具投影、历史与相同目标的推理控制允许复用尾随指令之前的前缀。目标、投影、检查点变化或非头部选择可能放弃复用；不保证 cache 命中。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>


这些限制说明自动压缩何时不合适，或何时需要特别注意；它们是当前包约束。

- **计量准确度取决于固定启发式规则**——可复用提供方用量缺失时，会回退到字符数加结构开销，而非精确的 token 化；只有在适配器声明了请求图片定价的路由上，图片出现处才携带提供方精确的视觉 token。
- **溢出分类由适配器维护**——提供方措辞可能改变；两个 DeepSeek 适配器将可识别的上下文限制失败规范化为 `CONTEXT_WINDOW_EXCEEDED`。
- **固定或不可分输入可能阻止修复**——系统头节点成本、活动工具声明、保留单元或单个超大安全单元可能使目标不可行。目标检查保守地保持当前工具成本固定，即使替换 developer 历史能够移除已停用声明。可选 pruner 可以在不拆分工具对的前提下减少工具结果文本。
- **`compactRegion` 要求存在未结束的轮次**——在完全关闭的会话上手动调用会抛出异常（「no open turn」），而不是执行压缩。
- **失败保留已提交进展**——剪枝与已完成分块保持持久有效。运行摘要失败保留原有警告行为；`CompactionBudgetError` 会停止自动继续，而非宣称较小检查点解决了临界输入。缺失或不完整价格不是安全上界。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性；已交付行为以上文、包代码与所链接的 Agent Note 为准。

- **默认比例，尚未决定**——`thresholdRatio: 0.8` 与 `retainRatio: 0.16` 是固定默认值；存在通过 `modelPolicies` 进行的按模型调优，但没有基于语料的理想值指引记录。
- **tokenizer 精确测量，暂缓**——token meter 每 token 四字符的启发式对 CJK 文本与 JSON Schema 定价偏低；精确 token 化仍是测量服务的开放方向。
- **规范错误之外的溢出恢复，尚未决定**——恢复仅针对 `CONTEXT_WINDOW_EXCEEDED` 触发；其他提供方侧上下文失败不参与分类。

</details>
