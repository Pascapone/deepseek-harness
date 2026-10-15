/**
 * Pure client-safe token-projection vocabulary.
 *
 * @module @deepseek-ai/dsh-token-meter/projection
 */

/**
 * Durable cumulative provider usage for a complete session log.
 *
 * The four buckets are disjoint. In particular, reasoning tokens are already
 * included in `outputTokens` and are not accumulated again.
 */
export interface TokenUsageProjection {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/**
 * Shared complete-input forecast and separately identified historical observation.
 * Capacity and output reserve always describe the forecast route.
 */
export interface ContextPressureProjection {
  /** Forecast route provider, when known. */
  provider?: string
  /** Forecast route model, when known. */
  model?: string
  /** Most recent observed input; its route may differ from the forecast route. */
  lastObservedInputTokens?: number
  /** Provider of the historical observation, independent of the forecast route. */
  lastObservedProvider?: string
  /** Model of the historical observation, independent of the forecast route. */
  lastObservedModel?: string
  /** Forecast evidence; incomplete means some retained input has no bounded price. */
  quality?: 'observed' | 'usage-supported' | 'estimated' | 'incomplete'
  /** Input cost not safely assigned to individual retained nodes. */
  unattributedTokens?: number
  /** Future output capacity reserved by the same route. */
  outputReserveTokens?: number
  /** Capacity remaining after input and output reserve; may be negative. */
  availableTokens?: number
  /** Original-history budget recorded for the latest request on this route. */
  retention?: { readonly retainTokens: number; readonly retainRatio?: number; readonly source: 'model' | 'settings' | 'config' }
  /**
   * Compatibility alias for the observed prompt input only while its route,
   * envelope, and pricing remain eligible for the current forecast.
   */
  pressureTokens?: number
  /**
   * Complete next-input forecast from the same calculator as host measurement,
   * including durable native/media prices and signed current-surface changes.
   */
  projectedTokens?: number
  /** Matching forecast-route capacity; absent when unknown. */
  contextWindow?: number
}

/**
 * Estimated categories from the same native/media-aware input calculation.
 * Categories are not scaled to an observation; residual input remains unattributed.
 */
export interface ContextBreakdownProjection {
  /** Observed cost not assigned to a displayed category. */
  unattributedTokens?: number
  /** Evidence supporting the shared next-input calculation. */
  quality?: 'observed' | 'usage-supported' | 'estimated' | 'incomplete'
  /** Estimated tokens of the last nonempty surviving system prompt; zero when absent. */
  systemTokens: number
  /** Estimated tokens of the effective envelope's tool schemas; zero before a request. */
  toolsTokens: number
  /** Estimated native/media-aware tokens of other surface nodes, including superseded prompts. */
  messageTokens: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Provider-reported usage accumulated across the complete durable log. */
    tokenUsage: TokenUsageProjection
    /** Shared next-input forecast with matching capacity and a separate historical observation. */
    contextPressure: ContextPressureProjection
    /** Estimated system/tools/message attribution of the same next-input forecast. */
    contextBreakdown: ContextBreakdownProjection
  }
}
