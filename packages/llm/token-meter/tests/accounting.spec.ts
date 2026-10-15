import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createToolResultMessage, createUserMessage, LlmAdapter, LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmReplayRequestPricing, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { RequestContext, RequestDispatch } from '@deepseek-ai/dsh-session'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '../src/index.ts'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { accountingStateSchema, calculateAccounting, foldAccounting, initAccounting } from '../src/accounting.ts'

const scope = { version: 1, adapter: 'controlled', projection: 'native-v1', provider: 'controlled', api: 'responses', model: 'opaque' } as const
class ControlledAdapter extends LlmAdapter {
  override replayRequestPricing(provider: string, model: string): LlmReplayRequestPricing {
    return {
      scope: { ...scope, provider, model },
      priceMessages: messages => messages.flatMap(message => message.role !== 'assistant' ? [] : [{
        messageId: message.id, replay: model === 'opaque' ? 'native' : 'fallback',
        basis: model === 'opaque' ? 'usage-output' : 'unknown',
      }]),
    }
  }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { throw new Error('offline only') }
}
function harness() {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  new LlmRuntime(ctx).registerAdapter(['controlled'], new ControlledAdapter())
  const session = Session.create(SessionId('accounting'), undefined, undefined, undefined, [imageOffloadProjection])
  session.append('turn/start', { turn: 1 })
  return { ctx, meter: new TokenMeter(ctx), session }
}
function user(session: Session, text = 'question') {
  return session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
}
function request(session: Session, step: number, projectionPrices?: RequestContext['projectionPrices']): RequestDispatch {
  session.append('step/start', { turn: 1, step })
  const header = session.append('request/header', { header: { config: { provider: 'controlled', model: 'opaque', maxTokens: 500 } }, reason: step === 1 ? 'initial' : 'series' })
  const context = session.append('request/context', { provider: 'controlled', model: 'opaque', contextWindow: 10_000, outputReserve: 500, replayPricing: scope, toolProjection: { tokens: 0, mode: 'none' }, ...projectionPrices === undefined ? {} : { projectionPrices } })
  return { version: 1, logOffset: session.seq, headerSeq: header.seq, contextSeq: context.seq }
}
function settle(session: Session, cut: RequestDispatch, step: number, usage?: TokenUsage) {
  const message = createAssistantMessage({ source: { provider: 'controlled', model: 'opaque', replayState: { response: { opaque: 'x'.repeat(30_000) } } }, content: [{ type: 'text', text: 'ok' }] })
  const event = session.append('assistant/message', {
    turn: 1, step, request: cut, message, stream: [],
    replayPrice: { contextSeq: cut.contextSeq, price: { messageId: message.id, replay: 'native', basis: 'usage-output' } },
    ...usage === undefined ? {} : { usage },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step })
  return event
}
function agree(ctx: Context, meter: TokenMeter, session: Session) {
  const measurement = meter.measure(session)
  const projection = ctx.sessionProjections.snapshot(session).values
  expect(projection.contextPressure?.projectedTokens).toBe(measurement.inputTokens)
  expect(projection.contextPressure?.quality).toBe(measurement.quality)
  expect(projection.contextBreakdown).toMatchObject({ systemTokens: measurement.systemTokens, toolsTokens: measurement.toolsTokens,
    messageTokens: measurement.messageTokens, unattributedTokens: measurement.unattributedTokens })
  const cold = Session.create(SessionId('cold'), session.snapshotEvents(), undefined, undefined, [imageOffloadProjection])
  expect(meter.measure(cold)).toMatchObject({ inputTokens: measurement.inputTokens, quality: measurement.quality,
    nodes: measurement.nodes, groups: measurement.groups })
  const state = session.snapshotEvents().reduce(foldAccounting, initAccounting())
  expect(calculateAccounting(accountingStateSchema.parse(JSON.parse(JSON.stringify(state))))).toMatchObject({
    inputTokens: measurement.inputTokens, quality: measurement.quality, nodes: measurement.nodes,
  })
  expect(JSON.stringify(state)).not.toContain('x'.repeat(100))
  return measurement
}
describe('shared request-cut accounting', () => {
  it('keeps zero native usage incomplete until positive request observations price the whole span', () => {
    const zero = harness()
    user(zero.session)
    const first = settle(zero.session, request(zero.session, 1), 1, { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 })
    settle(zero.session, request(zero.session, 2), 2, { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 })
    const unknown = agree(zero.ctx, zero.meter, zero.session)
    expect(unknown.nodes.find(node => node.seq === first.seq)?.quality).toBe('incomplete')
    expect(unknown.groups).toEqual([])
    expect(first.data.usage?.reasoningTokens).toBe(0)

    const positive = harness()
    user(positive.session)
    const output = settle(positive.session, request(positive.session, 1), 1, { inputTokens: 10, outputTokens: 0 })
    expect(positive.meter.measure(positive.session).nodes.at(-1)?.quality).toBe('incomplete')
    settle(positive.session, request(positive.session, 2), 2, { inputTokens: 4010, outputTokens: 10 })
    const priced = agree(positive.ctx, positive.meter, positive.session)
    expect(priced.groups).toEqual([{ seqs: [output.seq], tokens: 4000, quality: 'usage-supported' }])
    expect(priced.nodes.find(node => node.seq === output.seq)?.tokens).toBe(4000)
  })

  it('keeps actual context pressure when a rejected attempt reports zero input instead of treating billing zero as an empty request', () => {
    const { ctx, meter, session } = harness()
    user(session)
    settle(session, request(session, 1), 1, { inputTokens: 10, outputTokens: 4000 })
    const before = meter.measure(session)
    const cut = request(session, 2)
    session.append('assistant/attempt', { turn: 1, step: 2, request: cut, stream: [
      { type: 'chunk', time: 0, chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } } },
      { type: 'chunk', time: 1, chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'request rejected before prefill' } } } },
    ] })
    session.append('step/end', { turn: 1, step: 2 })
    const after = agree(ctx, meter, session)
    expect(after.inputTokens).toBe(before.inputTokens)
    expect(after.lastObservedPrompt?.tokens).toBe(10)
    expect(after.nodes.at(-1)?.tokens).toBe(4000)
  })

  it.each([0, 100])('uses new native receipts to explain old input, preserving only residual %i instead of double-counting it', (residual) => {
    const { ctx, meter, session } = harness()
    for (let step = 1; step <= 2; step += 1) {
      user(session)
      session.append('step/start', { turn: 1, step })
      session.append('request/header', { header: { config: { provider: 'controlled', model: 'opaque', maxTokens: 500 } }, reason: step === 1 ? 'initial' : 'series' })
      session.append('request/context', { provider: 'controlled', model: 'opaque', contextWindow: 10000, outputReserve: 500 })
      session.append('assistant/message', { turn: 1, step, stream: [],
        usage: { inputTokens: step === 1 ? 10 : 4020 + residual, outputTokens: step === 1 ? 4000 : 2000 },
        message: createAssistantMessage({ source: { provider: 'controlled', model: 'opaque', replayState: { response: { opaque: 'old replay' } } }, content: [{ type: 'text', text: 'ok' }] }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step })
    }
    const measured = meter.refresh(session)
    expect(measured.inputTokens).toBe(6020 + residual)
    expect(measured.unattributedTokens).toBe(residual)
    session.append('request/header', { header: { config: { provider: 'controlled', model: 'opaque', maxTokens: 500, temperature: 0.5 } }, reason: 'change' })
    const changed = agree(ctx, meter, session)
    expect(changed.inputTokens).toBe(6020 + residual)
    expect(changed.unattributedTokens).toBe(residual)
    expect(changed.baseline.kind).toBe('estimated')
  })

  it('previews old opaque history while idle and persists identical facts on manual compaction start', () => {
    const { ctx, meter, session } = harness()
    user(session)
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { header: { config: { provider: 'controlled', model: 'opaque', maxTokens: 500 } }, reason: 'initial' })
    session.append('request/context', { provider: 'controlled', model: 'opaque', contextWindow: 10_000, outputReserve: 500 })
    session.append('assistant/message', {
      turn: 1, step: 1, stream: [], usage: { inputTokens: 10, outputTokens: 4000 },
      message: createAssistantMessage({ source: { provider: 'controlled', model: 'opaque', replayState: { response: { opaque: 'old-native' } } }, content: [{ type: 'text', text: 'ok' }] }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const before = meter.measure(session)
    expect(before).toMatchObject({ inputTokens: 19, quality: 'incomplete' })
    const logOffset = session.seq
    expect(() => meter.refresh(session)).toThrow('requires an open turn')
    const preview = meter.preview(session)
    expect(preview.measurement.inputTokens).toBe(4010)
    expect(session.seq).toBe(logOffset)
    if (preview.context === undefined) throw new Error('expected old-log receipts')
    expect(preview.context.replayPrices).toHaveLength(1)
    const compactionId = CompactionId('manual-prices')
    session.append('compaction/start', { compactionId, turn: null, pricing: preview.context })
    expect(agree(ctx, meter, session).inputTokens).toBe(preview.measurement.inputTokens)
    session.append('compaction/end', { compactionId, turn: null })
    expect(meter.preview(session).context).toBeUndefined()
    const fork = Session.create(SessionId('fork'), session.snapshotEvents(), undefined, undefined, [imageOffloadProjection])
    expect(meter.measure(fork)).toMatchObject({ inputTokens: 4010, quality: preview.measurement.quality })
  })

  it('keeps a prepared native output ceiling instead of replacing it with the plain caller cap', () => {
    const { ctx, meter, session } = harness()
    user(session)
    request(session, 1)
    const replayRequestPricing = ctx.llm.replayRequestPricing('controlled', 'opaque')
    if (replayRequestPricing === undefined) throw new Error('missing controlled pricing')
    const prepared = meter.refresh(session, undefined, { replayRequestPricing, outputReserve: 900 })
    expect(prepared).toMatchObject({ inputTokens: 10, outputReserveTokens: 900, availableTokens: 9090 })
    const revision = session.seq
    meter.refresh(session, undefined, { replayRequestPricing, outputReserve: 900 })
    expect(session.seq).toBe(revision)
    expect(meter.measure(session, { config: { provider: 'controlled', model: 'opaque', maxTokens: 600 } }).outputReserveTokens).toBeUndefined()
    session.append('request/header', { header: { config: { provider: 'controlled', model: 'opaque', maxTokens: 600 } }, reason: 'change' })
    expect(meter.measure(session).outputReserveTokens).toBeUndefined()
  })

  it('applies known image-offload savings to the entire calibrated mixed group', () => {
    const { ctx, meter, session } = harness()
    user(session)
    const answer = settle(session, request(session, 1), 1, { inputTokens: 10, outputTokens: 4000 })
    const image = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png', bytes: 100, width: 10, height: 10 } }] }), { surfaceOp: 'append' })
    const second = request(session, 2, [{ messageId: image.data.id, images: [{ retained: { visualTokens: 100, text: 'handle' }, offloaded: { visualTokens: 0, text: 'omitted' } }] }])
    settle(session, second, 2, { inputTokens: 4120, outputTokens: 2000 })
    expect(agree(ctx, meter, session).inputTokens).toBe(6120)
    session.append('image/offload', { targets: [{ seq: image.seq, imageIndexes: [0] }] })
    const after = agree(ctx, meter, session)
    expect(after.inputTokens).toBe(6020)
    expect(after.groups).toEqual([{ seqs: [answer.seq, image.seq], tokens: 4010, quality: 'estimated' }])
  })

  it('materializes missing image receipts for an old session and replays its offloaded placeholder', () => {
    const { ctx, meter, session } = harness()
    const image = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{
      type: 'image', attachment: { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
        mediaType: 'image/png', bytes: 100, width: 10, height: 10 },
    }] }), { surfaceOp: 'append' })
    request(session, 1)
    expect(agree(ctx, meter, session).nodes[0]?.quality).toBe('incomplete')
    const replayRequestPricing = ctx.llm.replayRequestPricing('controlled', 'opaque')
    if (replayRequestPricing === undefined) throw new Error('missing controlled pricing')
    const imageRequestPricing = { priceImages: (images: readonly { offloaded?: boolean }[]) => images.map(block => ({
      visualTokens: block.offloaded === true ? 0 : 1200, text: block.offloaded === true ? 'omitted' : 'handle',
    })) }
    meter.refresh(session, undefined, { replayRequestPricing, imageRequestPricing, toolUpdate: undefined, outputReserve: 500 })
    expect(agree(ctx, meter, session).nodes[0]?.quality).toBe('estimated')
    const revision = session.seq
    meter.refresh(session, undefined, { replayRequestPricing, imageRequestPricing, toolUpdate: undefined, outputReserve: 500 })
    expect(session.seq).toBe(revision)
    session.append('image/offload', { targets: [{ seq: image.seq, imageIndexes: [0] }] })
    const after = agree(ctx, meter, session)
    expect(after.nodes[0]?.tokens).toBe(meter.estimateMessage(createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'omitted' }],
    })))
    expect(after.nodes[0]?.quality).toBe('estimated')
  })

  it('prices a tiny visible answer with eligible native O, never sums historical P or reasoning twice', () => {
    const { ctx, meter, session } = harness()
    const question = user(session)
    const first = request(session, 1)
    const answer = settle(session, first, 1, {
      inputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 3, outputTokens: 4000, reasoningTokens: 3900,
    })
    const before = agree(ctx, meter, session)
    expect(before).toMatchObject({ inputTokens: 4010, lastObservedPrompt: { tokens: 10 }, outputReserveTokens: 500,
      contextWindow: 10_000, availableTokens: 5490, unattributedTokens: 0 })
    expect(before.nodes.find(node => node.seq === answer.seq)).toMatchObject({ tokens: 4000, heuristicTokens: 9, quality: 'usage-supported' })
    const tail = user(session)
    const second = request(session, 2)
    settle(session, second, 2, { inputTokens: 4020, outputTokens: 2000, reasoningTokens: 1900 })
    const after = agree(ctx, meter, session)
    expect(after.inputTokens).toBe(6020)
    expect(after.groups).toEqual([{ seqs: [answer.seq, tail.seq], tokens: 4010, quality: 'usage-supported' }])
    expect(ctx.sessionProjections.snapshot(session).values.tokenUsage).toMatchObject({
      uncachedInputTokens: 4024, outputTokens: 6000, cacheReadTokens: 3, cacheWriteTokens: 3,
    })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'summary!' }] }), {
      surfaceOp: { op: 'replace', startSeq: answer.seq, endSeq: tail.seq }, sourceEventSeqs: [answer.seq, tail.seq],
    })
    expect(agree(ctx, meter, session).inputTokens).toBe(2020)
    expect(session.surface.nodes).toContain(question.seq)
  })

  it('anchors P at dispatch, not at assistant commit after an intervening surface replacement', () => {
    const { ctx, meter, session } = harness()
    const initial = user(session)
    const cut = request(session, 1)
    const replacement = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'a'.repeat(400) }] }), {
      surfaceOp: { op: 'replace', startSeq: initial.seq, endSeq: initial.seq }, sourceEventSeqs: [initial.seq],
    })
    settle(session, cut, 1, { inputTokens: 10, outputTokens: 4000 })
    const measured = agree(ctx, meter, session)
    expect(measured.inputTokens).toBe(4108)
    expect(measured.nodes[0]?.seq).toBe(replacement.seq)
    expect(measured.lastObservedPrompt?.logOffset).toBe(cut.logOffset)
  })

  it('does not invent relief when another consumer removes only part of a jointly measured group', () => {
    const { ctx, meter, session } = harness()
    user(session)
    const answer = settle(session, request(session, 1), 1, { inputTokens: 10, outputTokens: 4000 })
    const tail = user(session)
    settle(session, request(session, 2), 2, { inputTokens: 4020, outputTokens: 2000 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'summary!' }] }), {
      surfaceOp: { op: 'replace', startSeq: answer.seq, endSeq: answer.seq }, sourceEventSeqs: [answer.seq],
    })
    const measured = agree(ctx, meter, session)
    expect(measured.inputTokens).toBe(6030)
    expect(measured.quality).toBe('incomplete')
    expect(measured.groups).toEqual([{ seqs: [tail.seq], tokens: 4010, quality: 'incomplete' }])
  })

  it('keeps text-pruned joint groups complete without subtracting an unobserved share, including repeated pruning and cold replay', () => {
    const { ctx, meter, session } = harness()
    user(session)
    const answer = settle(session, request(session, 1), 1, { inputTokens: 10, outputTokens: 4000 })
    let tool = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
      callId: ToolCallId('pruned-result'), isError: false, content: [{ type: 'text', text: 'x'.repeat(4000) }],
    }) }, { surfaceOp: 'append' })
    const tail = user(session, 'retained tail')
    settle(session, request(session, 2), 2, { inputTokens: 5018, outputTokens: 2000 })
    const before = agree(ctx, meter, session)
    const originalCost = before.groups[0]!.tokens
    let retainedCost = originalCost
    for (const characters of [400, 40]) {
      session.append('compaction/prune', { shadowedRange: { start: tool.seq, end: tool.seq },
        shadowedSeqs: [tool.seq], shadowedTokenCount: meter.estimateMessage(tool.data.message) })
      tool = session.append('tool/result', { ...tool.data,
        message: { ...tool.data.message, content: [{ type: 'text', text: 'x'.repeat(characters) }] },
      }, { surfaceOp: { op: 'replace', startSeq: tool.seq, endSeq: tool.seq }, sourceEventSeqs: [tool.seq] })
      retainedCost += meter.estimateMessage(tool.data.message)
      const measured = agree(ctx, meter, session)
      expect(measured.groups).toEqual([{ seqs: [answer.seq, tool.seq, tail.seq], tokens: retainedCost, quality: 'estimated' }])
      expect(measured.nodes.find(node => node.seq === tail.seq)).toMatchObject({
        costGroupStartSeq: answer.seq, costGroupEndSeq: tail.seq,
      })
      expect(measured.nodes.some(node => node.quality === 'incomplete')).toBe(false)
      expect(measured.inputTokens).toBeGreaterThanOrEqual(before.inputTokens)
    }
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'checkpoint' }] }), {
      surfaceOp: { op: 'replace', startSeq: answer.seq, endSeq: tail.seq }, sourceEventSeqs: [answer.seq, tool.seq, tail.seq],
    })
    expect(agree(ctx, meter, session).groups).toEqual([])
  })

  it('keeps missing native usage incomplete and materializes old logs only on explicit refresh', () => {
    const { ctx, meter, session } = harness()
    user(session)
    const cut = request(session, 1)
    const answer = settle(session, cut, 1)
    expect(agree(ctx, meter, session).quality).toBe('incomplete')
    const seq = session.seq
    meter.measure(session)
    expect(session.seq).toBe(seq)
    const preview = meter.preview(session)
    expect(preview.context).toBeUndefined()
    expect(session.seq).toBe(seq)
    expect(answer.data.replayPrice?.price).not.toHaveProperty('tokens')
  })

  it('invalidates native eligibility, observation calibration and capacity together on route change', () => {
    const { ctx, meter, session } = harness()
    user(session)
    settle(session, request(session, 1), 1, { inputTokens: 10, outputTokens: 4000 })
    session.append('request/header', { header: { config: { provider: 'controlled', model: 'fallback' } }, reason: 'change' })
    const preview = meter.preview(session)
    expect(preview.context?.replayPrices?.[0]?.replay).toBe('fallback')
    expect(preview.measurement.inputTokens).toBe(19)
    expect(preview.measurement.contextWindow).toBeUndefined()
    expect(preview.measurement.lastObservedPrompt?.tokens).toBe(10)
    meter.refresh(session)
    expect(agree(ctx, meter, session).inputTokens).toBe(19)
    expect(ctx.sessionProjections.snapshot(session).values.contextPressure).toMatchObject({ lastObservedInputTokens: 10, lastObservedModel: 'opaque', model: 'fallback', projectedTokens: 19 })
    expect(ctx.sessionProjections.snapshot(session).values.contextPressure).not.toHaveProperty('pressureTokens')
  })

  it('does not assign an observed global residual to individual nodes', () => {
    const { ctx, meter, session } = harness()
    user(session)
    settle(session, request(session, 1), 1, { inputTokens: 110, outputTokens: 4000 })
    const measured = agree(ctx, meter, session)
    expect(measured.inputTokens).toBe(4110)
    expect(measured.unattributedTokens).toBe(100)
    expect(measured.nodes.map(node => node.tokens)).toEqual([10, 4000])
    expect(measured.groups).toEqual([])
  })

  it('retains only current compact nodes for a long text history and rejects corrupt ranges transactionally', () => {
    const { ctx, meter, session } = harness()
    for (let index = 0; index < 1000; index += 1) user(session, `text ${index}`)
    expect(agree(ctx, meter, session).nodes).toHaveLength(1000)
    const state = session.snapshotEvents().reduce(foldAccounting, initAccounting())
    const before = JSON.stringify(state)
    expect(() => foldAccounting(state, { type: 'user/message', seq: SessionSeq(session.seq), time: 0, data: createUserMessage({ source: { kind: 'user' }, content: [] }), surfaceOp: { op: 'replace', startSeq: SessionSeq(99999), endSeq: SessionSeq(99999) }, sourceEventSeqs: [] })).toThrow('invalid current range')
    expect(JSON.stringify(state)).toBe(before)
  })
})
