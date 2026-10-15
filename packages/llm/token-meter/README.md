---
description: "Replay-aware input accounting shared by compaction, context displays, and telemetry."
kind: "package-reference"
---

# @deepseek-ai/dsh-token-meter

English | [中文](README.zh.md)

## Summary

Use `ctx.tokenMeter` to forecast complete request input from durable usage and projection receipts. Measurement, pressure, and composition use one pure calculator; historical billing remains separate. Explicit price capture makes warm reads, cold replay, restore, and fork agree without model calls.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@deepseek-ai/dsh-token-meter` with the required `sessionProjections` service. The meter has no settings. Explicit price capture optionally uses `llm`; pure replay does not. Adapter routes own capacity and projection pricing; compaction owns policy and transaction timing.

### Measuring pressure

`measure(session, requestHeader?)` returns a detached immutable snapshot without invoking adapters or appending events. `inputTokens` and its compatibility alias `totalTokens` forecast input only. `outputReserveTokens` separately reserves future output. `surfaceTokens` equals the sum of node prices; `toolsTokens`, `quality`, `unattributedTokens`, and `lastObservedPrompt` explain the complete forecast. Capacity and available space belong to the same effective route. `estimateMessage(message)` remains the fixed heuristic used by replacement shadow prices.

`refresh(session, requestHeader?, snapshot?)` requires an open turn and already-logged tool schemas, persisting only changed `request/context` facts. `preview` returns `{ measurement, context? }` without appending, for an idle compaction transaction to persist on its start event. Prepared callers supply replay/image hooks, file projection, output reserve, and an explicitly present `toolUpdate` (undefined means unsupported). Other refreshes resolve runtime hooks and reuse tool mode only from a matching header/route receipt. Unknown tool projection remains incomplete. Image receipts include retained/offloaded prices; files retain exact short handle text. Tool receipts count historical/deferred declarations and filtered developer messages without copying schemas. Later pure reads need no live adapters or attachment paths.

Observed prompt input is `inputTokens + cacheReadTokens + cacheWriteTokens` for the referenced actual dispatch cut, not the surface at assistant commit. Historical inputs are never summed for pressure. Eligible native replay may use its own stored output usage as a hint; reasoning is already included, and missing usage is explicitly incomplete. Comparable request differences calibrate whole changed spans. Their finer node allocation remains estimated, and selectors must preserve complete `groups` rather than split a jointly observed span.

A logged text-only tool prune keeps its replacement in the original joint cost group, retaining the full old group price plus the replacement estimate. No unobserved share is subtracted. Unknown groups stay incomplete. Pressure and breakdown caches rebuild from the unchanged log when their accounting version changes.

### Session projections

`tokenUsage` sums disjoint billing buckets per settled attempt, replacing duplicate same-attempt samples without double-counting reasoning. `llm/retry-started` separates billed attempts. `contextPressure` publishes the shared input forecast, evidence quality, matching capacity, output reserve, and latest historical input with its route. The legacy `pressureTokens` alias exists only while that observation matches the forecast calibration. Unloading removes all three registrations.

`contextBreakdown` classifies the last nonempty surviving system node as system cost and other nodes as message cost. It uses the same native/media prices as measurement, including unmetered replacements. Categories are estimates, not scaled to a provider total; a global residual remains visibly unattributed rather than being invented as exact individual prices. Image offload switches the stored occurrence receipt without changing message identity or heuristic shadow prices. Missing media receipts are incomplete until explicitly materialized.

`deriveTurnTokenUsage(events)` folds a complete turn into exact per-attempt and whole-turn billing for browser consumers. Missing lifecycle evidence, unsafe counts, or conflicting exact totals produce no result; optional aggregates appear only when every participating attempt reports the corresponding value.

### Reading the numbers

Displays and compaction read the same forecast. Never combine a historical observation with a different model's capacity, interpret output usage as future output reserve, or treat incomplete prices as a safe upper bound. Old logs remain readable with explicitly best-effort request-cut reconstruction. Their native/media receipts must be explicitly captured before a pressure decision; pure reads never append them.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One pure fold retains compact current nodes, route identity, projection receipts, joint cost groups, and the latest input observation. A sparse in-step undo journal reconstructs actual dispatch cuts even when input or replacements arrive during streaming. It stores no native replay blobs, credentials, or message bodies. Malformed transitions throw without mutating previous state.

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Pure measurement and explicit refresh/preview operations |
| [`src/accounting.ts`](src/accounting.ts) | Shared request-cut fold and complete-input calculator |
| [`src/estimate.ts`](src/estimate.ts) | Fixed text/content and shadow-price heuristic |
| [`src/surface-fold.ts`](src/surface-fold.ts) | Positional surface planning and validation |
| [`src/surface-projection.ts`](src/surface-projection.ts) | Independent heuristic shadow-price protocol |
| [`src/usage-projection.ts`](src/usage-projection.ts) | Billing and pressure projections |
| [`src/breakdown-projection.ts`](src/breakdown-projection.ts) | Composition from the same accounting calculation |
| [`src/turn-usage.ts`](src/turn-usage.ts) | Exact per-attempt and turn billing |

Pressure and breakdown checkpoints contain compact accounting state and discard older checkpoint versions. Current-node reads are O(retained surface), not a rescan of the complete session log. Native replay receipts reference existing own output usage rather than persist duplicate token counts. The independent heuristic shadow-price protocol retains its meaning and validation.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Token meter subsystem](../../../docs/subsystems/token-meter.md) — public measurement types.
- [LLM service](../llm/README.md) — prepared calls and provider-owned projection prices.
- [Compaction](../../../docs/subsystems/compaction.md) — selection and transaction ownership.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through consumers such as `dsh-compaction-basic`; the service itself adds no prompt, message, schema, tool, or model call.

#### KV Cache effect

No direct invalidation; request-prefix changes belong to the consumer.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits apply to the forecast, not historical billing.

- Visible text without reusable observations uses an approximate character-density heuristic, not a provider tokenizer.
- Native output usage is a replay hint, not universally exact future input. Unknown eligibility or missing usage remains incomplete.
- Residual observed input is not assigned to individual nodes as exact cost. Removing part of an unmeasured region cannot establish guaranteed relief.
- Measurements clone current nodes; reads and checkpoint size are O(retained surface). Sparse in-flight mutations may retain replaced compact nodes until the step ends.
- An envelope, route, pricing identity, or media-receipt change can invalidate calibration. Capacity and output reserve remain absent when the route has not supplied them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
