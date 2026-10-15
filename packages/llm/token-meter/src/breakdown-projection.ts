/**
 * Native/media-aware input categories from the same pure accounting as pressure.
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { accountingStateSchema, calculateAccounting, foldAccounting, initAccounting } from './accounting.ts'
import type { AccountingState } from './accounting.ts'
// Import for the `contextBreakdown` SessionProjectionStateMap key merge.
import type {} from './projection.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    contextBreakdown: AccountingState
  }
}

const tokenCount = z.number().int().nonnegative()
const breakdownSchema = z.object({
  systemTokens: tokenCount,
  toolsTokens: tokenCount,
  messageTokens: tokenCount,
  unattributedTokens: tokenCount.optional(),
  quality: z.enum(['observed', 'usage-supported', 'estimated', 'incomplete']).optional(),
}).strict().transform(value => ({
  systemTokens: value.systemTokens, toolsTokens: value.toolsTokens, messageTokens: value.messageTokens,
  ...value.unattributedTokens === undefined ? {} : { unattributedTokens: value.unattributedTokens },
  ...value.quality === undefined ? {} : { quality: value.quality },
}))

/**
 * Estimated categories with residual cost separately visible. Categories are
 * never scaled to an observation or represented as exact per-message usage.
 */
export const contextBreakdownProjectionDefinition = {
  key: 'contextBreakdown',
  stateVersion: 6,
  stateSchema: accountingStateSchema,
  init: initAccounting,
  apply: foldAccounting,
  wire: {
    viewSchema: breakdownSchema,
    view: (state) => {
      const { systemTokens, toolsTokens, messageTokens, unattributedTokens, quality } = calculateAccounting(state)
      return { systemTokens, toolsTokens, messageTokens, unattributedTokens, quality }
    },
  },
} satisfies ProjectionDefinition<'contextBreakdown', AccountingState>
