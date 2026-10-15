import type { ContextPressureProjection } from '@deepseek-ai/dsh-token-meter/client'

/** Context usage rendered by conversation and Chat status surfaces. */
export interface ContextOccupancy {
  percent?: number
  usedTokens: number
  contextWindow?: number
}

/**
 * Resolve forecast occupancy without mixing a historical observation with current capacity.
 * @param pressure - latest token-meter projection.
 * @returns forecast counts with a percentage only for known capacity, or null without a forecast.
 */
export function contextOccupancy(
  pressure: ContextPressureProjection | undefined,
): ContextOccupancy | null {
  const usedTokens = pressure?.projectedTokens
  if (usedTokens === undefined) return null
  const contextWindow = pressure?.contextWindow
  return {
    usedTokens,
    ...contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0 ? {} : {
      percent: Math.max(0, Math.min(100, Math.round(usedTokens / contextWindow * 100))),
      contextWindow,
    },
  }
}
