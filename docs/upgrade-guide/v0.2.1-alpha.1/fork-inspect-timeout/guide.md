---
kind: upgrade-guide
description: "Fork configurations using inspectQueryTimeoutMs must use clientInspectTimeoutMs instead."
---
# Client inspect timeout configuration

English | [中文](guide.zh.md)

## Change

The fork's `inspectQueryTimeoutMs` configuration key becomes `clientInspectTimeoutMs`, matching upstream. Its default changes from 30000 to 10000 milliseconds. `inspectQueryErrorGraceMs` keeps its 250-millisecond default and non-resetting first-failure grace. A mounted Gateway without a connected page now fails before dispatch.

## Migration

1. In every profile patch or overlay configuring `@deepseek-ai/dsh-cordis-host-runner`, replace `inspectQueryTimeoutMs` with `clientInspectTimeoutMs`.
2. Set `clientInspectTimeoutMs: 30000` explicitly if the deployment needs the previous deadline. Keep any explicit `inspectQueryErrorGraceMs` setting.
3. Open a connected Harness page and run a Client `cordis_inspect_query`. Confirm that valid responses succeed and unanswered queries end at the configured deadline. Reconnect before retrying a no-page failure.
