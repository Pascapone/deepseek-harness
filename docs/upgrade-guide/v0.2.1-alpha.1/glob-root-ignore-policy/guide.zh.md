---
kind: upgrade-guide
description: 宽泛的工作区 glob 扫描默认包含被忽略文件，除非部署显式选择 respect 策略。
---

# 宽泛 glob 的忽略策略

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-tool-fs-search` 不再为未过滤的工作区根目录发现硬编码部署专用的忽略策略。默认情况下，`glob` 对所有模式都包含被忽略文件，同时保留隐藏文件支持与 VCS 元数据排除。工具描述反映解析后的配置。

## 迁移

1. 要保留此前的宽泛扫描行为，在每个搜索工具行现有的 `config` 中设置 `globRootIgnorePolicy: respect`。保留 `sampleOverCapGlobResults` 与其他配置值。
2. 对预设持有的搜索行分别应用此选择：根级行配置不会覆盖预设自己的行。候选 Ponytail bundle 与保留的预设设置均显式选择 `respect`。
3. 确认在 `respect` 下，未指定路径或 `path: .` 时，`*` 与 `**/*` 遵循忽略文件。更具体的模式和显式子目录仍包含被忽略文件。选择 `include` 或移除此选项即可恢复原生发现行为。移除 bundle 的配置贡献与卸载提示词插件不同：显式配置的搜索工具行会保留策略，直到配置被修改。
