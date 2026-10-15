---
description: "Automatic conversation condensation for deployments choosing, tuning, or debugging how older history is summarized as token pressure builds."
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-basic

English | [中文](README.zh.md)

## Summary

This package condenses older history while preserving recent messages. Automatic pressure checks, confirmed-overflow recovery, and `/compact` share the same input accounting. Optional pruning can avoid model calls; otherwise bounded summary requests process the selected history and retain summary text. The system head remains, and tool pairs and jointly measured cost groups cannot be split.

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

Mount this package to get automatic conversation condensation in a composition that already provides an LLM, session storage, and token measurement. The shipped `dsh` base enables it by default; mount it explicitly to control when condensation starts.

### What you get

With the default settings you get four behaviors: automatic condensation as the conversation grows toward the model's context limit; recovery after a confirmed context-overflow error, where the conversation condenses and the request retries; on-demand condensation through the `/compact` command; and — when the pruner is mounted — trimming of oversized tool outputs before condensation.

### Smallest working composition

Mount session storage, token measurement, the optional pruner, this backend, and optionally the on-demand command:

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-token-meter'
- name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
- name: '@deepseek-ai/dsh-compaction-basic'
- name: '@deepseek-ai/dsh-command-compact'
```

You can verify success by watching the conversation continue past the point where it would otherwise overflow, and by running `/compact` for an immediate condensation. If the composition lacks an LLM, session storage, or token measurement, the plugin fails to load. One backend can serve models with different context sizes; give each route its own threshold and retention with a per-model override:

```yaml
- name: '@deepseek-ai/dsh-compaction-basic'
  config:
    thresholdRatio: 0.8
    retainRatio: 0.16
    modelPolicies:
      - provider: local
        model: small-context
        thresholdRatio: 0.7
        retainTokens: 2048
```

### Tuning when condensation starts

All settings are optional. With context window `W`, prepared response reserve `O`, and headroom `B`, the default trigger is `floor(min(W × 0.8, W − O − B))`, where `B = 65,536` tokens. Retention targets the newest 16% of `W − O`, preserving complete units. The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-compaction-basic) also lists field types.

| Field | Default | Meaning |
|---|---|---|
| `thresholdRatio` | `0.8` | Window fraction used in `floor(min(W × thresholdRatio, W − O − headroomTokens))`. |
| `headroomTokens` | `65536` | Trigger headroom and desired post-compaction relief; a non-negative integer. |
| `retainRatio` | `0.16` | Recent conversation kept verbatim as a fraction of `W − O`; mutually exclusive with `retainTokens`. |
| `retainTokens` | — | Absolute recent-conversation budget kept verbatim; mutually exclusive with `retainRatio` and must be below the resolved threshold. |
| `summarizationProvider` | `''` | Set together with `summarizationModel`; an empty pair uses the latest routed request target, then the `AgentOptions` pair. |
| `summarizationModel` | `''` | Set together with `summarizationProvider`; an empty pair uses the latest routed request target, then the `AgentOptions` pair. |
| `maxTokens` | `headroomTokens` (`65536`) | Positive summary cap; the prepared provider reserve can additionally include reasoning. Explicit model cap beats explicit global cap. |
| `compactionRetries` | `1` | At most this value plus one summary invocation, including chunks and recovery retries. |
| `maxOverflowRetries` | `1` | Maximum retries after a confirmed context-window overflow; `0` disables recovery only. |
| `modelPolicies` | `[]` | Exact `{ provider, model, ...partialPolicy }` overrides for individual model routes. |
| `auto` | `true` | Enable automatic condensation and overflow recovery; set `false` for manual-only operation. |

Misconfiguration fails fast: unknown settings, duplicate per-model overrides, invalid token counts, both retention forms together, or a retention ratio at least as large as the threshold ratio reject the plugin at load. When the model is first used, `W − O − B` must be positive and the resolved retained budget must be below the trigger. Zero headroom requires an explicit positive `maxTokens`, globally or in that model policy. Small-window deployments must configure headroom that fits their capacity; lower `thresholdRatio` to compact earlier.

### What happens when condensation runs

The selected older span becomes a framed summary, retaining the recent tail verbatim. Oversized inputs use safe bounded chunks, including the preceding checkpoint in later chunks; all originally selected nodes must be condensed before completion. The backend refreshes and checks complete estimated input afterward. No useful range below pressure is a no-op; critical input without a safe range, exhausted calls, or an unmet goal raises `CompactionBudgetError`. Committed progress remains durable if a later chunk fails.

A sole existing checkpoint is never summarized again; a checkpoint with additional original history remains eligible. Each operation fixes a target below its trigger: desired relief uses existing headroom, capped at half the interval above the current fixed-input, whole-retained-unit, and minimum-checkpoint floor. Zero headroom keeps trigger minus one. Insufficient floor space fails before a paid summary; a smaller checkpoint alone does not establish success. A live lock still reports `busy`.

### On-demand condensation with /compact

With `dsh-command-compact` mounted, `/compact` works below the pressure threshold and reserves idle admission until cleanup and flush complete. Mid-turn or concurrent compaction reports unavailable; accepted prompts wait. Manual operations honor explicit configuration, Settings, or model retention; only inherited implicit retention uses the legacy zero-token target. Idle pricing and last-used retention are persisted on `compaction/start.pricing`, without an idle `request/context` or artificial turn.

### Trimming oversized tool outputs

Mount `dsh-compaction-tool-result-pruner` before this package to trim oversized tool results as part of condensation. Trimming makes no model call and can remove the need to summarize at all: when the trimmed conversation fits within the threshold, condensation skips the summary. Trimming only runs after a condensation trigger qualifies — a below-pressure conversation is never touched.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the backend; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The backend is built on four commitments:

- **One measurement service prices every decision.** Open-turn decisions explicitly refresh durable native, media, and tool-projection receipts; idle operations preview them. Pressure, retention, selection, and shrink checks use the shared pure forecast. Complete calibrated groups stay intact, and replacement shadow prices retain their independent heuristic meaning.
- **The log-recorded bracket is the transaction.** All entry points share one bracket-first region transaction: validate the range and live lock, append `compaction/start` synchronously, prepare and await the summary, revalidate, append `compaction/summary` plus the replacement, and make exactly one closing attempt. Automatic and explicit-region calls require a numeric open-turn owner and whole-surface stability; `compactNow()` reserves idle admission, uses `turn: null`, accepts append-only context outside its selected span, flushes every closed attempt, and releases admission in `finally`.
- **Summarization preserves compatible prefixes.** The system head, routed tools, and selected messages are replayed without reauthoring history. Same-target reasoning effort is retained without model-name allowlists; route-specific tool projection determines whether the provider can reuse that prefix.
- **`summarize()` is the sole subclass hook.** A template- or remote-summarizer subclass can override it while pressure, retention, cited source events, shrink validation, and shadowed-token accounting stay on the token meter.

### Automatic triggers and overflow recovery

With `auto: true`, a serial `agent/pre-step` listener checks pressure before request derivation: it prices the latest durable routed request envelope through `ctx.tokenMeter`, and when pressure crosses the routed model's threshold it prunes, then summarizes the oldest balanced span while keeping a priced recent tail. Every selected range starts at the first surface node that is not a `system/message`, so a system prompt at surface node 0 is never shadowed; a later `system/message` appended by an in-history prompt update is ordinary history that the range may shadow, and the agent loop's projection then replaces node 0 with the current prompt when their text differs ([decision rule](../../core/agent-loop/README.md#understand-the-implementation)). The `agent/request-error` listener reacts to a provider-confirmed `CONTEXT_WINDOW_EXCEEDED`: it bypasses the normal threshold and retention policy, attempts one maximal balanced head reduction, and authorizes a retry only after the surface replacement generation advances. Cancellation stays authoritative throughout.

Pressure policy resolves capacity from the durable route's adapter. Target-specific configuration failures retain their warning behavior. Budget failures are rethrown, not converted into warnings followed by another invalid request. Unknown native or media input must be priced or offloaded before critical paid condensation. Unassigned observed residual stays fully retained; residual-only incompleteness remains an estimate, not guaranteed actual reclaim, and never triggers a paid usage probe.

### Summarization mechanics

The default summarizer prepares the configured provider/model pair, falling back to the logged route and then `AgentOptions`. Before dispatch it validates known capacity against the complete projected prefix, system, tools, instruction, native/media input, residual, and prepared response reserve. Oversized indivisible units fail before a paid call. Dispatch uses the same single-use `PreparedLlmCall.stream` and captured tool history; middleware rerouting that invalidates the prepared budget is rejected. Template subclasses overriding `summarize()` bypass this LLM preflight and own their external-call budget.

The trailing instruction is a frozen `RequestUserInput` without durable identity or source, and purpose is `compaction`. Only returned text enters the `<compacted-summary>` checkpoint; raw output and usage remain on the summary event. Reasoning and tool calls are excluded from the checkpoint, and image output fails with `UNSUPPORTED_CONTENT`. The [shared compaction reference](../../../docs/subsystems/compaction.md#input-budgets-and-bounded-summaries) defines accounting and bounded-summary semantics.

### The region transaction

Failed summary requests dispatch synchronous `compaction/summary-error` after checking cancellation and selection stability. A recovery listener must record a durable input change before requesting retry. The backend re-derives the selected messages and refreshes their token prices and shrink baseline. The image-offload plugin owns image selection; its recorded omissions remain effective if the summary later fails or is cancelled.

The transaction validates the surface span and the durable lock, appends `compaction/start`, summarizes through the hook, revalidates stability (whole-surface for automatic calls, selected-span for manual calls), rejects a summary that does not shrink its source, appends `compaction/summary` plus the replacement `user/message`, and makes exactly one `compaction/end` attempt. A live unmatched start is the durable lock: an unmatched marker before a newer `session/end-seed` is stale evidence from a prior lifecycle and does not block; one after that boundary reports `busy`. A failed close deliberately leaves a blocking orphan. Cancellation remains authoritative after cleanup and durability.

### Config resolution

The optional `CompactionRetentionProvider` in the type-only `./retention-settings` export supplies a detached global override and accepts engine-owned synchronous validators. Settings schema, persistence, and UI belong to its provider plugin. With no provider, the engine uses its native configuration. Exact-model overrides still win; operation snapshots, accounting, capacity checks, and safe-history selection remain engine-owned.

`resolveConfig` validates defaults; `resolveTargetPolicy` snapshots global Settings retention below exact-model overrides. Mode switching removes the inactive fixed/ratio form, and owned active or cached model budgets are validated synchronously before Settings persistence. `resolveCompactSpec` uses routed capacity and the captured provider-adjusted reserve. Legacy conversation policy may estimate reserve from the header cap, adapter default, or zero; that fallback is never persisted as an actual reserve, and available space stays unknown without one. A paid default summary requires known prepared capacity and reserve.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `BasicCompactionEngine`, automatic listeners, entry-point dispatch |
| [`src/region.ts`](src/region.ts) | Retention selection and the shared bracket-first compaction transaction |
| [`src/summarizer.ts`](src/summarizer.ts) | Prepared LLM preflight and dispatch, checkpoint framing, safe-summary projection |
| [`src/config.ts`](src/config.ts) | Load-time validation and routed-model policy resolution |
| [`src/types.ts`](src/types.ts) | `BasicCompactionConfig` and resolved policy vocabulary |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the shared seam to the optional companions and the decision evidence.

- [Compaction seam](../compaction/README.md) — the condensation contract this backend implements.
- [Compaction subsystem reference](../../../docs/subsystems/compaction.md) — the condensation vocabulary, results, and service behavior.
- [Tool-result pruner](../compaction-tool-result-pruner/README.md) — the optional companion that trims oversized tool outputs first.
- [Human /compact command](../command-compact/README.md) — on-demand condensation without waiting for pressure.
- [Token meter](../../llm/token-meter/README.md) — the measurement service that decides when to condense.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-compaction-basic) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Conversation history

#### What the model sees

After a successful step crosses the threshold, oversized tool results are first rewritten when the optional pruner is loaded. If summarization remains necessary, the next request receives the checkpoint preamble below, a blank line, `<compacted-summary>`, the data-dependent summary, and `</compacted-summary>`. Overflow recovery rebuilds the immediate retry from whatever replacement advanced the surface. A checkpoint replaces the selected older range and is followed by the retained recent units.

##### Conversation checkpoint preamble

```markdown
This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.
```

#### Token effect

Model-free pruning can avoid the auxiliary call entirely; otherwise it reduces that call's transcript before the summary replaces an older range. The replacement reduces future input history rather than appending a second copy. A summary remains until a later compaction replaces it, while an indivisible non-tool unit can still exceed the budget.

#### KV Cache effect

Replacing rather than append-only. Each checkpoint invalidates reuse from the first replaced history token; the unchanged request prefix before that range remains reusable.

### Auxiliary summarizer request

#### What the model sees

The summarization model receives the system head and selected prefix, with tool declarations and developer updates projected for its route, followed by the compaction instruction below. Later chunks include the preceding checkpoint. The conversation receives only summary text; complete output remains logged for diagnostics.

##### Compaction instruction (final user message)

```markdown
You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.

Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.

## Primary Request and Intent
- [the user's original and evolving goals; quote verbatim where the exact wording matters]

## Key Technical Concepts
- [technologies, frameworks, patterns, and conventions in play]

## Files and Code
- [exact path: why it matters, key changes or snippets]

## Errors and Fixes
- [error: how it was resolved, plus any related user feedback]

## Pending Jobs
- [explicitly requested work not yet completed]

## Current Work
- [precisely what was in progress at this checkpoint]

## Next Step
- [the single next action, directly in line with the most recent request, or "(none)"]

## Critical Context
- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]

Rules:
- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.
- Capture user feedback and explicit instructions faithfully, especially corrections.
- Do NOT mention this summarization request or that the context was compacted.
- Output only the checkpoint text: do not call any tool or take any other action.
- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.
```

#### Token effect

Each bounded call pays for its replayed prefix and fixed instruction, with the provider's prepared response reserve accounting for output and any extra reasoning. Chunking and durable-input recovery share the configured summary-call allowance.

#### KV Cache effect

Compatible system, tool projection, history, and same-target reasoning controls permit prefix reuse before the trailing instruction. Changed target, projection, checkpoint, or non-head selection can forgo reuse; cache hits are not guaranteed.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when automatic condensation is a poor fit or needs special care; they are the current package constraints.

- **Meter accuracy follows the fixed heuristic** — missing reusable provider usage falls back to character count plus structural overhead rather than exact tokenization; image occurrences carry provider-exact visual tokens only on routes whose adapter declares request-image pricing.
- **Overflow classification is adapter-maintained** — provider wording can change; both DeepSeek adapters normalize recognized context-limit failures to `CONTEXT_WINDOW_EXCEEDED`.
- **Fixed or indivisible input can prevent repair** — system-head cost, active tool declarations, retained units, or a single oversized safe unit can prevent a feasible goal. Goal checks conservatively hold current tool costs fixed even when replacing developer history could remove retired declarations. The optional pruner can reduce tool-result text without splitting its pair.
- **`compactRegion` requires an open turn** — a manual call on a fully-closed session throws ("no open turn") rather than compacting.
- **Failure preserves committed progress** — pruning and completed chunks remain durable. Operational summary failures retain their warning behavior; `CompactionBudgetError` stops automatic continuation rather than claiming that a smaller checkpoint resolved critical input. Missing or incomplete prices are not safe upper bounds.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative; shipped behavior lives in the sections above, the package code, and the linked Agent Notes.

- **Default ratios, undecided** — `thresholdRatio: 0.8` and `retainRatio: 0.16` are fixed defaults; per-model tuning via `modelPolicies` exists, but no corpus-backed guidance on ideal values is recorded.
- **Tokenizer-accurate measurement, deferred** — the token meter's four-characters-per-token heuristic underprices CJK text and JSON Schema documents; exact tokenization remains an open direction for the measurement service.
- **Overflow recovery beyond canonical errors, undecided** — recovery triggers on `CONTEXT_WINDOW_EXCEEDED` only; other provider-side context failures are not classified.

</details>
