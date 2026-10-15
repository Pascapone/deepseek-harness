import { describe, expect, it } from 'vitest'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { RequestContext, RequestDispatch } from '@deepseek-ai/dsh-session'
import { validateAccountingData } from '../src/request-accounting.ts'

const scope = { version: 1, adapter: 'fake', projection: 'v1', provider: 'native', model: 'm' } as const

function reply() {
  return { turn: 1, step: 1, stream: [], message: createAssistantMessage({
    source: { provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'ok' }],
  }) }
}

describe('durable request accounting admission', () => {
  it('accepts old maintenance records and validates nested pricing with the request-context rules', () => {
    expect(() =>{  validateAccountingData({ type: 'compaction/start', data: { turn: null } }, 'manual') }).not.toThrow()
    expect(() =>{  validateAccountingData({ type: 'compaction/start', data: { turn: null,
      pricing: { provider: 'p', model: 'm', replayPricing: scope, outputReserve: 100, toolProjection: { tokens: 0, mode: 'none' },
        projectionPrices: [{ messageId: 'filtered', projectedTokens: 0 }],
        retention: { retainTokens: 20, source: 'settings' } },
    } }, 'manual') }).not.toThrow()
    for (const pricing of [null, {}, { provider: 'p', model: 'm', outputReserve: NaN },
      { provider: 'p', model: 'm', outputReserve: -1 }, { provider: 'p', model: 'm', contextWindow: Infinity },
      { provider: 'p', model: 'm', replayPricing: { ...scope, version: 99 } },
      { provider: 'p', model: 'm', retention: { retainTokens: 20, retainRatio: NaN, source: 'settings' } },
    ]) expect(() =>{  validateAccountingData({ type: 'compaction/start', data: { turn: null, pricing } }, 'manual') }).toThrow()
  })

  it('accepts old settlements and validates current dispatch references without changing history', () => {
    const session = Session.create(SessionId('facts'))
    const header = session.append('request/header', { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' })
    const context = session.append('request/context', { provider: 'p', model: 'm', replayPricing: scope,
      projectionPrices: [{ messageId: reply().message.id, files: ['file handle'], images: [{ retained: { visualTokens: 20, text: 'image' }, offloaded: { visualTokens: 0, text: 'omitted' } }] }],
    })
    session.append('assistant/message', reply(), { surfaceOp: 'append' })
    const value = reply()
    session.append('assistant/message', { ...value,
      request: { version: 1, logOffset: session.seq, headerSeq: header.seq, contextSeq: context.seq },
      replayPrice: { contextSeq: context.seq, price: { messageId: value.message.id, replay: 'native', basis: 'usage-output' } },
    }, { surfaceOp: 'append' })
    expect(Session.create(SessionId('cold'), session.snapshotEvents()).deriveMessages()).toEqual(session.deriveMessages())
    const before = session.seq
    expect(() => session.append('assistant/message', { ...reply(),
      request: { version: 1, logOffset: session.seq, headerSeq: context.seq, contextSeq: context.seq },
    }, { surfaceOp: 'append' })).toThrow('request/header')
    expect(session.seq).toBe(before)
  })

  it.each([
    { replayPricing: { ...scope, version: 99 } },
    { replayPricing: { ...scope, apiKey: 'must-not-be-a-fact' } },
    { outputReserve: -1 },
    { toolProjection: { tokens: NaN, mode: 'none' } },
    { toolProjection: { tokens: 0 } },
    { toolProjection: { tokens: 3, mode: 'unknown' } },
    { toolProjection: { tokens: 3, mode: 'in-history', schemas: [] } },
    { projectionPrices: [{ messageId: 'filtered', projectedTokens: -1 }] },
    { projectionPrices: [{ messageId: 'filtered', projectedTokens: Infinity }] },
    { retention: { retainTokens: -1, source: 'settings' } },
    { retention: { retainTokens: 10, retainRatio: 0, source: 'settings' } },
    { replayPrices: [] },
    { replayPricing: scope, replayPrices: [{ messageId: 'm', replay: 'native', basis: 'usage-output', tokens: 99 }] },
    { projectionPrices: [{ messageId: 'm', images: [{ retained: { visualTokens: -1, text: '' }, offloaded: { visualTokens: 0, text: '' } }] }] },
    { projectionPrices: [{ messageId: 'm', files: [12] }] },
  ])('rejects malformed optional context facts %j', (fields) => {
    const session = Session.create(SessionId('invalid'))
    expect(() => session.append('request/context', { provider: 'p', model: 'm', ...fields } as RequestContext)).toThrow()
    expect(session.seq).toBe(0)
  })

  it('rejects future cuts and hints bound to a different message', () => {
    const session = Session.create(SessionId('invalid-cut'))
    const value = reply()
    expect(() => session.append('assistant/message', { ...value,
      request: { version: 1, logOffset: 999, headerSeq: 0, contextSeq: 0 } as RequestDispatch,
    }, { surfaceOp: 'append' })).toThrow('must not follow settlement')
    expect(() => session.append('assistant/message', { ...value,
      replayPrice: { contextSeq: SessionSeq(0), price: { messageId: reply().message.id, replay: 'native', basis: 'unknown' } },
    }, { surfaceOp: 'append' })).toThrow('own-message')
  })
})
