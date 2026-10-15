import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmReplayRequestPricing, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'

class Adapter extends LlmAdapter {
  seen: GenerateOptions | undefined
  override replayRequestPricing(): LlmReplayRequestPricing {
    return {
      scope: { version: 1, adapter: 'test', projection: 'v1', provider: 'native', model: 'm' },
      priceMessages: messages => messages.flatMap(message => message.role === 'assistant'
        ? [{ messageId: message.id, replay: message.source.replayState === undefined ? 'fallback' : 'native', basis: 'unknown' }]
        : []),
    }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.seen = options
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('captured replay ownership', () => {
  it('preserves an adapter-declared unknown reserve instead of substituting the configured cap', async () => {
    class UnknownReserveAdapter extends Adapter {
      override async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
        return { ...await super.prepareCall(provider, model), outputReserve: () => undefined }
      }
    }
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['known'], new Adapter())
      ctx.llm.registerAdapter(['unknown'], new UnknownReserveAdapter())
      expect((await ctx.llm.prepareCall({ provider: 'known', model: 'm', maxTokens: 120 })).outputReserve).toBe(120)
      expect((await ctx.llm.prepareCall({ provider: 'unknown', model: 'm', maxTokens: 120 })).outputReserve).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps prepared stream and pricing on the same ownership snapshot across route replacement', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      const adapter = new Adapter()
      const registration = ctx.llm.registerAdapter(['old', 'target'], adapter)
      const assistant = createAssistantMessage({ content: [{ type: 'text', text: 'ok' }], source: { provider: 'old', model: 'm', replayState: { opaque: true } } })
      const prepared = await ctx.llm.prepareCall({ provider: 'target', model: 'm' })
      registration.replace(['target'])
      ctx.llm.registerAdapter(['old'], new Adapter())
      expect(prepared.replayPricing?.priceMessages([assistant])[0]?.replay).toBe('native')
      expect(ctx.llm.replayRequestPricing('target', 'm')?.priceMessages([assistant])[0]?.replay).toBe('fallback')
      expect(Object.isFrozen(prepared.replayPricing?.scope)).toBe(true)
      for await (const _chunk of prepared.stream({ ...prepared.config, messages: [assistant] })) { /* drain */ }
      expect(adapter.seen?.messages[0]).toBe(assistant)
      expect(ctx.llm.replayRequestPricing('missing', 'm')).toBeUndefined()
      expect(new Adapter().imageRequestPricing('target', 'm')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
