# Token Meter

English | [中文](token-meter.zh.md)

`@deepseek-ai/dsh-token-meter` derives input forecasts, positional prices, and client projections from the same persisted facts. `measure()` is pure: it does not consult current adapter functions or append events. `logRevision` identifies the consumed durable tail.

Source: [`packages/llm/token-meter/src/types.ts`](../../packages/llm/token-meter/src/types.ts)

## `TokenMeasurement`

```ts type-equiv
/** Detached immutable request-pressure and surface snapshot at one consumed log revision. */
interface TokenMeasurement {
  /** Number of durable events consumed; equal to the next unread event seq. */
  readonly logRevision: SessionLogOffset
  /** Provider or heuristic anchor used for this measurement. */
  readonly baseline: TokenMeasurementBaseline
  /** Signed repricing of current surface content relative to the baseline anchor. */
  readonly surfaceDeltaTokens: number
  /** Compatibility alias for inputTokens; response output is not added. */
  readonly totalTokens: number
  /** Forecast of the complete next request input, excluding the response reserve. */
  readonly inputTokens: number
  /** Evidence quality for the complete forecast. */
  readonly quality: TokenMeasurementQuality
  /** Observed input not safely attributable to individual retained nodes. */
  readonly unattributedTokens: number
  /** Current estimated tool-schema cost. */
  readonly toolsTokens: number
  /** Current estimated effective system cost. */
  readonly systemTokens: number
  /** Current estimated non-system surface cost. */
  readonly messageTokens: number
  /** Jointly calibrated spans; finer node allocations remain estimates. */
  readonly groups: readonly { readonly seqs: readonly SessionSeq[]; readonly tokens: number; readonly quality: TokenMeasurementQuality }[]
  /** Most recent provider input, retaining its route and actual request cut. */
  readonly lastObservedPrompt?: {
    readonly tokens: number
    readonly logOffset: SessionLogOffset
    readonly provider: string
    readonly model: string
    readonly headerSeq?: SessionSeq
    readonly contextSeq?: SessionSeq
  }
  /** Capacity from the same effective route as the forecast. */
  readonly contextWindow?: number
  /** Reserved future output, not historical output usage. */
  readonly outputReserveTokens?: number
  /** Capacity minus forecast input and reserved output; negative means overflow. */
  readonly availableTokens?: number
  /** Total route-priced request tokens across the current surface; equals the sum of the node prices. */
  readonly surfaceTokens: number
  /** Current surface nodes in positional head-to-tail order. */
  readonly nodes: readonly TokenSurfaceNode[]
}
```

Provider input is `inputTokens + cacheReadTokens + cacheWriteTokens` for one request, never a sum of historical prompts. `lastObservedPrompt` keeps that observation and its actual dispatch cut separate from the current forecast. Historical output already includes reasoning; it is neither added to input nor treated as universally exact native replay cost. An adapter's `usage-output` hint can support an estimate of retained native content, not certify its tokenization.

```ts type-equiv
/** Evidence supporting an input estimate; incomplete costs have no safe upper bound. */
type TokenMeasurementQuality = 'observed' | 'usage-supported' | 'estimated' | 'incomplete'
```

Comparable route, header, projection, and dispatch facts permit reuse of observed input and calibration of changed spans. A group keeps a jointly measured total; finer node allocations remain estimates, and compaction must not split that group. Unattributed costs remain visible. Missing native or media prices, stale projection facts, and non-reusable residuals produce `incomplete`, not an invented zero or safe upper bound. `availableTokens` subtracts both forecast input and the route's future response reserve from capacity; cumulative billing remains a separate projection.

## Capturing current prices

`refresh()` captures changed-only native replay, image, file-handle, and historical/deferred tool-projection receipts into `request/context` during an open turn. The effective tool schemas must already be logged in `request/header`; a supplied header cannot silently replace them. `preview()` performs the same calculation without appending, including before idle compaction. Standalone maintenance commits its captured facts on `compaction/start.pricing`. Both paths use the dispatch-bound pricing snapshot when supplied; an explicitly unknown reserve remains unknown.

```ts type-equiv
/** Prepared functions bound to the adapter revision used for actual dispatch. */
interface TokenPricingSnapshot {
  /** Native replay pricing from the prepared call, or absent when unsupported. */
  readonly replayRequestPricing?: LlmReplayRequestPricing
  /** Request image projection from the same prepared adapter. */
  readonly imageRequestPricing?: LlmImageRequestPricing
  /** Actual prepared response ceiling, which may exceed a caller's plain cap. */
  readonly outputReserve?: number
  /** Present even when undefined for a prepared route that does not support developer updates. */
  readonly toolUpdate?: ToolUpdate | undefined
  /** Exact file-handle projection used for dispatch. */
  readonly fileRequestText?: (ref: Extract<Message['content'][number], { type: 'file' }>['attachment']) => string
}
```

Cold replay, resume, and fork consume those receipts through the same pure calculator. Old logs remain readable but cannot acquire missing provider evidence retroactively. [LLM pricing](llm-streaming.md#native-replay-pricing) owns adapter hints; [Session metadata](session.md#the-route-capacity-event-requestcontext) owns their durable references.

## `TokenSurfaceNode`

```ts type-equiv
/** One token-priced node in the current ordered session surface. */
interface TokenSurfaceNode {
  /** Durable sequence number of the surface event. */
  readonly seq: SessionSeq
  /**
   * Request-pressure tokens for the exact message projected by this node under
   * the measured route: image occurrences carry the route's declared visual
   * price when the routed adapter declares one, and the fixed heuristic
   * otherwise. Trigger, retention, and range selection all read this price.
   */
  readonly tokens: number
  /**
   * Fixed-heuristic tokens for the same message, independent of any route.
   * The shadow-price protocol prices replacements with this value so the O(1)
   * projection fold stays in agreement with its own appends.
   */
  readonly heuristicTokens: number
  /** Evidence for this node's allocation, not an exact provider tokenization. */
  readonly quality?: TokenMeasurementQuality
  /** First node of an inseparable calibrated span, when present. */
  readonly costGroupStartSeq?: SessionSeq
  /** Last node of an inseparable calibrated span, when present. */
  readonly costGroupEndSeq?: SessionSeq
}
```

Surface order is authoritative; replacement nodes can have higher durable seqs than later positional nodes. The snapshot is immutable and does not grow when the underlying replay fold advances.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtokenmeter--tokenmeter"></a>

### `ctx.tokenMeter` — `TokenMeter`

Measures persisted facts; explicit refresh/preview alone consult live pricing.

```ts cordis-catalog
/** Read a pure input-only estimate from durable price and usage facts.
 * @param session - session to measure through its committed tail.
 * @param requestHeader - optional effective envelope; does not materialize prices.
 * @returns detached immutable measurement shared with the client projections.
 */
measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement

/** Materialize changed-only adapter and attachment receipts without a model call.
 * Call under the caller's session transaction before pressure decisions or dispatch.
 * @param session - session whose current surface should be priced.
 * @param requestHeader - effective envelope; tool schemas must already be logged.
 * @param snapshot - prepared dispatch pricing; omission resolves current runtime hooks.
 * @returns the pure measurement after any changed facts were committed.
 */
refresh(session: Session, requestHeader?: EpochHeader, snapshot?: TokenPricingSnapshot): TokenMeasurement

/** Capture prices without appending; manual compaction persists context on its start event.
 * @param session - session whose current surface should be priced.
 * @param requestHeader - effective envelope, defaulting to the logged header.
 * @param snapshot - optional prepared dispatch pricing functions.
 * @returns prospective measurement and changed context facts for the caller to commit.
 */
preview( session: Session, requestHeader?: EpochHeader, snapshot?: TokenPricingSnapshot, ): { measurement: TokenMeasurement; context?: RequestContext }

/** Price one message with the route-independent shadow-price heuristic.
 * @param message - message to price without mutation.
 * @returns heuristic tokens, not a native replay estimate.
 */
estimateMessage(message: Message): number
```

Types: [EpochHeader](session.md) · [Message](llm-streaming.md) · [RequestContext](session.md) · [Session](session.md)

Source: [`packages/llm/token-meter/src/index.ts`](../../packages/llm/token-meter/src/index.ts)
<!-- END GENERATED cordis-surface -->
