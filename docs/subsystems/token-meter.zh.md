# Token 计量

[English](token-meter.md) | 中文

`@deepseek-ai/dsh-token-meter` 从同一组持久事实派生输入预测、按位置计算的价格和客户端投影。`measure()` 是纯读取：它不查询当前 adapter 函数，也不追加事件。`logRevision` 标识已消费的持久日志末尾。

来源：[`packages/llm/token-meter/src/types.ts`](../../packages/llm/token-meter/src/types.ts)

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

提供方输入是单次请求的 `inputTokens + cacheReadTokens + cacheWriteTokens`，绝不是历史提示词之和。`lastObservedPrompt` 保留该观测及其实际调度切点，并与当前预测区分。历史输出已包含推理；它既不再次加入输入，也不能普遍作为精确的原生回放价格。adapter 的 `usage-output` 提示可支持保留原生内容的估算，但不证明其精确 token 化结果。

```ts type-equiv
/** Evidence supporting an input estimate; incomplete costs have no safe upper bound. */
type TokenMeasurementQuality = 'observed' | 'usage-supported' | 'estimated' | 'incomplete'
```

只有可比较的路由、header、投影和调度事实才允许复用观测输入及校准变化区间。组保留联合测量的总量；更细的节点分配仍属估算，压缩不能拆开该组。未分配成本保持可见。缺失的原生或媒体价格、过时投影事实以及不可复用的残差会产生 `incomplete`，而不是虚构零值或安全上界。`availableTokens` 从容量中同时扣除预测输入与路由的未来回答预留；累计计费仍是独立投影。

## 捕获当前价格

`refresh()` 在打开的轮次中把仅变化的原生回放、图片、文件句柄以及历史或延迟工具投影收据写入 `request/context`。生效工具 schema 必须已记录在 `request/header` 中；传入 header 不能悄悄替换它们。`preview()` 执行同样的计算但不追加事件，也适用于空闲压缩之前。独立维护把捕获事实提交到 `compaction/start.pricing`。两条路径都在提供时使用调度绑定的定价快照；明确未知的回答预留仍保持未知。

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

冷回放、恢复与 fork 通过同一个纯计算器消费这些收据。旧日志仍可读取，但不能追溯补造缺失的提供方证据。[LLM 定价](llm-streaming.zh.md#native-replay-pricing)拥有 adapter 提示；[Session 元数据](session.zh.md#the-route-capacity-event-requestcontext)拥有其持久引用。

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

表层顺序具有权威性；替换节点的持久 seq 可能高于位置排在其后的节点。该快照不可变，不会随底层回放折叠推进而增长。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [EpochHeader](session.zh.md) · [Message](llm-streaming.zh.md) · [RequestContext](session.zh.md) · [Session](session.zh.md)

Source: [`packages/llm/token-meter/src/index.ts`](../../packages/llm/token-meter/src/index.ts)
<!-- END GENERATED cordis-surface -->
