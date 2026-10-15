---
kind: upgrade-guide
description: "Desktop browser integrations configure carrier requirements through the native Browser entry and consume its public protocol types."
---
# Desktop 浏览器注册策略

[English](guide.md) | 中文

## 变更

原生 Browser 不再读取 `__DSH_NATIVE_BROWSER_HOST__`。启用的 `ui-sidebar-browser` 条目改为接受 `config.requireDesktopBridge`，默认值为 `false`。设为 true 时，缺少受支持 Desktop bridge 的 Client 不注册 Browser tab、开始页入口或快捷键。默认仍保留现有 iframe 回退。原生 Guest 权限及 Session 数据不变。

Main/Host 浏览器消息从 `@deepseek-ai/dsh-client-ui-sidebar-browser/types` 导出。MCP provider 使用现有公开的 `SessionMcpOptions` 和 `mountSessionMcp` 类型，不再维护本地副本。

## 迁移

1. 同时更新 fork 和 Electron 浏览器插件。将插件的全局标记注入替换为 bundle patch，在 `ui-sidebar-browser` 上设置 `config.requireDesktopBridge: true`；保留条目现有的 `disabled` 规则。
2. 从公开的 `/types` 导出导入浏览器消息类型，并使用 `@deepseek-ai/dsh-experimental-browser-use-runtime/mcp` 中的 `typeof mountSessionMcp`。保留进程消息校验和运行时激活能力检查。
3. 重新加载 Client。确认具有 Desktop bridge 时注册 Browser，同一 Host 的 Web Client 则不注册。在 Browser 条目启用时，将选项设为 false 应恢复 iframe 回退。
4. 将此设置视为 profile/bundle 配置：仅卸载 MCP provider 不会清除它。移除 bundle patch 或显式重置选项并重新加载才能恢复默认行为。已禁用的 Browser 条目仍然禁用。
