import { describe, expect, it } from 'vitest'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { Api, Model, Usage } from '@earendil-works/pi-ai'
import { piOutputReserve, piReplayRequestPricing } from '../src/replay-pricing.ts'
import { mapUsage } from '../src/stream.ts'

const model: Model<Api> = {
  id: 'native-model', name: 'native-model', provider: 'native-provider', api: 'openai-responses',
  baseUrl: 'https://example.invalid/v1', input: ['text'], reasoning: true,
  contextWindow: 200000, maxTokens: 10000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

function message(replayState: unknown, provider = model.provider) {
  return createAssistantMessage({
    content: [{ type: 'reasoning', text: '' }, { type: 'text', text: 'ok' }],
    source: { provider, model: model.id, replayState },
  })
}

const replay = {
  response: { kind: 'pi-ai', version: 2, provider: model.provider, model: model.id, api: model.api, stopReason: 'stop' },
  blocks: [{ type: 'reasoning', thinkingSignature: JSON.stringify({ type: 'reasoning', encrypted_content: 'opaque'.repeat(10000) }) }, { type: 'text' }],
}

describe('pi replay pricing', () => {
  it('reserves actual capped protocols and added thinking without model-name heuristics', () => {
    expect(piOutputReserve({ ...model, api: 'openai-completions' }, 1000, 'high', undefined)).toBe(1000)
    expect(piOutputReserve({ ...model, api: 'anthropic-messages', compat: { forceAdaptiveThinking: true } }, 1000, 'high', undefined)).toBe(1000)
    expect(piOutputReserve({ ...model, api: 'anthropic-messages', compat: {} }, 1000, 'high', { high: 2000 })).toBe(3000)
    expect(piOutputReserve({ ...model, api: 'anthropic-messages', compat: {} }, 1000, 'off', undefined)).toBe(1000)
    expect(piOutputReserve(model, undefined, undefined, undefined)).toBe(model.maxTokens)
    expect(piOutputReserve({ ...model, api: 'openai-codex-responses' }, 1000, undefined, undefined)).toBe(model.maxTokens)
    expect(piOutputReserve({ ...model, api: 'future-api' }, 1000, undefined, undefined)).toBe(model.maxTokens)
    expect(piOutputReserve({ ...model, api: 'openai-responses', compat: { supportsMaxOutputTokens: false } }, 1000, undefined, undefined)).toBe(model.maxTokens)
    expect(piOutputReserve({ ...model, api: 'openai-responses', compat: {} }, 1, undefined, undefined)).toBe(16)
  })

  it('references output usage for actual native compatibility without copying encrypted data', () => {
    const assistant = message(replay)
    const pricing = piReplayRequestPricing(model)
    expect(pricing.priceMessages([assistant])).toEqual([{ messageId: assistant.id, replay: 'native', basis: 'usage-output' }])
    expect(JSON.stringify(pricing.priceMessages([assistant])).length).toBeLessThan(200)
    expect(pricing.scope).toMatchObject({ provider: model.provider, api: model.api, model: model.id })
    const frozenScope = pricing.scope.projection
    model.compat = { supportsStore: false }
    expect(pricing.scope.projection).toBe(frozenScope)
    expect(piReplayRequestPricing(model).scope.projection).not.toBe(frozenScope)
  })

  it('does not treat model names or Harness source aliases as native replay compatibility', () => {
    const assistant = message(replay)
    for (const target of [{ ...model, id: 'other' }, { ...model, api: 'openai-completions' }, { ...model, provider: 'other' }]) {
      expect(piReplayRequestPricing(target).priceMessages([assistant])).toEqual([
        { messageId: assistant.id, replay: 'fallback', basis: 'unknown' },
      ])
    }
    const aliased = message(replay, 'harness-alias')
    expect(piReplayRequestPricing(model).priceMessages([aliased])[0]).toMatchObject({ replay: 'fallback', basis: 'unknown' })
  })

  it('degrades unknown replay versions and recognizes omitted failed native responses', () => {
    const malformed = message({ ...replay, response: { ...replay.response, version: 99 } })
    expect(piReplayRequestPricing(model).priceMessages([malformed])[0]).toMatchObject({ replay: 'fallback', basis: 'unknown' })
    const failed = message({ ...replay, response: { ...replay.response, stopReason: 'aborted' } })
    expect(piReplayRequestPricing(model).priceMessages([failed])[0]).toMatchObject({ replay: 'fallback', basis: 'estimate', tokens: 0 })
  })

  it.each([undefined, 0, 7])('preserves optional reasoning %s without adding it to output', (reasoning) => {
    const usage: Usage = { input: 10, output: 12, cacheRead: 3, cacheWrite: 2, totalTokens: 27,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      ...reasoning === undefined ? {} : { reasoning },
    }
    expect(mapUsage(usage)).toEqual({ inputTokens: 10, outputTokens: 12, cacheReadTokens: 3, cacheWriteTokens: 2, totalTokens: 27,
      ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
    })
  })
})
