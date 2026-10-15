---
kind: upgrade-guide
description: The native compaction retention Loader entry and editor move to an independently installed plugin.
---

# Compaction retention settings plugin

English | [中文](guide.zh.md)

## Change

The `@deepseek-ai/dsh-compaction-basic/retention-settings` runtime entry and built-in Context & Compaction editor are removed. The same module subpath now exports only the optional `CompactionRetentionProvider` TypeScript interface. Native compaction continues with its configured defaults when no provider is mounted.

The companion `@pascapone/dsh-compaction-settings` plugin owns the durable global preference and editor. Its Host row retains the `compaction-retention` id and atomic `retention` mode/value setting. Exact-model policies, revision checks and engine budget validation retain their precedence and behavior.

## Migration

1. Build and make the companion plugin available together with the matching Core candidate. Install or activate it only through the separately authorized environment workflow.
2. In every profile patch or overlay explicitly naming `@deepseek-ai/dsh-compaction-basic/retention-settings`, change only `name` to `@pascapone/dsh-compaction-settings`. Keep `id: compaction-retention` and the complete saved `config`, including `config.retention`. A higher profile layer replaces the whole row configuration; do not replace a saved preference with an empty object.
3. If the profile relied only on the removed base-bundle row, add the companion bundle, preserving any existing patch targeting `compaction-retention`. Mount exactly one preference provider.
4. Confirm that the accepted preference and revision still appear in the editor, switching token/ratio mode persists one active mode, and the next compaction records the expected retention. Without the plugin, confirm native agent configuration applies.

For custom UI plugins, replace the removed implicit remote-browser exception with `ctx.configForms.get(namespace, { persistence: 'host' })` only for intentionally durable preferences. This option requests a scoped read and does not grant Host permissions or settings-document access.
