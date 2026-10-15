---
kind: upgrade-guide
description: "Fork popup integrations must use pane render targets and Session retention leases instead of native browser-window management."
---
# Pane-based popup integrations

English | [中文](guide.zh.md)

## Change

The fork removes `sidebarRight.registerWindowOpener`, `popout` and `setPinned`. Browser-window ownership, geometry, parking and reopening belong to the consuming plugin. A floating pane can contain multiple tabs; its external render target is identified by Session and pane rather than its first tab.

Existing single-tab saved sidebar layouts remain readable. New layouts containing multi-tab floating panes require this runtime; the older single-tab validator rejects them. Session logs and their generations are unchanged.

## Migration

1. Update the fork and its popup plugin together. Better Web's pane-window implementation requires `panes`, `attachPaneTarget`, `retainSession`, `floatIn`, `closePaneIn` and `registerFloatHandler`. Keep a copy of browser-local sidebar layout data before upgrading if returning to an older runtime is required.
2. Use the public ordered `panes` snapshot to identify a tab's group. Acquire a Session retention lease before attaching a browser-owned element through `attachPaneTarget`. Release the attachment and await its DOM-return acknowledgement before closing the browser window and releasing the Session lease. Register browser opening through `registerFloatHandler`; keep Window objects and session-switch policy in the plugin.
3. Replace tab pinning calls with effect-owned `retainSession` leases. Use native group actions and `canCloseIn` for cleanup and availability instead of editing layout stores. File-opening plugins can register a source-aware resource placement resolver; explicit caller placement takes priority.
4. Verify two tabs in one popup, closing the original tab, docking the group, Session switching and plugin unload. Confirm that cleanup failures preserve the native group and that disabling the popup plugin leaves usable native floating panes.
