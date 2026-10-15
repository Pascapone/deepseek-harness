import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { assistantUpdates } from '../src/updates.ts'

it('reports the shared next-input forecast without billing output or mixing route capacity', async () => {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  const meter = new TokenMeter(ctx)
  const session = Session.create(SessionId('acp-accounting'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }] }), { surfaceOp: 'append' })
  const header = session.append('request/header', { header: { config: { provider: 'controlled', model: 'opaque' } }, reason: 'initial' })
  const context = session.append('request/context', { provider: 'controlled', model: 'opaque', contextWindow: 10_000, outputReserve: 500, replayPricing: { version: 1, adapter: 'controlled', projection: 'native', provider: 'controlled', model: 'opaque' } })
  const message = createAssistantMessage({ source: { provider: 'controlled', model: 'opaque' }, content: [{ type: 'text', text: 'ok' }] })
  const event = session.append('assistant/message', {
    turn: 1, step: 1, message, stream: [], usage: { inputTokens: 10, outputTokens: 4000, reasoningTokens: 3900 },
    request: { version: 1, logOffset: session.seq, headerSeq: header.seq, contextSeq: context.seq },
    replayPrice: { contextSeq: context.seq, price: { messageId: message.id, replay: 'native', basis: 'usage-output' } },
  }, { surfaceOp: 'append' })
  const updates = await assistantUpdates(ctx, session, event)
  expect(updates.at(-1)).toEqual({ sessionUpdate: 'usage_update', used: 4010, size: 10_000 })
  expect(meter.measure(session).inputTokens).toBe(4010)
  session.append('request/header', { header: { config: { provider: 'controlled', model: 'different' } }, reason: 'change' })
  expect((await assistantUpdates(ctx, session, event)).some(update => update.sessionUpdate === 'usage_update')).toBe(false)
  await ctx.fiber.dispose()
})
