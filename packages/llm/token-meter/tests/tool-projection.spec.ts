import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createDeveloperMessage, LlmAdapter, LlmRuntime, projectToolUpdates } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk, ToolSchema, ToolUpdate } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '../src/index.ts'
import { estimateContent, estimateMessage, estimateStructuralBlock, estimateToolsTokens } from '../src/estimate.ts'

const config = { provider: 'tools', model: 'fixture', maxTokens: 100 }
const read: ToolSchema = { name: 'read', description: 'read', parameters: { type: 'object' } }
const large: ToolSchema = { name: 'large', description: 'retained schema '.repeat(1000), parameters: { type: 'object' } }
class ToolAdapter extends LlmAdapter {
  constructor(public mode: ToolUpdate | undefined) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100000 },
      ...this.mode === undefined ? {} : { toolUpdate: this.mode } })
  }
  override imageRequestPricing() {
    return { priceImages: (images: readonly { offloaded?: boolean }[]) => images.map(image => ({ visualTokens: image.offloaded ? 0 : 100, text: image.offloaded ? '[omitted]' : 'image handle' })) }
  }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { throw new Error('price capture performs no model call') }
}
function harness(mode: ToolUpdate | undefined, media = false) {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  new LlmRuntime(ctx)
  const adapter = new ToolAdapter(mode)
  ctx.llm.registerAdapter(['tools'], adapter)
  const meter = new TokenMeter(ctx)
  const session = Session.create(SessionId('tool-projection'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { header: { config, tools: [read] }, reason: 'initial' })
  const addition = session.append('request/header', { header: { config, tools: [read, large] }, reason: 'change' })
  const developer = session.append('developer/message', { turn: 1, step: 1, headerSeq: addition.seq,
    message: createDeveloperMessage({ source: { kind: 'user' }, content: [
      { type: 'tool-addition', toolName: 'large' },
      ...media ? [{ type: 'image' as const, attachment: { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png' as const, bytes: 100, width: 10, height: 10 } },
        { type: 'file' as const, attachment: { attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`), bytes: 50, name: 'data.txt' } }] : [],
    ] }),
  }, { surfaceOp: 'append' })
  session.append('request/header', { header: { config, tools: [read] }, reason: 'change' })
  session.append('developer/message', { turn: 1, step: 1, message: createDeveloperMessage({ source: { kind: 'user' }, content: [{ type: 'tool-removal', toolName: 'large' }] }) }, { surfaceOp: 'append' })
  session.append('request/context', { provider: 'tools', model: 'fixture', contextWindow: 100000, outputReserve: 100 })
  return { ctx, meter, session, adapter, developer }
}
async function capture(ctx: Context, meter: TokenMeter, session: Session) {
  const prepared = await ctx.llm.prepareCall(config)
  return meter.refresh(session, undefined, { toolUpdate: prepared.toolUpdate,
    ...prepared.imagePricing === undefined ? {} : { imageRequestPricing: prepared.imagePricing },
    ...prepared.outputReserve === undefined ? {} : { outputReserve: prepared.outputReserve },
    fileRequestText: ref => ctx.llm.fileRequestText(ref),
  })
}
function agree(ctx: Context, meter: TokenMeter, session: Session) {
  const measured = meter.measure(session)
  const views = ctx.sessionProjections.snapshot(session).values
  expect(views.contextPressure?.projectedTokens).toBe(measured.inputTokens)
  expect(views.contextBreakdown?.toolsTokens).toBe(measured.toolsTokens)
  expect(views.contextBreakdown?.messageTokens).toBe(measured.messageTokens)
  expect(meter.measure(Session.create(SessionId('tool-projection-cold'), session.snapshotEvents()))).toMatchObject({ inputTokens: measured.inputTokens, toolsTokens: measured.toolsTokens, nodes: measured.nodes, quality: measured.quality })
  return measured
}
describe('durable tool projection receipts', () => {
  it.each([undefined, 'addition-only', 'in-history'] as const)('captures complete tool declarations and developer filtering for mode %s', async (mode) => {
    const { ctx, meter, session } = harness(mode)
    expect(meter.measure(session).quality).toBe('incomplete')
    const measured = await capture(ctx, meter, session)
    const actual = projectToolUpdates(session.deriveMessages(), [read], mode, session.toolHistory())
    expect(measured.toolsTokens).toBe(estimateToolsTokens({ config, ...actual.tools === undefined ? {} : { tools: [...actual.tools] } }))
    expect(measured.messageTokens).toBe(actual.messages.reduce((sum, message) => sum + (message.role === 'developer' ? estimateMessage(message) : 0), 0))
    expect(measured.quality).toBe('estimated')
    expect(measured.toolsTokens > estimateToolsTokens({ config, tools: [read] })).toBe(mode === 'in-history')
    const receipt = session.requestContext()
    expect(receipt?.toolProjection?.mode).toBe(mode ?? 'none')
    expect(receipt?.projectionPrices).toHaveLength(2)
    expect(JSON.stringify(receipt)).not.toContain(large.description.slice(0, 60))
    const revision = session.seq
    const prospective = { config, tools: [read, large] }
    const preview = meter.preview(session, prospective, { toolUpdate: mode })
    const future = projectToolUpdates(session.deriveMessages(), prospective.tools, mode, session.toolHistory())
    expect(preview.measurement.toolsTokens).toBe(estimateToolsTokens({
      config, ...future.tools === undefined ? {} : { tools: [...future.tools] },
    }))
    expect(() => meter.refresh(session, prospective, { toolUpdate: mode })).toThrow(/log effective tool schemas/)
    expect(session.seq).toBe(revision)
    meter.refresh(session)
    expect(session.seq).toBe(revision)
    agree(ctx, meter, session)
    await ctx.fiber.dispose()
  })

  it('invalidates developer receipts on mode and header-series changes until a prepared boundary captures them', async () => {
    const { ctx, meter, session, adapter } = harness('in-history')
    const retained = await capture(ctx, meter, session)
    adapter.mode = undefined
    const omitted = await capture(ctx, meter, session)
    expect(omitted.inputTokens).toBeLessThan(retained.inputTokens)
    expect(omitted.nodes.every(node => node.tokens === 0)).toBe(true)
    session.append('request/header', { header: { config, tools: [read] }, reason: 'series' })
    expect(meter.preview(session).measurement.quality).toBe('incomplete')
    const revision = session.seq
    const prepared = await capture(ctx, meter, session)
    expect(session.seq).toBe(revision + 1)
    expect(prepared.quality).toBe('estimated')
    agree(ctx, meter, session)
    await ctx.fiber.dispose()
  })

  it('merges developer totals with image and file receipts without double-counting their structural references', async () => {
    const { ctx, meter, session, developer } = harness('in-history', true)
    await capture(ctx, meter, session)
    const receipt = session.requestContext()?.projectionPrices?.find(price => price.messageId === developer.data.message.id)
    expect(receipt?.images).toHaveLength(1)
    expect(receipt?.files).toHaveLength(1)
    const actual = projectToolUpdates(session.deriveMessages(), [read], 'in-history', session.toolHistory()).messages.find(message => message.id === developer.data.message.id)
    if (actual?.role !== 'developer' || receipt?.projectedTokens === undefined) throw new Error('missing retained developer projection')
    let expected = estimateMessage(actual)
    for (const block of actual.content) {
      if (block.type === 'image') expected += 100 + estimateContent([{ type: 'text', text: 'image handle' }]) - estimateStructuralBlock(block)
      if (block.type === 'file') expected += estimateContent([{ type: 'text', text: ctx.llm.fileRequestText(block.attachment) }]) - estimateStructuralBlock(block)
    }
    expect(receipt.projectedTokens).toBe(expected)
    expect(meter.measure(session).nodes.find(node => node.seq === developer.seq)?.tokens).toBe(expected)
    agree(ctx, meter, session)
    await ctx.fiber.dispose()
  })

  it('explains previously unknown historical declarations before retaining the old request residual', async () => {
    const { ctx, meter, session } = harness('in-history')
    const actual = projectToolUpdates(session.deriveMessages(), [read], 'in-history', session.toolHistory())
    const inputTokens = estimateToolsTokens({ config, ...actual.tools === undefined ? {} : { tools: [...actual.tools] } })
      + actual.messages.reduce((sum, message) => sum + (message.role === 'developer' ? estimateMessage(message) : 0), 0)
    session.append('assistant/message', { turn: 1, step: 1, stream: [], usage: { inputTokens, outputTokens: 20 },
      message: createAssistantMessage({ source: { provider: 'tools', model: 'fixture' }, content: [{ type: 'text', text: 'ok' }] }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    const prospective = meter.preview(session, { config: { ...config, maxTokens: 50 }, tools: [read] }, { toolUpdate: 'in-history', outputReserve: 50 })
    expect(prospective.measurement.inputTokens).toBe(inputTokens + 9)
    expect(prospective.measurement.unattributedTokens).toBe(0)
    const measured = await capture(ctx, meter, session)
    expect(measured.inputTokens).toBe(inputTokens + 9)
    expect(measured.unattributedTokens).toBe(0)
    agree(ctx, meter, session)
    await ctx.fiber.dispose()
  })
})
