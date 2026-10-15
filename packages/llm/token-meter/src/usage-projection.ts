/**
 * Pure folds for durable provider-reported token usage and context occupancy.
 */

import { z } from 'zod'
import { lastAssistantStreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { TokenUsageProjection } from './projection.ts'
import { accountingStateSchema, calculateAccounting, foldAccounting, initAccounting } from './accounting.ts'
import type { AccountingState } from './accounting.ts'

const zeroBuckets = (): TokenUsageProjection => ({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

const bucketsFrom = (usage: TokenUsage): TokenUsageProjection => ({
  uncachedInputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cacheReadTokens: usage.cacheReadTokens ?? 0,
  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
})

const bucketsEqual = (left: TokenUsageProjection, right: TokenUsageProjection): boolean =>
  left.uncachedInputTokens === right.uncachedInputTokens
  && left.outputTokens === right.outputTokens
  && left.cacheReadTokens === right.cacheReadTokens
  && left.cacheWriteTokens === right.cacheWriteTokens

const addReplacing = (
  totals: TokenUsageProjection,
  previous: TokenUsageProjection | undefined,
  next: TokenUsageProjection,
): TokenUsageProjection => ({
  uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + next.uncachedInputTokens,
  outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + next.outputTokens,
  cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
  cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
})

const projectionSchema = z.object({
  uncachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
}).strict()

/**
 * The token-usage unit's state schema — the one definition of the state
 * shape; the state type is inferred from it.
 */
const tokenUsageStateSchema = z.object({
  totals: projectionSchema,
  last: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    buckets: projectionSchema,
  }).nullable(),
}).strict()

type TokenUsageState = z.infer<typeof tokenUsageStateSchema>

const pressureSchema = z.object({
  pressureTokens: z.number().int().nonnegative().optional(),
  projectedTokens: z.number().int().nonnegative().optional(),
  contextWindow: z.number().int().positive().optional(),
  provider: z.string().optional(), model: z.string().optional(),
  lastObservedInputTokens: z.number().int().nonnegative().optional(),
  lastObservedProvider: z.string().optional(), lastObservedModel: z.string().optional(),
  quality: z.enum(['observed', 'usage-supported', 'estimated', 'incomplete']).optional(),
  unattributedTokens: z.number().int().nonnegative().optional(),
  outputReserveTokens: z.number().int().nonnegative().optional(),
  availableTokens: z.number().int().optional(),
  retention: z.object({ retainTokens: z.number().int().nonnegative(), retainRatio: z.number().nonnegative().max(1).optional(), source: z.enum(['model', 'settings', 'config']) }).optional(),
}).strict().transform(value => ({
  ...value.pressureTokens === undefined ? {} : { pressureTokens: value.pressureTokens },
  ...value.projectedTokens === undefined ? {} : { projectedTokens: value.projectedTokens },
  ...value.contextWindow === undefined ? {} : { contextWindow: value.contextWindow },
  ...value.provider === undefined ? {} : { provider: value.provider },
  ...value.model === undefined ? {} : { model: value.model },
  ...value.lastObservedInputTokens === undefined ? {} : { lastObservedInputTokens: value.lastObservedInputTokens },
  ...value.lastObservedProvider === undefined ? {} : { lastObservedProvider: value.lastObservedProvider },
  ...value.lastObservedModel === undefined ? {} : { lastObservedModel: value.lastObservedModel },
  ...value.quality === undefined ? {} : { quality: value.quality },
  ...value.unattributedTokens === undefined ? {} : { unattributedTokens: value.unattributedTokens },
  ...value.outputReserveTokens === undefined ? {} : { outputReserveTokens: value.outputReserveTokens },
  ...value.availableTokens === undefined ? {} : { availableTokens: value.availableTokens },
  ...value.retention === undefined ? {} : { retention: { retainTokens: value.retention.retainTokens, source: value.retention.source,
    ...value.retention.retainRatio === undefined ? {} : { retainRatio: value.retention.retainRatio } } },
}))

/** The usage one durable Assistant settlement reports for its attempt, if any. */
function usageOf(event: SessionEvent): TokenUsage | undefined {
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  return lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    tokenUsage: TokenUsageState
    contextPressure: AccountingState
  }
}

/**
 * Token-meter's session projection unit.
 *
 * Each v2 Assistant settlement contributes the last usage sample embedded in
 * its stream. `llm/retry-started` closes the replacement slot so the retried
 * attempt adds to the total.
 */
export const tokenUsageProjectionDefinition = {
  key: 'tokenUsage',
  stateVersion: 2,
  stateSchema: tokenUsageStateSchema,
  init: () => ({ totals: zeroBuckets(), last: null }),
  apply: (state, event) => {
    if (event.type === 'llm/retry-started') {
      return state.last?.turn === event.data.turn && state.last.step === event.data.step
        ? { ...state, last: null }
        : state
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') {
      return state
    }
    const sample = usageOf(event)
    if (sample === undefined) return state
    const { turn, step } = event.data
    const usage: TokenUsage = sample

    const buckets = bucketsFrom(usage)
    const previous = state.last !== null
      && state.last.turn === turn
      && state.last.step === step
      ? state.last.buckets
      : undefined
    if (previous !== undefined && bucketsEqual(previous, buckets)) return state

    return {
      totals: addReplacing(state.totals, previous, buckets),
      last: { turn, step, buckets },
    }
  },
  wire: { viewSchema: projectionSchema, view: state => state.totals },
} satisfies ProjectionDefinition<'tokenUsage', TokenUsageState>

/**
 * Complete next-input forecast, using the host measurement's pure accounting
 * state. Historical observations retain their own route; forecast capacity
 * never inherits an unrelated route's observation or output reserve.
 */
export const contextPressureProjectionDefinition = {
  key: 'contextPressure',
  stateVersion: 6,
  stateSchema: accountingStateSchema,
  init: initAccounting,
  apply: foldAccounting,
  wire: {
    viewSchema: pressureSchema,
    view: (state) => {
      const value = calculateAccounting(state)
      return {
        ...state.frame.provider === '' ? {} : { provider: state.frame.provider, model: state.frame.model },
        ...state.observation === undefined ? {} : {
          lastObservedInputTokens: state.observation.tokens, lastObservedProvider: state.observation.frame.provider,
          lastObservedModel: state.observation.frame.model,
        },
        ...value.baseline.kind !== 'usage' ? {} : { pressureTokens: value.baseline.tokens },
        projectedTokens: value.inputTokens, quality: value.quality, unattributedTokens: value.unattributedTokens,
        ...value.contextWindow === undefined ? {} : { contextWindow: value.contextWindow },
        ...value.outputReserveTokens === undefined ? {} : { outputReserveTokens: value.outputReserveTokens },
        ...value.availableTokens === undefined ? {} : { availableTokens: value.availableTokens },
        ...state.frame.retention === undefined ? {} : { retention: {
          retainTokens: state.frame.retention.retainTokens, source: state.frame.retention.source,
          ...state.frame.retention.retainRatio === undefined ? {} : { retainRatio: state.frame.retention.retainRatio } } },
      }
    },
  },
} satisfies ProjectionDefinition<'contextPressure', AccountingState>
