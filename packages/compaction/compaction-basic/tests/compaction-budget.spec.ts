import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage, LlmAdapter, LlmRuntime, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmReplayRequestPricing, LlmResolvedModelInfo, MessageId, PreparedAdapterCall, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { estimateMessage, estimateToolsTokens } from '@deepseek-ai/dsh-token-meter/estimate'
import { BasicCompactionEngine, CompactionBudgetError } from '../src/index.ts'
import { resolveConfig, resolveTargetPolicy } from '../src/config.ts'
import { safeCompactionEnds, selectCompactableRange } from '../src/region.ts'
import { frameSummary, prepareSummarization } from '../src/summarizer.ts'
import type { SummarizationInput, SummaryResult } from '../src/summarizer.ts'
import RetentionSettings from '../src/retention-settings.ts'
import type { RetentionPreference } from '../src/retention-settings.ts'

const scope = { version: 1, adapter: 'budget-test', projection: 'opaque-v1', provider: 'native', api: 'responses', model: 'budget' } as const
const low = ReasoningEffortId('low')
const signal = new AbortController().signal
class BudgetAdapter extends LlmAdapter {
  readonly outputs = new Map<MessageId, number>()
  readonly requests: GenerateOptions[] = []
  beforeDispatch?: () => void
  extraReserve = 0
  constructor(readonly windows: Record<string, number>) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: this.windows[provider] ?? 10000 }, reasoning: { efforts: [{ id: low, name: 'Low' }] } })
  }
  override replayRequestPricing(): LlmReplayRequestPricing {
    return { scope, priceMessages: messages => messages.flatMap(message => message.role === 'assistant' ? [{ messageId: message.id, replay: 'native', basis: 'usage-output' }] : []) }
  }
  override async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    const prepared = await super.prepareCall(provider, model)
    return { ...prepared, outputReserve: config => (config.maxTokens ?? 100) + this.extraReserve }
  }
  inputTokens(messages: readonly RequestMessage[]): number {
    return messages.reduce((sum, message) => {
      const native = message.id === undefined ? undefined : this.outputs.get(message.id)
      return sum + (native ?? estimateMessage(message.role === 'user' ? createUserMessage({ source: { kind: 'user' }, content: message.content }) : message))
    }, 0)
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.beforeDispatch?.()
    this.requests.push(options)
    const inputTokens = this.inputTokens(options.messages) + estimateToolsTokens({
      config: options, ...options.tools === undefined ? {} : { tools: options.tools },
    })
    expect(inputTokens + (options.maxTokens ?? 100) + this.extraReserve).toBeLessThanOrEqual(this.windows[options.provider] ?? 10000)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'checkpoint' } }
    yield { type: 'usage', usage: { inputTokens, outputTokens: 30 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
function harness(windows: Record<string, number> = { conversation: 10000, summary: 4000 }) {
  const ctx = new Context()
  new SessionStore(ctx)
  new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  const meter = new TokenMeter(ctx)
  const adapter = new BudgetAdapter(windows)
  ctx.llm.registerAdapter(Object.keys(windows), adapter)
  return { ctx, meter, adapter }
}
function history(adapter: BudgetAdapter, turns = 3, nativeTokens = 2000, characters = 1000) {
  const session = Session.create(SessionId('budget-history'))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `history-${turn} ${'x'.repeat(characters)}` }] }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    const header = session.append('request/header', { header: { config: { provider: 'conversation', model: 'budget', maxTokens: 500, reasoningEffort: low } }, reason: turn === 1 ? 'initial' : 'series' })
    const context = session.append('request/context', { provider: 'conversation', model: 'budget', contextWindow: adapter.windows.conversation ?? 10000, outputReserve: 500, replayPricing: scope, toolProjection: { tokens: 0, mode: 'none' } })
    const cut = { version: 1 as const, logOffset: session.seq, headerSeq: header.seq, contextSeq: context.seq }
    const inputTokens = adapter.inputTokens(session.deriveMessages())
    const message = createAssistantMessage({ source: { provider: 'conversation', model: 'budget', replayState: { response: { opaque: 'hidden continuation' } } }, content: [{ type: 'text', text: 'ok' }] })
    adapter.outputs.set(message.id, nativeTokens)
    session.append('assistant/message', { turn, step: 1, message, stream: [], usage: { inputTokens, outputTokens: nativeTokens, reasoningTokens: nativeTokens - 1 }, request: cut,
      replayPrice: { contextSeq: context.seq, price: { messageId: message.id, replay: 'native', basis: 'usage-output' } } }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}
function owner(session: Session): Agent {
  return { session, options: { provider: 'conversation', model: 'budget' },
    runMaintenance: task => task(signal),
  } as Agent
}
class TemplateEngine extends BasicCompactionEngine {
  calls = 0
  summaryText = 'checkpoint'
  during?: () => void
  override async summarize(_input: SummarizationInput): Promise<SummaryResult> {
    this.calls += 1
    this.during?.()
    return { summary: [{ type: 'text', text: this.summaryText }], provider: 'template', model: 'none' }
  }
}

describe('complete compaction budgets', () => {
  it('never lends negative old-anchor bias to retained native/media or pays for an unreachable tail', async () => {
    const { ctx, meter, adapter } = harness()
    adapter.imageRequestPricing = () => ({ priceImages: images => images.map(() => ({ visualTokens: 392, text: '' })) })
    const session = Session.create(SessionId('negative-anchor'))
    session.append('turn/start', { turn: 1 })
    const first = session.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }],
    }), { surfaceOp: 'append' })
    session.append('request/header', {
      header: { config: { provider: 'conversation', model: 'budget', maxTokens: 500 } }, reason: 'initial',
    })
    session.append('request/context', {
      provider: 'conversation', model: 'budget', contextWindow: 10000, outputReserve: 5500,
      replayPricing: scope, toolProjection: { tokens: 0, mode: 'none' },
    })
    const older = []
    for (const [index, outputTokens] of [5500, 4000].entries()) {
      session.append('step/start', { turn: 1, step: index + 1 })
      const message = createAssistantMessage({
        source: { provider: 'conversation', model: 'budget', replayState: { response: { opaque: 'retained native' } } },
        content: [{ type: 'text', text: 'ok' }],
      })
      older.push(session.append('assistant/message', { turn: 1, step: index + 1, message, stream: [],
        usage: { inputTokens: index === 0 ? 10 : 100, outputTokens },
      }, { surfaceOp: 'append' }))
      session.append('step/end', { turn: 1, step: index + 1 })
    }
    const image = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: {
      attachmentId: AttachmentId(`sha256:${'f'.repeat(64)}`), mediaType: 'image/png', bytes: 100, width: 10, height: 10,
    } }] })
    session.append('user/message', image, { surfaceOp: 'append' })
    const visualTokens = 400 - meter.estimateMessage(createUserMessage({ source: { kind: 'user' }, content: [] }))
    session.append('request/context', {
      provider: 'conversation', model: 'budget', contextWindow: 10000, outputReserve: 5500,
      replayPricing: scope, toolProjection: { tokens: 0, mode: 'none' }, projectionPrices: [{ messageId: image.id,
        images: [{ retained: { visualTokens, text: '' }, offloaded: { visualTokens: 0, text: '' } }],
      }],
    })
    expect(meter.refresh(session).inputTokens).toBe(4500)
    const engine = new TemplateEngine(ctx, { auto: false, headroomTokens: 0, maxTokens: 100, thresholdRatio: 1, retainTokens: 1000 })
    await expect(engine.compactIfNeeded(owner(session), 'pressure', signal)).rejects.toThrow(CompactionBudgetError)
    expect(engine.calls).toBe(0)
    const oldest = older[0]
    if (oldest === undefined) throw new Error('missing old native fixture')
    for (const startSeq of [oldest.seq, first.seq]) {
      const replay = Session.create(SessionId(`negative-replaced-${startSeq}`), session.snapshotEvents())
      const checkpoint = createUserMessage({ source: { kind: 'user' }, content: frameSummary([]) })
      replay.append('user/message', checkpoint, { surfaceOp: { op: 'replace', startSeq, endSeq: oldest.seq },
        sourceEventSeqs: startSeq === first.seq ? [first.seq, oldest.seq] : [oldest.seq] })
      const after = meter.measure(replay)
      expect(after.inputTokens).toBe(after.nodes.reduce((sum, node) => sum + node.tokens, 0))
      expect(after.inputTokens).toBeGreaterThanOrEqual(4400 + meter.estimateMessage(checkpoint))
      expect(after.baseline.kind).toBe('estimated')
      expect(ctx.sessionProjections.snapshot(replay).values.contextPressure?.projectedTokens).toBe(after.inputTokens)
    }
  })

  it('caps large requested headroom at the feasible midpoint so a useful real-sized checkpoint can succeed', async () => {
    const { ctx, meter, adapter } = harness()
    const session = history(adapter, 2)
    const before = meter.measure(session)
    const engine = new TemplateEngine(ctx, { auto: false, headroomTokens: 4000, maxTokens: 100,
      thresholdRatio: before.inputTokens / 10000, retainTokens: 1000 })
    const empty = meter.estimateMessage(createUserMessage({ source: { kind: 'user' }, content: frameSummary([{ type: 'text', text: '' }]) }))
    engine.summaryText = 'x'.repeat(4 * (1200 - empty))
    const result = await engine.compactIfNeeded(owner(session), 'pressure', signal)
    expect(result).not.toBeNull()
    expect(meter.measure(session).inputTokens).toBe(3200)
    expect(engine.calls).toBe(1)
  })

  it('rejects one-token relief without requested workroom and never pays again for the resulting sole checkpoint', async () => {
    const { ctx, meter, adapter } = harness()
    const session = history(adapter, 2)
    const before = meter.measure(session)
    const engine = new TemplateEngine(ctx, { auto: false, headroomTokens: 100, maxTokens: 100,
      thresholdRatio: before.inputTokens / 10000, retainTokens: 1000, compactionRetries: 2 })
    const range = selectCompactableRange(session, before, 1000)
    if (range === null) throw new Error('expected selected history')
    const end = before.nodes.findIndex(node => node.seq === range.end)
    const selectedTokens = before.nodes.slice(0, end + 1).reduce((sum, node) => sum + node.tokens, 0)
    const framedEmpty = meter.estimateMessage(createUserMessage({ source: { kind: 'user' }, content: frameSummary([{ type: 'text', text: '' }]) }))
    engine.summaryText = 'x'.repeat(4 * (selectedTokens - 1 - framedEmpty))
    await expect(engine.compactIfNeeded(owner(session), 'pressure', signal)).rejects.toBeInstanceOf(CompactionBudgetError)
    expect(meter.measure(session).inputTokens).toBe(before.inputTokens - 1)
    expect(engine.calls).toBe(1)
    expect(await engine.compactIfNeeded(owner(session), 'pressure', signal)).toBeNull()
    const checkpoint = session.surface.nodes[0]!
    await expect(engine.compactRegion(checkpoint, checkpoint, owner(session), signal)).rejects.toThrow(/sole existing checkpoint/)
    expect(engine.calls).toBe(1)
  })

  it('splits a large older region only at whole cost groups and condenses every selected original after pressure already dropped', async () => {
    const { ctx, meter, adapter } = harness()
    const session = history(adapter)
    const engine = new BasicCompactionEngine(ctx, { auto: false, headroomTokens: 0, maxTokens: 100, thresholdRatio: 0.6, retainTokens: 1000, compactionRetries: 2, summarizationProvider: 'summary', summarizationModel: 'budget' })
    const original = [...session.surface.nodes]
    const retained = original.at(-1)!
    const expected = selectCompactableRange(session, meter.measure(session), 1000)
    if (expected === null) throw new Error('expected older region')
    const snapshots: number[] = []
    adapter.beforeDispatch = () => { snapshots.push(meter.measure(session).inputTokens) }
    const result = await engine.compactIfNeeded(owner(session), 'pressure', signal)
    expect(result).not.toBeNull()
    expect(adapter.requests).toHaveLength(2)
    expect(snapshots[1]).toBeLessThan(6000)
    expect(session.surface.nodes).toContain(retained)
    expect(original.filter(seq => seq !== retained && session.surface.nodes.includes(seq))).toEqual([])
    expect(meter.measure(session).inputTokens).toBeLessThan(6000)
    expect(ctx.sessionProjections.snapshot(session).values.contextPressure?.projectedTokens).toBe(meter.measure(session).inputTokens)
    const firstSummary = session.snapshotEvents().filter(event => event.type === 'compaction/summary')[0]
    expect(firstSummary?.data.shadowedRange.end).toBe(meter.measure(Session.create(SessionId('fork-before'), session.snapshotEvents().slice(0, firstSummary?.seq ?? 0))).groups[0]?.seqs.at(-1))
  })

  it('fails before a paid call when fixed instruction/system plus prepared reserve cannot fit', async () => {
    const { ctx, adapter } = harness({ conversation: 10000, summary: 500 })
    const session = history(adapter, 2)
    const engine = new BasicCompactionEngine(ctx, { auto: false, headroomTokens: 0, maxTokens: 100, retainTokens: 1, summarizationProvider: 'summary', summarizationModel: 'budget' })
    const nodes = session.surface.nodes
    await expect(engine.compactRegion(nodes[0]!, nodes.at(-2)!, owner(session), signal)).rejects.toBeInstanceOf(CompactionBudgetError)
    expect(adapter.requests).toHaveLength(0)
    expect(session.surface.nodes).toEqual(nodes)
  })

  it('uses the prepared response reserve and keeps same-route reasoning for cache-compatible replay', async () => {
    const { ctx, adapter } = harness({ conversation: 10000 })
    const session = history(adapter, 1, 2000, 10)
    adapter.extraReserve = 250
    const input = { messages: session.deriveMessages().slice(0, 1) }
    const prepared = await prepareSummarization(ctx, { summarizationProvider: '', summarizationModel: '', maxTokens: 100 }, input, owner(session), signal)
    expect(prepared.outputReserve).toBe(350)
    const result = await prepared.summarize(input)
    expect(result.model).toBe('budget')
    expect(adapter.requests[0]?.reasoningEffort).toBe(low)
    expect(adapter.requests[0]?.maxTokens).toBe(100)
  })

  it('refuses an indivisible huge native replay group without sending a summary request', async () => {
    const { ctx, adapter } = harness()
    const session = history(adapter, 2, 8000, 10)
    const engine = new BasicCompactionEngine(ctx, { auto: false, headroomTokens: 0, maxTokens: 100, retainTokens: 1, summarizationProvider: 'summary', summarizationModel: 'budget' })
    const nodes = [...session.surface.nodes]
    await expect(engine.compactRegion(nodes[0]!, nodes.at(-2)!, owner(session), signal)).rejects.toThrow(/indivisible/)
    expect(adapter.requests).toHaveLength(0)
    expect(session.surface.nodes).toEqual(nodes)
  })

  it('preserves whole jointly observed spans at retention and summary-prefix cuts', () => {
    const { meter, adapter } = harness()
    const session = history(adapter)
    const measurement = meter.measure(session)
    const group = measurement.groups[0]
    if (group === undefined) throw new Error('expected native-plus-input group')
    const index = measurement.nodes.findIndex(node => node.seq === group.seqs.at(-1))
    const tailTokens = measurement.nodes.slice(index).reduce((sum, node) => sum + node.tokens, 0)
    const selected = selectCompactableRange(session, measurement, tailTokens)
    expect(selected?.end).toBe(measurement.nodes[index - group.seqs.length]?.seq)
    const ends = safeCompactionEnds(session, measurement, measurement.nodes[0]!.seq, measurement.nodes.at(-2)!.seq)
    expect(ends).not.toContain(group.seqs[0])
    expect(ends).toContain(group.seqs.at(-1))
  })

  it('merges Settings below model overrides and removes the inactive retention form', () => {
    const config = resolveConfig({ retainTokens: 100, modelPolicies: [{ provider: 'special', model: 'budget', retainRatio: 0.1 }] })
    expect(resolveTargetPolicy(config, { provider: 'conversation', model: 'budget' }, { retainRatio: 0.05 })).toMatchObject({ retainRatio: 0.05, retentionSource: 'settings' })
    expect(resolveTargetPolicy(config, { provider: 'conversation', model: 'budget' }, { retainRatio: 0.05 })).not.toHaveProperty('retainTokens')
    expect(resolveTargetPolicy(config, { provider: 'special', model: 'budget' }, { retainTokens: 500 })).toMatchObject({ retainRatio: 0.1, retentionSource: 'model' })
    expect(resolveTargetPolicy(config, { provider: 'special', model: 'budget' }, { retainTokens: 500 })).not.toHaveProperty('retainTokens')
  })

  it('validates known capacities on ConfigEditor writes and unregisters its validator on disposal', async () => {
    const { ctx, adapter } = harness()
    new RetentionSettings(ctx, { retention: { get: () => ({ mode: 'inherit', value: 0 }) } })
    const fiber = await ctx.plugin(BasicCompactionEngine, { auto: false, headroomTokens: 0, maxTokens: 100 })
    const session = history(adapter, 1)
    await ctx.compaction.compactIfNeeded(owner(session), 'pressure', signal)
    const candidate = { retention: { mode: 'tokens', value: 8000 } }
    expect(() => { ctx.waterfall(ctx.fiber, 'internal/config', candidate, () => candidate) }).toThrow(/retainTokens/)
    const ratio = { retention: { mode: 'ratio', value: 0.9 } }
    expect(() => { ctx.waterfall(ctx.fiber, 'internal/config', ratio, () => ratio) }).toThrow(/retainRatio/)
    await fiber.dispose()
    expect(ctx.waterfall(ctx.fiber, 'internal/config', candidate, () => candidate)).toEqual(candidate)
  })

  it('does not return partial success after the summary call allowance ends', async () => {
    const { ctx, meter, adapter } = harness()
    const session = history(adapter)
    const original = [...session.surface.nodes]
    const engine = new BasicCompactionEngine(ctx, { auto: false, headroomTokens: 0, maxTokens: 100, thresholdRatio: 0.6, retainTokens: 1000, compactionRetries: 0, summarizationProvider: 'summary', summarizationModel: 'budget' })
    await expect(engine.compactIfNeeded(owner(session), 'pressure', signal)).rejects.toThrow(/exhausted.*before all selected original history/)
    expect(adapter.requests).toHaveLength(1)
    expect(meter.measure(session).inputTokens).toBeLessThan(6000)
    expect(original.filter(seq => session.surface.nodes.includes(seq)).length).toBeGreaterThan(1)
    expect(session.snapshotEvents().filter(event => event.type === 'compaction/start')).toHaveLength(1)
    expect(session.snapshotEvents().filter(event => event.type === 'compaction/end')).toHaveLength(1)
  })

  it('snapshots Settings for a running manual compaction and records the actual explicit tail budget', async () => {
    const { ctx, adapter } = harness()
    let preference: RetentionPreference = { mode: 'tokens', value: 1000 }
    new RetentionSettings(ctx, { retention: { get: () => preference } })
    const session = history(adapter)
    session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
    ctx.sessions.enter(session)
    const engine = new TemplateEngine(ctx, { auto: false, headroomTokens: 0, maxTokens: 100, thresholdRatio: 0.9 })
    engine.during = () => { preference = { mode: 'tokens', value: 0 } }
    const retained = session.surface.nodes.at(-1)
    await engine.compactNow(owner(session), signal)
    expect(session.surface.nodes).toContain(retained)
    const start = session.snapshotEvents().findLast(event => event.type === 'compaction/start')
    expect(start?.data.pricing?.retention).toEqual({ retainTokens: 1000, source: 'settings' })
    expect(session.snapshotEvents().filter(event => event.type === 'request/context').every(event => event.data.retention === undefined)).toBe(true)
  })
})
