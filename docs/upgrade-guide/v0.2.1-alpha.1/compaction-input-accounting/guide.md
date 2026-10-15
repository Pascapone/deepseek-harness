---
kind: upgrade-guide
description: "Token measurements become input-only forecasts, and compaction requires complete priced input and an explicit response reserve."
---

# Input-only accounting and durable retention settings

English | [中文](guide.zh.md)

## Change

Previously, `TokenMeasurement.totalTokens` included request-and-response pressure, while the display used a separate usage-anchored approximation. It is now an alias for the shared `inputTokens` forecast. The last observed provider input, current forecast, quality, and future output reserve are separate values. A smaller checkpoint no longer establishes successful budget relief.

New optional dispatch references and scoped pricing receipts preserve the actual request cut, native replay eligibility, media representation, and projected tools. Older logs remain readable without fabricated provider evidence; estimates with missing coverage remain incomplete. Historical usage is unchanged, and reasoning remains a subset of output.

## Migration

1. Update meter consumers to read `inputTokens`, `quality`, `lastObservedPrompt`, and `outputReserveTokens` independently. Do not add historical output to input, sum earlier prompt observations, or present incomplete costs as a safe upper bound. Keep billing on the cumulative usage projection. See [Token Meter](../../../subsystems/token-meter.md).
2. Replace implicit live repricing through `measure()` with explicit `refresh()` inside an open turn. Log changed effective tools in `request/header` before refreshing. Use `preview()` before idle maintenance and preserve its captured context on `compaction/start.pricing`; ordinary reads remain pure.
3. Update custom adapters to bind replay/image pricing, native route identity, and response-reserve calculation to the same prepared generation as dispatch. Preserve an explicitly unknown reserve instead of substituting a plain generation cap. Prepared calls reject later `llm/stream` call-config rewrites. See [prepared calls](../../../subsystems/llm-streaming.md#service-and-provider-contracts).
4. Use Settings → Context & Compaction for fixed tokens or a percentage of context capacity minus answer reserve. Switching mode removes fixed-token precedence; exact-model policies still win. Saved changes affect the next compaction, not an operation already running. Custom compositions must mount the [retention settings owner](../../../../packages/compaction/compaction-basic/src/retention-settings.ts) to expose this preference.
5. Supply real context capacity and a known prepared response reserve for the summary route. Budget the complete summary input, including instructions, projected tools, native replay, media, and checkpoint framing. Do not silently reroute to another provider. Bounded summaries can commit progress and still report an unreachable budget; handle that failure rather than retrying a sole checkpoint.
6. Confirm fixed/ratio persistence, known-model rejection before saving, and unchanged running snapshots. Compare live and cold replay of the same request facts, including missing-usage and route-change cases. The [compaction reference](../../../subsystems/compaction.md#input-budgets-and-bounded-summaries) defines safe range and completion behavior.
