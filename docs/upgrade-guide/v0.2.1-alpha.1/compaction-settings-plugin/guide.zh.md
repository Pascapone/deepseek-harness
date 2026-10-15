---
kind: upgrade-guide
description: 原生压缩保留设置的 Loader 入口与编辑器迁移到独立安装的插件。
---

# 压缩保留设置插件

[English](guide.md) | 中文

## 变更

移除 `@deepseek-ai/dsh-compaction-basic/retention-settings` 的运行时入口和内置「上下文与压缩」编辑器。相同子路径现在只导出可选的 `CompactionRetentionProvider` TypeScript 接口。没有提供方时，原生压缩继续使用其配置默认值。

配套 `@pascapone/dsh-compaction-settings` 插件持有全局持久偏好与编辑器。宿主行保留 `compaction-retention` 标识及原子的 `retention` 模式和值。精确模型策略、修订检查和引擎预算验证保留原有优先级与行为。

## 迁移

1. 将配套插件与匹配的 Core 候选一起构建并提供；安装或激活仍需遵循单独授权的环境流程。
2. 对显式引用 `@deepseek-ai/dsh-compaction-basic/retention-settings` 的每个 profile patch 或 overlay，仅将 `name` 改为 `@pascapone/dsh-compaction-settings`。保留 `id: compaction-retention` 与完整的已保存 `config`，包括 `config.retention`。较高 profile 层会替换整行配置，不能用空对象覆盖已保存偏好。
3. 如果 profile 只依赖被移除的基础 bundle 行，则添加配套 bundle，并保留现有针对 `compaction-retention` 的 patch。只挂载一个偏好提供方。
4. 确认编辑器仍显示已接受偏好及修订号，切换 Token／比例模式只持久化一个生效模式，下次压缩记录预期保留设置。没有插件时，确认使用原生 Agent 配置。

自定义 UI 插件应仅为明确需要持久化的偏好，将移除的远程浏览器隐式例外改为 `ctx.configForms.get(namespace, { persistence: 'host' })`。该选项请求作用域读取，不授予宿主权限或配置文件访问权。
