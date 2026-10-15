/** Replay-aware input measurement and explicit durable adapter-price refresh. */
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-compaction-image-offload/projection'
import z from '@deepseek-ai/schemastery'
import { projectToolUpdates } from '@deepseek-ai/dsh-llm'
import type { LlmImageRequestPricing, LlmMessageProjectionPrice, LlmReplayRequestPricing, Message, ToolUpdate } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { canonicalHeader, SessionSeq } from '@deepseek-ai/dsh-session'
import type { EpochHeader, RequestContext, Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { TokenMeasurement, TokenMeterConfig } from './types.ts'
import { contextBreakdownProjectionDefinition } from './breakdown-projection.ts'
import { contextPressureProjectionDefinition, tokenUsageProjectionDefinition } from './usage-projection.ts'
import { estimateContent, estimateMessage, estimateStructuralBlock, estimateToolsTokens } from './estimate.ts'
import { calculateAccounting, foldAccounting, pricingScopeKey } from './accounting.ts'

export type * from './types.ts'
export type * from './usage-projection.ts'
export type * from './breakdown-projection.ts'

/** Prepared functions bound to the adapter revision used for actual dispatch. */
export interface TokenPricingSnapshot {
  /** Native replay pricing from the prepared call, or absent when unsupported. */
  readonly replayRequestPricing?: LlmReplayRequestPricing
  /** Request image projection from the same prepared adapter. */
  readonly imageRequestPricing?: LlmImageRequestPricing
  /** Actual prepared response ceiling, which may exceed a caller's plain cap. */
  readonly outputReserve?: number
  /** Present even when undefined for a prepared route that does not support developer updates. */
  readonly toolUpdate?: ToolUpdate | undefined
  /** Exact file-handle projection used for dispatch. */
  readonly fileRequestText?: (ref: Extract<Message['content'][number], { type: 'file' }>['attachment']) => string
}

declare module '@deepseek-ai/cordis' {
  interface Context { tokenMeter: TokenMeter }
}

/** Measures persisted facts; explicit refresh/preview alone consult live pricing. */
export class TokenMeter extends Service {
  static Config = z.object({})
  static inject = ['sessionProjections']

  constructor(ctx: Context, config: TokenMeterConfig = {}) {
    super(ctx, 'tokenMeter')
    for (const key of Object.keys(config)) throw new Error(`TokenMeterConfig: unknown key "${key}" (no settings are supported)`)
    ctx.sessionProjections.register(tokenUsageProjectionDefinition)
    ctx.sessionProjections.register(contextPressureProjectionDefinition)
    ctx.sessionProjections.register(contextBreakdownProjectionDefinition)
  }

  /** Read a pure input-only estimate from durable price and usage facts.
   * @param session - session to measure through its committed tail.
   * @param requestHeader - optional effective envelope; does not materialize prices.
   * @returns detached immutable measurement shared with the client projections.
   */
  measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement {
    const state = this.ctx.sessionProjections.stateOf(session, 'contextPressure')
    if (state === undefined) throw new Error('token meter: contextPressure projection is not registered')
    return deepFreeze(structuredClone({ ...calculateAccounting(state, requestHeader), logRevision: session.seq }))
  }

  /** Materialize changed-only adapter and attachment receipts without a model call.
   * Call under the caller's session transaction before pressure decisions or dispatch.
   * @param session - session whose current surface should be priced.
   * @param requestHeader - effective envelope; tool schemas must already be logged.
   * @param snapshot - prepared dispatch pricing; omission resolves current runtime hooks.
   * @returns the pure measurement after any changed facts were committed.
   */
  refresh(session: Session, requestHeader?: EpochHeader, snapshot?: TokenPricingSnapshot): TokenMeasurement {
    const state = this.ctx.sessionProjections.stateOf(session, 'contextPressure')
    if (state === undefined) throw new Error('token meter: contextPressure projection is not registered')
    if (!state.turnOpen) throw new Error('token meter: refresh requires an open turn; use preview for idle compaction')
    if (requestHeader !== undefined && JSON.stringify(canonicalHeader(requestHeader).tools ?? []) !== state.frame.toolsHeaderKey) throw new Error('token meter: log effective tool schemas before refreshing; preview is available before commit')
    const preview = this.preview(session, requestHeader, snapshot)
    if (preview.context !== undefined) session.append('request/context', preview.context)
    return this.measure(session, requestHeader)
  }

  /** Capture prices without appending; manual compaction persists context on its start event.
   * @param session - session whose current surface should be priced.
   * @param requestHeader - effective envelope, defaulting to the logged header.
   * @param snapshot - optional prepared dispatch pricing functions.
   * @returns prospective measurement and changed context facts for the caller to commit.
   */
  preview(
    session: Session,
    requestHeader?: EpochHeader,
    snapshot?: TokenPricingSnapshot,
  ): { measurement: TokenMeasurement; context?: RequestContext } {
    const header = requestHeader === undefined ? session.requestHeader() : canonicalHeader(requestHeader)
    if (header === undefined) return { measurement: this.measure(session) }
    const { provider, model } = header.config
    const llm = this.ctx.get('llm')
    const replay = snapshot === undefined ? llm?.replayRequestPricing(provider, model) : snapshot.replayRequestPricing
    const image = snapshot === undefined ? llm?.imageRequestPricing(provider, model) : snapshot.imageRequestPricing
    const fileText = snapshot === undefined ? llm === undefined ? undefined : (ref: Extract<Message['content'][number], { type: 'file' }>['attachment']) => llm.fileRequestText(ref) : snapshot.fileRequestText
    const state = this.ctx.sessionProjections.stateOf(session, 'contextPressure')
    if (state === undefined) throw new Error('token meter: contextPressure projection is not registered')
    const messages = session.deriveMessages()
    const scope = pricingScopeKey(replay?.scope)
    const sameRoute = state.frame.provider === provider && state.frame.model === model && state.frame.scope === scope
    const sameTools = state.frame.toolsHeaderKey === JSON.stringify(header.tools ?? [])
    const previousTool = state.frame.toolProjection
    const mode = snapshot !== undefined && Object.hasOwn(snapshot, 'toolUpdate') ? snapshot.toolUpdate ?? 'none'
      : snapshot === undefined && sameRoute && sameTools && previousTool?.headerSeq === state.frame.headerSeq
        && previousTool?.scope === JSON.stringify([provider, model, scope]) ? previousTool.mode : undefined
    const projectedTools = mode === undefined ? undefined : projectToolUpdates(messages, header.tools, mode === 'none' ? undefined : mode, session.toolHistory())
    const toolProjection = projectedTools === undefined || mode === undefined ? undefined : {
      mode, tokens: estimateToolsTokens({
        config: header.config, ...projectedTools.tools === undefined ? {} : { tools: [...projectedTools.tools] },
      }),
    }
    const projectedDevelopers = new Map(projectedTools?.messages.flatMap(message => message.role === 'developer' ? [[message.id, message] as const] : []) ?? [])
    const byId = new Map(state.nodes.map(node => [node.messageId, node]))
    const replayPrices = (replay?.priceMessages(messages) ?? []).filter((price) => {
      const previous = sameRoute ? byId.get(price.messageId)?.replayPrice : undefined
      return previous === undefined || previous.scope !== scope || previous.replay !== price.replay
        || previous.basis !== price.basis || previous.tokens !== price.tokens
    })
    const projectionPrices: LlmMessageProjectionPrice[] = []
    const requestImages = messages.flatMap(message => message.content.filter(block => block.type === 'image'))
    const retainedImages = requestImages.length === 0 ? undefined
      : image?.priceImages(requestImages.map(({ offloaded: _marked, ...block }) => block))
    const offloadedImages = requestImages.length === 0 ? undefined
      : image?.priceImages(requestImages.map(block => ({ ...block, offloaded: true })))
    if (image !== undefined && requestImages.length > 0 && (retainedImages?.length !== requestImages.length || offloadedImages?.length !== requestImages.length)) throw new Error(`token meter: route image pricing answered a mismatched occurrence count for ${requestImages.length} occurrences`)
    let imageCursor = 0
    for (const message of messages) {
      const images = message.content.filter(block => block.type === 'image')
      const files = message.content.filter(block => block.type === 'file')
      if (images.length === 0 && files.length === 0 && (message.role !== 'developer' || projectedTools === undefined)) continue
      const retained = images.length === 0 ? undefined : retainedImages?.slice(imageCursor, imageCursor + images.length)
      const offloaded = images.length === 0 ? undefined : offloadedImages?.slice(imageCursor, imageCursor + images.length)
      imageCursor += images.length
      const media: LlmMessageProjectionPrice = {
        messageId: message.id,
        ...retained === undefined || offloaded === undefined ? {} : { images: retained.map((value, index) => {
          const omitted = offloaded[index]
          if (omitted === undefined) throw new Error('token meter: missing offloaded image price')
          return { retained: value, offloaded: omitted }
        }) },
        ...fileText === undefined || files.length === 0 ? {} : { files: files.map(block => fileText(block.attachment)) },
      }
      let projectedTokens: number | undefined
      if (message.role === 'developer' && projectedTools !== undefined) {
        const projected = projectedDevelopers.get(message.id)
        if (projected === undefined) projectedTokens = 0
        else if ((images.length === 0 || media.images !== undefined) && (files.length === 0 || media.files !== undefined)) {
          projectedTokens = estimateMessage(projected)
          for (const [index, block] of images.entries()) {
            const receipt = media.images?.[index]
            if (receipt === undefined) continue
            const price = block.offloaded === true ? receipt.offloaded : receipt.retained
            projectedTokens += price.visualTokens + estimateContent([{ type: 'text', text: price.text }]) - estimateStructuralBlock(block)
          }
          for (const [index, block] of files.entries()) {
            const text = media.files?.[index]
            if (text !== undefined) projectedTokens += estimateContent([{ type: 'text', text }]) - estimateStructuralBlock(block)
          }
        }
      }
      const price: LlmMessageProjectionPrice = { ...media, ...projectedTokens === undefined ? {} : { projectedTokens } }
      const previous = sameRoute ? byId.get(message.id)?.projectionPrice : undefined
      const previousPrice = previous === undefined ? undefined : { messageId: message.id,
        ...previous.images === undefined ? {} : { images: previous.images },
        ...previous.files === undefined ? {} : { files: previous.files },
        ...previous.projectedTokens === undefined ? {} : { projectedTokens: previous.projectedTokens } }
      if (JSON.stringify(previousPrice) !== JSON.stringify(price) || (projectedTokens !== undefined && previous?.toolMode !== mode)) {
        projectionPrices.push(price)
      }
    }
    const previous = session.requestContext()
    const { replayPricing: _oldScope, replayPrices: _oldReplay, projectionPrices: _oldProjection,
      outputReserve: _oldReserve, contextWindow: _oldWindow, retention: _oldRetention,
      toolProjection: _oldTools, ...previousMetadata } = previous ?? { provider, model }
    const matchingMetadata = state.frame.provider === provider && state.frame.model === model
    const reserve = snapshot === undefined
      ? matchingMetadata && header.config.maxTokens === state.frame.requestedMaxTokens ? state.frame.outputReserveTokens : undefined
      : snapshot.outputReserve
    const metadata: RequestContext = {
      ...previous?.provider === provider && previous.model === model ? previousMetadata : {},
      provider, model,
      ...matchingMetadata && state.frame.contextWindow !== undefined ? { contextWindow: state.frame.contextWindow } : {},
      ...matchingMetadata && state.frame.retention !== undefined ? { retention: {
        retainTokens: state.frame.retention.retainTokens, source: state.frame.retention.source,
        ...state.frame.retention.retainRatio === undefined ? {} : { retainRatio: state.frame.retention.retainRatio } } } : {},
      ...reserve === undefined ? {} : { outputReserve: reserve },
      ...replay === undefined ? {} : { replayPricing: replay.scope },
      ...replayPrices.length === 0 ? {} : { replayPrices },
      ...projectionPrices.length === 0 ? {} : { projectionPrices },
      ...toolProjection === undefined ? {} : { toolProjection },
    }
    const toolsChanged = toolProjection !== undefined && (!sameRoute || !sameTools || previousTool === undefined
      || previousTool.scope !== JSON.stringify([provider, model, scope]) || previousTool.headerSeq !== state.frame.headerSeq
      || previousTool.headerKey !== JSON.stringify(header.tools ?? [])
      || previousTool.tokens !== toolProjection.tokens || previousTool.mode !== toolProjection.mode)
    if (matchingMetadata && state.frame.scope === scope && state.frame.outputReserveTokens === reserve
      && replayPrices.length === 0 && projectionPrices.length === 0 && !toolsChanged) return { measurement: this.measure(session, header) }
    const capture = { ...state, frame: { ...state.frame, headerKey: JSON.stringify(header),
      toolsHeaderKey: JSON.stringify(header.tools ?? []), toolsTokens: estimateToolsTokens(header),
      requestedMaxTokens: header.config.maxTokens } }
    const projected = foldAccounting(capture, { type: 'request/context', seq: SessionSeq(session.seq), time: 0, data: metadata })
    return { measurement: deepFreeze(structuredClone({ ...calculateAccounting(projected, header), logRevision: session.seq })),
      context: metadata }
  }

  /** Price one message with the route-independent shadow-price heuristic.
   * @param message - message to price without mutation.
   * @returns heuristic tokens, not a native replay estimate.
   */
  estimateMessage(message: Message): number { return estimateMessage(message) }
}
export default TokenMeter
