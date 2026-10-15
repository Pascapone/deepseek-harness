---
kind: upgrade-guide
description: "Desktop browser integrations configure carrier requirements through the native Browser entry and consume its public protocol types."
---
# Desktop browser registration policy

English | [中文](guide.zh.md)

## Change

The native Browser no longer reads `__DSH_NATIVE_BROWSER_HOST__`. An enabled `ui-sidebar-browser` entry instead accepts `config.requireDesktopBridge`, defaulting to `false`. When true, Clients without the supported Desktop bridge register no Browser tabs, guide entries or shortcuts. The default retains the existing iframe fallback. Native Guest permissions and Session data are unchanged.

Main/Host browser messages are exported from `@deepseek-ai/dsh-client-ui-sidebar-browser/types`. MCP providers use the existing public `SessionMcpOptions` and `mountSessionMcp` types rather than local copies.

## Migration

1. Update the fork and its Electron browser plugin together. Replace the plugin's global-marker injection with a bundle patch setting `config.requireDesktopBridge: true` on `ui-sidebar-browser`; preserve the entry's existing `disabled` rule.
2. Import the browser message types from the public `/types` export and use `typeof mountSessionMcp` from `@deepseek-ai/dsh-experimental-browser-use-runtime/mcp`. Keep validation of incoming process messages and the check for runtime activation support.
3. Reload the Client. Verify Browser registration with the Desktop bridge and its absence in Web Clients of the same Host. Setting the option to false must restore the iframe fallback when the Browser entry is enabled.
4. Treat the setting as profile/bundle configuration: unloading only the MCP provider leaves it in effect. Remove the bundle patch or explicitly reset the option and reload to restore the default. A disabled Browser entry remains disabled.
