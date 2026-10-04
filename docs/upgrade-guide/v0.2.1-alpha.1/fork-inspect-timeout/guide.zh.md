---
kind: upgrade-guide
description: "使用 inspectQueryTimeoutMs 的 fork 配置必须改用 clientInspectTimeoutMs。"
---
# Client 检查超时配置

[English](guide.md) | 中文

## 变更

Fork 的 `inspectQueryTimeoutMs` 配置键改为 `clientInspectTimeoutMs`，与 upstream 一致。默认值从 30000 毫秒改为 10000 毫秒。`inspectQueryErrorGraceMs` 保留 250 毫秒的默认值，以及首个失败后不可重置的宽限期。装载 Gateway 但没有连接页面时，现在会在发送前失败。

## 迁移

1. 在每个配置 `@deepseek-ai/dsh-cordis-host-runner` 的 profile patch 或 overlay 中，将 `inspectQueryTimeoutMs` 改为 `clientInspectTimeoutMs`。
2. 如果部署需要原有期限，显式设置 `clientInspectTimeoutMs: 30000`。保留任何显式的 `inspectQueryErrorGraceMs` 设置。
3. 打开已连接的 Harness 页面，执行一次 Client `cordis_inspect_query`。确认有效响应成功，没有响应的查询在配置期限内结束。没有页面时的失败须在重新连接后重试。
