/**
 * Public configuration and measurement vocabulary for replay token metering.
 *
 * @module @deepseek-ai/dsh-token-meter/types
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session/types'

export type { ContextBreakdownProjection, ContextPressureProjection, TokenUsageProjection } from './projection.ts'

/** Token-meter plugin configuration; the fixed estimator has no settings. */
export type TokenMeterConfig = Record<string, never>

/** Evidence supporting an input estimate; incomplete costs have no safe upper bound. */
export type TokenMeasurementQuality = 'observed' | 'usage-supported' | 'estimated' | 'incomplete'

/** The baseline from which a signed surface delta produces current pressure. */
export type TokenMeasurementBaseline =
  | { readonly kind: 'none'; readonly tokens: 0 }
  | { readonly kind: 'estimated'; readonly tokens: number }
  | { readonly kind: 'usage'; readonly tokens: number; readonly usage: Readonly<TokenUsage> }

/** Detached immutable request-pressure and surface snapshot at one consumed log revision. */
export interface TokenMeasurement {
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

/** One token-priced node in the current ordered session surface. */
export interface TokenSurfaceNode {
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
